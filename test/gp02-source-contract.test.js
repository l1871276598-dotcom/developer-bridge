import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildCanonicalNoteSnapshot, buildSnapshotFromRaw } from "../src/vault/snapshot.js";
import { buildNoteIdentity, canonicalNoteBytes } from "../src/vault/note-identity.js";
import { buildPartitionMap, resolvePartition } from "../src/vault/partition-map.js";

// GP-02: source byte contract. There is exactly ONE canonicalization. For every
// note variant, SHA256(payload.content) == identity.source_sha256, and the
// Bridge's derived source hash matches what Core will recompute.

const PARTITION = { workspace: "personal", project: "laos", confidentiality: "personal" };
const RULES = [
  { path_prefix: "01-Projects/LAOS", workspace: "personal", project: "laos", confidentiality: "personal" },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Each variant must satisfy: payload.content is canonicalNoteBytes(raw), and
// source_sha256 == SHA256(payload.content) == identity.source_sha256.
const VARIANTS = [
  { name: "plain markdown", raw: "just a note with no front matter\n" },
  { name: "front matter", raw: "---\nid: n001\ntitle: T\n---\n\nbody\n" },
  { name: "front matter key order variation", raw: "---\ntitle: T\nid: n001\nproject: laos\n---\n\nbody\n" },
  { name: "CRLF", raw: "---\r\nid: n001\r\ntitle: T\r\n---\r\n\r\nbody\r\n" },
  { name: "LF", raw: "---\nid: n001\ntitle: T\n---\n\nbody\n" },
  { name: "UTF-8 BOM", raw: "﻿---\nid: n001\ntitle: T\n---\n\nbody\n" },
  { name: "front matter formatting variation", raw: "---\nid: n001\ntitle: T\nproject : laos\n---\n\nbody\n" },
];

for (const variant of VARIANTS) {
  test(`GP-02 source contract: ${variant.name}`, () => {
    const relativePath = "01-Projects/LAOS/design.md";
    const partition = resolvePartition(buildPartitionMap(RULES), relativePath);
    const { identity, input } = buildCanonicalNoteSnapshot(variant.raw, relativePath, partition);

    // The payload content is exactly the canonical note bytes.
    assert.equal(input.payload.content, canonicalNoteBytes(variant.raw).toString("utf8"));
    // SHA256(payload.content) == identity.source_sha256.
    assert.equal(sha256(input.payload.content), identity.source_sha256);
    // And identity.source_sha256 == SHA256(canonicalNoteBytes(raw)).
    assert.equal(identity.source_sha256, sha256(canonicalNoteBytes(variant.raw)));
  });
}

test("GP-02: identity source_sha equals the payload content hash (single contract)", () => {
  const raw = "---\nid: n002\ntitle: T\n---\n\nbody\n";
  const relativePath = "01-Projects/LAOS/a.md";
  const partition = resolvePartition(buildPartitionMap(RULES), relativePath);
  const identity = buildNoteIdentity(raw, relativePath);
  const snapshot = buildSnapshotFromRaw(raw, identity, partition);
  assert.equal(snapshot.input.payload.content, canonicalNoteBytes(raw).toString("utf8"));
  assert.equal(snapshot.input.source.source_sha256, sha256(snapshot.input.payload.content));
  assert.equal(snapshot.input.source.source_sha256, identity.source_sha256);
});

test("GP-02: an identity that disagrees with the canonical bytes fails source_contract_violation", () => {
  const raw = "---\nid: n003\ntitle: T\n---\n\nbody A\n";
  const relativePath = "01-Projects/LAOS/b.md";
  const partition = resolvePartition(buildPartitionMap(RULES), relativePath);
  // Forge an identity whose source_sha256 does NOT match the canonical bytes.
  const forged = {
    ...buildNoteIdentity(raw, relativePath),
    source_sha256: "f".repeat(64),
    sha256: "f".repeat(64),
  };
  assert.throws(
    () => buildSnapshotFromRaw(raw, forged, partition),
    (e) => e.code === "source_contract_violation",
  );
});

test("GP-02: identity source_sha equals SHA256 of the canonical note bytes", () => {
  const raw = "---\nid: n005\ntitle: T\n---\n\nbody\n";
  const relativePath = "01-Projects/LAOS/c.md";
  const identity = buildNoteIdentity(raw, relativePath);
  assert.equal(identity.source_sha256, sha256(canonicalNoteBytes(raw)));
});
