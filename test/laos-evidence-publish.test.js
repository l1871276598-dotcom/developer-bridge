import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const operatorIdentity = Object.freeze({ id: "laos.evidence.test", type: "local-human" });

const PROFILE = Object.freeze({
  LAOS_CHECKPOINT_WORKSPACE: "personal",
  LAOS_CHECKPOINT_PROJECT: "laos",
  LAOS_CHECKPOINT_CONFIDENTIALITY: "personal",
});

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

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

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-laos-evidence-")));
  const workspace = path.join(base, "workspace");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([mkdir(workspace), mkdir(dataRoot), mkdir(stateDir)]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), "{}\n", "utf8");
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "laos.py"), "print('fixture')\n", "utf8");
  await git(workspace, "init", "--quiet", "-b", "feat/laos-evidence");
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
    ...PROFILE,
  };
}

function evidenceTask(overrides = {}) {
  const payload = overrides.payload ?? { content: "note body", metadata: { title: "t" } };
  const source = overrides.source ?? {
    scheme: "vault-note",
    note_id: "01HXYZ123",
    source_sha256: "",
  };
  const input = {
    schema_version: 2,
    kind: "vault_note_snapshot",
    source,
    locator: { relative_path: "Projects/LAOS/design.md" },
    payload,
    payload_sha256: overrides.payload_sha256 ?? "",
    ...(overrides.scope || {}),
  };
  if (!source.source_sha256) {
    const content = typeof payload.content === "string" ? payload.content : "";
    input.source.source_sha256 = createHash("sha256").update(content).digest("hex");
  }
  if (!input.payload_sha256 && typeof payload.content === "string") {
    input.payload_sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  }
  return { type: "evidence.publish", input };
}

// The canonical identity Core MUST derive from the same payload content.
function expectedIdentity(task) {
  const { note_id, source_sha256 } = task.input.source;
  return `vault-note:${note_id}@${source_sha256}`;
}

async function createBridge(item, laosRunCommand) {
  return createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: env(item),
    laosRunCommand: laosRunCommand ?? (async () => {
      throw new Error("unexpected runner call");
    }),
  });
}

// Returns a stub runner that echoes the derived canonical identity so the
// Bridge's round-trip validation (C-INV-14) succeeds.
function echoingRunner(captured) {
  return async (command, args) => {
    const idx = args.indexOf("--task-json") + 1;
    const sent = JSON.parse(args[idx]);
    captured?.push(sent);
    const identity = expectedIdentity({ type: "evidence.publish", input: sent.input });
    return {
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify({ ok: true, result: { canonical_identity: identity } })}\n`,
      stderr: "",
    };
  };
}

test("derives a safe confidentiality default when the profile omits it", async (t) => {
  const item = await fixture(t);
  const captured = [];
  // Profile env without LAOS_CHECKPOINT_CONFIDENTIALITY.
  const noCeilingEnv = {
    ...env(item),
  };
  delete noCeilingEnv.LAOS_CHECKPOINT_CONFIDENTIALITY;
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: noCeilingEnv,
    laosRunCommand: async (command, args) => {
      const idx = args.indexOf("--task-json") + 1;
      captured.push(JSON.parse(args[idx]));
      return {
        exitCode: 0,
        signal: null,
        stdout: `${JSON.stringify({ ok: true, result: { canonical_identity: expectedIdentity({ type: "evidence.publish", input: JSON.parse(args[idx]).input }) } })}\n`,
        stderr: "",
      };
    },
  });

  const payload = { content: "note body", metadata: { title: "t" } };
  const task = evidenceTask({ payload });
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(captured[0].input.confidentiality, "personal");
});

test("evidence.publish is in the frozen allowlist", () => {
  assert.equal(ALLOWED_LAOS_TASKS.has("evidence.publish"), true);
  assert.ok(FROZEN_LAOS_TASKS.includes("evidence.publish"));
});

test("advertises evidence.publish in the exported schema enum", async (t) => {
  const item = await fixture(t);
  const bridge = await createBridge(item);
  const definition = bridge.tools.find(({ name }) => name === "laos_memory_task");
  const enumVals = definition.inputSchema.properties.task.properties.type.enum;
  assert.equal(enumVals.includes("evidence.publish"), true);
  assert.equal(enumVals.includes("memory.review"), false);
  assert.equal(enumVals.includes("memory.activate"), false);
});

test("publishes a valid vault note snapshot through the Bridge, injecting trusted scope", async (t) => {
  const item = await fixture(t);
  const captured = [];
  const bridge = await createBridge(item, echoingRunner(captured));

  const payload = { content: "note body", metadata: { title: "design" } };
  const task = evidenceTask({ payload });
  const result = await bridge.callTool("laos_memory_task", { task });

  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const sent = captured[0];
  assert.equal(sent.type, "evidence.publish");
  // Caller-supplied scope is replaced by Bridge profile scope.
  assert.equal(sent.input.workspace, "personal");
  assert.equal(sent.input.project, "laos");
  assert.equal(sent.input.confidentiality, "personal");
  assert.equal(sent.input.schema_version, 2);
  // payload_sha256 recomputed by the Bridge from the canonical payload.
  assert.equal(sent.input.payload_sha256, createHash("sha256").update(canonicalJson(payload)).digest("hex"));
  // source_sha256 recomputed from payload.content.
  assert.equal(sent.input.source.source_sha256, createHash("sha256").update("note body").digest("hex"));
});

test("rejects a caller-supplied conflicting workspace as scope_mismatch without calling Core", async (t) => {
  const item = await fixture(t);
  let called = false;
  const bridge = await createBridge(item, async () => {
    called = true;
    throw new Error("must not run");
  });

  const payload = { a: 1, b: 2 };
  const sha = await import("node:crypto").then((c) =>
    c.createHash("sha256").update(canonicalJson(payload)).digest("hex"),
  );
  const task = evidenceTask({
    payload,
    payload_sha256: sha,
    scope: { workspace: "work", project: "evil", confidentiality: "restricted" },
  });
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
  assert.equal(called, false);
});

test("rejects a payload hash mismatch as source_hash_mismatch", async (t) => {
  const item = await fixture(t);
  let called = false;
  const bridge = await createBridge(item, async () => {
    called = true;
    throw new Error("must not run");
  });

  const task = evidenceTask({ payload: { content: "note body", metadata: { title: "t" } }, payload_sha256: "f".repeat(64) });
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "source_hash_mismatch");
  assert.equal(called, false);
});

test("rejects a source hash mismatch as source_hash_mismatch", async (t) => {
  const item = await fixture(t);
  let called = false;
  const bridge = await createBridge(item, async () => {
    called = true;
    throw new Error("must not run");
  });

  // source_sha256 does not match SHA256(payload.content).
  const task = evidenceTask({
    payload: { content: "note body", metadata: { title: "t" } },
    source: { scheme: "vault-note", note_id: "01HXYZ123", source_sha256: "e".repeat(64) },
  });
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "source_hash_mismatch");
  assert.equal(called, false);
});

test("rejects an oversized payload as payload_too_large without calling Core", async (t) => {
  const item = await fixture(t);
  let called = false;
  const bridge = await createBridge(item, async () => {
    called = true;
    throw new Error("must not run");
  });

  const big = { content: "x".repeat(300 * 1024), metadata: { title: "t" } };
  const task = evidenceTask({ payload: big });
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "payload_too_large");
  assert.equal(called, false);
});

test("rejects an invalid source identity as invalid_source_identity", async (t) => {
  const item = await fixture(t);
  let called = false;
  const bridge = await createBridge(item, async () => {
    called = true;
    throw new Error("must not run");
  });

  const task = evidenceTask({ source: { scheme: "file", note_id: "../etc", source_sha256: "0".repeat(64) } });
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "invalid_source_identity");
  assert.equal(called, false);
});

test("canonicalization is key-order independent (same payload, same sha)", async (t) => {
  const item = await fixture(t);
  const payloadA = { a: 1, b: 2, nested: { z: 1, y: [3, 2] } };
  const payloadB = { b: 2, a: 1, nested: { y: [3, 2], z: 1 } };
  const shaA = await import("node:crypto").then((c) =>
    c.createHash("sha256").update(canonicalJson(payloadA)).digest("hex"),
  );
  const shaB = await import("node:crypto").then((c) =>
    c.createHash("sha256").update(canonicalJson(payloadB)).digest("hex"),
  );
  assert.equal(shaA, shaB);
});

test("does not leak internal details in rejections", async (t) => {
  const item = await fixture(t);
  const bridge = await createBridge(item);
  const task = evidenceTask({ payload: { content: "note body", metadata: { title: "t" } }, payload_sha256: "f".repeat(64) });
  const result = await bridge.callTool("laos_memory_task", { task });
  const text = result.content[0].text;
  for (const leaked of [item.dataRoot, item.stateDir, item.workspace, "laos-memory-tool", "stack", "at "]) {
    assert.equal(text.includes(leaked), false, `must not leak: ${leaked}`);
  }
  const parsed = JSON.parse(text);
  assert.equal(parsed.error.code, "source_hash_mismatch");
  assert.equal(parsed.error.message, "LAOS task failed.");
});
