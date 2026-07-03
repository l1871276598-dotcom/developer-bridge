import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT_BYTES = 200 * 1024;
const SAFE_GIT_ENV = Object.freeze({
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: os.devNull,
  GIT_CONFIG_KEY_2: "commit.gpgSign",
  GIT_CONFIG_VALUE_2: "false",
  GIT_CONFIG_KEY_3: "protocol.ext.allow",
  GIT_CONFIG_VALUE_3: "never",
});

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...SAFE_GIT_ENV },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let timeout;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const collect = (target, chunk, currentBytes) => {
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes <= GIT_OUTPUT_LIMIT_BYTES) target.push(chunk);
      else outputExceeded = true;
      return nextBytes;
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
      if (outputExceeded) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
      if (outputExceeded) child.kill("SIGKILL");
    });
    child.once("error", () => finish(new Error("Git could not be started")));
    child.once("close", (code) => {
      if (outputExceeded) return finish(new Error("Git output exceeded the fixed limit"));
      if (timedOut) return finish(new Error("Git operation timed out"));
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) return finish(new Error(errorText || "Git operation failed"));
      return finish(null, Buffer.concat(stdout).toString("utf8").trim());
    });

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    timeout.unref();
  });
}

async function resolveDirectory(value, message) {
  try {
    const resolved = await realpath(path.resolve(value));
    if (!(await stat(resolved)).isDirectory()) throw new Error("not-directory");
    return resolved;
  } catch {
    throw new Error(message);
  }
}


async function pathExists(value) {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function resolveManagedRoot(root, value) {
  const candidate = value === undefined
    ? path.join(path.dirname(root), `${path.basename(root)}-worktrees`)
    : value;
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.includes("\0") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(candidate) ||
    !path.isAbsolute(candidate)
  ) {
    throw new Error("Managed worktree root must be an absolute local path");
  }

  const managedRoot = path.normalize(candidate);
  if (managedRoot === root) throw new Error("Managed worktree root must differ from the workspace");

  let ancestor = managedRoot;
  while (!(await pathExists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Managed worktree root has no existing ancestor");
    ancestor = parent;
  }
  const ancestorStat = await lstat(ancestor);
  if (ancestorStat.isSymbolicLink() || await realpath(ancestor) !== ancestor) {
    throw new Error("Managed worktree root cannot traverse a symbolic link");
  }
  if (ancestor === managedRoot && !ancestorStat.isDirectory()) {
    throw new Error("Managed worktree root must identify a directory");
  }
  return managedRoot;
}

export async function createWorkspaceContext(workspace, options = {}) {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("Workspace must identify a Git repository root");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Workspace context options must be an object");
  }

  const root = await resolveDirectory(workspace, "Workspace must identify a Git repository root");
  let topLevel;
  let commonDir;
  let branch;
  try {
    topLevel = await realpath(await runGit(root, ["rev-parse", "--show-toplevel"]));
    const commonPath = await runGit(root, ["rev-parse", "--git-common-dir"]);
    commonDir = await realpath(path.resolve(root, commonPath));
    branch = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    throw new Error("Workspace must identify an attached Git repository branch");
  }

  if (topLevel !== root) throw new Error("Workspace must be the Git repository root");
  if (branch === "main" || branch === "master") throw new Error("Protected branch is not allowed");

  const managedRoot = await resolveManagedRoot(root, options.managedRoot);

  let state = Object.freeze({ root, branch, initialRoot: root, commonDir, managedRoot });
  let tail = Promise.resolve();

  return Object.freeze({
    snapshot: () => state,
    replace(next) {
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        throw new Error("Replacement state must be an object");
      }
      state = Object.freeze({ ...state, ...next });
    },
    runExclusive(operation) {
      if (typeof operation !== "function") throw new Error("Operation must be a function");
      const run = tail.then(operation, operation);
      tail = run.catch(() => {});
      return run;
    },
  });
}
