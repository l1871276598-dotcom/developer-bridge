import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT_BYTES = 200 * 1024;
const BRANCH_MAX_LENGTH = 200;
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const TOOL_NAMES = new Set([
  "git_branch_list",
  "git_branch_create",
  "git_branch_switch",
  "git_worktree_list",
  "git_worktree_create",
  "git_worktree_switch",
]);
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

export const GIT_BRANCH_WORKTREE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "git_branch_list",
    description: "List local branches in the authorized repository.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "git_branch_create",
    description: "Create a validated local branch from HEAD and optionally switch to it.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", minLength: 1, maxLength: BRANCH_MAX_LENGTH },
        switch: { type: "boolean" },
      },
      required: ["branch", "switch"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "git_branch_switch",
    description: "Switch the authorized repository to an existing clean local branch.",
    inputSchema: {
      type: "object",
      properties: { branch: { type: "string", minLength: 1, maxLength: BRANCH_MAX_LENGTH } },
      required: ["branch"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "git_worktree_list",
    description: "List the initial and managed Git worktrees for the authorized repository.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "git_worktree_create",
    description: "Create a worktree at the fixed managed location for an existing or new branch.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", minLength: 1, maxLength: BRANCH_MAX_LENGTH },
        create_branch: { type: "boolean" },
      },
      required: ["branch", "create_branch"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "git_worktree_switch",
    description: "Switch live Bridge authorization to an existing managed worktree by branch name.",
    inputSchema: {
      type: "object",
      properties: { branch: { type: "string", minLength: 1, maxLength: BRANCH_MAX_LENGTH } },
      required: ["branch"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
]);

export function isGitBranchWorktreeTool(name) {
  return TOOL_NAMES.has(name);
}

function jsonResult(value, auditBranch) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > GIT_OUTPUT_LIMIT_BYTES) {
    throw new Error("Git result exceeded the fixed limit");
  }
  return { text, ...(auditBranch === undefined ? {} : { auditBranch }) };
}

function assertPlainArguments(args, allowed, required = []) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`Unexpected argument: ${key}`);
  }
  for (const key of required) {
    if (!(key in args)) throw new Error(`Missing required argument: ${key}`);
  }
}

function runGit(cwd, args, { allowedExitCodes = [0], trim = true } = {}) {
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
    let outputExceeded = false;
    let timedOut = false;
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
      const next = currentBytes + chunk.length;
      if (next <= GIT_OUTPUT_LIMIT_BYTES) target.push(chunk);
      else outputExceeded = true;
      return next;
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
      if (!allowedExitCodes.includes(code)) return finish(new Error("Git operation failed"));
      const raw = Buffer.concat(stdout).toString("utf8");
      return finish(null, { code, stdout: trim ? raw.trim() : raw });
    });

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    timeout.unref();
  });
}

function snapshotOf(context) {
  const snapshot = context?.snapshot?.();
  if (!snapshot || typeof snapshot !== "object") throw new Error("Missing authorized workspace context");
  for (const key of ["root", "branch", "initialRoot", "commonDir", "managedRoot"]) {
    if (typeof snapshot[key] !== "string" || snapshot[key].length === 0) {
      throw new Error("Invalid authorized workspace context");
    }
  }
  return snapshot;
}

async function validateBranch(root, branch) {
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch.length > BRANCH_MAX_LENGTH ||
    branch.startsWith("-") ||
    /[\0-\x20\x7f]/u.test(branch)
  ) {
    throw new Error("Branch name is invalid");
  }
  if (PROTECTED_BRANCHES.has(branch)) throw new Error("Protected branch is not allowed");
  await runGit(root, ["check-ref-format", "--branch", branch]);
  return branch;
}

async function actualIdentity(root) {
  const canonicalRoot = await realpath(root);
  const topLevel = await realpath((await runGit(root, ["rev-parse", "--show-toplevel"])).stdout);
  const commonPath = (await runGit(root, ["rev-parse", "--git-common-dir"])).stdout;
  const commonDir = await realpath(path.resolve(root, commonPath));
  const branch = (await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout;
  if (!branch || PROTECTED_BRANCHES.has(branch)) throw new Error("Unsafe attached branch");
  return { root: canonicalRoot, topLevel, commonDir, branch };
}

async function assertSnapshotIdentity(snapshot) {
  const actual = await actualIdentity(snapshot.root);
  if (
    actual.root !== snapshot.root ||
    actual.topLevel !== snapshot.root ||
    actual.commonDir !== snapshot.commonDir ||
    actual.branch !== snapshot.branch
  ) {
    throw new Error("Authorized workspace context no longer matches Git state");
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

async function assertClean(root) {
  const status = (await runGit(root, ["status", "--porcelain=v1", "-z"], { trim: false })).stdout;
  if (status.length !== 0) throw new Error("Git workspace must be clean before this operation");

  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
  ]) {
    const gitPath = (await runGit(root, ["rev-parse", "--git-path", marker])).stdout;
    if (await pathExists(path.resolve(root, gitPath))) {
      throw new Error("Git operation state must be clear before this operation");
    }
  }
}

async function branchExists(root, branch) {
  const result = await runGit(
    root,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { allowedExitCodes: [0, 1] },
  );
  return result.code === 0;
}

async function assertNoExternalFilters(root) {
  const configured = await runGit(
    root,
    ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
    { allowedExitCodes: [0, 1] },
  );
  if (configured.code === 0 && configured.stdout.length > 0) {
    throw new Error("External Git filters are not allowed for checkout operations");
  }
}

function parseWorktreePorcelain(raw) {
  const records = [];
  let record = {};
  for (const token of raw.split("\0")) {
    if (token === "") {
      if (Object.keys(record).length > 0) records.push(record);
      record = {};
      continue;
    }
    const space = token.indexOf(" ");
    const key = space === -1 ? token : token.slice(0, space);
    const value = space === -1 ? true : token.slice(space + 1);
    if (key in record) throw new Error("Malformed Git worktree output");
    record[key] = value;
  }
  if (Object.keys(record).length > 0) throw new Error("Malformed Git worktree output");
  return records;
}

function isDirectManagedPath(managedRoot, candidate) {
  return path.dirname(candidate) === managedRoot && candidate !== managedRoot;
}

async function validatedWorktrees(snapshot) {
  const raw = (await runGit(
    snapshot.root,
    ["worktree", "list", "--porcelain", "-z"],
    { trim: false },
  )).stdout;
  const parsed = parseWorktreePorcelain(raw);
  const roots = new Set();
  const branches = new Set();
  const records = [];

  for (const item of parsed) {
    if (typeof item.worktree !== "string" || typeof item.branch !== "string" || item.detached === true) {
      throw new Error("Only attached Git worktrees are allowed");
    }
    const branchPrefix = "refs/heads/";
    if (!item.branch.startsWith(branchPrefix)) throw new Error("Malformed Git worktree branch");
    const branch = item.branch.slice(branchPrefix.length);
    if (!branch || PROTECTED_BRANCHES.has(branch)) throw new Error("Protected or missing worktree branch is not allowed");

    const lexicalRoot = path.resolve(item.worktree);
    const rootStat = await lstat(lexicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Worktree root must be a real directory");
    const root = await realpath(lexicalRoot);
    if (root !== lexicalRoot) throw new Error("Symlinked worktree roots are not allowed");
    if (root !== snapshot.initialRoot && !isDirectManagedPath(snapshot.managedRoot, root)) {
      throw new Error("Unmanaged Git worktree is registered");
    }
    if (root !== snapshot.initialRoot) {
      const expected = path.join(snapshot.managedRoot, branch.replaceAll("/", "--"));
      if (root !== expected) throw new Error("Managed worktree path does not match its branch");
    }

    const identity = await actualIdentity(root);
    if (identity.commonDir !== snapshot.commonDir || identity.branch !== branch) {
      throw new Error("Worktree identity does not match the authorized repository");
    }
    if (roots.has(root) || branches.has(branch)) throw new Error("Duplicate Git worktree mapping is not allowed");
    roots.add(root);
    branches.add(branch);
    records.push(Object.freeze({ root, branch, head: typeof item.HEAD === "string" ? item.HEAD : "" }));
  }

  return records;
}

async function listBranches(snapshot) {
  await assertSnapshotIdentity(snapshot);
  const output = (await runGit(snapshot.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout;
  const worktrees = await validatedWorktrees(snapshot);
  const occupied = new Set(worktrees.map(({ branch }) => branch));
  const branches = output.length === 0 ? [] : output.split("\n").filter(Boolean).sort();
  return jsonResult({
    branches: branches.map((branch) => ({
      branch,
      current: branch === snapshot.branch,
      checked_out: occupied.has(branch),
    })),
  });
}

async function createBranch(args, context, snapshot) {
  assertPlainArguments(args, ["branch", "switch"], ["branch", "switch"]);
  if (typeof args.switch !== "boolean") throw new Error("switch must be a boolean");
  const branch = await validateBranch(snapshot.root, args.branch);
  await assertSnapshotIdentity(snapshot);
  await assertClean(snapshot.root);
  await validatedWorktrees(snapshot);
  if (await branchExists(snapshot.root, branch)) throw new Error("Branch already exists");
  if (args.switch) await assertNoExternalFilters(snapshot.root);

  await runGit(snapshot.root, ["branch", "--", branch, "HEAD"]);
  if (args.switch) {
    await runGit(snapshot.root, ["switch", branch]);
    const actual = await actualIdentity(snapshot.root);
    if (actual.branch !== branch || actual.commonDir !== snapshot.commonDir) {
      throw new Error("Git branch switch did not reach the requested branch");
    }
    context.replace({ branch });
  }
  return jsonResult({ branch, switched: args.switch }, branch);
}

async function switchBranch(args, context, snapshot) {
  assertPlainArguments(args, ["branch"], ["branch"]);
  const branch = await validateBranch(snapshot.root, args.branch);
  await assertSnapshotIdentity(snapshot);
  await assertClean(snapshot.root);
  const worktrees = await validatedWorktrees(snapshot);
  if (!(await branchExists(snapshot.root, branch))) throw new Error("Branch does not exist");
  const occupied = worktrees.find((item) => item.branch === branch);
  if (occupied && occupied.root !== snapshot.root) throw new Error("Branch is checked out by another worktree");
  if (branch === snapshot.branch) return jsonResult({ branch, switched: false }, branch);
  await assertNoExternalFilters(snapshot.root);

  await runGit(snapshot.root, ["switch", branch]);
  const actual = await actualIdentity(snapshot.root);
  if (actual.branch !== branch || actual.commonDir !== snapshot.commonDir) {
    throw new Error("Git branch switch did not reach the requested branch");
  }
  context.replace({ branch });
  return jsonResult({ branch, switched: true }, branch);
}

async function ensureManagedRoot(snapshot) {
  const managedRoot = path.resolve(snapshot.managedRoot);
  if (!path.isAbsolute(managedRoot) || managedRoot === snapshot.initialRoot) {
    throw new Error("Managed worktree root is invalid");
  }

  const missing = [];
  let current = managedRoot;
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Managed worktree root has no existing ancestor");
    missing.unshift(path.basename(current));
    current = parent;
  }

  let currentStat = await lstat(current);
  if (currentStat.isSymbolicLink() || !currentStat.isDirectory() || await realpath(current) !== current) {
    throw new Error("Managed worktree root cannot traverse a symbolic link");
  }
  for (const segment of missing) {
    current = path.join(current, segment);
    await mkdir(current);
    currentStat = await lstat(current);
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory() || await realpath(current) !== current) {
      throw new Error("Managed worktree root must be a real directory");
    }
  }
  return managedRoot;
}

async function listWorktrees(snapshot) {
  await assertSnapshotIdentity(snapshot);
  const worktrees = await validatedWorktrees(snapshot);
  return jsonResult({ worktrees });
}

async function createWorktree(args, snapshot) {
  assertPlainArguments(args, ["branch", "create_branch"], ["branch", "create_branch"]);
  if (typeof args.create_branch !== "boolean") throw new Error("create_branch must be a boolean");
  const branch = await validateBranch(snapshot.root, args.branch);
  await assertSnapshotIdentity(snapshot);
  await assertClean(snapshot.root);
  const existingWorktrees = await validatedWorktrees(snapshot);
  if (existingWorktrees.some((item) => item.branch === branch)) throw new Error("Branch already has a worktree");
  await assertNoExternalFilters(snapshot.root);

  const exists = await branchExists(snapshot.root, branch);
  if (args.create_branch === exists) {
    throw new Error(args.create_branch ? "Branch already exists" : "Branch does not exist");
  }

  const managedRoot = await ensureManagedRoot(snapshot);
  const destination = path.join(managedRoot, branch.replaceAll("/", "--"));
  if (!isDirectManagedPath(managedRoot, destination)) throw new Error("Derived worktree path is invalid");
  if (await pathExists(destination)) throw new Error("Derived worktree path already exists");

  const command = args.create_branch
    ? ["worktree", "add", "-b", branch, "--", destination, "HEAD"]
    : ["worktree", "add", "--", destination, branch];
  await runGit(snapshot.root, command);

  const worktrees = await validatedWorktrees(snapshot);
  const created = worktrees.find((item) => item.branch === branch);
  if (!created || created.root !== destination) throw new Error("Created worktree could not be verified");
  return jsonResult(created, branch);
}

async function switchWorktree(args, context, snapshot) {
  assertPlainArguments(args, ["branch"], ["branch"]);
  const branch = await validateBranch(snapshot.root, args.branch);
  await assertSnapshotIdentity(snapshot);
  await assertClean(snapshot.root);
  const worktrees = await validatedWorktrees(snapshot);
  const matches = worktrees.filter((item) => item.branch === branch);
  if (matches.length !== 1) throw new Error("Managed worktree branch is missing or ambiguous");
  const target = matches[0];
  await assertClean(target.root);
  const identity = await actualIdentity(target.root);
  if (identity.commonDir !== snapshot.commonDir || identity.branch !== branch) {
    throw new Error("Target worktree identity is not authorized");
  }
  context.replace({ root: target.root, branch });
  return jsonResult({ root: target.root, branch, switched: target.root !== snapshot.root }, branch);
}

export async function handleGitBranchWorktreeTool(name, args = {}, context) {
  if (!isGitBranchWorktreeTool(name)) throw new Error(`Unsupported Git branch/worktree tool: ${name}`);
  const snapshot = snapshotOf(context);
  if (name === "git_branch_list") {
    assertPlainArguments(args, []);
    return listBranches(snapshot);
  }
  if (name === "git_branch_create") return createBranch(args, context, snapshot);
  if (name === "git_branch_switch") return switchBranch(args, context, snapshot);
  if (name === "git_worktree_list") {
    assertPlainArguments(args, []);
    return listWorktrees(snapshot);
  }
  if (name === "git_worktree_create") return createWorktree(args, snapshot);
  return switchWorktree(args, context, snapshot);
}
