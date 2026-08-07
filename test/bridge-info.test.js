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
  const expected = createHash("sha256").update(canonicalJson({ tasks: [...FROZEN_LAOS_TASKS] })).digest("hex");
  const repoDir = await repo(t);
  const info = await buildBridgeInfo({ bridgeRoot: repoDir, codeRoot: repoDir });
  assert.equal(info.bridge.allowlist_sha256, expected);
  assert.equal(info.bridge.allowlist_sha256.length, 64);
});
