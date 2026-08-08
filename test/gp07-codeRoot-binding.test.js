import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createLaosMemoryTool } from "../src/laos-memory-tool.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-gp07-")));
  const workspaceA = path.join(base, "workspaceA");
  const workspaceB = path.join(base, "workspaceB");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([
    mkdir(workspaceA), mkdir(workspaceB), mkdir(dataRoot), mkdir(stateDir),
  ]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), "{}\n", "utf8");
  for (const ws of [workspaceA, workspaceB]) {
    await mkdir(path.join(ws, "src"));
    await writeFile(path.join(ws, "src", "laos.py"), `print('${path.basename(ws)}')\n`, "utf8");
    await git(ws, "init", "--quiet", "-b", "main");
    await git(ws, "config", "user.name", "Test User");
    await git(ws, "config", "user.email", "test@example.invalid");
    await git(ws, "add", "src/laos.py");
    await git(ws, "commit", "--quiet", "-m", "fixture");
  }
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspaceA, workspaceB, dataRoot, stateDir };
}

function env(item) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LAOS_DATA_ROOT: item.dataRoot,
    LAOS_STATE_DIR: item.stateDir,
    LAOS_CHECKPOINT_WORKSPACE: "personal",
    LAOS_CHECKPOINT_PROJECT: "laos",
    LAOS_CHECKPOINT_CONFIDENTIALITY: "personal",
  };
}

// GP7-02: the vault publisher must run Core from the CURRENT authorized
// workspace (re-validated per call), never from a stale root captured at
// construction. A workspace swap between calls must change where Core runs.
test("GP7-02: vault.snapshot.publish uses the current codeRoot, not the construction-time root", async (t) => {
  const item = await fixture(t);
  let activeRoot = item.workspaceA;
  const receivedRoots = [];
  let publishCalls = 0;
  const vaultPublish = async (input, codeRoot) => {
    publishCalls += 1;
    receivedRoots.push(codeRoot);
    return {
      canonical_identity: "vault-note:test@x",
      note_id: "test",
      source_sha256: "0".repeat(64),
      identity_state: "front_matter",
      source_ref: "artifact:test",
      artifact_sha256: "test",
      payload_sha256: "0".repeat(64),
      partition: { workspace: "personal", project: "laos", confidentiality: "personal" },
    };
  };

  const tool = await createLaosMemoryTool(env(item), () => activeRoot, { vaultPublish });
  assert.ok(tool, "tool should be constructed");

  // Call 1: active workspace is A.
  await tool.call({
    task: { type: "vault.snapshot.publish", workspace: "personal", input: { relative_path: "P/t.md" } },
  });
  assert.equal(publishCalls, 1);
  assert.equal(receivedRoots[0], item.workspaceA, "first call runs from workspace A");

  // Swap the authorized workspace to B.
  activeRoot = item.workspaceB;

  // Call 2: publisher must run from the CURRENT workspace B, not captured A.
  await tool.call({
    task: { type: "vault.snapshot.publish", workspace: "personal", input: { relative_path: "P/t.md" } },
  });
  assert.equal(publishCalls, 2);
  assert.equal(receivedRoots[1], item.workspaceB, "second call runs from the swapped workspace B");
  assert.notEqual(receivedRoots[1], item.workspaceA, "must not use the stale construction-time root");
});

// The dispatcher re-validates the current root BEFORE routing to the vault
// publisher; a workspace that no longer contains a safe CLI must fail before
// the publisher is reached.
test("GP7-02: a workspace swap to a dir without a safe CLI fails closed before the publisher runs", async (t) => {
  const item = await fixture(t);
  const broken = path.join(item.workspaceA, "..", "noclone");
  await mkdir(broken, { recursive: true });
  let activeRoot = item.workspaceA;
  let publishCalls = 0;
  const vaultPublish = async () => {
    publishCalls += 1;
    throw new Error("should never be reached");
  };
  const tool = await createLaosMemoryTool(env(item), () => activeRoot, { vaultPublish });
  assert.ok(tool);

  activeRoot = broken;
  await assert.rejects(
    tool.call({
      task: { type: "vault.snapshot.publish", workspace: "personal", input: { relative_path: "P/t.md" } },
    }),
    /Authorized workspace|safe LAOS CLI|real directory/,
  );
  assert.equal(publishCalls, 0, "publisher must not be reached when the current root is invalid");
});
