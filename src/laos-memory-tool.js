import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_TASK_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 120_000;
const ALLOWED_TASK_TYPES = new Set([
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

function normalizeTask(args) {
  if (!isPlainObject(args) || Object.keys(args).some((key) => key !== "task")) {
    throw new Error("Arguments must contain only task");
  }
  const task = args.task;
  if (!isPlainObject(task)) throw new Error("task must be an object");
  const keys = Object.keys(task);
  if (keys.some((key) => !["type", "workspace", "input"].includes(key))) {
    throw new Error("task contains an unsupported field");
  }
  if (!ALLOWED_TASK_TYPES.has(task.type)) throw new Error("LAOS task type is not allowlisted");
  if (task.workspace !== undefined && !["personal", "work"].includes(task.workspace)) {
    throw new Error("LAOS workspace is invalid");
  }
  if (!isPlainObject(task.input)) throw new Error("LAOS task input must be an object");
  const encoded = JSON.stringify(task);
  if (Buffer.byteLength(encoded, "utf8") > MAX_TASK_BYTES) throw new Error("LAOS task exceeds the fixed size limit");
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
    child.once("error", () => finish(new Error("LAOS command could not be started")));
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
  if (overlaps(dataRoot, stateDir)) throw new Error("LAOS data and state directories must not overlap");
  const runner = options.runCommand || runFixed;

  return Object.freeze({
    definition: LAOS_MEMORY_TOOL_DEFINITION,
    async call(args) {
      const taskJson = normalizeTask(args);
      const codeRoot = await canonicalDirectory(getCodeRoot(), "Authorized workspace");
      if (overlaps(codeRoot, dataRoot) || overlaps(codeRoot, stateDir)) {
        throw new Error("LAOS code, data and state directories must be separate");
      }
      const cli = await resolveCli(codeRoot);
      const result = await runner(
        process.platform === "win32" ? "python" : "python3",
        [cli, "--root", dataRoot, "--state-dir", stateDir, "--task-json", taskJson],
        { cwd: codeRoot, env: safeEnvironment(env), timeoutMs: TIMEOUT_MS },
      );
      if (
        result?.exitCode !== 0 ||
        result?.timedOut === true ||
        result?.outputLimitExceeded === true ||
        typeof result?.stdout !== "string"
      ) {
        throw new Error("LAOS task failed");
      }
      let payload;
      try {
        payload = JSON.parse(result.stdout.trim());
      } catch {
        throw new Error("LAOS returned malformed JSON");
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
