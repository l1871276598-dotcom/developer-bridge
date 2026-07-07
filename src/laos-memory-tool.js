import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_TASK_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 120_000;
const ALLOWED_TASK_TYPES = new Set([
  "handoff.write",
  "memory.create",
  "memory.search",
  "memory.review",
  "context.build",
  "loop.reflect",
  "loop.suggest-policies",
  "loop.generate-candidate",
  "loop.coordinate",
  "reflection.prepare",
  "reflection.apply",
  "reflection.record",
]);

export class LaosMemoryToolError extends Error {
  constructor(code, detail) {
    super(detail?.message || "LAOS task failed");
    this.name = "LaosMemoryToolError";
    this.code = code;
    this.detail = detail || null;
  }
}

export const LAOS_MEMORY_TOOL_DEFINITION = Object.freeze({
  name: "laos_memory_task",
  description: "Run one allowlisted LAOS JSON task against the configured external memory data root while retaining the Git code workspace.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...ALLOWED_TASK_TYPES] },
          workspace: { type: "string", enum: ["personal", "work"] },
          input: { type: "object" },
        },
        required: ["type", "input"],
        additionalProperties: false,
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
});

function fail(code, detail) {
  throw new LaosMemoryToolError(code, detail);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function overlaps(left, right) {
  return isContained(left, right) || isContained(right, left);
}

async function canonicalDirectory(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) ||
    !path.isAbsolute(value)
  ) {
    throw new Error(`${label} must be an absolute local directory`);
  }
  const lexical = path.resolve(value);
  const lexicalStat = await lstat(lexical).catch(() => null);
  if (!lexicalStat?.isDirectory() || lexicalStat.isSymbolicLink()) {
    throw new Error(`${label} must identify a real directory`);
  }
  const canonical = await realpath(lexical);
  if (canonical !== lexical || !(await stat(canonical)).isDirectory()) {
    throw new Error(`${label} cannot traverse a symbolic link`);
  }
  return canonical;
}

async function resolveCli(codeRoot) {
  const cli = path.join(codeRoot, "src", "laos.py");
  const lexicalStat = await lstat(cli).catch(() => null);
  if (!lexicalStat?.isFile() || lexicalStat.isSymbolicLink() || lexicalStat.nlink !== 1) {
    throw new Error("The authorized workspace does not contain a safe LAOS CLI");
  }
  const canonical = await realpath(cli);
  if (!isContained(codeRoot, canonical) || canonical !== cli) {
    throw new Error("The LAOS CLI escapes the authorized workspace");
  }
  return cli;
}

async function requireDataRoot(dataRoot) {
  const marker = path.join(dataRoot, ".research-agent-root");
  const markerStat = await lstat(marker).catch(() => null);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
    throw new Error("LAOS_DATA_ROOT is not an initialized ResearchAgent data root");
  }
  const canonical = await realpath(marker);
  if (!isContained(dataRoot, canonical) || canonical !== marker) {
    throw new Error("LAOS_DATA_ROOT is not an initialized ResearchAgent data root");
  }
}

function requireSeparatedRoots(runtimeRoot, codeRoot, dataRoot, stateDir) {
  const roots = [runtimeRoot, codeRoot, dataRoot, stateDir];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (overlaps(roots[left], roots[right])) {
        throw new Error("Developer Bridge runtime, LAOS code, data and state directories must be separate");
      }
    }
  }
}

function normalizeTask(args) {
  if (!isPlainObject(args) || Object.keys(args).some((key) => key !== "task")) {
    fail("invalid_laos_task");
  }
  const task = args.task;
  if (!isPlainObject(task)) fail("invalid_laos_task");
  const keys = Object.keys(task);
  if (keys.some((key) => !["type", "workspace", "input"].includes(key))) {
    fail("invalid_laos_task");
  }
  if (!ALLOWED_TASK_TYPES.has(task.type)) fail("invalid_laos_task");
  if (task.workspace !== undefined && !["personal", "work"].includes(task.workspace)) {
    fail("invalid_laos_task");
  }
  if (!isPlainObject(task.input)) fail("invalid_laos_task");
  const encoded = JSON.stringify(task);
  if (Buffer.byteLength(encoded, "utf8") > MAX_TASK_BYTES) fail("invalid_laos_task");
  return encoded;
}

function safeEnvironment(env) {
  const safe = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"]) {
    if (typeof env[key] === "string") safe[key] = env[key];
  }
  safe.PYTHONUTF8 = "1";
  return safe;
}

function runFixed(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    let settled = false;
    let timer;

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
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.once("error", () => finish(new LaosMemoryToolError("laos_command_unavailable")));
    child.once("close", (exitCode, signal) => finish(null, {
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      outputLimitExceeded,
      timedOut,
    }));

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, TIMEOUT_MS);
    timer.unref();
  });
}

function cliErrorDetail(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return null;
  try {
    const parsed = JSON.parse(stderr.trim());
    if (parsed?.error) {
      const code = typeof parsed.error.code === "string" ? parsed.error.code : "request_failed";
      return { code, message: parsed.error.message || "LAOS task failed", stage: parsed.error.stage };
    }
  } catch {}
  return null;
}

function redact(value, roots) {
  if (typeof value === "string") {
    return roots.reduce((text, [root, replacement]) => text.replaceAll(root, replacement), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, roots));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, roots)]));
  }
  return value;
}

export async function createLaosMemoryTool(env, getCodeRoot, options = {}) {
  const dataConfigured = typeof env.LAOS_DATA_ROOT === "string" && env.LAOS_DATA_ROOT.length > 0;
  const stateConfigured = typeof env.LAOS_STATE_DIR === "string" && env.LAOS_STATE_DIR.length > 0;
  if (!dataConfigured && !stateConfigured) return null;
  if (!dataConfigured || !stateConfigured) {
    throw new Error("LAOS_DATA_ROOT and LAOS_STATE_DIR must be configured together");
  }
  if (typeof getCodeRoot !== "function") throw new Error("LAOS code root resolver is required");

  const dataRoot = await canonicalDirectory(env.LAOS_DATA_ROOT, "LAOS_DATA_ROOT");
  const stateDir = await canonicalDirectory(env.LAOS_STATE_DIR, "LAOS_STATE_DIR");
  await requireDataRoot(dataRoot);
  if (overlaps(dataRoot, stateDir)) throw new Error("LAOS data and state directories must not overlap");
  const runtimeRoot = await canonicalDirectory(path.resolve(import.meta.dirname, ".."), "Developer Bridge runtime");
  const initialCodeRoot = await canonicalDirectory(getCodeRoot(), "Authorized workspace");
  requireSeparatedRoots(runtimeRoot, initialCodeRoot, dataRoot, stateDir);
  await resolveCli(initialCodeRoot);
  const runner = options.runCommand || runFixed;

  return Object.freeze({
    definition: LAOS_MEMORY_TOOL_DEFINITION,
    async call(args) {
      const taskJson = normalizeTask(args);
      const codeRoot = await canonicalDirectory(getCodeRoot(), "Authorized workspace");
      requireSeparatedRoots(runtimeRoot, codeRoot, dataRoot, stateDir);
      const cli = await resolveCli(codeRoot);
      const result = await runner(
        process.platform === "win32" ? "python" : "python3",
        [cli, "--root", dataRoot, "--state-dir", stateDir, "--task-json", taskJson],
        { cwd: codeRoot, env: safeEnvironment(env), timeoutMs: TIMEOUT_MS },
      );
      if (result?.timedOut === true) fail("laos_task_timeout");
      if (result?.outputLimitExceeded === true) fail("laos_output_limit_exceeded");
      if (result?.exitCode !== 0) {
        const detail = cliErrorDetail(result?.stderr);
        if (detail) fail(detail.code, detail);
        fail("request_failed");
      }
      if (typeof result?.stdout !== "string") fail("laos_malformed_response");

      let payload;
      try {
        payload = JSON.parse(result.stdout.trim());
      } catch {
        fail("laos_malformed_response");
      }
      return {
        text: JSON.stringify(redact(payload, [
          [codeRoot, "[workspace]"],
          [dataRoot, "[laos-data]"],
          [stateDir, "[laos-state]"],
        ])),
      };
    },
  });
}
