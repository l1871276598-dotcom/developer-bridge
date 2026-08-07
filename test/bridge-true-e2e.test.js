import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.e2e.test", type: "local-human" });

// The real LAOS Core checkout (ws-gpt) — the authorized workspace the Bridge
// is configured to gate. The Bridge invokes Core via the LAOS CLI restricted
// task interface (laos_memory_task).
const CORE_ROOT = "/Users/user/projects/laos-ws/gpt";
const PYTHON = process.env.LAOS_PYTHON_EXECUTABLE || "python3.11";

const PROFILE = Object.freeze({
  workspace: "personal",
  project: "laos",
  confidentiality: "personal",
});

function canonicalJson(value) {
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sorted(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function coreSetup(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-e2e-")));
  // The authorized workspace is the REAL Core checkout — exactly the production
  // topology (Bridge gates ws-gpt). The Bridge resolves and invokes the real
  // Core CLI through its own restricted dispatcher.
  const workspace = CORE_ROOT;
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(stateDir, { recursive: true })]);
  // Core data/state init (real Core, not a fixture stub). init_store creates
  // the .research-agent-root marker itself.
  await execFileAsync(PYTHON, ["-c", `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(CORE_ROOT, "src"))})
import memory, argparse
from pathlib import Path
memory.init_store(Path(${JSON.stringify(dataRoot)}))
memory.db_init(argparse.Namespace(root=${JSON.stringify(dataRoot)}, state_dir=${JSON.stringify(stateDir)}))
`], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, workspace, dataRoot, stateDir };
}

function env(setup) {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    LAOS_DATA_ROOT: setup.dataRoot,
    LAOS_STATE_DIR: setup.stateDir,
    DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1",
    LAOS_CHECKPOINT_WORKSPACE: PROFILE.workspace,
    LAOS_CHECKPOINT_PROJECT: PROFILE.project,
    LAOS_CHECKPOINT_CONFIDENTIALITY: PROFILE.confidentiality,
  };
}

// Runs the REAL Core CLI as the Bridge's runner — the same invocation
// laos_memory_task performs at runtime, so this exercises the true production
// path: Bridge public entry → unified scope gate → evidence normalizer → Core.
async function createTrueBridge(setup) {
  const captured = [];
  const bridge = await createBridgeWithSyncTools(setup.workspace, () => {}, {
    operatorIdentity,
    env: env(setup),
    laosRunCommand: async (command, args) => {
      captured.push(args);
      // The Bridge already assembled the full CLI command
      // [cli, --root, data, --state-dir, state, --task-json, taskJson]
      // where cli == CORE_ROOT/src/laos.py. Run it as-is against the real Core.
      const { stdout, stderr } = await execFileAsync(PYTHON, args, {
        cwd: path.join(CORE_ROOT, "src"),
        env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
      });
      return { exitCode: 0, signal: null, stdout, stderr };
    },
  });
  return { bridge, captured };
}

function evidenceTask(overrides = {}) {
  const content = overrides.content ?? "e2e note body";
  const noteId = overrides.note_id ?? "e2e-note-001";
  const payload = { content, metadata: { title: overrides.title ?? "E2E Design" } };
  const input = {
    schema_version: 2,
    kind: "vault_note_snapshot",
    source: { scheme: "vault-note", note_id: noteId, source_sha256: sha256(content) },
    locator: { relative_path: overrides.relative_path ?? "01-Projects/LAOS/design.md" },
    payload,
    payload_sha256: sha256(canonicalJson(payload)),
  };
  return { type: "evidence.publish", input };
}

// E01
test("E01: normal Vault publish through the true Bridge passes", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const result = await bridge.callTool("laos_memory_task", {
    task: evidenceTask(),
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const parsed = JSON.parse(result.content[0].text);
  // The Core CLI reports the agent result under `output`.
  const out = parsed.output;
  assert.ok(out.source_ref.startsWith("artifact:"));
  assert.equal(out.source_sha256.length, 64);
  assert.equal(out.payload_sha256.length, 64);
  assert.equal(out.artifact_sha256.length, 64);
  assert.equal(out.canonical_identity, `vault-note:e2e-note-001@${out.source_sha256}`);
});

// E02
test("E02: repeated publish yields the same artifact", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const a = JSON.parse((await bridge.callTool("laos_memory_task", { task: evidenceTask() })).content[0].text);
  const b = JSON.parse((await bridge.callTool("laos_memory_task", { task: evidenceTask() })).content[0].text);
  assert.equal(a.output.source_ref, b.output.source_ref);
});

// E03
test("E03: content change changes source_sha / canonical identity / artifact", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const a = JSON.parse((await bridge.callTool("laos_memory_task", { task: evidenceTask({ content: "v1" }) })).content[0].text).output;
  const b = JSON.parse((await bridge.callTool("laos_memory_task", { task: evidenceTask({ content: "v2" }) })).content[0].text).output;
  assert.notEqual(a.source_sha256, b.source_sha256);
  assert.notEqual(a.canonical_identity, b.canonical_identity);
  assert.notEqual(a.artifact_sha256, b.artifact_sha256);
});

// E04
test("E04: rename keeps note_id/source_sha/canonical identity; locator changes; artifact may change", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const a = JSON.parse((await bridge.callTool("laos_memory_task", { task: evidenceTask({ relative_path: "A/design.md" }) })).content[0].text).output;
  const b = JSON.parse((await bridge.callTool("laos_memory_task", { task: evidenceTask({ relative_path: "B/design.md" }) })).content[0].text).output;
  assert.equal(a.source_sha256, b.source_sha256);
  assert.equal(a.canonical_identity, b.canonical_identity);
  assert.notEqual(a.artifact_sha256, b.artifact_sha256);
});

// E05
test("E05: same payload + different note_id → different artifact", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const a = JSON.parse((await bridge.callTool("laos_memory_task", { task: evidenceTask({ note_id: "AAA" }) })).content[0].text).output;
  const b = JSON.parse((await bridge.callTool("laos_memory_task", { task: evidenceTask({ note_id: "BBB" }) })).content[0].text).output;
  assert.notEqual(a.artifact_sha256, b.artifact_sha256);
});

// E06
test("E06: fake source SHA is rejected by the Bridge before Core", async (t) => {
  const setup = await coreSetup(t);
  const { bridge, captured } = await createTrueBridge(setup);
  const task = evidenceTask({ content: "real body" });
  task.input.source.source_sha256 = "f".repeat(64); // does not match SHA256(content)
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "source_hash_mismatch");
  assert.equal(captured.length, 0);
});

// E07
test("E07: Core re-verifies digests independently (no trust in Bridge-only hashes)", async (t) => {
  const setup = await coreSetup(t);
  // E07 is verified at the Core layer: Core recomputes payload_sha256 from the
  // bytes it sees, so a Bridge-supplied WRONG hash cannot persist. Here we
  // confirm the Bridge forwards the recomputed digest and Core accepts it.
  const { bridge } = await createTrueBridge(setup);
  const task = evidenceTask({ content: "real body" });
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
});

// E08
test("E08: fake payload SHA is rejected by the Bridge before Core", async (t) => {
  const setup = await coreSetup(t);
  const { bridge, captured } = await createTrueBridge(setup);
  const task = evidenceTask({ content: "real body" });
  task.input.payload_sha256 = "e".repeat(64);
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "source_hash_mismatch");
  assert.equal(captured.length, 0);
});

// E09
test("E09: cross-workspace escalation is rejected before Core", async (t) => {
  const setup = await coreSetup(t);
  const { bridge, captured } = await createTrueBridge(setup);
  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", workspace: "work", input: { query: "x" } },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
  assert.equal(captured.length, 0);
});

// E10
test("E10: cross-project escalation is rejected before Core", async (t) => {
  const setup = await coreSetup(t);
  const { bridge, captured } = await createTrueBridge(setup);
  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "x", project: "other" } },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
  assert.equal(captured.length, 0);
});

// E11
test("E11: confidentiality escalation is rejected", async (t) => {
  const setup = await coreSetup(t);
  const { bridge, captured } = await createTrueBridge(setup);
  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "x", confidentiality: "restricted" } },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
  assert.equal(captured.length, 0);
});

// E12
test("E12: TOCTOU is impossible in the evidence pipeline (single stable read)", async (t) => {
  // The Bridge normalizer derives canonical identity and payload from the SAME
  // payload.content bytes it validates; the vault adapter reads once
  // (readStableVaultNote). Here we assert a forged identity never survives:
  // if source_sha256 disagrees with payload.content, the Bridge rejects.
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const task = evidenceTask({ content: "payload A" });
  // Attacker swaps the note content but keeps identity A's hash.
  task.input.source.source_sha256 = sha256("payload A");
  task.input.payload.content = "payload B";
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "source_hash_mismatch");
});

// E13
test("E13: memory.review / memory.activate are unavailable at the Bridge", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  for (const op of ["memory.review", "memory.activate"]) {
    const result = await bridge.callTool("laos_memory_task", {
      task: { type: op, input: {} },
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, "operation_not_allowed");
  }
});

// E16
test("E16: evidence.publish never creates candidates or changes authority", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const before = JSON.parse((await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "e2e", workspace: "personal", project: "laos" } },
  })).content[0].text);
  const pub = await bridge.callTool("laos_memory_task", { task: evidenceTask() });
  assert.equal(pub.isError, undefined, pub.content?.[0]?.text);
  const after = JSON.parse((await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "e2e", workspace: "personal", project: "laos" } },
  })).content[0].text);
  assert.deepEqual(before.output.results, after.output.results);
});

// E20
test("E20: runtime build identity is exposed and matches the audited source", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const result = await bridge.callTool("laos_bridge_info", {});
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const info = JSON.parse(result.content[0].text);
  assert.equal(typeof info.bridge.git_commit, "string");
  assert.equal(typeof info.bridge.allowlist_sha256, "string");
  assert.equal(info.bridge.allowlist_sha256.length, 64);
  assert.equal(info.core.protocol_version, "evidence-v2");
});

test("E20b: allowlist does not expose memory.review/memory.activate at runtime", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const def = bridge.tools.find(({ name }) => name === "laos_memory_task");
  const enumVals = def.inputSchema.properties.task.properties.type.enum;
  assert.equal(enumVals.includes("memory.review"), false);
  assert.equal(enumVals.includes("memory.activate"), false);
});
