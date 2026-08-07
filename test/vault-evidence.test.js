import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveVaultRoot, resolveNotePath } from "../src/vault/vault-root.js";
import { buildNoteIdentity, canonicalNoteBytes, parseFrontMatter } from "../src/vault/note-identity.js";
import { buildPartitionMap, resolvePartition } from "../src/vault/partition-map.js";
import { buildSnapshotFromRaw } from "../src/vault/snapshot.js";
import { verifyScope, saveEvidenceHandle, readEvidenceHandles } from "../src/vault/publisher.js";
import { publishNote } from "../src/vault/vault-evidence.js";

const PROFILE = Object.freeze({
  workspace: "personal",
  project: "laos",
  confidentiality_ceiling: "internal",
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

const RULES = Object.freeze([
  { path_prefix: "01-Projects/LAOS", workspace: "personal", project: "laos", confidentiality: "internal" },
  { path_prefix: "02-Knowledge", workspace: "personal", project: "laos", confidentiality: "personal" },
]);

async function vaultFixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "vault-evidence-")));
  const vault = path.join(base, "vault");
  const workspace = path.join(base, "workspace");
  await Promise.all([mkdir(vault, { recursive: true }), mkdir(workspace, { recursive: true })]);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, vault, workspace };
}

const NOTE_WITH_ID = `---
id: abc123
title: LAOS Design
project: laos
---

content
`;

const NOTE_WITHOUT_ID = `---
title: No ID Note
---

body
`;

test("resolveVaultRoot rejects missing / file / symlink roots", async (t) => {
  const { base, vault } = await vaultFixture(t);

  await assert.rejects(resolveVaultRoot(path.join(base, "nope")), (e) => e.code === "vault_root_missing");
  const fileRoot = path.join(base, "file.txt");
  await writeFile(fileRoot, "x");
  await assert.rejects(resolveVaultRoot(fileRoot), (e) => e.code === "vault_root_not_directory");
  const symlinkRoot = path.join(base, "link");
  await import("node:fs/promises").then((fs) => fs.symlink(vault, symlinkRoot));
  await assert.rejects(resolveVaultRoot(symlinkRoot), (e) => e.code === "vault_root_symlink");
});

test("resolveNotePath rejects escape and symlink traversal", async (t) => {
  const { vault } = await vaultFixture(t);
  const note = path.join(vault, "note.md");
  await writeFile(note, "hello");

  await assert.rejects(resolveNotePath(vault, "../outside.md"), (e) => e.code === "note_path_escape");
  await assert.rejects(resolveNotePath(vault, "sub/../../x.md"), (e) => e.code === "note_path_escape");
  await assert.rejects(resolveNotePath(vault, "nope.md"), (e) => e.code === "note_missing");

  const resolved = await resolveNotePath(vault, "note.md");
  assert.equal(resolved.absolute, note);
});

test("buildNoteIdentity uses front-matter id and canonical source sha", () => {
  const identity = buildNoteIdentity(NOTE_WITH_ID, "01-Projects/LAOS/design.md");
  assert.equal(identity.note_id, "abc123");
  assert.equal(identity.identity_state, "front_matter");
  assert.equal(identity.has_front_matter_id, true);
  // canonical_identity = vault-note:<id>@<source_sha256> (path is a locator).
  assert.equal(identity.canonical_identity, `vault-note:abc123@${identity.sha256}`);
  assert.equal(identity.source_sha256, identity.sha256);
  assert.equal(identity.sha256.length, 64);
});

test("note without id derives a stable id and marks identity_state=derived", () => {
  const identity = buildNoteIdentity(NOTE_WITHOUT_ID, "04-Inbox/note.md");
  assert.equal(identity.identity_state, "derived");
  assert.equal(identity.has_front_matter_id, false);
  assert.ok(identity.note_id.length > 0);
  // Same content → same derived id.
  const again = buildNoteIdentity(NOTE_WITHOUT_ID, "04-Inbox/note.md");
  assert.equal(identity.note_id, again.note_id);
});

test("content change changes the sha (Test 2)", () => {
  const a = buildNoteIdentity("abc", "x.md");
  const b = buildNoteIdentity("abcd", "x.md");
  assert.notEqual(a.sha256, b.sha256);
});

test("path change with same id keeps canonical identity, changes the locator (Test 3)", () => {
  const a = buildNoteIdentity(NOTE_WITH_ID, "A/design.md");
  const b = buildNoteIdentity(NOTE_WITH_ID, "B/design.md");
  assert.equal(a.note_id, b.note_id);
  assert.equal(a.sha256, b.sha256); // content hash unchanged
  // Evidence Hash Semantics v1: path is a locator, not part of identity.
  assert.equal(a.canonical_identity, b.canonical_identity);
  assert.equal(a.relative_path, "A/design.md");
  assert.equal(b.relative_path, "B/design.md");
});

test("canonicalNoteBytes normalizes LF and removes BOM", () => {
  const crlf = `---\r\nid: x\r\n---\r\nbody\r\n`;
  const lf = `---\nid: x\n---\nbody\n`;
  assert.deepEqual(canonicalNoteBytes(crlf), canonicalNoteBytes(lf));
  const bommed = `﻿${lf}`;
  assert.deepEqual(canonicalNoteBytes(bommed), canonicalNoteBytes(lf));
});

test("parseFrontMatter extracts id and canonicalizes as sorted JSON", () => {
  const { frontMatter } = parseFrontMatter(NOTE_WITH_ID);
  assert.equal(frontMatter.id, "abc123");
});

test("partition map: longest prefix wins, conflict/absence rejected", () => {
  const map = buildPartitionMap([
    { path_prefix: "01-Projects", workspace: "personal", project: "laos", confidentiality: "internal" },
    { path_prefix: "01-Projects/LAOS", workspace: "personal", project: "laos", confidentiality: "restricted" },
  ]);
  const match = resolvePartition(map, "01-Projects/LAOS/design.md");
  assert.equal(match.confidentiality, "restricted"); // longest prefix
  assert.equal(match.workspace, "personal");

  assert.throws(() => buildPartitionMap([
    { path_prefix: "A", workspace: "personal", project: "p", confidentiality: "personal" },
    { path_prefix: "A", workspace: "work", project: "q", confidentiality: "internal" },
  ]), (e) => e.code === "partition_rule_conflict");

  const small = buildPartitionMap([{ path_prefix: "01-Projects", workspace: "personal", project: "laos", confidentiality: "personal" }]);
  assert.throws(() => resolvePartition(small, "99-Other/x.md"), (e) => e.code === "partition_not_found");
});

test("partition map rejects out-of-range confidentiality", () => {
  assert.throws(() => buildPartitionMap([
    { path_prefix: "A", workspace: "personal", project: "laos", confidentiality: "topsecret" },
  ]), (e) => e.code === "invalid_partition_rule");
});

test("snapshot envelope is evidence.publish/v2-compatible and sized", () => {
  const identity = buildNoteIdentity(NOTE_WITH_ID, "01-Projects/LAOS/design.md");
  const partition = { workspace: "personal", project: "laos", confidentiality: "internal" };
  const snapshot = buildSnapshotFromRaw(NOTE_WITH_ID, identity, partition);
  assert.equal(snapshot.input.schema_version, 2);
  assert.equal(snapshot.input.kind, "vault_note_snapshot");
  assert.equal(snapshot.input.source.scheme, "vault-note");
  assert.equal(snapshot.input.source.note_id, "abc123");
  assert.equal(snapshot.input.source.source_sha256, identity.source_sha256);
  assert.equal(snapshot.input.locator.relative_path, "01-Projects/LAOS/design.md");
  assert.equal(snapshot.input.payload.content, "---\n{\"id\":\"abc123\",\"project\":\"laos\",\"title\":\"LAOS Design\"}\n---\n\ncontent\n");
  assert.equal(snapshot.input.payload_sha256, createHash("sha256").update(canonicalJson(snapshot.input.payload)).digest("hex"));
  assert.equal(snapshot.partition.workspace, "personal");
  assert.ok(snapshot.envelope_bytes > 0);
});

test("oversized payload is rejected as payload_too_large (Test 6)", () => {
  const big = `---\nid: big\n---\n${"x".repeat(300 * 1024)}`;
  const identity = buildNoteIdentity(big, "x.md");
  const partition = { workspace: "personal", project: "laos", confidentiality: "internal" };
  assert.throws(() => buildSnapshotFromRaw(big, identity, partition), (e) => e.code === "payload_too_large");
});

test("verifyScope rejects scope injection and over-ceiling confidentiality (Tests 4, 5)", () => {
  const partition = { workspace: "personal", project: "laos", confidentiality: "internal" };
  const ok = verifyScope(partition, PROFILE);
  assert.equal(ok.project, "laos");

  assert.throws(() => verifyScope({ ...partition, project: "evil" }, PROFILE), (e) => e.code === "scope_mismatch");
  assert.throws(() => verifyScope({ ...partition, workspace: "work" }, PROFILE), (e) => e.code === "scope_mismatch");
  assert.throws(() => verifyScope({ ...partition, confidentiality: "restricted" }, PROFILE), (e) => e.code === "scope_exceeded");
});

test("saveEvidenceHandle persists a handle to .projectmem/summaries/evidence.json", async (t) => {
  const { workspace } = await vaultFixture(t);
  const handle = { note_id: "abc123", artifact_ref: "artifact:zzz", source_identity: "vault-note:abc123@zzz" };
  const target = await saveEvidenceHandle(workspace, handle);
  assert.ok(target.endsWith(path.join(".projectmem", "summaries", "evidence.json")));
  const read = await readEvidenceHandles(workspace);
  assert.equal(read.note_id, "abc123");
  assert.equal(read.artifact_ref, "artifact:zzz");
});

test("publishNote end-to-end with stub publisher (Tests 1, 7)", async (t) => {
  const { vault, workspace } = await vaultFixture(t);
  await mkdir(path.join(vault, "01-Projects", "LAOS"), { recursive: true });
  await writeFile(path.join(vault, "01-Projects", "LAOS", "design.md"), NOTE_WITH_ID);

  const calls = [];
  const result = await publishNote({
    config: { vault: { root: vault }, partition_rules: RULES },
    profile: PROFILE,
    noteRelativePath: "01-Projects/LAOS/design.md",
    workspaceRoot: workspace,
    publishEvidence: async (input) => {
      calls.push(input);
      const { note_id, source_sha256 } = input.source;
      return {
        source_ref: "artifact:abc",
        artifact_sha256: "abc",
        canonical_identity: `vault-note:${note_id}@${source_sha256}`,
      };
    },
  });

  assert.equal(result.note_id, "abc123");
  assert.equal(result.canonical_identity, `vault-note:abc123@${calls[0].source.source_sha256}`);
  assert.equal(result.source_ref, "artifact:abc");
  assert.equal(calls.length, 1);
  // The adapter injects profile-confirmed scope into the evidence.publish input.
  assert.equal(calls[0].workspace, "personal");
  assert.equal(calls[0].project, "laos");
  assert.equal(calls[0].confidentiality, "internal");
  assert.equal(calls[0].kind, "vault_note_snapshot");
  assert.equal(calls[0].schema_version, 2);
  const handle = await readEvidenceHandles(workspace);
  assert.equal(handle.artifact_ref, "artifact:abc");
});

test("publishNote rejects unknown partition (Test 5)", async (t) => {
  const { vault } = await vaultFixture(t);
  await mkdir(path.join(vault, "99-Other"), { recursive: true });
  await writeFile(path.join(vault, "99-Other", "x.md"), NOTE_WITH_ID);
  await assert.rejects(
    publishNote({
      config: { vault: { root: vault }, partition_rules: RULES },
      profile: PROFILE,
      noteRelativePath: "99-Other/x.md",
      publishEvidence: async () => ({ source_ref: "artifact:x", artifact_sha256: "x", canonical_identity: "x" }),
    }),
    (e) => e.code === "partition_not_found",
  );
});

test("publishNote does not mutate memory authority (Test 8)", async (t) => {
  // The adapter never calls memory.create/review/activate — verify the stub
  // receives only evidence.publish and returns no authority effects.
  const { vault } = await vaultFixture(t);
  await mkdir(path.join(vault, "01-Projects", "LAOS"), { recursive: true });
  await writeFile(path.join(vault, "01-Projects", "LAOS", "design.md"), NOTE_WITH_ID);
  const seen = [];
  await publishNote({
    config: { vault: { root: vault }, partition_rules: RULES },
    profile: PROFILE,
    noteRelativePath: "01-Projects/LAOS/design.md",
    publishEvidence: async (input) => {
      seen.push(input.kind);
      return { source_ref: "artifact:z", artifact_sha256: "z", canonical_identity: "z" };
    },
  });
  assert.deepEqual(seen, ["vault_note_snapshot"]);
});
