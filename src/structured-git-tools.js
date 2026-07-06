import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { runFixedGit } from "./fixed-git-runner.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_BRANCH_LENGTH = 200;
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const TOOL_NAMES = new Set([
  "git_branch_create_from_ref",
  "file_replace_exact",
  "git_merge_state",
]);
const WRITE_DENYLIST = Object.freeze({
  directorySegments: new Set([".git", "node_modules"]),
  exactBasenames: new Set([".env", "id_rsa", "id_ed25519"]),
  extensions: new Set([".pem", ".key"]),
});

export const STRUCTURED_GIT_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "git_branch_create_from_ref",
    description: "Create a validated local branch from the exact fetched origin/main commit and optionally switch to it.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", minLength: 1, maxLength: MAX_BRANCH_LENGTH },
        start_ref: { type: "string", enum: ["origin/main"] },
        expected_start_oid: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
        switch: { type: "boolean" },
      },
      required: ["branch", "start_ref", "expected_start_oid", "switch"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "file_replace_exact",
    description: "Atomically replace exact text in one verified UTF-8 workspace file using a required pre-change SHA-256 hash and line-change budget.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 1000 },
        expected_sha256: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
        replacements: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              old: { type: "string", minLength: 1, maxLength: MAX_FILE_BYTES },
              new: { type: "string", maxLength: MAX_FILE_BYTES },
              count: { type: "integer", minimum: 1, maximum: 1000 },
            },
            required: ["old", "new", "count"],
            additionalProperties: false,
          },
        },
        max_changed_lines: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["path", "expected_sha256", "replacements", "max_changed_lines"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "git_merge_state",
    description: "Report the active merge commit and bounded relative conflict, staged, and unstaged paths.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
]);

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

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function git(root, args, allowedExitCodes = [0]) {
  return runFixedGit("git", args, { cwd: root, allowedExitCodes });
}

async function actualIdentity(snapshot) {
  const root = await realpath(snapshot.root);
  const top = await realpath((await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim());
  const commonPath = (await git(root, ["rev-parse", "--git-common-dir"])).stdout.trim();
  const commonDir = await realpath(path.resolve(root, commonPath));
  const branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!branch || PROTECTED_BRANCHES.has(branch)) throw new Error("Unsafe attached branch");
  return { root, top, commonDir, branch };
}

async function assertSnapshotIdentity(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("Missing authorized workspace context");
  for (const key of ["root", "branch", "commonDir"]) {
    if (typeof snapshot[key] !== "string" || !snapshot[key]) {
      throw new Error("Invalid authorized workspace context");
    }
  }
  const actual = await actualIdentity(snapshot);
  if (
    actual.root !== snapshot.root ||
    actual.top !== snapshot.root ||
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
  const status = (await git(root, ["status", "--porcelain=v1", "-z"])).stdout;
  if (status.length !== 0) throw new Error("Git workspace must be clean before this operation");
  for (const marker of [
    "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply",
  ]) {
    const gitPath = (await git(root, ["rev-parse", "--git-path", marker])).stdout.trim();
    if (await pathExists(path.resolve(root, gitPath))) {
      throw new Error("Git operation state must be clear before this operation");
    }
  }
}

async function assertNoExternalFilters(root) {
  const result = await git(
    root,
    ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
    [0, 1],
  );
  if (result.exitCode === 0 && result.stdout.trim()) {
    throw new Error("External Git filters are not allowed for checkout operations");
  }
}

async function validateBranch(root, branch) {
  if (
    typeof branch !== "string" ||
    !branch ||
    branch.length > MAX_BRANCH_LENGTH ||
    branch.startsWith("-") ||
    /[\0-\x20\x7f]/u.test(branch)
  ) {
    throw new Error("Branch name is invalid");
  }
  if (PROTECTED_BRANCHES.has(branch)) throw new Error("Protected branch is not allowed");
  await git(root, ["check-ref-format", "--branch", branch]);
  return branch;
}

async function branchExists(root, branch) {
  const result = await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], [0, 1]);
  return result.exitCode === 0;
}

async function createBranchFromRef(args, context, snapshot) {
  assertPlainArguments(
    args,
    ["branch", "start_ref", "expected_start_oid", "switch"],
    ["branch", "start_ref", "expected_start_oid", "switch"],
  );
  if (args.start_ref !== "origin/main") throw new Error("start_ref must be origin/main");
  if (!/^[0-9a-f]{40}$/iu.test(args.expected_start_oid)) throw new Error("Expected commit is invalid");
  if (typeof args.switch !== "boolean") throw new Error("switch must be a boolean");
  const branch = await validateBranch(snapshot.root, args.branch);
  await assertClean(snapshot.root);
  if (await branchExists(snapshot.root, branch)) throw new Error("Branch already exists");
  if (args.switch) await assertNoExternalFilters(snapshot.root);

  const resolved = (await git(snapshot.root, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"])).stdout.trim();
  const expected = args.expected_start_oid.toLowerCase();
  if (resolved !== expected) throw new Error("origin/main does not match the expected commit");

  if (args.switch) {
    await git(snapshot.root, ["switch", "--no-track", "-c", branch, expected]);
    const actual = await actualIdentity({ ...snapshot, branch });
    const head = (await git(snapshot.root, ["rev-parse", "HEAD"])).stdout.trim();
    if (actual.branch !== branch || actual.commonDir !== snapshot.commonDir || head !== expected) {
      throw new Error("Git branch switch did not reach the requested commit");
    }
    context.replace({ branch });
  } else {
    await git(snapshot.root, ["branch", "--no-track", "--", branch, expected]);
    const created = (await git(snapshot.root, ["rev-parse", `refs/heads/${branch}^{commit}`])).stdout.trim();
    if (created !== expected) throw new Error("Created branch does not match the requested commit");
  }

  return {
    text: JSON.stringify({ branch, start_ref: "origin/main", start_oid: expected, switched: args.switch }),
    auditBranch: branch,
  };
}

function normalizeRelative(input) {
  if (
    typeof input !== "string" ||
    !input ||
    input.includes("\0") ||
    path.isAbsolute(input) ||
    /^[A-Za-z]:[\\/]/u.test(input) ||
    input.startsWith("\\\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(input)
  ) {
    throw new Error("Path must be a non-empty relative path");
  }
  const normalized = path.normalize(input);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Path must stay inside the authorized workspace");
  }
  const segments = normalized.split(path.sep).map((value) => value.toLowerCase());
  const basename = segments.at(-1);
  if (
    segments.some((value) => WRITE_DENYLIST.directorySegments.has(value)) ||
    WRITE_DENYLIST.exactBasenames.has(basename) ||
    WRITE_DENYLIST.extensions.has(path.extname(basename))
  ) {
    throw new Error("Replacing this protected path is not allowed");
  }
  return normalized;
}

async function verifiedFile(root, relative) {
  const lexical = path.resolve(root, relative);
  if (!isContained(root, lexical)) throw new Error("Path must stay inside the authorized workspace");
  const lexicalStat = await lstat(lexical).catch(() => null);
  if (!lexicalStat) throw new Error("Path does not exist");
  if (lexicalStat.isSymbolicLink()) throw new Error("Symbolic links are not allowed");
  if (!lexicalStat.isFile()) throw new Error("Path must identify a regular file");
  if (lexicalStat.nlink > 1) throw new Error("Hard-linked files are not allowed");
  if (lexicalStat.size > MAX_FILE_BYTES) throw new Error("File exceeds the fixed size limit");
  const canonical = await realpath(lexical);
  if (canonical !== lexical || !isContained(root, canonical)) {
    throw new Error("Symbolic link escapes the authorized workspace");
  }
  return { target: canonical, stat: lexicalStat };
}

async function readVerified(target, expectedStat) {
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      opened.dev !== expectedStat.dev ||
      opened.ino !== expectedStat.ino ||
      opened.size > MAX_FILE_BYTES
    ) {
      throw new Error("File changed during security validation");
    }
    const content = await handle.readFile();
    if (content.length > MAX_FILE_BYTES) throw new Error("File exceeds the fixed size limit");
    return content.toString("utf8");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function occurrenceCount(text, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function lineSpan(text) {
  return text.split("\n").length;
}

async function atomicReplace(target, expectedStat, content, mode) {
  const current = await lstat(target);
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink > 1 ||
    current.dev !== expectedStat.dev ||
    current.ino !== expectedStat.ino
  ) {
    throw new Error("File changed during security validation");
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      mode,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    const beforeRename = await lstat(target);
    if (
      beforeRename.isSymbolicLink() ||
      beforeRename.nlink > 1 ||
      beforeRename.dev !== expectedStat.dev ||
      beforeRename.ino !== expectedStat.ino
    ) {
      throw new Error("File changed during security validation");
    }
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function replaceExact(args, snapshot) {
  assertPlainArguments(
    args,
    ["path", "expected_sha256", "replacements", "max_changed_lines"],
    ["path", "expected_sha256", "replacements", "max_changed_lines"],
  );
  if (!/^[0-9a-f]{64}$/iu.test(args.expected_sha256)) throw new Error("Expected SHA-256 hash is invalid");
  if (!Array.isArray(args.replacements) || args.replacements.length < 1 || args.replacements.length > 20) {
    throw new Error("replacements must contain between 1 and 20 items");
  }
  if (!Number.isInteger(args.max_changed_lines) || args.max_changed_lines < 1 || args.max_changed_lines > 500) {
    throw new Error("Changed line budget is invalid");
  }
  const relative = normalizeRelative(args.path);
  const { target, stat } = await verifiedFile(snapshot.root, relative);
  const before = await readVerified(target, stat);
  const beforeHash = digest(before);
  if (beforeHash !== args.expected_sha256.toLowerCase()) throw new Error("File hash does not match expected_sha256");

  let after = before;
  let changedLines = 0;
  const counts = [];
  for (const replacement of args.replacements) {
    assertPlainArguments(replacement, ["old", "new", "count"], ["old", "new", "count"]);
    if (typeof replacement.old !== "string" || !replacement.old) throw new Error("Replacement old text must be non-empty");
    if (typeof replacement.new !== "string") throw new Error("Replacement new text must be a string");
    if (!Number.isInteger(replacement.count) || replacement.count < 1 || replacement.count > 1000) {
      throw new Error("Replacement count is invalid");
    }
    const count = occurrenceCount(after, replacement.old);
    if (count !== replacement.count) throw new Error("Replacement count did not match the expected count");
    const oldBytes = Buffer.byteLength(replacement.old, "utf8");
    const newBytes = Buffer.byteLength(replacement.new, "utf8");
    if (oldBytes > MAX_FILE_BYTES || newBytes > MAX_FILE_BYTES) {
      throw new Error("Replacement text exceeds the fixed file size limit");
    }
    const projectedBytes = Buffer.byteLength(after, "utf8") + count * (newBytes - oldBytes);
    if (projectedBytes > MAX_FILE_BYTES) {
      throw new Error("Replacement exceeds the fixed file size limit");
    }
    changedLines += count * Math.max(lineSpan(replacement.old), lineSpan(replacement.new));
    if (changedLines > args.max_changed_lines) throw new Error("Changed line budget exceeded");
    after = after.split(replacement.old).join(replacement.new);
    counts.push(count);
  }
  if (after === before) throw new Error("Replacement produced no file change");
  if (Buffer.byteLength(after, "utf8") > MAX_FILE_BYTES) throw new Error("Replacement exceeds the fixed file size limit");

  const mode = stat.mode & 0o777;
  await atomicReplace(target, stat, after, mode);
  const replacedStat = await lstat(target);
  const check = await git(snapshot.root, ["diff", "--check", "--", relative], [0, 1, 2]);
  if (check.exitCode !== 0) {
    await atomicReplace(target, replacedStat, before, mode);
    throw new Error("Git diff check rejected the replacement and the original file was restored");
  }

  return {
    text: JSON.stringify({
      path: relative.split(path.sep).join("/"),
      before_sha256: beforeHash,
      after_sha256: digest(after),
      replacement_counts: counts,
      changed_lines_upper_bound: changedLines,
    }),
    relativePath: relative,
    contentBytes: Buffer.byteLength(after, "utf8"),
  };
}

function parsePaths(raw) {
  const values = raw.split("\0").filter(Boolean);
  const unique = new Set();
  for (const value of values) {
    const normalized = value.replaceAll("\\", "/");
    if (
      path.isAbsolute(value) ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      normalized.startsWith("//") ||
      /^[A-Za-z]:\//u.test(normalized)
    ) {
      throw new Error("Git returned an unsafe path");
    }
    unique.add(normalized);
  }
  return [...unique].sort();
}

async function mergeState(args, snapshot) {
  assertPlainArguments(args, []);
  const merge = await git(snapshot.root, ["rev-parse", "-q", "--verify", "MERGE_HEAD^{commit}"], [0, 1, 128]);
  const conflicts = await git(snapshot.root, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  const staged = await git(snapshot.root, ["diff", "--cached", "--name-only", "-z"]);
  const unstaged = await git(snapshot.root, ["diff", "--name-only", "-z"]);
  const mergeHead = merge.exitCode === 0 ? merge.stdout.trim() : null;
  return {
    text: JSON.stringify({
      in_merge: mergeHead !== null,
      merge_head: mergeHead,
      conflicts: parsePaths(conflicts.stdout),
      staged_paths: parsePaths(staged.stdout),
      unstaged_paths: parsePaths(unstaged.stdout),
    }),
  };
}

export function createStructuredGitTools(workspaceContext) {
  if (
    !workspaceContext ||
    typeof workspaceContext.snapshot !== "function" ||
    typeof workspaceContext.replace !== "function" ||
    typeof workspaceContext.runExclusive !== "function"
  ) {
    throw new Error("A shared workspace context is required");
  }
  return Object.freeze({
    definitions: STRUCTURED_GIT_TOOL_DEFINITIONS,
    isTool(name) {
      return TOOL_NAMES.has(name);
    },
    call(name, args = {}) {
      if (!TOOL_NAMES.has(name)) throw new Error(`Unsupported structured Git tool: ${name}`);
      return workspaceContext.runExclusive(async () => {
        const snapshot = workspaceContext.snapshot();
        await assertSnapshotIdentity(snapshot);
        if (name === "git_branch_create_from_ref") {
          return createBranchFromRef(args, workspaceContext, snapshot);
        }
        if (name === "file_replace_exact") return replaceExact(args, snapshot);
        return mergeState(args, snapshot);
      });
    },
  });
}
