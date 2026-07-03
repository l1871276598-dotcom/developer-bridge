import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertNoRepositoryTransportOverrides,
  runFixedGit,
} from "./fixed-git-runner.js";

const PROFILE = "controlled-engineering-v1";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_WORKFLOW_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const PACKAGE_TIMEOUT_MS = 10 * 60_000;
const SEARCH_FILE_LIMIT = 5_000;
const ALLOWED_PACKAGE_SCRIPTS = Object.freeze([
  "test",
  "lint",
  "typecheck",
  "build",
  "format:check",
]);

export const REQUIRED_TOOL_NAMES = Object.freeze([
  "list_files",
  "read_file",
  "write_file",
  "create_directory",
  "path_stat",
  "search_text",
  "find_files",
  "move_path",
  "delete_file",
  "delete_empty_directory",
  "git_status",
  "git_diff",
  "git_context",
  "git_log",
  "git_show",
  "git_diff_refs",
  "git_fetch_ref",
  "git_upstream_status",
  "git_branch_list",
  "git_branch_create",
  "git_branch_switch",
  "git_worktree_list",
  "git_worktree_create",
  "git_worktree_switch",
  "git_stage",
  "git_commit",
  "git_push_current_branch",
  "git_fetch_origin_main",
  "git_merge_origin_main",
  "git_merge_abort",
  "run_tests",
  "run_validation",
  "install_dependencies",
  "run_package_script",
  "run_project_validation",
  "validate_github_workflow",
  "github_pr_create_draft",
  "github_pr_get",
  "github_pr_mark_ready",
  "github_pr_update",
  "github_pr_reviews",
  "github_pr_checks",
  "github_actions_list_workflows",
  "github_actions_list_runs",
  "github_actions_get_jobs",
  "github_actions_get_logs",
  "github_actions_dispatch",
  "github_actions_rerun_failed",
  "github_branch_protection_get",
  "github_contents_write_workflow",
  "github_pr_merge_squash_if_green",
]);

const pathProperty = { type: "string", minLength: 1, maxLength: 1000 };
const positiveInteger = { type: "integer", minimum: 1 };

function tool(name, description, properties = {}, required = [], annotations = { readOnlyHint: true }) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    annotations,
  };
}

export const CONTROLLED_ENGINEERING_TOOL_DEFINITIONS = Object.freeze([
  tool(
    "create_directory",
    "Create a directory inside the authorized workspace without traversing symbolic links.",
    { path: pathProperty, recursive: { type: "boolean" } },
    ["path"],
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  ),
  tool("path_stat", "Inspect one workspace path without following symbolic links.", { path: pathProperty }, ["path"]),
  tool(
    "search_text",
    "Search bounded UTF-8 workspace files for text or a regular expression.",
    {
      query: { type: "string", minLength: 1, maxLength: 500 },
      path: pathProperty,
      regex: { type: "boolean" },
      case_sensitive: { type: "boolean" },
      file_extensions: {
        type: "array",
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 20 },
      },
      max_results: { type: "integer", minimum: 1, maximum: 500 },
    },
    ["query"],
  ),
  tool(
    "find_files",
    "Find workspace files by a bounded glob pattern.",
    {
      pattern: { type: "string", minLength: 1, maxLength: 300 },
      path: pathProperty,
      max_results: { type: "integer", minimum: 1, maximum: 500 },
    },
    ["pattern"],
  ),
  tool(
    "move_path",
    "Move one existing workspace file or directory without overwriting the destination.",
    { source: pathProperty, destination: pathProperty },
    ["source", "destination"],
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  ),
  tool(
    "delete_file",
    "Delete one verified regular file after exact confirmation.",
    { path: pathProperty, confirm: { type: "string", enum: ["DELETE FILE"] } },
    ["path", "confirm"],
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  ),
  tool(
    "delete_empty_directory",
    "Delete one verified empty directory after exact confirmation.",
    { path: pathProperty, confirm: { type: "string", enum: ["DELETE EMPTY DIRECTORY"] } },
    ["path", "confirm"],
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  ),
  tool("git_context", "Return the authorized repository, branch, HEAD, upstream, and clean-state context."),
  tool(
    "git_log",
    "Return bounded recent Git commit metadata, optionally limited to one workspace path.",
    { limit: { type: "integer", minimum: 1, maximum: 100 }, path: pathProperty },
  ),
  tool(
    "git_show",
    "Show one verified commit with fixed safe Git formatting.",
    { ref: { type: "string", minLength: 1, maxLength: 200 }, path: pathProperty },
    ["ref"],
  ),
  tool(
    "git_diff_refs",
    "Compare two verified commit references using a fixed three-dot diff.",
    {
      base: { type: "string", minLength: 1, maxLength: 200 },
      head: { type: "string", minLength: 1, maxLength: 200 },
    },
    ["base", "head"],
  ),
  tool(
    "git_fetch_ref",
    "Fetch one explicit origin branch or pull-request head into a remote-tracking reference.",
    { ref: { type: "string", minLength: 1, maxLength: 200 } },
    ["ref"],
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  ),
  tool("git_upstream_status", "Report whether the current branch tracks origin and is fully pushed."),
  tool(
    "install_dependencies",
    "Run fixed npm ci --ignore-scripts using the committed package lock.",
    {},
    [],
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  ),
  tool(
    "run_package_script",
    "Run one allowlisted package script without arbitrary arguments.",
    { script: { type: "string", enum: ALLOWED_PACKAGE_SCRIPTS } },
    ["script"],
    { readOnlyHint: false, openWorldHint: true },
  ),
  tool(
    "run_project_validation",
    "Install locked dependencies and run all available allowlisted validation scripts in a fixed order.",
    {},
    [],
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  ),
  tool(
    "validate_github_workflow",
    "Validate one local GitHub Actions workflow against the controlled security policy.",
    { path: pathProperty },
    ["path"],
  ),
  tool("github_pr_get", "Read one pull request from the authorized GitHub origin.", { number: positiveInteger }, ["number"], { readOnlyHint: true, openWorldHint: true }),
  tool(
    "github_pr_mark_ready",
    "Mark one Draft pull request ready only when its head SHA matches the expected value.",
    { number: positiveInteger, expected_head_sha: { type: "string", pattern: "^[0-9a-f]{40}$" } },
    ["number", "expected_head_sha"],
    { readOnlyHint: false, openWorldHint: true },
  ),
  tool(
    "github_pr_update",
    "Update only the title and/or body of one pull request after checking its head SHA.",
    {
      number: positiveInteger,
      expected_head_sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
      title: { type: "string", minLength: 1, maxLength: 256 },
      body: { type: "string", maxLength: 65_536 },
    },
    ["number", "expected_head_sha"],
    { readOnlyHint: false, openWorldHint: true },
  ),
  tool("github_pr_reviews", "Read reviews and review threads for one pull request.", { number: positiveInteger }, ["number"], { readOnlyHint: true, openWorldHint: true }),
  tool("github_pr_checks", "Read and normalize all reported checks for one pull request head.", { number: positiveInteger }, ["number"], { readOnlyHint: true, openWorldHint: true }),
  tool("github_actions_list_workflows", "List GitHub Actions workflows in the authorized repository.", {}, [], { readOnlyHint: true, openWorldHint: true }),
  tool(
    "github_actions_list_runs",
    "List bounded GitHub Actions runs for the authorized repository.",
    {
      branch: { type: "string", minLength: 1, maxLength: 200 },
      head_sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
      event: { type: "string", minLength: 1, maxLength: 100 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    [],
    { readOnlyHint: true, openWorldHint: true },
  ),
  tool("github_actions_get_jobs", "Read jobs and steps for one GitHub Actions run.", { run_id: positiveInteger }, ["run_id"], { readOnlyHint: true, openWorldHint: true }),
  tool("github_actions_get_logs", "Read and redact logs for one GitHub Actions job.", { job_id: positiveInteger }, ["job_id"], { readOnlyHint: true, openWorldHint: true }),
  tool(
    "github_actions_dispatch",
    "Dispatch an existing workflow only on the current non-protected branch.",
    {
      workflow: { type: "string", minLength: 1, maxLength: 300 },
      ref: { type: "string", minLength: 1, maxLength: 200 },
      inputs: { type: "object", maxProperties: 20, additionalProperties: { type: "string", maxLength: 1000 } },
    },
    ["workflow"],
    { readOnlyHint: false, openWorldHint: true },
  ),
  tool(
    "github_actions_rerun_failed",
    "Re-run failed jobs only for a run belonging to the current branch.",
    { run_id: positiveInteger },
    ["run_id"],
    { readOnlyHint: false, openWorldHint: true },
  ),
  tool(
    "github_branch_protection_get",
    "Read branch protection for main, master, or another explicit branch.",
    { branch: { type: "string", minLength: 1, maxLength: 200 } },
    [],
    { readOnlyHint: true, openWorldHint: true },
  ),
  tool(
    "github_contents_write_workflow",
    "Create or update one validated workflow on the current pushed branch through GitHub Contents API.",
    {
      path: pathProperty,
      content: { type: "string", minLength: 1, maxLength: MAX_WORKFLOW_BYTES },
      message: { type: "string", minLength: 1, maxLength: 300 },
      expected_head_sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
      expected_blob_sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    },
    ["path", "content", "message", "expected_head_sha"],
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  ),
]);

const NEW_TOOL_NAMES = new Set(CONTROLLED_ENGINEERING_TOOL_DEFINITIONS.map(({ name }) => name));
const PROTECTED_SEGMENTS = new Set([".git", "node_modules"]);
const PROTECTED_BASENAMES = new Set([".env", "id_rsa", "id_ed25519"]);
const PROTECTED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks"]);

export function isControlledEngineeringTool(name) {
  return NEW_TOOL_NAMES.has(name);
}

export function validateRequiredToolContract(availableNames, env = process.env) {
  const available = [...availableNames];
  if (env.DEVELOPER_BRIDGE_FAIL_IF_REQUIRED_TOOL_MISSING !== "1") return available;
  const required = String(env.DEVELOPER_BRIDGE_REQUIRED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (required.length === 0) throw new Error("Required tool contract is empty.");
  if (new Set(required).size !== required.length) throw new Error("Required tool contract contains duplicates.");
  const availableSet = new Set(available);
  const missing = required.filter((name) => !availableSet.has(name));
  if (missing.length) throw new Error(`Missing required tools: ${missing.join(", ")}`);
  return required;
}

function assertCapability(env) {
  if (env.DEVELOPER_BRIDGE_CAPABILITY_PROFILE !== PROFILE) {
    throw new Error("Controlled engineering capability profile is required.");
  }
}

function assertArgs(args, allowed, required = []) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object.");
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`Unexpected argument: ${key}`);
  }
  for (const key of required) {
    if (!(key in args)) throw new Error(`Missing required argument: ${key}`);
  }
}

function normalizeRelative(input, defaultRoot = false) {
  if (input === undefined && defaultRoot) return ".";
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new Error("Path must be a non-empty relative string.");
  }
  if (
    path.isAbsolute(input) ||
    /^[A-Za-z]:[\\/]/u.test(input) ||
    input.startsWith("\\\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(input)
  ) {
    throw new Error("Absolute paths are not allowed.");
  }
  const normalized = path.normalize(input);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Path must stay inside the authorized workspace.");
  }
  return normalized;
}

function relativeDisplay(value) {
  return value.split(path.sep).join("/");
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertPathAllowed(relativePath) {
  const parts = relativePath.split(path.sep).filter((part) => part && part !== ".");
  const lowered = parts.map((part) => part.toLowerCase());
  const basename = lowered.at(-1) ?? "";
  if (
    lowered.some((part) => PROTECTED_SEGMENTS.has(part)) ||
    PROTECTED_BASENAMES.has(basename) ||
    PROTECTED_EXTENSIONS.has(path.extname(basename)) ||
    lowered.some((part) => /(?:credential|oauth|secret|private[_-]?key)/u.test(part))
  ) {
    throw new Error("Protected workspace path is not allowed.");
  }
}

async function canonicalWorkspace(root) {
  const canonical = await fs.realpath(root);
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new Error("Authorized workspace is invalid.");
  return canonical;
}

async function existingPath(root, relativePath, expected) {
  assertPathAllowed(relativePath);
  const target = path.resolve(root, relativePath);
  if (!isContained(root, target)) throw new Error("Path escapes the authorized workspace.");
  const lexical = await fs.lstat(target);
  if (lexical.isSymbolicLink()) throw new Error("Symbolic links are not allowed for this operation.");
  const canonical = await fs.realpath(target);
  if (!isContained(root, canonical)) throw new Error("Path escapes the authorized workspace.");
  const stat = await fs.stat(canonical);
  if (expected === "file" && (!stat.isFile() || stat.nlink > 1)) throw new Error("Path must be a single-link regular file.");
  if (expected === "directory" && !stat.isDirectory()) throw new Error("Path must identify a directory.");
  return { target, canonical, stat };
}

async function existingDirectory(root, relativePath = ".") {
  return existingPath(root, relativePath, "directory");
}

async function writableParent(root, relativePath) {
  assertPathAllowed(relativePath);
  const target = path.resolve(root, relativePath);
  if (!isContained(root, target) || target === root) throw new Error("Path escapes the authorized workspace.");
  const parent = path.dirname(target);
  const lexical = await fs.lstat(parent);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new Error("Destination parent must be a real directory.");
  const canonicalParent = await fs.realpath(parent);
  if (!isContained(root, canonicalParent)) throw new Error("Destination parent escapes the authorized workspace.");
  return { target: path.join(canonicalParent, path.basename(target)), parent: canonicalParent };
}

function boundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("Integer argument is outside the allowed range.");
  return value;
}

function safeProjectEnv(env) {
  const safe = { ...env };
  delete safe.NODE_TEST_CONTEXT;
  for (const key of Object.keys(safe)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|AUTH|MCP_PATH)/iu.test(key)) delete safe[key];
  }
  safe.CI = "1";
  safe.GIT_TERMINAL_PROMPT = "0";
  return safe;
}

function ghEnvironment(env) {
  const safe = { ...env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
  delete safe.GH_REPO;
  delete safe.GH_HOST;
  delete safe.MCP_PATH;
  return safe;
}

function runCommand(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowedExitCodes = [0],
    allowFailure = false,
    input,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const stop = (signal) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {}
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const collect = (target, chunk, type) => {
      if (type === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        stop("SIGKILL");
        finish(new Error("Command output exceeded the fixed limit."));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.once("error", () => finish(new Error("Fixed command could not be started.")));
    child.once("close", (exitCode, signal) => {
      if (timedOut) return finish(new Error("Fixed command timed out."));
      const result = {
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (!allowFailure && !allowedExitCodes.includes(exitCode)) {
        return finish(new Error("Fixed command failed."));
      }
      return finish(null, result);
    });
    if (input !== undefined) child.stdin.end(input);

    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timer.unref();
  });
}

async function git(root, args, options = {}) {
  return runFixedGit("git", args, { cwd: root, ...options });
}

async function repositoryContext(root, { requireGitHub = false } = {}) {
  const canonical = await canonicalWorkspace(root);
  const topLevel = (await git(canonical, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (path.resolve(topLevel) !== canonical) throw new Error("Workspace must be the repository root.");
  const branch = (await git(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!branch) throw new Error("Detached HEAD is not allowed.");
  const head = (await git(canonical, ["rev-parse", "HEAD"])).stdout.trim();
  const remote = (await git(canonical, ["remote", "get-url", "origin"], { allowedExitCodes: [0, 2] }).catch(() => ({ stdout: "" }))).stdout.trim();
  const repository = remote ? parseGitHubRepository(remote) : null;
  if (requireGitHub && !repository) throw new Error("A GitHub origin remote is required.");
  return { root: canonical, branch, head, remote, repository };
}

function parseGitHubRepository(remote) {
  const patterns = [
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(remote);
    if (match) return { owner: match[1], name: match[2], slug: `${match[1]}/${match[2]}` };
  }
  return null;
}

async function resolveCommit(root, ref) {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 200 || ref.startsWith("-") || /[\0\r\n]/u.test(ref)) {
    throw new Error("Git ref is invalid.");
  }
  const result = await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("Git ref did not resolve to one commit.");
  return sha;
}

async function currentUpstream(root) {
  try {
    return (await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout.trim();
  } catch {
    return null;
  }
}

function parseJson(text, message = "Command returned malformed JSON.") {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(message);
  }
}

async function runGh(root, args, options = {}) {
  const runner = options.runCommand || runCommand;
  return runner("gh", args, {
    cwd: root,
    env: ghEnvironment(options.env || process.env),
    envOverrides: ghEnvironment(options.env || process.env),
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    allowedExitCodes: options.allowedExitCodes || [0],
    allowFailure: options.allowFailure || false,
    input: options.input,
  });
}

async function assertGh(root, options) {
  await runGh(root, ["auth", "status", "--hostname", "github.com"], options);
}

async function collectFiles(root, startRelative, callback) {
  const start = await existingDirectory(root, startRelative);
  let visited = 0;
  async function walk(directory, relativeDirectory) {
    if (visited >= SEARCH_FILE_LIMIT) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (visited >= SEARCH_FILE_LIMIT) return;
      const relative = relativeDirectory === "." ? entry.name : path.join(relativeDirectory, entry.name);
      const lowered = entry.name.toLowerCase();
      if (entry.isSymbolicLink() || PROTECTED_SEGMENTS.has(lowered) || PROTECTED_BASENAMES.has(lowered)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        visited += 1;
        await callback(absolute, relativeDisplay(relative));
      }
    }
  }
  await walk(start.canonical, relativeDisplay(startRelative));
  return visited;
}

function globRegExp(pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  if (normalized.includes("\0") || normalized.startsWith("/") || normalized.includes("../")) {
    throw new Error("Glob pattern is invalid.");
  }
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.-]/u, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
}

async function createDirectory(args, root) {
  assertArgs(args, ["path", "recursive"], ["path"]);
  const relative = normalizeRelative(args.path);
  assertPathAllowed(relative);
  if ("recursive" in args && typeof args.recursive !== "boolean") throw new Error("recursive must be a boolean.");
  const recursive = args.recursive !== false;
  const parts = relative.split(path.sep).filter((part) => part && part !== ".");
  let current = root;
  let created = false;
  for (let index = 0; index < parts.length; index += 1) {
    const next = path.join(current, parts[index]);
    try {
      const stat = await fs.lstat(next);
      if (stat.isSymbolicLink()) throw new Error("Directory path traverses a symbolic link.");
      if (!stat.isDirectory()) throw new Error("Directory path collides with a non-directory.");
      current = await fs.realpath(next);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!recursive && index !== parts.length - 1) throw new Error("Parent directory must already exist.");
      await fs.mkdir(next);
      const stat = await fs.lstat(next);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Directory could not be created safely.");
      current = await fs.realpath(next);
      created = true;
    }
    if (!isContained(root, current)) throw new Error("Directory path escapes the authorized workspace.");
  }
  return { text: JSON.stringify({ created, path: relativeDisplay(relative) }) };
}

async function pathStat(args, root) {
  assertArgs(args, ["path"], ["path"]);
  const relative = normalizeRelative(args.path);
  assertPathAllowed(relative);
  const target = path.resolve(root, relative);
  if (!isContained(root, target)) throw new Error("Path escapes the authorized workspace.");
  const stat = await fs.lstat(target);
  const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
  return {
    text: JSON.stringify({
      path: relativeDisplay(relative),
      type,
      size: stat.size,
      modified_at: stat.mtime.toISOString(),
    }),
  };
}

async function searchText(args, root) {
  assertArgs(args, ["query", "path", "regex", "case_sensitive", "file_extensions", "max_results"], ["query"]);
  if (typeof args.query !== "string" || args.query.length === 0 || args.query.length > 500) throw new Error("Search query is invalid.");
  const start = normalizeRelative(args.path, true);
  const limit = boundedInteger(args.max_results, 100, 500);
  const regexMode = args.regex === true;
  const caseSensitive = args.case_sensitive === true;
  let matcher;
  if (regexMode) matcher = new RegExp(args.query, caseSensitive ? "u" : "iu");
  else {
    const needle = caseSensitive ? args.query : args.query.toLocaleLowerCase("en-US");
    matcher = (line) => (caseSensitive ? line : line.toLocaleLowerCase("en-US")).indexOf(needle);
  }
  const extensions = Array.isArray(args.file_extensions)
    ? new Set(args.file_extensions.map((item) => item.startsWith(".") ? item.toLowerCase() : `.${item.toLowerCase()}`))
    : null;
  const matches = [];
  const files_scanned = await collectFiles(root, start, async (absolute, relative) => {
    if (matches.length >= limit) return;
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_FILE_BYTES || stat.nlink > 1) return;
    if (extensions && !extensions.has(path.extname(relative).toLowerCase())) return;
    const content = await fs.readFile(absolute, "utf8").catch(() => null);
    if (content === null || content.includes("\0")) return;
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
      const line = lines[index];
      let column = -1;
      if (regexMode) {
        const found = matcher.exec(line);
        matcher.lastIndex = 0;
        if (found) column = found.index;
      } else column = matcher(line);
      if (column >= 0) matches.push({ path: relative, line: index + 1, column: column + 1, text: line.slice(0, 500) });
    }
  });
  return { text: JSON.stringify({ query: args.query, files_scanned, matches, truncated: matches.length >= limit }) };
}

async function findFiles(args, root) {
  assertArgs(args, ["pattern", "path", "max_results"], ["pattern"]);
  if (typeof args.pattern !== "string" || args.pattern.length === 0 || args.pattern.length > 300) throw new Error("Glob pattern is invalid.");
  const start = normalizeRelative(args.path, true);
  const limit = boundedInteger(args.max_results, 100, 500);
  const pattern = globRegExp(args.pattern);
  const paths = [];
  const files_scanned = await collectFiles(root, start, async (_absolute, relative) => {
    if (paths.length < limit && pattern.test(relative)) paths.push(relative);
  });
  paths.sort();
  return { text: JSON.stringify({ pattern: args.pattern, files_scanned, paths, truncated: paths.length >= limit }) };
}

async function movePath(args, root) {
  assertArgs(args, ["source", "destination"], ["source", "destination"]);
  const sourceRelative = normalizeRelative(args.source);
  const destinationRelative = normalizeRelative(args.destination);
  const source = await existingPath(root, sourceRelative);
  const destination = await writableParent(root, destinationRelative);
  try {
    await fs.lstat(destination.target);
    throw new Error("Destination already exists.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.rename(source.canonical, destination.target);
  return { text: JSON.stringify({ moved: true, source: relativeDisplay(sourceRelative), destination: relativeDisplay(destinationRelative) }) };
}

async function deleteFile(args, root) {
  assertArgs(args, ["path", "confirm"], ["path", "confirm"]);
  if (args.confirm !== "DELETE FILE") throw new Error("Exact file deletion confirmation is required.");
  const relative = normalizeRelative(args.path);
  const target = await existingPath(root, relative, "file");
  await fs.unlink(target.canonical);
  return { text: JSON.stringify({ deleted: true, path: relativeDisplay(relative) }) };
}

async function deleteEmptyDirectory(args, root) {
  assertArgs(args, ["path", "confirm"], ["path", "confirm"]);
  if (args.confirm !== "DELETE EMPTY DIRECTORY") throw new Error("Exact empty-directory deletion confirmation is required.");
  const relative = normalizeRelative(args.path);
  if (relative === ".") throw new Error("Workspace root cannot be deleted.");
  const target = await existingPath(root, relative, "directory");
  if ((await fs.readdir(target.canonical)).length !== 0) throw new Error("Directory is not empty.");
  await fs.rmdir(target.canonical);
  return { text: JSON.stringify({ deleted: true, path: relativeDisplay(relative) }) };
}

async function gitContext(args, root) {
  assertArgs(args, []);
  const context = await repositoryContext(root);
  const status = (await git(root, ["status", "--porcelain=v1", "-z"])).stdout;
  const upstream = await currentUpstream(root);
  return {
    text: JSON.stringify({
      root: context.root,
      branch: context.branch,
      head: context.head,
      upstream,
      clean: status.length === 0,
      repository: context.repository?.slug ?? null,
    }),
  };
}

async function gitLog(args, root) {
  assertArgs(args, ["limit", "path"]);
  const limit = boundedInteger(args.limit, 20, 100);
  const command = ["log", `-n${limit}`, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s"];
  if (args.path !== undefined) {
    const relative = normalizeRelative(args.path);
    assertPathAllowed(relative);
    command.push("--", relativeDisplay(relative));
  }
  const output = (await git(root, command)).stdout.trim();
  const commits = output ? output.split(/\r?\n/u).map((line) => {
    const [sha, short_sha, author, authored_at, subject] = line.split("\x1f");
    return { sha, short_sha, author, authored_at, subject };
  }) : [];
  return { text: JSON.stringify({ commits }) };
}

async function gitShow(args, root) {
  assertArgs(args, ["ref", "path"], ["ref"]);
  const sha = await resolveCommit(root, args.ref);
  const command = ["show", "--no-ext-diff", "--no-textconv", "--no-color", "--format=fuller", "--stat", "--patch", sha];
  if (args.path !== undefined) {
    const relative = normalizeRelative(args.path);
    assertPathAllowed(relative);
    command.push("--", relativeDisplay(relative));
  }
  return { text: (await git(root, command)).stdout || "no output" };
}

async function gitDiffRefs(args, root) {
  assertArgs(args, ["base", "head"], ["base", "head"]);
  const base = await resolveCommit(root, args.base);
  const head = await resolveCommit(root, args.head);
  const output = (await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", `${base}...${head}`])).stdout;
  return { text: output || "no diff" };
}

async function gitFetchRef(args, root) {
  assertArgs(args, ["ref"], ["ref"]);
  const context = await repositoryContext(root, { requireGitHub: true });
  await assertNoRepositoryTransportOverrides(root);
  let refspec;
  if (/^pull\/[1-9][0-9]*\/head$/u.test(args.ref)) {
    const number = args.ref.split("/")[1];
    refspec = `+refs/pull/${number}/head:refs/remotes/origin/pr/${number}`;
  } else {
    const checked = await git(root, ["check-ref-format", "--branch", args.ref]);
    const branch = checked.stdout.trim();
    if (branch === "main" || branch === "master") {
      refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
    } else refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  }
  await git(root, ["fetch", "--no-tags", "--no-recurse-submodules", "origin", refspec]);
  return { text: JSON.stringify({ fetched: true, ref: args.ref, repository: context.repository.slug }) };
}

async function gitUpstreamStatus(args, root) {
  assertArgs(args, []);
  const context = await repositoryContext(root);
  const upstream = await currentUpstream(root);
  if (!upstream) return { text: JSON.stringify({ branch: context.branch, head: context.head, tracked: false, fully_pushed: false }) };
  const counts = (await git(root, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`])).stdout.trim().split(/\s+/u).map(Number);
  const upstreamHead = (await git(root, ["rev-parse", upstream])).stdout.trim();
  const behind = counts[0] ?? 0;
  const ahead = counts[1] ?? 0;
  return { text: JSON.stringify({ branch: context.branch, head: context.head, upstream, upstream_head: upstreamHead, ahead, behind, tracked: true, fully_pushed: ahead === 0 && context.head === upstreamHead }) };
}

async function packageManifest(root) {
  const manifestPath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const [manifestStat, lockStat] = await Promise.all([fs.stat(manifestPath), fs.stat(lockPath)]);
  if (!manifestStat.isFile() || !lockStat.isFile()) throw new Error("package.json and package-lock.json are required.");
  return parseJson(await fs.readFile(manifestPath, "utf8"), "package.json is malformed.");
}

async function installDependencies(args, root, options) {
  assertArgs(args, []);
  await packageManifest(root);
  const runner = options.runCommand || runCommand;
  const result = await runner("npm", ["ci", "--ignore-scripts"], {
    cwd: root,
    env: safeProjectEnv(options.env || process.env),
    timeoutMs: PACKAGE_TIMEOUT_MS,
    allowFailure: true,
  });
  return { text: JSON.stringify({ command: "npm ci --ignore-scripts", ...result, passed: result.exitCode === 0 }) };
}

async function runPackageScript(args, root, options) {
  assertArgs(args, ["script"], ["script"]);
  if (!ALLOWED_PACKAGE_SCRIPTS.includes(args.script)) throw new Error("Package script is not allowlisted.");
  const manifest = await packageManifest(root);
  if (typeof manifest.scripts?.[args.script] !== "string") throw new Error("Package script is not defined.");
  const runner = options.runCommand || runCommand;
  const result = await runner("npm", ["run", "--silent", args.script], {
    cwd: root,
    env: safeProjectEnv(options.env || process.env),
    timeoutMs: PACKAGE_TIMEOUT_MS,
    allowFailure: true,
  });
  return { text: JSON.stringify({ script: args.script, ...result, passed: result.exitCode === 0 }) };
}

async function runProjectValidation(args, root, options) {
  assertArgs(args, []);
  const manifest = await packageManifest(root);
  const runner = options.runCommand || runCommand;
  const results = [];
  const install = await runner("npm", ["ci", "--ignore-scripts"], {
    cwd: root,
    env: safeProjectEnv(options.env || process.env),
    timeoutMs: PACKAGE_TIMEOUT_MS,
    allowFailure: true,
  });
  results.push({ step: "install", command: "npm ci --ignore-scripts", ...install, passed: install.exitCode === 0 });
  if (install.exitCode === 0) {
    for (const script of ALLOWED_PACKAGE_SCRIPTS) {
      if (typeof manifest.scripts?.[script] !== "string") continue;
      const result = await runner("npm", ["run", "--silent", script], {
        cwd: root,
        env: safeProjectEnv(options.env || process.env),
        timeoutMs: PACKAGE_TIMEOUT_MS,
        allowFailure: true,
      });
      results.push({ step: script, ...result, passed: result.exitCode === 0 });
      if (result.exitCode !== 0) break;
    }
  }
  return { text: JSON.stringify({ passed: results.every(({ passed }) => passed), results }) };
}

function validateWorkflowContent(relative, content) {
  const normalized = relativeDisplay(normalizeRelative(relative));
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(normalized)) throw new Error("Workflow path must be under .github/workflows with a YAML extension.");
  if (Buffer.byteLength(content, "utf8") > MAX_WORKFLOW_BYTES) throw new Error("Workflow exceeds the fixed size limit.");
  const rejected = [
    [/\bpull_request_target\b/iu, "pull_request_target is not allowed"],
    [/\bself-hosted\b/iu, "self-hosted runners are not allowed"],
    [/permissions\s*:\s*write-all/iu, "write-all permissions are not allowed"],
    [/^\s*(?:actions|checks|contents|deployments|id-token|issues|packages|pages|pull-requests|repository-projects|security-events|statuses)\s*:\s*write\s*$/imu, "write permissions are not allowed"],
    [/\$\{\{\s*secrets\./iu, "workflow secrets are not allowed"],
    [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b/iu, "download-and-execute pipelines are not allowed"],
    [/\bsudo\b/iu, "sudo is not allowed"],
  ];
  for (const [pattern, message] of rejected) {
    if (pattern.test(content)) throw new Error(message);
  }
  if (!/^\s*(?:on|['"]on['"])\s*:/mu.test(content)) throw new Error("Workflow must declare triggers.");
  if (!/^\s*jobs\s*:/mu.test(content)) throw new Error("Workflow must declare jobs.");
  const warnings = [];
  if (!/^\s*permissions\s*:/mu.test(content)) warnings.push("Declare explicit read-only permissions.");
  return { valid: true, path: normalized, warnings };
}

async function validateGithubWorkflow(args, root) {
  assertArgs(args, ["path"], ["path"]);
  const relative = normalizeRelative(args.path);
  const target = await existingPath(root, relative, "file");
  if (target.stat.size > MAX_WORKFLOW_BYTES) throw new Error("Workflow exceeds the fixed size limit.");
  const content = await fs.readFile(target.canonical, "utf8");
  return { text: JSON.stringify(validateWorkflowContent(relative, content)) };
}

async function githubPr(root, number, options) {
  const context = await repositoryContext(root, { requireGitHub: true });
  await assertGh(root, options);
  const fields = "number,state,isDraft,mergeStateStatus,reviewDecision,headRefName,headRefOid,baseRefName,title,body,url";
  const response = await runGh(root, ["pr", "view", String(number), "--repo", context.repository.slug, "--json", fields], options);
  return { context, pr: parseJson(response.stdout, "GitHub returned malformed pull request JSON.") };
}

async function githubPrGet(args, root, options) {
  assertArgs(args, ["number"], ["number"]);
  return { text: JSON.stringify((await githubPr(root, args.number, options)).pr) };
}

async function githubPrMarkReady(args, root, options) {
  assertArgs(args, ["number", "expected_head_sha"], ["number", "expected_head_sha"]);
  const { context, pr } = await githubPr(root, args.number, options);
  if (pr.headRefOid !== args.expected_head_sha) throw new Error("Pull request head changed.");
  if (pr.state !== "OPEN") throw new Error("Pull request is not open.");
  if (pr.isDraft !== true) return { text: JSON.stringify({ ready: true, changed: false, number: pr.number, head_sha: pr.headRefOid }) };
  await runGh(root, ["pr", "ready", String(args.number), "--repo", context.repository.slug], options);
  const confirmed = (await githubPr(root, args.number, options)).pr;
  if (confirmed.isDraft !== false || confirmed.headRefOid !== args.expected_head_sha) throw new Error("GitHub did not confirm ready state.");
  return { text: JSON.stringify({ ready: true, changed: true, number: confirmed.number, head_sha: confirmed.headRefOid }) };
}

async function githubPrUpdate(args, root, options) {
  assertArgs(args, ["number", "expected_head_sha", "title", "body"], ["number", "expected_head_sha"]);
  if (args.title === undefined && args.body === undefined) throw new Error("At least one pull request field is required.");
  const { context, pr } = await githubPr(root, args.number, options);
  if (pr.headRefOid !== args.expected_head_sha) throw new Error("Pull request head changed.");
  const command = ["api", "--method", "PATCH", `repos/${context.repository.slug}/pulls/${args.number}`];
  if (args.title !== undefined) command.push("-f", `title=${args.title}`);
  if (args.body !== undefined) command.push("-f", `body=${args.body}`);
  const response = await runGh(root, command, options);
  const updated = parseJson(response.stdout, "GitHub returned malformed update JSON.");
  return { text: JSON.stringify({ number: updated.number, title: updated.title, body: updated.body, url: updated.html_url }) };
}

async function githubPrReviews(args, root, options) {
  assertArgs(args, ["number"], ["number"]);
  const context = await repositoryContext(root, { requireGitHub: true });
  await assertGh(root, options);
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision reviews(first:100){nodes{author{login} state body submittedAt url}} reviewThreads(first:100){nodes{id isResolved comments(first:20){nodes{author{login} body path line url}}}}}}}`;
  const response = await runGh(root, [
    "api", "graphql",
    "-f", `query=${query}`,
    "-F", `owner=${context.repository.owner}`,
    "-F", `name=${context.repository.name}`,
    "-F", `number=${args.number}`,
  ], options);
  const parsed = parseJson(response.stdout, "GitHub returned malformed review JSON.");
  return { text: JSON.stringify(parsed.data?.repository?.pullRequest ?? null) };
}

function checkSucceeded(item) {
  if (item?.__typename === "StatusContext") return item.state === "SUCCESS";
  return item?.status === "COMPLETED" && item?.conclusion === "SUCCESS";
}

async function githubPrChecks(args, root, options) {
  assertArgs(args, ["number"], ["number"]);
  const context = await repositoryContext(root, { requireGitHub: true });
  await assertGh(root, options);
  const fields = "number,state,isDraft,mergeStateStatus,reviewDecision,headRefOid,url,statusCheckRollup";
  const response = await runGh(root, ["pr", "view", String(args.number), "--repo", context.repository.slug, "--json", fields], options);
  const pr = parseJson(response.stdout, "GitHub returned malformed check JSON.");
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  return {
    text: JSON.stringify({
      number: pr.number,
      head_sha: pr.headRefOid,
      state: pr.state,
      draft: pr.isDraft,
      merge_state: pr.mergeStateStatus,
      review_decision: pr.reviewDecision,
      checks,
      check_count: checks.length,
      all_green: checks.length > 0 && checks.every(checkSucceeded),
      url: pr.url,
    }),
  };
}

async function githubActionsListWorkflows(args, root, options) {
  assertArgs(args, []);
  const context = await repositoryContext(root, { requireGitHub: true });
  await assertGh(root, options);
  const response = await runGh(root, ["api", `repos/${context.repository.slug}/actions/workflows?per_page=100`], options);
  const parsed = parseJson(response.stdout, "GitHub returned malformed workflow JSON.");
  return { text: JSON.stringify({ workflows: (parsed.workflows || []).map(({ id, name, path: workflowPath, state, html_url }) => ({ id, name, path: workflowPath, state, url: html_url })) }) };
}

async function githubActionsListRuns(args, root, options) {
  assertArgs(args, ["branch", "head_sha", "event", "limit"]);
  const context = await repositoryContext(root, { requireGitHub: true });
  await assertGh(root, options);
  const query = new URLSearchParams({ per_page: String(boundedInteger(args.limit, 20, 100)) });
  if (args.branch !== undefined) query.set("branch", args.branch);
  if (args.head_sha !== undefined) query.set("head_sha", args.head_sha);
  if (args.event !== undefined) query.set("event", args.event);
  const response = await runGh(root, ["api", `repos/${context.repository.slug}/actions/runs?${query}`], options);
  const parsed = parseJson(response.stdout, "GitHub returned malformed workflow-run JSON.");
  return { text: JSON.stringify({ runs: (parsed.workflow_runs || []).map(({ id, name, event, status, conclusion, head_branch, head_sha, html_url, run_attempt, created_at, updated_at }) => ({ id, name, event, status, conclusion, head_branch, head_sha, url: html_url, run_attempt, created_at, updated_at })) }) };
}

async function githubActionsGetJobs(args, root, options) {
  assertArgs(args, ["run_id"], ["run_id"]);
  const context = await repositoryContext(root, { requireGitHub: true });
  await assertGh(root, options);
  const response = await runGh(root, ["api", `repos/${context.repository.slug}/actions/runs/${args.run_id}/jobs?per_page=100`], options);
  const parsed = parseJson(response.stdout, "GitHub returned malformed job JSON.");
  return { text: JSON.stringify({ jobs: (parsed.jobs || []).map(({ id, name, status, conclusion, started_at, completed_at, html_url, steps }) => ({ id, name, status, conclusion, started_at, completed_at, url: html_url, steps })) }) };
}

function redactLogs(text, root) {
  return text
    .replaceAll(root, "[workspace]")
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu, "[redacted-token]")
    .replace(/(authorization\s*[:=]\s*)([^\s]+)/giu, "$1[redacted]")
    .replace(/((?:token|password|secret)\s*[:=]\s*)([^\s]+)/giu, "$1[redacted]");
}

async function githubActionsGetLogs(args, root, options) {
  assertArgs(args, ["job_id"], ["job_id"]);
  const context = await repositoryContext(root, { requireGitHub: true });
  await assertGh(root, options);
  const response = await runGh(root, ["run", "view", "--repo", context.repository.slug, "--job", String(args.job_id), "--log"], options);
  return { text: redactLogs(response.stdout, root) };
}

function assertWorkflowIdentifier(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 300 || value.startsWith("-") || /[\0\r\n]/u.test(value)) {
    throw new Error("Workflow identifier is invalid.");
  }
}

async function githubActionsDispatch(args, root, options) {
  assertArgs(args, ["workflow", "ref", "inputs"], ["workflow"]);
  assertWorkflowIdentifier(args.workflow);
  const context = await repositoryContext(root, { requireGitHub: true });
  if (context.branch === "main" || context.branch === "master") throw new Error("Protected branch workflow dispatch is not allowed.");
  const ref = args.ref ?? context.branch;
  if (ref !== context.branch) throw new Error("Workflow dispatch is limited to the current branch.");
  const command = ["workflow", "run", args.workflow, "--repo", context.repository.slug, "--ref", ref];
  if (args.inputs !== undefined) {
    if (!args.inputs || typeof args.inputs !== "object" || Array.isArray(args.inputs) || Object.keys(args.inputs).length > 20) throw new Error("Workflow inputs are invalid.");
    for (const [key, value] of Object.entries(args.inputs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(key) || typeof value !== "string" || value.length > 1000) throw new Error("Workflow input is invalid.");
      command.push("-f", `${key}=${value}`);
    }
  }
  await assertGh(root, options);
  await runGh(root, command, options);
  return { text: JSON.stringify({ dispatched: true, workflow: args.workflow, ref }) };
}

async function githubActionsRerunFailed(args, root, options) {
  assertArgs(args, ["run_id"], ["run_id"]);
  const context = await repositoryContext(root, { requireGitHub: true });
  await assertGh(root, options);
  const viewed = await runGh(root, ["api", `repos/${context.repository.slug}/actions/runs/${args.run_id}`], options);
  const run = parseJson(viewed.stdout, "GitHub returned malformed workflow-run JSON.");
  if (run.head_branch !== context.branch) throw new Error("Workflow run does not belong to the current branch.");
  await runGh(root, ["api", "--method", "POST", `repos/${context.repository.slug}/actions/runs/${args.run_id}/rerun-failed-jobs`], options);
  return { text: JSON.stringify({ rerun_requested: true, run_id: args.run_id, branch: context.branch }) };
}

async function githubBranchProtectionGet(args, root, options) {
  assertArgs(args, ["branch"]);
  const context = await repositoryContext(root, { requireGitHub: true });
  const branch = args.branch ?? "main";
  if (typeof branch !== "string" || branch.length === 0 || branch.length > 200 || branch.startsWith("-") || /[\0\r\n]/u.test(branch)) throw new Error("Branch is invalid.");
  await assertGh(root, options);
  const response = await runGh(root, ["api", `repos/${context.repository.slug}/branches/${encodeURIComponent(branch)}/protection`], { ...options, allowFailure: true });
  if (response.exitCode !== 0) {
    if (/404|Branch not protected/iu.test(response.stderr)) return { text: JSON.stringify({ branch, protected: false }) };
    throw new Error("GitHub branch protection lookup failed.");
  }
  return { text: JSON.stringify({ branch, protected: true, protection: parseJson(response.stdout, "GitHub returned malformed protection JSON.") }) };
}

async function assertCleanPushedBranch(root, expectedHead) {
  const context = await repositoryContext(root, { requireGitHub: true });
  if (context.branch === "main" || context.branch === "master") throw new Error("Protected branch writes are not allowed.");
  if (context.head !== expectedHead) throw new Error("Local HEAD changed.");
  const status = (await git(root, ["status", "--porcelain=v1", "-z"])).stdout;
  if (status.length !== 0) throw new Error("Workspace must be clean.");
  const upstream = await currentUpstream(root);
  if (upstream !== `origin/${context.branch}`) throw new Error("Current branch must track the same origin branch.");
  const remoteHead = (await git(root, ["rev-parse", `refs/remotes/origin/${context.branch}`])).stdout.trim();
  if (remoteHead !== expectedHead) throw new Error("Current branch must be fully pushed.");
  return context;
}

async function githubContentsWriteWorkflow(args, root, options) {
  assertArgs(args, ["path", "content", "message", "expected_head_sha", "expected_blob_sha"], ["path", "content", "message", "expected_head_sha"]);
  if (typeof args.message !== "string" || args.message.length === 0 || args.message.length > 300 || /[\r\n\0]/u.test(args.message)) throw new Error("Commit message must be one line.");
  const validation = validateWorkflowContent(args.path, args.content);
  const context = await assertCleanPushedBranch(root, args.expected_head_sha);
  await assertGh(root, options);
  const endpoint = `repos/${context.repository.slug}/contents/${validation.path.split("/").map(encodeURIComponent).join("/")}`;
  const existing = await runGh(root, ["api", `${endpoint}?ref=${encodeURIComponent(context.branch)}`], { ...options, allowFailure: true });
  let existingSha = null;
  if (existing.exitCode === 0) existingSha = parseJson(existing.stdout, "GitHub returned malformed contents JSON.").sha;
  else if (!/404|Not Found/iu.test(existing.stderr)) throw new Error("GitHub contents lookup failed.");
  if (existingSha && args.expected_blob_sha !== existingSha) throw new Error("Existing workflow SHA confirmation is required.");
  if (!existingSha && args.expected_blob_sha !== undefined) throw new Error("Workflow does not exist at the expected blob SHA.");
  const payload = {
    message: args.message,
    content: Buffer.from(args.content, "utf8").toString("base64"),
    branch: context.branch,
    ...(existingSha ? { sha: existingSha } : {}),
  };
  const updated = await runGh(root, ["api", "--method", "PUT", endpoint, "--input", "-"], { ...options, input: JSON.stringify(payload) });
  const parsed = parseJson(updated.stdout, "GitHub returned malformed contents-write JSON.");
  return { text: JSON.stringify({ written: true, path: validation.path, branch: context.branch, commit_sha: parsed.commit?.sha ?? null, content_sha: parsed.content?.sha ?? null, local_requires_fetch: true }) };
}

export async function handleControlledEngineeringTool(name, args = {}, root, options = {}) {
  if (!isControlledEngineeringTool(name)) throw new Error(`Unsupported controlled engineering tool: ${name}`);
  const env = options.env || process.env;
  assertCapability(env);
  const canonical = await canonicalWorkspace(root);

  if (name === "create_directory") return createDirectory(args, canonical);
  if (name === "path_stat") return pathStat(args, canonical);
  if (name === "search_text") return searchText(args, canonical);
  if (name === "find_files") return findFiles(args, canonical);
  if (name === "move_path") return movePath(args, canonical);
  if (name === "delete_file") return deleteFile(args, canonical);
  if (name === "delete_empty_directory") return deleteEmptyDirectory(args, canonical);
  if (name === "git_context") return gitContext(args, canonical);
  if (name === "git_log") return gitLog(args, canonical);
  if (name === "git_show") return gitShow(args, canonical);
  if (name === "git_diff_refs") return gitDiffRefs(args, canonical);
  if (name === "git_fetch_ref") return gitFetchRef(args, canonical);
  if (name === "git_upstream_status") return gitUpstreamStatus(args, canonical);
  if (name === "install_dependencies") return installDependencies(args, canonical, options);
  if (name === "run_package_script") return runPackageScript(args, canonical, options);
  if (name === "run_project_validation") return runProjectValidation(args, canonical, options);
  if (name === "validate_github_workflow") return validateGithubWorkflow(args, canonical);
  if (name === "github_pr_get") return githubPrGet(args, canonical, options);
  if (name === "github_pr_mark_ready") return githubPrMarkReady(args, canonical, options);
  if (name === "github_pr_update") return githubPrUpdate(args, canonical, options);
  if (name === "github_pr_reviews") return githubPrReviews(args, canonical, options);
  if (name === "github_pr_checks") return githubPrChecks(args, canonical, options);
  if (name === "github_actions_list_workflows") return githubActionsListWorkflows(args, canonical, options);
  if (name === "github_actions_list_runs") return githubActionsListRuns(args, canonical, options);
  if (name === "github_actions_get_jobs") return githubActionsGetJobs(args, canonical, options);
  if (name === "github_actions_get_logs") return githubActionsGetLogs(args, canonical, options);
  if (name === "github_actions_dispatch") return githubActionsDispatch(args, canonical, options);
  if (name === "github_actions_rerun_failed") return githubActionsRerunFailed(args, canonical, options);
  if (name === "github_branch_protection_get") return githubBranchProtectionGet(args, canonical, options);
  if (name === "github_contents_write_workflow") return githubContentsWriteWorkflow(args, canonical, options);
  throw new Error(`Unsupported controlled engineering tool: ${name}`);
}
