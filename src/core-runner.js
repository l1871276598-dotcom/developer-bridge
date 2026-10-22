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
const TERMINATION_GRACE_MS = 250;
const PROCESS_TREE_EXIT_WATCHDOG_MS = 500;
const PROCESS_TREE_EXIT_POLL_MS = 10;
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
  const baseArgs = [interpreter, ...PYTHON_ARGS];

  // Both public runner shapes accept the same execution binding. The caller's
  // current workspace is an identity used for per-call interpreter isolation;
  // Core itself always runs from this runner's immutable canonical coreRoot.
  // Keep all physical-path checks here so runTask and runCli cannot drift.
  async function validateExecutionOptions(options) {
    if (!options || typeof options !== "object" || Array.isArray(options)
      || !Object.hasOwn(options, "workspace") || !Object.hasOwn(options, "cwd")) {
      fail("invalid_workspace", "writable workspace and immutable Core cwd must be explicit own properties");
    }
    const { workspace, cwd } = options;
    if (typeof workspace !== "string" || !workspace || workspace.includes("\0") || !path.isAbsolute(workspace)) {
      fail("invalid_workspace", "writable workspace must be an absolute path");
    }
    const lexicalWorkspace = path.resolve(workspace);
    if (lexicalWorkspace !== workspace) {
      fail("invalid_workspace", "writable workspace must already be canonical");
    }
    const workspaceInfo = await lstat(lexicalWorkspace).catch(() => null);
    if (!workspaceInfo?.isDirectory() || workspaceInfo.isSymbolicLink()) {
      fail("invalid_workspace", "writable workspace must be a real directory (no symlink)");
    }
    const canonicalWorkspace = await realpath(lexicalWorkspace).catch(() => null);
    if (canonicalWorkspace !== lexicalWorkspace) {
      fail("invalid_workspace", "writable workspace must not traverse a symlink");
    }
    if (overlaps(canonicalWorkspace, interpreter)) {
      fail("invalid_workspace", "writable workspace must not contain the Python interpreter");
    }
    if (typeof cwd !== "string" || !cwd || cwd !== coreRoot) {
      fail("invalid_cwd", "Core cwd must equal this runner's canonical Core root");
    }
    return options;
  }

  // Bounded spawn (GP7-04/GP8-03): timeout + output cap + always-drain pipes.
  // On POSIX, detached spawn creates a new session/process group whose leader
  // is the child pid. That makes negative-pid signalling an actual tree kill,
  // instead of merely assuming an unrelated process group exists (GP13-01).
  // GP10-01: the child env is the sanitized childEnv only — no extraEnv spread.
  // The vault publisher passes the frozen LAOS_VAULT_ROOT as an extra field;
  // options.extraEnv is a field-level allowlist: only well-known config keys
  // (LAOS_VAULT_ROOT, LAOS_STATE_DIR) are permitted; PYTHON*, LD_*, DYLD_*, and
  // PATH are always rejected.
  const ALLOWED_EXTRA_ENV = new Set(["LAOS_VAULT_ROOT", "LAOS_STATE_DIR"]);
  function spawnBounded(pythonArgs, options = {}) {
    // Node has no dependency-free, awaitable tree-reaping primitive on Windows.
    // Do not claim taskkill's fire-and-forget result as process-tree cleanup.
    if (process.platform === "win32") {
      fail("unsupported_platform", "LAOS Core runner requires POSIX process-group termination");
    }
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
        cwd: options.cwd,
        env: childEnvFinal,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let discardOutput = false;
      let terminal = null;
      let timeoutTimer;
      let escalationTimer;
      let treeExitTimer;
      let treeExitDeadline = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(escalationTimer);
        clearTimeout(treeExitTimer);
        // A descendant that retained a pipe must not keep a referenced handle
        // alive after the bounded terminal result has been settled.
        try { child.stdout.destroy(); } catch (_) {}
        try { child.stderr.destroy(); } catch (_) {}
        if (terminal.error) reject(terminal.error);
        else resolve(terminal.value);
      };

      const processGroupExists = () => {
        const pid = child.pid;
        if (!pid) return false;
        try {
          process.kill(-pid, 0);
          return true;
        } catch (error) {
          // ESRCH proves the group is gone. Treat every other failure as live
          // so a permission/race anomaly cannot be mistaken for cleanup.
          return error?.code !== "ESRCH";
        }
      };

      const signalProcessGroup = (signal) => {
        const pid = child.pid;
        if (!pid) return;
        try {
          // This is safe because the POSIX spawn above created a session with
          // the child as process-group leader.
          process.kill(-pid, signal);
        } catch (_) {
          // A concurrent leader exit can make the group disappear between the
          // liveness probe and signal delivery. Direct-child fallback only
          // covers that race; it is never the normal tree strategy.
          try { child.kill(signal); } catch (_) {}
        }
      };

      const waitForProcessGroupExit = () => {
        if (!processGroupExists()) {
          finish();
          return;
        }
        if (Date.now() >= treeExitDeadline) {
          // SIGKILL should make this unreachable for a descendant that stayed
          // in the detached group. Do not resolve a normal result or report a
          // timeout/output/exit outcome as clean when the tree still answers
          // a liveness probe: that would be a false completion claim.
          terminal = {
            error: new CoreRunnerError("core_termination_failed", "LAOS CLI process tree termination could not be verified"),
            value: undefined,
          };
          finish();
          return;
        }
        treeExitTimer = setTimeout(waitForProcessGroupExit, PROCESS_TREE_EXIT_POLL_MS);
      };

      const beginProcessTreeCleanup = () => {
        if (!processGroupExists()) {
          finish();
          return;
        }
        signalProcessGroup("SIGTERM");
        escalationTimer = setTimeout(() => {
          // Always make the bounded TERM -> KILL escalation, including after
          // a normal direct-child close. The liveness poll avoids claiming the
          // terminal result while a redirected-stdio descendant still exists.
          signalProcessGroup("SIGKILL");
          treeExitDeadline = Date.now() + PROCESS_TREE_EXIT_WATCHDOG_MS;
          waitForProcessGroupExit();
        }, TERMINATION_GRACE_MS);
        // These timers deliberately remain referenced. Once cleanup has
        // begun, a bare CLI caller may have no other live handles after the
        // direct child exits; unref'ing them could let Node exit before the
        // mandatory escalation and tree check run.
      };

      const beginTerminal = (error, value) => {
        if (terminal) return;
        terminal = { error, value };
        // Continue draining pipe events but never buffer output after a cap,
        // timeout, spawn error, or normal close; cleanup owns settlement now.
        discardOutput = true;
        clearTimeout(timeoutTimer);
        beginProcessTreeCleanup();
      };

      const collect = (target, chunk, isStdout) => {
        if (discardOutput) return;
        if (isStdout) stdoutBytes += chunk.length;
        else stderrBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
          beginTerminal(new CoreRunnerError("core_output_limit", "LAOS CLI output limit exceeded"));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk) => collect(stdout, chunk, true));
      child.stderr.on("data", (chunk) => collect(stderr, chunk, false));
      child.once("error", (error) => {
        beginTerminal(error);
      });
      child.once("close", (code) => {
        if (terminal) return;
        if (code !== 0) {
          beginTerminal(new CoreRunnerError("core_exit", "LAOS CLI exited " + code + ": " + Buffer.concat(stderr).toString("utf8").slice(0, 400)));
          return;
        }
        beginTerminal(null, Buffer.concat(stdout).toString("utf8"));
      });
      timeoutTimer = setTimeout(() => {
        beginTerminal(new CoreRunnerError("core_timeout", "LAOS CLI timed out"));
      }, options.timeoutMs ?? TIMEOUT_MS);
      timeoutTimer.unref();
    });
  }

  return {
    coreRoot,
    interpreter,
    childEnv,
    // Task-shape runner compatible with the dispatcher's contract. When a
    // custom runCommand is injected (tests / host), it is called with the
    // (command, args) shape it expects; otherwise the bounded spawn runs.
    async runTask(taskJson, options = {}) {
      const execution = await validateExecutionOptions(options);
      const cli = path.join(coreRoot, "src", "laos.py");
      const args = [cli, "--root", childEnv.LAOS_DATA_ROOT, "--state-dir", childEnv.LAOS_STATE_DIR, "--task-json", taskJson];
      if (runCommand) {
        return runCommand(interpreter, args, { cwd: execution.cwd, timeoutMs: execution.timeoutMs });
      }
      const stdout = await spawnBounded(args, execution);
      return { stdout, exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
    },
    // Raw stdout-returning runner for vault.read / evidence.publish. This is an
    // INTERNAL Bridge path — always uses the trusted bounded spawn with the
    // sanitized childEnv (LAOS_VAULT_ROOT etc.), NOT an injected test seam.
    // GP10-03: the current workspace is re-validated per call — any workspace
    // the caller passes must be separate from the verified interpreter.
    async runCli(taskJson, options = {}) {
      const execution = await validateExecutionOptions(options);
      const cli = path.join(coreRoot, "src", "laos.py");
      const args = [cli, "--root", childEnv.LAOS_DATA_ROOT, "--state-dir", childEnv.LAOS_STATE_DIR, "--task-json", taskJson];
      return spawnBounded(args, execution);
    },
  };
}
