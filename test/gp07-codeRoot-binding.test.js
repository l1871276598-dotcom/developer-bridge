import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createLaosMemoryTool } from "../src/laos-memory-tool.js";
import { runCli } from "../src/vault/laos-publisher.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-gp07-")));
  const workspaceA = path.join(base, "workspaceA");
  const workspaceB = path.join(base, "workspaceB");
  const coreRoot = path.join(base, "core-runtime");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([
    mkdir(workspaceA), mkdir(workspaceB), mkdir(coreRoot), mkdir(dataRoot), mkdir(stateDir),
  ]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), "{}\n", "utf8");
  // The immutable Core runtime holds laos.py; the writable workspaces hold only
  // data context (no laos.py — Core never executes from them, GP8-01).
  await mkdir(path.join(coreRoot, "src"));
  await writeFile(path.join(coreRoot, "src", "laos.py"), "print('core')\n", "utf8");
  for (const ws of [workspaceA, workspaceB]) {
    await git(ws, "init", "--quiet", "-b", "main");
    await git(ws, "config", "user.name", "Test User");
    await git(ws, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(ws, "context.txt"), path.basename(ws), "utf8");
    await git(ws, "add", "context.txt");
    await git(ws, "commit", "--quiet", "-m", "fixture");
  }
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspaceA, workspaceB, coreRoot, dataRoot, stateDir };
}

function env(item) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LAOS_CORE_ROOT: item.coreRoot,
    LAOS_DATA_ROOT: item.dataRoot,
    LAOS_STATE_DIR: item.stateDir,
    LAOS_CHECKPOINT_WORKSPACE: "personal",
    LAOS_CHECKPOINT_PROJECT: "laos",
    LAOS_CHECKPOINT_CONFIDENTIALITY: "personal",
  };
}

// GP8-01: Core always executes from the IMMUTABLE LAOS_CORE_ROOT runtime, never
// from the Agent-writable workspace. A workspace swap (A→B) must not change
// where Core runs — the mutable workspace is only a data/project context.
test("GP8-01: Core runs from the immutable coreRoot, never the writable workspace", async (t) => {
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

  // Call 1: publisher receives the immutable coreRoot, NOT workspace A.
  await tool.call({
    task: { type: "vault.snapshot.publish", workspace: "personal", input: { relative_path: "P/t.md" } },
  });
  assert.equal(publishCalls, 1);
  assert.equal(receivedRoots[0], item.coreRoot, "Core runs from the immutable runtime root");

  // Swap the authorized workspace to B — Core execution must NOT move.
  activeRoot = item.workspaceB;

  await tool.call({
    task: { type: "vault.snapshot.publish", workspace: "personal", input: { relative_path: "P/t.md" } },
  });
  assert.equal(publishCalls, 2);
  assert.equal(receivedRoots[1], item.coreRoot, "Core still runs from the immutable runtime root");
  assert.equal(receivedRoots[1], receivedRoots[0], "workspace swap never changes Core execution root");
});

// GP7-04: runCli is a bounded spawn — a hung Core child is killed via the
// timeout, and a chatty child is killed via the output cap, so a malicious
// vault FIFO (or any unresponsive CLI) can never block the Bridge forever.
function makeFakeCli(dir, body) {
  // The fake "python" is a shell script named LAOS_PYTHON_EXECUTABLE.
  const fake = path.join(dir, "fake-python.sh");
  return writeFile(fake, `#!/bin/sh\n${body}\n`, { mode: 0o755 }).then(() => fake);
}

async function fakeWorkspace(base) {
  const ws = path.join(base, "w");
  await mkdir(path.join(ws, "src"), { recursive: true });
  await writeFile(path.join(ws, "src", "laos.py"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await git(ws, "init", "--quiet", "-b", "main");
  await git(ws, "config", "user.name", "Test User");
  await git(ws, "config", "user.email", "test@example.invalid");
  await git(ws, "add", "src/laos.py");
  await git(ws, "commit", "--quiet", "-m", "fixture");
  return ws;
}

test("GP7-04: runCli kills a hung Core child (timeout, not forever)", async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-gp07-timeout-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const ws = await fakeWorkspace(base);
  const fake = await makeFakeCli(base, "sleep 300");
  const env = { LAOS_DATA_ROOT: "/tmp", LAOS_STATE_DIR: "/tmp", LAOS_PYTHON_EXECUTABLE: fake };
  const start = Date.now();
  await assert.rejects(runCli(env, "{}", ws, { timeoutMs: 300 }), /timed out/i);
  assert.ok(Date.now() - start < 5_000, "must not block for the full 300s sleep");
});

test("GP7-04: runCli kills a chatty Core child (output cap, no unbounded buffering)", async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-gp07-cap-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const ws = await fakeWorkspace(base);
  const fake = await makeFakeCli(base, 'i=0; while [ $i -lt 800000 ]; do echo "x"; i=$((i+1)); done');
  const env = { LAOS_DATA_ROOT: "/tmp", LAOS_STATE_DIR: "/tmp", LAOS_PYTHON_EXECUTABLE: fake };
  await assert.rejects(runCli(env, "{}", ws), /output limit exceeded/i);
});
test("GP8-01: a workspace swap to a non-directory fails closed before the publisher runs", async (t) => {
  const item = await fixture(t);
  const broken = path.join(item.workspaceA, "..", "not-a-dir");
  await writeFile(broken, "file", "utf8");
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
    /Authorized workspace|real directory|not a directory/,
  );
  assert.equal(publishCalls, 0, "publisher must not be reached when the current workspace is invalid");
});
