import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TERMINATION_GRACE_MS,
  MAX_COMMAND_OUTPUT_BYTES,
  runBoundedProcess,
} from "./bounded-process.js";

export { MAX_COMMAND_OUTPUT_BYTES };

export const MAX_FILE_BYTES = 1024 * 1024;
export const RUN_TESTS_TIMEOUT_MS = 120 * 1000;

const GIT_TIMEOUT_MS = 30 * 1000;
const TEST_SUPERVISOR_PATH = fileURLToPath(new URL("./test-supervisor.js", import.meta.url));
const SAFE_GIT_ENV = Object.freeze({
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
});

const WRITE_DENYLIST = Object.freeze({
  directorySegments: new Set([".git", "node_modules"]),
  exactBasenames: new Set([".env", "id_rsa", "id_ed25519"]),
  extensions: new Set([".pem", ".key"]),
});

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "list_files",
    description: "List files and directories inside the authorized local workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative directory path; use . for the workspace root." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the authorized local workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative file path." } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file inside the authorized local workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path." },
        content: { type: "string", description: "Complete UTF-8 file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "git_status",
    description: "Return the short Git status of the authorized local workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "git_diff",
    description: "Return the unstaged or staged Git diff of the authorized local workspace.",
    inputSchema: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "When true, return the staged diff." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "run_tests",
    description: "Run the pre-approved default test suite in the authorized local workspace.",
    inputSchema: {
      type: "object",
      properties: {
        test: { type: "string", enum: ["default"] },
      },
      required: ["test"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
]);

class ToolError extends Error {}

function toolResult(text, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text }],
  };
}

function assertPlainArguments(args, allowed, required = []) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolError("Arguments must be an object");
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new ToolError(`Unexpected argument: ${key}`);
  }
  for (const key of required) {
    if (!(key in args)) throw new ToolError(`Missing required argument: ${key}`);
  }
}

function normalizeRelativePath(input, defaultToRoot = false) {
  if (input === undefined && defaultToRoot) return ".";
  if (typeof input !== "string" || input.length === 0) {
    throw new ToolError("Path must be a non-empty relative string");
  }
  if (
    input.includes("\0") ||
    path.isAbsolute(input) ||
    /^[A-Za-z]:[\\/]/.test(input) ||
    input.startsWith("\\\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)
  ) {
    throw new ToolError("Absolute paths are not allowed");
  }
  const normalized = path.normalize(input);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new ToolError("Path must stay inside the authorized workspace");
  }
  return normalized;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertWriteAllowed(relativePath) {
  const segments = relativePath.split(path.sep).map((segment) => segment.toLowerCase());
  const basename = segments.at(-1);
  if (
    segments.some((segment) => WRITE_DENYLIST.directorySegments.has(segment)) ||
    WRITE_DENYLIST.exactBasenames.has(basename) ||
    WRITE_DENYLIST.extensions.has(path.extname(basename))
  ) {
    throw new ToolError("Writing to this protected path is not allowed");
  }
}

function displayPath(value) {
  return JSON.stringify(String(value)).slice(1, -1).replace(/=/g, "%3D").replace(/ /g, "%20");
}

export async function createBridgeCore(workspace, logger = (line) => console.error(line), options = {}) {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("DEVELOPER_BRIDGE_WORKSPACE is required; set it to the authorized project directory");
  }

  let root;
  try {
    root = await fs.realpath(path.resolve(workspace));
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) throw new Error("not-directory");
  } catch {
    throw new Error("DEVELOPER_BRIDGE_WORKSPACE must identify an existing directory");
  }

  const testTimeoutMs = options.testTimeoutMs ?? RUN_TESTS_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  if (!Number.isInteger(testTimeoutMs) || testTimeoutMs <= 0) throw new Error("Test timeout must be a positive integer");
  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 0) throw new Error("Termination grace must be a non-negative integer");

  async function runGit(args) {
    let result;
    try {
      result = await runBoundedProcess("git", args, {
        cwd: root,
        timeoutMs: GIT_TIMEOUT_MS,
        env: { ...process.env, ...SAFE_GIT_ENV },
      });
    } catch {
      throw new ToolError("Git could not be started");
    }
    if (result.outputLimitExceeded) {
      throw new ToolError("Git output size limit exceeded; narrow the workspace changes before retrying");
    }
    if (result.timedOut) throw new ToolError("Git operation timed out");
    if (result.exitCode !== 0) {
      if (/not a git repository/iu.test(result.stderr)) throw new ToolError("Authorized workspace is not a Git repository");
      throw new ToolError("Git operation failed");
    }
    return result.stdout;
  }

  function lexicalTarget(relativePath) {
    const target = path.resolve(root, relativePath);
    if (!isContained(root, target)) throw new ToolError("Path must stay inside the authorized workspace");
    return target;
  }

  async function existingTarget(relativePath, expected) {
    const target = lexicalTarget(relativePath);
    let canonical;
    let stat;
    try {
      canonical = await fs.realpath(target);
      stat = await fs.stat(canonical);
    } catch {
      throw new ToolError("Path does not exist");
    }
    if (!isContained(root, canonical)) throw new ToolError("Symbolic link escapes the authorized workspace");
    if (expected === "file" && !stat.isFile()) throw new ToolError("Path must identify a file");
    if (expected === "file" && stat.nlink > 1) throw new ToolError("Hard-linked files are not allowed");
    if (expected === "directory" && !stat.isDirectory()) throw new ToolError("Path must identify a directory");
    return { target, canonical, stat };
  }

  async function writableTarget(relativePath) {
    assertWriteAllowed(relativePath);
    const target = lexicalTarget(relativePath);
    try {
      const canonical = await fs.realpath(target);
      if (!isContained(root, canonical)) throw new ToolError("Symbolic link escapes the authorized workspace");
      const stat = await fs.stat(canonical);
      if (!stat.isFile()) throw new ToolError("Cannot overwrite a directory or non-file path");
      if (stat.nlink > 1) throw new ToolError("Hard-linked files are not allowed");
      assertWriteAllowed(path.relative(root, canonical));
      return { target: canonical, expectedStat: stat, exists: true };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error?.code !== "ENOENT") throw new ToolError("Target path cannot be written");
      const parent = path.dirname(target);
      let canonicalParent;
      try {
        canonicalParent = await fs.realpath(parent);
        const parentStat = await fs.stat(canonicalParent);
        if (!parentStat.isDirectory()) throw new Error("not-directory");
      } catch {
        throw new ToolError("Parent directory must already exist");
      }
      if (!isContained(root, canonicalParent)) throw new ToolError("Symbolic link escapes the authorized workspace");
      const canonicalTarget = path.join(canonicalParent, path.basename(target));
      assertWriteAllowed(path.relative(root, canonicalTarget));
      return { target: canonicalTarget, expectedStat: null, exists: false };
    }
  }

  async function readFileVerified(canonical, expectedStat) {
    let handle;
    try {
      handle = await fs.open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.nlink > 1 ||
        openedStat.dev !== expectedStat.dev ||
        openedStat.ino !== expectedStat.ino
      ) {
        throw new ToolError("File changed during security validation");
      }
      if (openedStat.size > MAX_FILE_BYTES) throw new ToolError(`File exceeds the ${MAX_FILE_BYTES}-byte size limit`);
      const content = await handle.readFile();
      if (content.length > MAX_FILE_BYTES) throw new ToolError(`File exceeds the ${MAX_FILE_BYTES}-byte size limit`);
      return content.toString("utf8");
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("File could not be read safely");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function writeFileVerified(target, expectedStat, exists, content) {
    let handle;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      const flags = exists
        ? fsConstants.O_WRONLY | noFollow
        : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
      handle = await fs.open(target, flags, 0o666);
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.nlink > 1) {
        throw new ToolError("File changed during security validation");
      }
      if (
        expectedStat &&
        (openedStat.dev !== expectedStat.dev || openedStat.ino !== expectedStat.ino)
      ) {
        throw new ToolError("File changed during security validation");
      }
      if (exists) await handle.truncate(0);
      await handle.writeFile(content, "utf8");
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("File could not be written safely");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function invoke(name, args, onValidatedPath) {
    if (name === "list_files") {
      assertPlainArguments(args, ["path"]);
      const relativePath = normalizeRelativePath(args.path, true);
      onValidatedPath(relativePath);
      const { canonical } = await existingTarget(relativePath, "directory");
      const entries = await fs.readdir(canonical, { withFileTypes: true });
      return {
        relativePath,
        text: entries.map((entry) => `${entry.isDirectory() ? "DIR " : "FILE"} ${entry.name}`).join("\n"),
      };
    }
    if (name === "read_file") {
      assertPlainArguments(args, ["path"], ["path"]);
      const relativePath = normalizeRelativePath(args.path);
      onValidatedPath(relativePath);
      const { canonical, stat } = await existingTarget(relativePath, "file");
      const text = await readFileVerified(canonical, stat);
      return { relativePath, text, contentBytes: Buffer.byteLength(text, "utf8") };
    }
    if (name === "write_file") {
      assertPlainArguments(args, ["path", "content"], ["path", "content"]);
      const relativePath = normalizeRelativePath(args.path);
      onValidatedPath(relativePath);
      if (typeof args.content !== "string") throw new ToolError("Content must be a UTF-8 string");
      const contentBytes = Buffer.byteLength(args.content, "utf8");
      if (contentBytes > MAX_FILE_BYTES) throw new ToolError(`Content exceeds the ${MAX_FILE_BYTES}-byte size limit`);
      const { target, expectedStat, exists } = await writableTarget(relativePath);
      await writeFileVerified(target, expectedStat, exists, args.content);
      return { relativePath, text: `Wrote ${relativePath} (${contentBytes} bytes)`, contentBytes };
    }
    if (name === "git_status") {
      assertPlainArguments(args, []);
      const output = await runGit(["status", "--short"]);
      return { text: output.length === 0 ? "clean" : output };
    }
    if (name === "git_diff") {
      assertPlainArguments(args, ["staged"]);
      if ("staged" in args && typeof args.staged !== "boolean") {
        throw new ToolError("staged must be a boolean");
      }
      const gitArgs = args.staged === true
        ? ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color"]
        : ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
      const output = await runGit(gitArgs);
      return { text: output.length === 0 ? "no diff" : output };
    }
    if (name === "run_tests") {
      assertPlainArguments(args, ["test"], ["test"]);
      if (args.test !== "default") throw new ToolError('test must be exactly "default"');
      let result;
      try {
        result = await runBoundedProcess(process.execPath, [TEST_SUPERVISOR_PATH], {
          cwd: root,
          timeoutMs: testTimeoutMs,
          detached: true,
          terminationGraceMs,
        });
      } catch {
        throw new ToolError("The approved test command could not be started");
      }
      return { text: JSON.stringify(result) };
    }
    throw new ToolError(`Unknown tool: ${name}`);
  }

  return {
    tools: TOOL_DEFINITIONS,
    async callTool(name, args = {}) {
      const started = performance.now();
      let relativePath;
      try {
        const result = await invoke(name, args, (validatedPath) => {
          relativePath = validatedPath;
        });
        relativePath = result.relativePath;
        const fields = [new Date().toISOString(), `tool=${displayPath(name)}`];
        if (relativePath !== undefined) fields.push(`path=${displayPath(relativePath)}`);
        if (result.contentBytes !== undefined) fields.push(`content_bytes=${result.contentBytes}`);
        fields.push("result=success", `duration_ms=${Math.round(performance.now() - started)}`);
        logger(fields.join(" "));
        return toolResult(result.text);
      } catch (error) {
        const fields = [new Date().toISOString(), `tool=${displayPath(name)}`];
        if (relativePath !== undefined) fields.push(`path=${displayPath(relativePath)}`);
        if (name === "write_file" && typeof args?.content === "string") {
          fields.push(`content_bytes=${Buffer.byteLength(args.content, "utf8")}`);
        }
        fields.push("result=failure", `duration_ms=${Math.round(performance.now() - started)}`);
        logger(fields.join(" "));
        const message = error instanceof ToolError ? error.message : "Tool operation failed";
        return toolResult(message, true);
      }
    },
  };
}
