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
 * Convenience: build the envelope directly from raw note bytes.
 */
export function buildSnapshotFromRaw(raw, identity, partition) {
  const canonicalBytes = canonicalNoteBytes(raw);
  return buildSnapshotEnvelope(identity, partition, canonicalBytes.toString("utf8"));
}

export { canonicalNoteBytes };
