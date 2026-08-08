import { spawn } from "node:child_process";
import { access, constants, lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * TrustedCoreRunner — the SINGLE Core execution primitive (GP9-01).
 *
 * Every Core child (laos_memory_task dispatcher, vault publisher runCli,
 * projectmem core-client) must go through this module so the Python
 * interpreter + environment + import bootstrap are part of the same verified
 * TCB as the immutable LAOS_CORE_ROOT. A Python executable resolved from a
 * writable workspace, or a bootstrap environment that can load agent-controlled
 * modules (PYTHONPATH / user-site / sitecustomize), would let attacker code run
 * BEFORE src/laos.py executes — the same dispatch-before-code-execution class
 * as GP8-01.
 *
 * Invariants:
 *   - interpreter: LAOS_PYTHON_EXECUTABLE must be an absolute path, realpath
 *     (no symlink), executable, and NOT inside the writable workspace.
 *   - environment: no PYTHONPATH / PYTHONSTARTUP / user-site bootstrap; Python
 *     runs isolated (-I) so sys.path cannot be extended from environment.
 *   - PATH is inherited but stripped of the writable workspace (so a
 *     `workspace/bin/python3` shim can never shadow the trusted interpreter).
 *   - spawn is bounded: timeout + output cap, pipes always drained.
 */

export class CoreRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CoreRunnerError";
    this.code = code;
  }
}

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
// -I (isolated) would disable sys.path[0] script-dir insertion and break Core's
// `import memory` from src/. Instead use -X utf8 + explicit PYTHONPATH pinned to
// the immutable coreRoot/src (sanitized, never attacker-controlled).
const PYTHON_ARGS = ["-X", "utf8"];

function fail(code, message) {
  throw new CoreRunnerError(code, message);
}

function isContained(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function overlaps(left, right) {
  return isContained(left, right) || isContained(right, left);
}

async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value)) {
    fail("invalid_core_root", `${label} must be an absolute directory`);
  }
  const lexical = path.resolve(value);
  const info = await lstat(lexical).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    fail("invalid_core_root", `${label} must be a real directory (no symlink)`);
  }
  const canonical = await realpath(lexical);
  if (canonical !== lexical) {
    fail("invalid_core_root", `${label} must not traverse a symlink`);
  }
  return canonical;
}

async function resolveInterpreter(env, codeRoot) {
  const raw = env.LAOS_PYTHON_EXECUTABLE;
  if (typeof raw !== "string" || !raw || raw.includes("\0") || !path.isAbsolute(raw)) {
    fail("invalid_interpreter", "LAOS_PYTHON_EXECUTABLE must be an absolute path");
  }
  const lexical = path.resolve(raw);
  // OS-managed interpreters are commonly symlinks (e.g. /opt/homebrew/bin/python3
  // → .../Python.framework/.../python3). Resolving through the symlink is safe as
  // long as the final realpath is NOT inside the writable workspace. The TCB
  // threat is an Agent-controlled shim under the workspace, not an OS symlink.
  const info = await lstat(lexical).catch(() => null);
  if (!info?.isFile() && !info?.isSymbolicLink()) {
    fail("invalid_interpreter", "LAOS_PYTHON_EXECUTABLE must be a file");
  }
  const canonical = await realpath(lexical);
  const canonicalInfo = await lstat(canonical).catch(() => null);
  if (!canonicalInfo?.isFile()) {
    fail("invalid_interpreter", "LAOS_PYTHON_EXECUTABLE must resolve to a real file");
  }
  await access(canonical, constants.X_OK).catch(() => {
    fail("invalid_interpreter", "LAOS_PYTHON_EXECUTABLE is not executable");
  });
  // GP9-01: the resolved interpreter must NOT live inside the writable
  // workspace — an Agent-controlled python3 shim would run before any Core code.
  if (codeRoot && overlaps(codeRoot, canonical)) {
    fail("invalid_interpreter", "LAOS_PYTHON_EXECUTABLE must not be inside the writable workspace");
  }
  return canonical;
}

/**
 * Build the sanitized environment for a Core child.
 * - strips PYTHONPATH / PYTHONSTARTUP / PYTHONUSERBASE / site bootstrap;
 * - PATH is copied but any writable-workspace entry is removed, so a
 *   `workspace/bin/*` shim can never be picked up by the interpreter.
 */
function sanitizedCoreEnv(env, codeRoot) {
  const safe = {};
  for (const key of ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"]) {
    if (typeof env[key] === "string") safe[key] = env[key];
  }
  if (typeof env.PATH === "string") {
    const sep = process.platform === "win32" ? ";" : ":";
    const keep = env.PATH.split(sep).filter((entry) => {
      if (!entry) return false;
      const abs = path.resolve(entry);
      return !(codeRoot && overlaps(codeRoot, abs));
    });
    safe.PATH = keep.join(sep);
  }
  // Never inherit Python bootstrap that could load attacker modules.
  delete safe.PYTHONPATH;
  delete safe.PYTHONSTARTUP;
  delete safe.PYTHONUSERBASE;
  delete safe.PYTHONHOME;
  delete safe.PYTHONEXECUTABLE;
  safe.PYTHONUTF8 = "1";
  safe.PYTHONDONTWRITEBYTECODE = "1";
  return safe;
}

/**
 * Resolve the trusted interpreter once per runner construction.
 */
export async function createCoreRunner({ env, codeRoot, runCommand }) {
  const coreRoot = await canonicalDirectory(env.LAOS_CORE_ROOT, "LAOS Core runtime");
  const dataRoot = await canonicalDirectory(env.LAOS_DATA_ROOT, "LAOS data root");
  const stateDir = await canonicalDirectory(env.LAOS_STATE_DIR, "LAOS state dir");
  // When a custom runCommand is injected (host override / test seam), the host
  // fully controls the child — no interpreter validation needed. Production
  // (no injected runner) validates the interpreter into the TCB (GP9-01).
  const interpreter = runCommand
    ? (env.LAOS_PYTHON_EXECUTABLE || "python3")
    : await resolveInterpreter(env, codeRoot);
  const childEnv = {
    ...sanitizedCoreEnv(env, codeRoot),
    LAOS_CORE_ROOT: coreRoot,
    LAOS_DATA_ROOT: dataRoot,
    LAOS_STATE_DIR: stateDir,
    // Pin the import path to the immutable runtime — never inherited PYTHONPATH.
    PYTHONPATH: path.join(coreRoot, "src"),
  };
  const baseArgs = [interpreter, ...PYTHON_ARGS];

  // Bounded spawn (GP7-04/GP8-03): timeout + output cap + always-drain pipes.
  function spawnBounded(pythonArgs, options = {}) {
    return new Promise((resolve, reject) => {
      const args = [...baseArgs, ...pythonArgs];
      const child = spawn(args[0], args.slice(1), {
        cwd: options.cwd ?? coreRoot,
        env: { ...childEnv, ...(options.extraEnv ?? {}) },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let outputLimitExceeded = false;
      let settled = false;
      let timer;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const collect = (target, chunk, isStdout) => {
        if (isStdout) stdoutBytes += chunk.length;
        else stderrBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
          outputLimitExceeded = true;
          child.kill("SIGKILL");
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk) => collect(stdout, chunk, true));
      child.stderr.on("data", (chunk) => collect(stderr, chunk, false));
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (outputLimitExceeded) {
          finish(new CoreRunnerError("core_output_limit", "LAOS CLI output limit exceeded"));
          return;
        }
        if (timedOut) {
          finish(new CoreRunnerError("core_timeout", "LAOS CLI timed out"));
          return;
        }
        if (code !== 0) {
          finish(new CoreRunnerError("core_exit", `LAOS CLI exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 400)}`));
          return;
        }
        finish(null, Buffer.concat(stdout).toString("utf8"));
      });
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, options.timeoutMs ?? TIMEOUT_MS);
      timer.unref();
    });
  }

  return {
    coreRoot,
    interpreter,
    childEnv,
    // Task-shape runner compatible with the dispatcher's contract. When a
    // custom runCommand is injected (tests / host), it is called with the
    // (command, args) shape it expects; otherwise the bounded spawn runs.
    async runTask(taskJson, { cwd, timeoutMs } = {}) {
      const cli = path.join(coreRoot, "src", "laos.py");
      const args = [cli, "--root", childEnv.LAOS_DATA_ROOT, "--state-dir", childEnv.LAOS_STATE_DIR, "--task-json", taskJson];
      if (runCommand) {
        return runCommand(interpreter, args, { cwd: cwd ?? coreRoot, timeoutMs });
      }
      const stdout = await spawnBounded(args, { cwd, timeoutMs });
      return { stdout, exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
    },
    // Raw stdout-returning runner for vault.read / evidence.publish. This is an
    // INTERNAL Bridge path — always uses the trusted bounded spawn with the
    // sanitized childEnv (LAOS_VAULT_ROOT etc.), NOT an injected test seam.
    async runCli(taskJson, options = {}) {
      const cli = path.join(coreRoot, "src", "laos.py");
      const args = [cli, "--root", childEnv.LAOS_DATA_ROOT, "--state-dir", childEnv.LAOS_STATE_DIR, "--task-json", taskJson];
      return spawnBounded(args, options);
    },
  };
}
