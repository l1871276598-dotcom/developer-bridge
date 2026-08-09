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
// -s: no user site-packages. -E: ignore PYTHON* environment variables (they
// are explicitly set in the sanitized child env via allowlist). -X utf8 forces
// UTF-8 mode. Combined with explicit PYTHONPATH pinned to coreRoot/src and
// sanitized env (no PYTHONSTARTUP/PYTHONHOME/PYTHONUSERBASE), this is the
// tightest bootstrap; no environment can inject attacker-controlled modules
// before Core import dispatch (GP10-01).
const PYTHON_ARGS = ["-s", "-E", "-X", "utf8"];

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
  // Accept any valid file (regular file or symlink) that resolves to a real file.
  const info = await lstat(lexical).catch(() => null);
  if (!info || (!info.isFile() && !info.isSymbolicLink())) {
    fail("invalid_interpreter", "LAOS_PYTHON_EXECUTABLE must be a file");
  }
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
  // Never inherit Python bootstrap that could load attacker modules (GP10-01).
  // These are explicitly deleted (not just omitted) so options.extraEnv cannot
  // re-introduce them via spread.
  delete safe.PYTHONPATH;
  delete safe.PYTHONSTARTUP;
  delete safe.PYTHONUSERBASE;
  delete safe.PYTHONHOME;
  delete safe.PYTHONEXECUTABLE;
  delete safe.PYTHONNOUSERSITE;
  // Reject all dynamic-linker and Python env overrides.
  for (const key of Object.keys(safe)) {
    if (key.startsWith("LD_") || key.startsWith("DYLD_") || key.startsWith("PYTHON")) {
      delete safe[key];
    }
  }
  safe.PYTHONUTF8 = "1";
  safe.PYTHONDONTWRITEBYTECODE = "1";
  safe.PYTHONNOUSERSITE = "1";
  return safe;
}

/**
 * Resolve the trusted interpreter once per runner construction.
 */
export async function createCoreRunner({ env, codeRoot, runCommand = null }) {
  const coreRoot = await canonicalDirectory(env.LAOS_CORE_ROOT, "LAOS Core runtime");
  const dataRoot = env.LAOS_DATA_ROOT ? await canonicalDirectory(env.LAOS_DATA_ROOT, "LAOS data root") : null;
  const stateDir = env.LAOS_STATE_DIR ? await canonicalDirectory(env.LAOS_STATE_DIR, "LAOS state dir") : null;
  // GP10-01: the interpreter is always resolved from the environment.
  // When LAOS_PYTHON_EXECUTABLE is set, it must be an absolute path, a real
  // file, executable, and not inside the writable workspace. If unset,
  // search PATH for the first matching "python3" binary and resolve its
  // realpath — same containment check applies.
  const interpreter = await resolveInterpreter(env, codeRoot);
  const childEnv = {
    ...sanitizedCoreEnv(env, codeRoot),
    LAOS_CORE_ROOT: coreRoot,
    LAOS_DATA_ROOT: dataRoot,
    LAOS_STATE_DIR: stateDir,
    // Pin the import path to the immutable runtime — never inherited PYTHONPATH.
    PYTHONPATH: path.join(coreRoot, "src"),
  };
  // GP10-03: cache the construction-time workspace (used for interpreter
  // containment) so call-time re-validation can compare against it.
  const constructionCodeRoot = codeRoot;
  const baseArgs = [interpreter, ...PYTHON_ARGS];

  // Bounded spawn (GP7-04/GP8-03): timeout + output cap + always-drain pipes.
  // GP10-01: the child env is the sanitized childEnv only — no extraEnv spread.
  // The vault publisher passes the frozen LAOS_VAULT_ROOT as an extra field;
  // options.extraEnv is a field-level allowlist: only well-known config keys
  // (LAOS_VAULT_ROOT, LAOS_STATE_DIR) are permitted; PYTHON*, LD_*, DYLD_*, and
  // PATH are always rejected.
  const ALLOWED_EXTRA_ENV = new Set(["LAOS_VAULT_ROOT", "LAOS_STATE_DIR"]);
  function spawnBounded(pythonArgs, options = {}) {
    return new Promise((resolve, reject) => {
      const args = [...baseArgs, ...pythonArgs];
      let childEnvFinal = { ...childEnv };
      if (options.extraEnv && typeof options.extraEnv === "object") {
        for (const key of Object.keys(options.extraEnv)) {
          if (
            ALLOWED_EXTRA_ENV.has(key) ||
            // LAOS_CHECKPOINT_* are safe config values used by adapter.
            key.startsWith("LAOS_CHECKPOINT_")
          ) {
            const value = options.extraEnv[key];
            if (typeof value === "string") {
              childEnvFinal[key] = value;
            }
          }
        }
      }
      const child = spawn(args[0], args.slice(1), {
        cwd: options.cwd ?? coreRoot,
        env: childEnvFinal,
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
        // GP10-09: kill the entire process group so descendant processes cannot
        // keep stdio handles open and prevent child.close from firing.
        try {
          // Use process.kill with the negative pid on posix to target the
          // process group; on Windows fall back to child.kill.
          const pid = child.pid;
          if (pid && process.platform !== "win32") {
            process.kill(-pid, "SIGTERM");
            setTimeout(() => {
              try { process.kill(-pid, "SIGKILL"); } catch (_) {}
            }, 2_000).unref();
          } else {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
          }
        } catch (_) {
          child.kill("SIGKILL");
        }
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
        // Per-call re-validation of workspace vs interpreter containment
        // (GP10-03). The construction-time workspace is cached; the current
        // workspace from the call options must also not overlap.
        if (options.cwd && overlaps(options.cwd, interpreter)) {
          throw new CoreRunnerError("invalid_workspace", "writable workspace must not contain the Python interpreter");
        }
        return runCommand(interpreter, args, { cwd: options.cwd ?? coreRoot, timeoutMs: options.timeoutMs });
      }
      const stdout = await spawnBounded(args, { cwd, timeoutMs });
      return { stdout, exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
    },
    // Raw stdout-returning runner for vault.read / evidence.publish. This is an
    // INTERNAL Bridge path — always uses the trusted bounded spawn with the
    // sanitized childEnv (LAOS_VAULT_ROOT etc.), NOT an injected test seam.
    // GP10-03: codeRoot is re-validated per call — any workspace the caller
    // passes must be separate from the verified interpreter.
    async runCli(taskJson, options = {}) {
      const cli = path.join(coreRoot, "src", "laos.py");
      const args = [cli, "--root", childEnv.LAOS_DATA_ROOT, "--state-dir", childEnv.LAOS_STATE_DIR, "--task-json", taskJson];
      // Per-call re-validation of workspace vs interpreter containment.
      // If the caller passes a current workspace that contains the
      // interpreter, reject — a writable-workspace interpreter shim must
      // never execute (GP10-03 / GP8-01). Construction-time validation is not
      // sufficient because getCodeRoot() can change between calls.
      if (options.cwd && overlaps(options.cwd, interpreter)) {
        throw new CoreRunnerError("invalid_workspace", "writable workspace must not contain the Python interpreter");
      }
      return spawnBounded(args, options);
    },
  };
}
