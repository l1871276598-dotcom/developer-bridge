import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";
import { buildBridgeInfo, LAOS_BRIDGE_INFO_DEFINITION } from "../src/bridge-info.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.bridgeinfo.test", type: "local-human" });

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function repo(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-info-")));
  const repo = path.join(base, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "file.txt"), "x\n");
  await git(repo, "init", "--quiet", "-b", "feat/bridge-info");
  await git(repo, "config", "user.name", "T");
  await git(repo, "config", "user.email", "t@t.invalid");
  await git(repo, "add", "file.txt");
  await git(repo, "commit", "--quiet", "-m", "init");
  t.after(() => rm(base, { recursive: true, force: true }));
  return repo;
}

test("C-INV-19: laos_bridge_info exposes verifiable build identity", async (t) => {
  const repoDir = await repo(t);
  const head = (await git(repoDir, "rev-parse", "HEAD")).stdout.trim();
  const tree = (await git(repoDir, "rev-parse", "HEAD^{tree}")).stdout.trim();
  const info = await buildBridgeInfo({ bridgeRoot: repoDir, codeRoot: repoDir });
  assert.equal(info.bridge.git_commit, head);
  assert.equal(info.bridge.git_tree, tree);
  assert.equal(info.bridge.dirty, false);
  assert.equal(typeof info.bridge.allowlist_sha256, "string");
  assert.equal(info.bridge.allowlist_sha256.length, 64);
  assert.equal(info.bridge.protocol_version, "laos-task-v2");
  assert.equal(info.core.protocol_version, "evidence-v2");
  assert.equal(info.governance.constitution_version, "1.0");
});

test("S13: allowlist contents are exposed so the digest is independently recomputable", async (t) => {
  const repoDir = await repo(t);
  const { createHash } = await import("node:crypto");
  const { FROZEN_LAOS_TASKS, canonicalJson } = await import("../src/laos-memory-tool.js");
  const info = await buildBridgeInfo({ bridgeRoot: repoDir, codeRoot: repoDir });
  // The allowlist array must be present and sorted.
  assert.ok(Array.isArray(info.bridge.allowlist));
  assert.deepEqual(info.bridge.allowlist, [...FROZEN_LAOS_TASKS].sort());
  // An auditor can recompute the digest from the exposed contents alone.
  const recomputed = createHash("sha256")
    .update(canonicalJson({ tasks: info.bridge.allowlist }))
    .digest("hex");
  assert.equal(recomputed, info.bridge.allowlist_sha256);
});

test("S13: laos_bridge_info has no side effects on git tree or state", async (t) => {
  const repoDir = await repo(t);
  const before = (await git(repoDir, "rev-parse", "HEAD^{tree}")).stdout.trim();
  const info = await buildBridgeInfo({ bridgeRoot: repoDir, codeRoot: repoDir });
  // Reading build info must not dirty the tree or change HEAD.
  assert.equal(info.bridge.dirty, false);
  const after = (await git(repoDir, "rev-parse", "HEAD^{tree}")).stdout.trim();
  assert.equal(after, before);
});

test("C-INV-19: dirty working tree is reported", async (t) => {
  const repoDir = await repo(t);
  await writeFile(path.join(repoDir, "uncommitted.txt"), "x\n");
  const info = await buildBridgeInfo({ bridgeRoot: repoDir, codeRoot: repoDir });
  assert.equal(info.bridge.dirty, true);
});

test("C-INV-19: laos_bridge_info is advertised as a read-only tool", async (t) => {
  const repoDir = await repo(t);
  const bridge = await createBridgeWithSyncTools(repoDir, () => {}, { operatorIdentity, env: { ...process.env, DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1" } });
  const def = bridge.tools.find(({ name }) => name === "laos_bridge_info");
  assert.ok(def, "laos_bridge_info should be advertised");
  assert.equal(def.annotations.readOnlyHint, true);
  assert.deepEqual(LAOS_BRIDGE_INFO_DEFINITION.inputSchema.properties, {});
});

test("C-INV-19: calling laos_bridge_info returns the build identity without side effects", async (t) => {
  const repoDir = await repo(t);
  const head = (await git(repoDir, "rev-parse", "HEAD")).stdout.trim();
  const bridge = await createBridgeWithSyncTools(repoDir, () => {}, { operatorIdentity, env: { ...process.env, DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1" } });
  const result = await bridge.callTool("laos_bridge_info", {});
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(typeof parsed.bridge.git_commit, "string");
  assert.equal(typeof parsed.bridge.git_tree, "string");
  assert.equal(typeof parsed.bridge.allowlist_sha256, "string");
  // codeRoot is the workspace itself, so core.git_commit is the workspace HEAD.
  assert.equal(parsed.core.git_commit, head);
  assert.equal(typeof parsed.core.protocol_version, "string");
});

test("C-INV-19: allowlist digest is stable and recomputable from the frozen allowlist", async (t) => {
  const { createHash } = await import("node:crypto");
  const { FROZEN_LAOS_TASKS, canonicalJson } = await import("../src/laos-memory-tool.js");
  // The digest contract sorts task names then canonical-serializes {tasks}.
  const expected = createHash("sha256")
    .update(canonicalJson({ tasks: [...FROZEN_LAOS_TASKS].sort() }))
    .digest("hex");
  const repoDir = await repo(t);
  const info = await buildBridgeInfo({ bridgeRoot: repoDir, codeRoot: repoDir });
  assert.equal(info.bridge.allowlist_sha256, expected);
  assert.equal(info.bridge.allowlist_sha256.length, 64);
});

// GP5-02/R15: bridge_info must be strictly read-only — .git/index hash and
// mtime must not change across a call, even with a dirty working tree (where
// a plain `git status` would refresh the index stat cache).
test("GP5-02: bridge_info does not mutate .git/index (--no-optional-locks)", async (t) => {
  const repoDir = await repo(t);
  const { stat, readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  // Make the stat cache stale: modify a tracked file so git status would want
  // to refresh the index.
  await writeFile(path.join(repoDir, "file.txt"), "changed\n");
  const indexPath = path.join(repoDir, ".git", "index");
  const before = await stat(indexPath);
  const beforeMtime = before.mtimeMs;
  const beforeHash = createHash("sha256").update(await readFile(indexPath)).digest("hex");
  // Small delay so a write would be observable via mtime.
  await new Promise((r) => setTimeout(r, 20));

  const bridge = await createBridgeWithSyncTools(repoDir, () => {}, { operatorIdentity, env: { ...process.env, DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1" } });
  const result = await bridge.callTool("laos_bridge_info", {});
  assert.equal(result.isError, undefined, result.content?.[0]?.text);

  const after = await stat(indexPath);
  const afterMtime = after.mtimeMs;
  const afterHash = createHash("sha256").update(await readFile(indexPath)).digest("hex");
  assert.equal(afterHash, beforeHash, ".git/index content must not change");
  assert.equal(afterMtime, beforeMtime, ".git/index mtime must not change (no stat refresh)");
});

