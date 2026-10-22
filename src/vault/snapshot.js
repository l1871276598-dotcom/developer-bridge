import { createHash } from "node:crypto";

import { canonicalNoteBytes } from "./note-identity.js";

/**
 * Vault snapshot envelope — produces the exact `input` shape consumed by the
 * deployed evidence.publish/v2 contract (see docs/adr/evidence-hash-semantics-v1.md
 * and src/laos-memory-tool.js normalizeEvidenceTask):
 *
 *   input: {
 *     schema_version: 2,
 *     kind: "vault_note_snapshot",
 *     source: { scheme, note_id, source_sha256 },
 *     locator: { relative_path },
 *     payload: { content, metadata },
 *     payload_sha256,
 *   }
 *
 * source_sha256 is the canonical note bytes sha256 (same as identity.sha256).
 * payload_sha256 is SHA256(LAOSCanonicalJSON(payload)), NOT the note-bytes
 * hash — the three digests are distinct (C-INV-15). The path is a locator and
 * is NOT part of the canonical identity (docs/adr/evidence-hash-semantics-v1.md §3).
 *
 * The partition (workspace/project/confidentiality) is carried separately for
 * the publisher's Phase-4 scope verification and is NOT included in the input:
 * the Bridge injects scope from its profile, and Core's EvidenceAgent rejects
 * unknown input keys.
 *
 * Constraints:
 *   - the canonical envelope stays under 256 KiB.
 */

const MAX_ENVELOPE_BYTES = 256 * 1024;

export class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SnapshotError(code, message);
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

/**
 * Build the evidence.publish/v2 input + partition for one note.
 * identity: from buildNoteIdentity
 * partition: from resolvePartition
 * Returns { input, partition, payload_sha256, envelope_sha256, envelope_bytes }.
 */
export function buildSnapshotEnvelope(identity, partition, noteContent) {
  if (typeof noteContent !== "string") {
    fail("invalid_note_content", "note content must be a string");
  }
  const payload = {
    content: noteContent,
    metadata: {
      title: identity.front_matter_id ? identity.front_matter_id : identity.note_id,
    },
  };
  const input = {
    schema_version: 2,
    kind: "vault_note_snapshot",
    source: {
      scheme: "vault-note",
      note_id: identity.note_id,
      source_sha256: identity.source_sha256,
    },
    locator: {
      relative_path: identity.relative_path,
    },
    payload,
    payload_sha256: canonicalJsonSha256(payload),
  };
  const canonical = canonicalJson({ input, partition });
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > MAX_ENVELOPE_BYTES) {
    fail("payload_too_large", "snapshot envelope exceeds 256 KiB");
  }
  return {
    input,
    partition: { ...partition },
    payload_sha256: canonicalJsonSha256(payload),
    envelope_sha256: createHash("sha256").update(canonical).digest("hex"),
    envelope_bytes: bytes,
  };
}

function canonicalJsonSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * GP-02: the single source-byte contract. From one raw note read, produce
 * canonical bytes, note identity, and the evidence snapshot such that:
 *
 *   SHA256(payload.content UTF-8) == identity.source_sha256
 *
 * There is exactly ONE canonicalization (canonicalNoteBytes) — no second YAML
 * re-implementation in Bridge or Core. buildSnapshotFromRaw routes through
 * here so the two code paths cannot drift.
 */
export function buildCanonicalNoteSnapshot(raw, relativePath, partition) {
  const canonicalBytes = canonicalNoteBytes(raw);
  const noteContent = canonicalBytes.toString("utf8");
  // Identity is built from the ORIGINAL raw bytes (buildNoteIdentity internally
  // canonicalizes); passing already-canonical bytes would re-canonicalize the
  // front matter and change the hash. The invariant below proves the two
  // canonicalizations agree.
  const { buildNoteIdentity } = noteIdentityModule;
  const identity = buildNoteIdentity(raw, relativePath);
  const envelope = buildSnapshotEnvelope(identity, partition, noteContent);
  // Invariant assertion: the payload content bytes hash to the identity's
  // source hash. Any drift is a source_contract_violation and must never reach
  // Core.
  const actual = sha256Hex(noteContent);
  if (actual !== identity.source_sha256) {
    fail("source_contract_violation", "payload.content does not match the canonical note source hash");
  }
  return { identity, ...envelope };
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Lazily resolved to avoid an import cycle (note-identity → yaml → snapshot is
// acyclic, but keeping the reference explicit avoids surprises).
const noteIdentityModule = await import("./note-identity.js");

/**
 * Convenience: build the envelope directly from raw note bytes, routing
 * through the single source-byte contract so identity and payload derive from
 * the same canonical bytes (GP-02). The provided identity must match.
 */
export function buildSnapshotFromRaw(raw, identity, partition) {
  const canonicalBytes = canonicalNoteBytes(raw);
  const noteContent = canonicalBytes.toString("utf8");
  const envelope = buildSnapshotEnvelope(identity, partition, noteContent);
  const actual = sha256Hex(noteContent);
  if (actual !== identity.source_sha256) {
    fail("source_contract_violation", "payload.content does not match the canonical note source hash");
  }
  return envelope;
}

export { canonicalNoteBytes };
