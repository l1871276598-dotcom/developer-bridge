import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";
import {
  ALLOWED_LAOS_TASKS,
  FROZEN_LAOS_TASKS,
} from "../src/laos-memory-tool.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.allowlist.test", type: "local-human" });

// 独立冻结集合：唯一用途是发现 ALLOWED_LAOS_TASKS 被错误扩权。
// 它故意与 FROZEN_LAOS_TASKS 分开维护；两者不一致即测试失败。
const EXPECTED_FROZEN_TASKS = Object.freeze([
  "memory.create",
  "memory.search",
  "context.build",
  "handoff.write",
  "vault.snapshot.publish",
  "loop.reflect",
  "loop.suggest-policies",
  "loop.generate-candidate",
  "loop.coordinate",
  "reflection.prepare",
  "reflection.apply",
  "reflection.record",
]);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-laos-allowlist-")));
  const workspace = path.join(base, "workspace");
  const coreRoot = path.join(base, "core-runtime");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([mkdir(workspace), mkdir(coreRoot), mkdir(dataRoot), mkdir(stateDir)]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), "{}\n", "utf8");
  await mkdir(path.join(coreRoot, "src"));
  await writeFile(path.join(coreRoot, "src", "laos.py"), "print('fixture')\n", "utf8");
  await git(workspace, "init", "--quiet", "-b", "feat/laos-allowlist");
  await git(workspace, "config", "user.name", "Test User");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(workspace, "context.txt"), "fixture", "utf8");
  await git(workspace, "add", "context.txt");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspace, coreRoot, dataRoot, stateDir };
}

function env(item) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LAOS_CORE_ROOT: item.coreRoot,
    LAOS_PYTHON_EXECUTABLE: process.env.LAOS_PYTHON_EXECUTABLE || "/opt/homebrew/bin/python3",
    DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1",
    LAOS_DATA_ROOT: item.dataRoot,
    LAOS_STATE_DIR: item.stateDir,
    LAOS_CHECKPOINT_WORKSPACE: "personal",
    LAOS_CHECKPOINT_PROJECT: "laos",
    LAOS_CHECKPOINT_CONFIDENTIALITY: "personal",
  };
}

async function createBridgeWithSpy(item) {
  let calls = 0;
  let vaultCalls = 0;
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: env(item),
    laosRunCommand: async (command, args) => {
      calls += 1;
      return { exitCode: 0, signal: null, stdout: `${JSON.stringify({ ok: true })}\n`, stderr: "" };
    },
    vaultPublish: async (input) => {
      vaultCalls += 1;
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
    },
  });
  return { bridge, spy: { get calls() { return calls; }, get vaultCalls() { return vaultCalls; } } };
}

test("ALLOWED_LAOS_TASKS equals the frozen allowlist exactly, no more and no less", () => {
  assert.deepEqual([...ALLOWED_LAOS_TASKS].sort(), [...EXPECTED_FROZEN_TASKS].sort());
  assert.equal(ALLOWED_LAOS_TASKS.has("memory.review"), false);
  assert.equal(ALLOWED_LAOS_TASKS.has("memory.activate"), false);
  // GP7-01: vault.read (raw vault read, no partition/scope) and evidence.publish
  // (synthetic evidence minting) must never be externally dispatchable.
  assert.equal(ALLOWED_LAOS_TASKS.has("vault.read"), false);
  assert.equal(ALLOWED_LAOS_TASKS.has("evidence.publish"), false);
});

test("FROZEN_LAOS_TASKS and EXPECTED_FROZEN_TASKS are identical frozen lists", () => {
  assert.deepEqual([...FROZEN_LAOS_TASKS], [...EXPECTED_FROZEN_TASKS]);
  assert.ok(Object.isFrozen(FROZEN_LAOS_TASKS));
  assert.ok(Object.isFrozen(ALLOWED_LAOS_TASKS));
});

test("exported laos_memory_task schema enum matches the frozen allowlist exactly", async (t) => {
  const item = await fixture(t);
  const { bridge } = await createBridgeWithSpy(item);

  const definition = bridge.tools.find(({ name }) => name === "laos_memory_task");
  assert.ok(definition, "laos_memory_task tool should be advertised");
  const enumVals = definition.inputSchema.properties.task.properties.type.enum;
  assert.deepEqual(enumVals.sort(), [...EXPECTED_FROZEN_TASKS].sort());
  assert.equal(enumVals.includes("memory.review"), false);
  assert.equal(enumVals.includes("memory.activate"), false);
});

for (const forbidden of [
  "memory.review",
  "memory.activate",
  "unknown.task",
  "import.file",
  // GP7-01: vault.read and evidence.publish must NOT be externally reachable —
  // otherwise the partition→verifyScope→evidence.publish chain could be
  // bypassed to read the vault directly, or synthetic evidence published.
  "vault.read",
  "evidence.publish",
]) {
  test(`rejects ${forbidden} at the Bridge boundary with operation_not_allowed and zero downstream calls`, async (t) => {
    const item = await fixture(t);
    const { bridge, spy } = await createBridgeWithSpy(item);

    const result = await bridge.callTool("laos_memory_task", {
      task: { type: forbidden, workspace: "personal", input: {} },
    });

    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error.code, "operation_not_allowed");
    assert.equal(parsed.error.message, "LAOS task failed.");
    assert.equal(spy.calls, 0);
    const text = result.content[0].text;
    assert.equal(text.includes(item.dataRoot), false);
    assert.equal(text.includes(item.stateDir), false);
    assert.equal(text.includes(item.workspace), false);
  });
}

test("rejects memory.review with a non-existent candidate id at the Bridge boundary, never reaching Core", async (t) => {
  const item = await fixture(t);
  const { bridge, spy } = await createBridgeWithSpy(item);

  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "memory.review",
      workspace: "personal",
      input: { candidate_id: "nonexistent-candidate-0000", decision: "accept" },
    },
  });

  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "operation_not_allowed");
  assert.equal(spy.calls, 0);
  const text = result.content[0].text;
  assert.equal(text.includes("nonexistent-candidate-0000"), false);
  assert.equal(text.includes("candidate"), false);
  assert.equal(text.includes(item.dataRoot), false);
});

test("does not leak dispatcher internals or module paths in rejections", async (t) => {
  const item = await fixture(t);
  const { bridge, spy } = await createBridgeWithSpy(item);

  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.activate", workspace: "personal", input: {} },
  });

  assert.equal(JSON.parse(result.content[0].text).error.code, "operation_not_allowed");
  const text = result.content[0].text;
  for (const leaked of ["laos-memory-tool", "normalizeTask", "dispatcher", "stack", "at ", "LaosMemoryToolError"]) {
    assert.equal(text.includes(leaked), false, `must not leak: ${leaked}`);
  }
  assert.equal(spy.calls, 0);
});

for (const allowed of ["memory.search", "context.build"]) {
  test(`passes allowlisted ${allowed} through the Bridge dispatcher`, async (t) => {
    const item = await fixture(t);
    const { bridge, spy } = await createBridgeWithSpy(item);

    const result = await bridge.callTool("laos_memory_task", {
      task: { type: allowed, workspace: "personal", input: { query: "test" } },
    });

    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.equal(spy.calls, 1);
  });
}

test("passes every remaining allowlisted task type through the Bridge dispatcher", async (t) => {
  const item = await fixture(t);
  const { bridge, spy } = await createBridgeWithSpy(item);
  const sampler = {
    "memory.create": { type: "principle", title: "t", scope: "global", workspace: "personal", confidentiality: "personal", source: "manual:user_confirmed", confidence: "confirmed", content: "c" },
    "context.build": { query: "t" },
    "handoff.write": { project_slug: "p", content: "# h" },
    "vault.snapshot.publish": {
      relative_path: "P/t.md",
    },
    "loop.reflect": {},
    "loop.suggest-policies": {},
    "loop.generate-candidate": {},
    "loop.coordinate": {},
    "reflection.prepare": {},
    "reflection.apply": {},
    "reflection.record": {},
  };

  for (const taskType of EXPECTED_FROZEN_TASKS) {
    const beforeCalls = spy.calls;
    const beforeVault = spy.vaultCalls;
    const result = await bridge.callTool("laos_memory_task", {
      task: { type: taskType, workspace: "personal", input: sampler[taskType] ?? {} },
    });
    assert.equal(result.isError, undefined, `${taskType}: ${result.content?.[0]?.text}`);
    if (taskType === "vault.snapshot.publish") {
      assert.equal(spy.vaultCalls, beforeVault + 1, `${taskType} should reach the vault publisher`);
      assert.equal(spy.calls, beforeCalls, `${taskType} should NOT reach the Core runner`);
    } else {
      assert.equal(spy.calls, beforeCalls + 1, `${taskType} should reach the runner`);
    }
  }
});
