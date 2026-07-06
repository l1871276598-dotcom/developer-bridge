import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";
import { STRUCTURED_GIT_TOOL_DEFINITIONS, createStructuredGitTools } from "../src/structured-git-tools.js";
import { createWorkspaceContext } from "../src/workspace-context.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "structured.git.tools", type: "local-human" });
const git = (cwd, ...args) => execFileAsync("git", args, { cwd });
const hash = (text) => createHash("sha256").update(text).digest("hex");

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-structured-")));
  await git(root, "init", "--quiet", "-b", "feat/start");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "README.md"), "release: pending\nsecond line\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "--quiet", "-m", "base");
  const feature = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  await git(root, "switch", "--quiet", "-c", "temporary-main");
  await writeFile(path.join(root, "main.txt"), "main\n");
  await git(root, "add", "main.txt");
  await git(root, "commit", "--quiet", "-m", "main");
  const main = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  await git(root, "update-ref", "refs/remotes/origin/main", main);
  await git(root, "switch", "--quiet", "feat/start");
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = await createWorkspaceContext(root);
  return { root, feature, main, context, tools: createStructuredGitTools(context) };
}

test("defines the three strict tools", () => {
  assert.deepEqual(STRUCTURED_GIT_TOOL_DEFINITIONS.map(({ name }) => name), [
    "git_branch_create_from_ref", "file_replace_exact", "git_merge_state",
  ]);
  assert.deepEqual(STRUCTURED_GIT_TOOL_DEFINITIONS[0].inputSchema.properties.start_ref.enum, ["origin/main"]);
  assert.equal(STRUCTURED_GIT_TOOL_DEFINITIONS[1].inputSchema.properties.replacements.maxItems, 20);
  assert.equal(STRUCTURED_GIT_TOOL_DEFINITIONS[2].annotations.readOnlyHint, true);
});

test("creates from exact origin/main with and without switching", async (t) => {
  const item = await fixture(t);
  const result = JSON.parse((await item.tools.call("git_branch_create_from_ref", {
    branch: "docs/final", start_ref: "origin/main", expected_start_oid: item.main, switch: true,
  })).text);
  assert.deepEqual(result, {
    branch: "docs/final", start_ref: "origin/main", start_oid: item.main, switched: true,
  });
  assert.equal(item.context.snapshot().branch, "docs/final");
  assert.equal((await git(item.root, "rev-parse", "HEAD")).stdout.trim(), item.main);

  const unswitched = JSON.parse((await item.tools.call("git_branch_create_from_ref", {
    branch: "docs/no-switch", start_ref: "origin/main", expected_start_oid: item.main, switch: false,
  })).text);
  assert.equal(unswitched.switched, false);
  assert.equal(item.context.snapshot().branch, "docs/final");
  assert.equal((await git(item.root, "rev-parse", "refs/heads/docs/no-switch")).stdout.trim(), item.main);

  await assert.rejects(item.tools.call("git_branch_create_from_ref", {
    branch: "docs/stale", start_ref: "origin/main", expected_start_oid: item.feature, switch: false,
  }), /expected commit/iu);
});

test("exact replacement is atomic, bounded and stale-safe", async (t) => {
  const item = await fixture(t);
  const file = path.join(item.root, "README.md");
  const before = await readFile(file, "utf8");
  const statBefore = await lstat(file);
  const result = JSON.parse((await item.tools.call("file_replace_exact", {
    path: "README.md", expected_sha256: hash(before),
    replacements: [{ old: "release: pending", new: "release: merged", count: 1 }],
    max_changed_lines: 2,
  })).text);
  const after = await readFile(file, "utf8");
  const statAfter = await lstat(file);
  assert.equal(after, "release: merged\nsecond line\n");
  assert.notEqual(statAfter.ino, statBefore.ino);
  assert.equal(statAfter.mode & 0o777, statBefore.mode & 0o777);
  assert.equal(result.before_sha256, hash(before));
  assert.equal(result.after_sha256, hash(after));
  await assert.rejects(item.tools.call("file_replace_exact", {
    path: "README.md", expected_sha256: hash(before),
    replacements: [{ old: "merged", new: "released", count: 1 }], max_changed_lines: 2,
  }), /hash/iu);
  await assert.rejects(item.tools.call("file_replace_exact", {
    path: "README.md", expected_sha256: hash(after),
    replacements: [{ old: "release: merged", new: "one\ntwo\nthree", count: 1 }], max_changed_lines: 2,
  }), /line/iu);
  await assert.rejects(item.tools.call("file_replace_exact", {
    path: "README.md", expected_sha256: hash(after),
    replacements: [{ old: "release: merged", new: "x".repeat(1024 * 1024 + 1), count: 1 }],
    max_changed_lines: 2,
  }), /size/iu);
});

test("replacement rejects traversal and links, then rolls back failed diff checks", async (t) => {
  const item = await fixture(t);
  const file = path.join(item.root, "README.md");
  const before = await readFile(file, "utf8");
  await assert.rejects(item.tools.call("file_replace_exact", {
    path: "../README.md", expected_sha256: hash(before),
    replacements: [{ old: "pending", new: "merged", count: 1 }], max_changed_lines: 2,
  }), /inside|relative/iu);
  await symlink(file, path.join(item.root, "linked.md"));
  await assert.rejects(item.tools.call("file_replace_exact", {
    path: "linked.md", expected_sha256: hash(before),
    replacements: [{ old: "pending", new: "merged", count: 1 }], max_changed_lines: 2,
  }), /symbolic/iu);
  await link(file, path.join(item.root, "hard.md"));
  await assert.rejects(item.tools.call("file_replace_exact", {
    path: "README.md", expected_sha256: hash(before),
    replacements: [{ old: "pending", new: "merged", count: 1 }], max_changed_lines: 2,
  }), /hard-linked/iu);
  await rm(path.join(item.root, "hard.md"));
  await assert.rejects(item.tools.call("file_replace_exact", {
    path: "README.md", expected_sha256: hash(before),
    replacements: [{ old: "release: pending", new: "release: pending ", count: 1 }], max_changed_lines: 2,
  }), /diff check/iu);
  assert.equal(await readFile(file, "utf8"), before);
});

test("reports clean and conflicted merge state", async (t) => {
  const item = await fixture(t);
  assert.deepEqual(JSON.parse((await item.tools.call("git_merge_state", {})).text), {
    in_merge: false, merge_head: null, conflicts: [], staged_paths: [], unstaged_paths: [],
  });
  await git(item.root, "switch", "--quiet", "-c", "feat/conflict");
  await writeFile(path.join(item.root, "README.md"), "other\n");
  await git(item.root, "commit", "--quiet", "-am", "other");
  const mergeHead = (await git(item.root, "rev-parse", "HEAD")).stdout.trim();
  await git(item.root, "switch", "--quiet", "feat/start");
  await writeFile(path.join(item.root, "README.md"), "current\n");
  await git(item.root, "commit", "--quiet", "-am", "current");
  await assert.rejects(git(item.root, "merge", "--no-commit", "feat/conflict"));
  const state = JSON.parse((await item.tools.call("git_merge_state", {})).text);
  assert.equal(state.in_merge, true);
  assert.equal(state.merge_head, mergeHead);
  assert.deepEqual(state.conflicts, ["README.md"]);
  assert.ok(state.unstaged_paths.includes("README.md"));
});

test("bridge exposes the tools and keeps branch context synchronized", async (t) => {
  const item = await fixture(t);
  const bridge = await createBridgeWithSyncTools(item.root, () => {}, {
    operatorIdentity, env: { DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1" },
  });
  const names = bridge.tools.map(({ name }) => name);
  for (const { name } of STRUCTURED_GIT_TOOL_DEFINITIONS) assert.ok(names.includes(name));
  const created = await bridge.callTool("git_branch_create_from_ref", {
    branch: "docs/integration", start_ref: "origin/main", expected_start_oid: item.main, switch: true,
  });
  assert.equal(created.isError, undefined, created.content?.[0]?.text);
  const context = await bridge.callTool("git_context", {});
  assert.equal(JSON.parse(context.content[0].text).branch, "docs/integration");
});
