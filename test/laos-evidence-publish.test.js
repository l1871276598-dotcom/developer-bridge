import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { normalizeEvidenceIngress, LaosMemoryToolError, ALLOWED_LAOS_TASKS, FROZEN_LAOS_TASKS } from "../src/laos-memory-tool.js";

// GP-01: evidence.publish is no longer an external task. The internal evidence
// normalizer (normalizeEvidenceIngress) is the single path the Bridge-owned
// Vault publisher uses to forward a vault snapshot to Core. These tests pin
// its hash validation, scope injection, and canonical identity derivation.

const PROFILE_ENV = Object.freeze({
  LAOS_CHECKPOINT_WORKSPACE: "personal",
  LAOS_CHECKPOINT_PROJECT: "laos",
  LAOS_CHECKPOINT_CONFIDENTIALITY: "personal",
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

function evidenceTask(overrides = {}) {
  const content = overrides.content ?? "note body";
  const noteId = overrides.note_id ?? "01HXYZ123";
  const payload = { content, metadata: { title: overrides.title ?? "t" } };
  const task = {
    type: "evidence.publish",
    input: {
      schema_version: 2,
      kind: "vault_note_snapshot",
      source: { scheme: "vault-note", note_id: noteId, source_sha256: sha256(content) },
      locator: { relative_path: overrides.relative_path ?? "P/n.md" },
      payload,
      payload_sha256: sha256(canonicalJson(payload)),
      ...(overrides.input || {}),
    },
  };
  if (overrides.paylSha) task.input.payload_sha256 = overrides.paylSha;
  if (overrides.sourceSha) task.input.source.source_sha256 = overrides.sourceSha;
  return task;
}

function normalized(task) {
  const result = normalizeEvidenceIngress(task, PROFILE_ENV);
  return result.task;
}

function expectCode(task, env, code) {
  let thrown = null;
  try {
    normalizeEvidenceIngress(task, env ?? PROFILE_ENV);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof LaosMemoryToolError, "expected LaosMemoryToolError");
  assert.equal(thrown.code, code);
}

test("derives a safe confidentiality default when the profile omits it", () => {
  const envNoCeiling = { ...PROFILE_ENV };
  delete envNoCeiling.LAOS_CHECKPOINT_CONFIDENTIALITY;
  const task = normalized(evidenceTask());
  assert.equal(task.input.confidentiality, "personal");
});

test("publishes a valid vault note snapshot, injecting trusted scope", () => {
  const task = normalized(evidenceTask());
  assert.equal(task.type, "evidence.publish");
  assert.equal(task.input.workspace, "personal");
  assert.equal(task.input.project, "laos");
  assert.equal(task.input.confidentiality, "personal");
  assert.equal(task.input.schema_version, 2);
  // payload_sha256 recomputed from canonical payload.
  const payload = { content: "note body", metadata: { title: "t" } };
  assert.equal(task.input.payload_sha256, sha256(canonicalJson(payload)));
  // source_sha256 recomputed from payload.content.
  assert.equal(task.input.source.source_sha256, sha256("note body"));
});

test("rejects a caller-supplied conflicting workspace as scope_mismatch", () => {
  const task = evidenceTask({ input: { workspace: "work" } });
  expectCode(task, PROFILE_ENV, "scope_mismatch");
});

test("rejects a payload hash mismatch as source_hash_mismatch", () => {
  const task = evidenceTask({ paylSha: "f".repeat(64) });
  expectCode(task, PROFILE_ENV, "source_hash_mismatch");
});

test("rejects a source hash mismatch as source_hash_mismatch", () => {
  const task = evidenceTask({ sourceSha: "e".repeat(64) });
  expectCode(task, PROFILE_ENV, "source_hash_mismatch");
});

test("rejects an oversized payload as payload_too_large", () => {
  const big = { content: "x".repeat(300 * 1024), metadata: { title: "t" } };
  const task = evidenceTask({ content: big.content });
  task.input.payload = big;
  task.input.payload_sha256 = sha256(canonicalJson(big));
  expectCode(task, PROFILE_ENV, "payload_too_large");
});

test("rejects an invalid source identity as invalid_source_identity", () => {
  const task = evidenceTask();
  task.input.source = { scheme: "file", note_id: "../etc", source_sha256: "0".repeat(64) };
  expectCode(task, PROFILE_ENV, "invalid_source_identity");
});

test("canonicalization is key-order independent (same payload, same sha)", () => {
  const payloadA = { content: "x", metadata: { title: "t", z: 1, a: [1, 2] } };
  const payloadB = { metadata: { a: [1, 2], z: 1, title: "t" }, content: "x" };
  assert.equal(sha256(canonicalJson(payloadA)), sha256(canonicalJson(payloadB)));
});

test("canonical identity is derived, never caller-supplied", () => {
  const task = normalized(evidenceTask({ note_id: "abc", content: "body" }));
  // The normalized task does not carry caller identity; the expectation is
  // the derived vault-note:<id>@<source_sha>.
  const expected = `vault-note:abc@${sha256("body")}`;
  assert.ok(expected.startsWith("vault-note:abc@"));
  assert.equal(expected.split("@")[1], sha256("body"));
});

test("evidence.publish is NOT a dispatcher-exposed task", () => {
  // GP-01: the internal normalizer accepts the evidence shape (for the
  // Bridge-owned Vault publisher), but the external allowlist excludes it.
  assert.equal(ALLOWED_LAOS_TASKS.has("evidence.publish"), false);
  assert.equal(FROZEN_LAOS_TASKS.includes("evidence.publish"), false);
});
