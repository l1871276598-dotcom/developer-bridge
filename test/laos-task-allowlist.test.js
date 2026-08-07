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
  "evidence.publish",
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
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([mkdir(workspace), mkdir(dataRoot), mkdir(stateDir)]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), "{}\n", "utf8");
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "laos.py"), "print('fixture')\n", "utf8");
  await git(workspace, "init", "--quiet", "-b", "feat/laos-allowlist");
  await git(workspace, "config", "user.name", "Test User");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "add", "src/laos.py");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspace, dataRoot, stateDir };
}

function env(item) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
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
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: env(item),
    laosRunCommand: async (command, args) => {
      calls += 1;
      // evidence.publish must round-trip the derived canonical identity
      // (C-INV-14); echo it back so the dispatcher validation passes.
      const idx = args.indexOf("--task-json") + 1;
      let payload = { ok: true };
      if (idx > 0) {
        const task = JSON.parse(args[idx]);
        if (task.type === "evidence.publish") {
          const { note_id, source_sha256 } = task.input.source;
          payload = { ok: true, result: { canonical_identity: `vault-note:${note_id}@${source_sha256}` } };
        }
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: `${JSON.stringify(payload)}\n`,
        stderr: "",
      };
    },
  });
  return { bridge, spy: { get calls() { return calls; } } };
}

test("ALLOWED_LAOS_TASKS equals the frozen allowlist exactly, no more and no less", () => {
  assert.deepEqual([...ALLOWED_LAOS_TASKS].sort(), [...EXPECTED_FROZEN_TASKS].sort());
  assert.equal(ALLOWED_LAOS_TASKS.has("memory.review"), false);
  assert.equal(ALLOWED_LAOS_TASKS.has("memory.activate"), false);
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

for (const forbidden of ["memory.review", "memory.activate", "unknown.task", "import.file"]) {
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
  const evidencePayload = { content: "note body", metadata: { title: "t" } };
  const crypto = await import("node:crypto");
  const canonicalJsonFor = (value) => {
    const sorted = (v) => {
      if (Array.isArray(v)) return v.map(sorted);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
      }
      return v;
    };
    return JSON.stringify(sorted(value));
  };
  const evidenceSha = crypto.createHash("sha256").update(canonicalJsonFor(evidencePayload)).digest("hex");
  const sourceSha = crypto.createHash("sha256").update("note body").digest("hex");
  const sampler = {
    "memory.create": { type: "principle", title: "t", scope: "global", workspace: "personal", confidentiality: "personal", source: "manual:user_confirmed", confidence: "confirmed", content: "c" },
    "context.build": { query: "t" },
    "handoff.write": { project_slug: "p", content: "# h" },
    "evidence.publish": {
      schema_version: 2,
      kind: "vault_note_snapshot",
      source: { scheme: "vault-note", note_id: "01HXYZ", source_sha256: sourceSha },
      locator: { relative_path: "P/t.md" },
      payload: evidencePayload,
      payload_sha256: evidenceSha,
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
    const before = spy.calls;
    const result = await bridge.callTool("laos_memory_task", {
      task: { type: taskType, workspace: "personal", input: sampler[taskType] ?? {} },
    });
    assert.equal(result.isError, undefined, `${taskType}: ${result.content?.[0]?.text}`);
    assert.equal(spy.calls, before + 1, `${taskType} should reach the runner`);
  }
});
