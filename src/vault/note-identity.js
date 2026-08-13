import { createHash } from "node:crypto";

import { parseFrontMatterYaml, YamlError } from "./yaml-front-matter.js";

/**
 * Vault note identity — vault-note:<id>@<sha256>.
 *
 * The id is taken from the note's Front Matter `id` field when present.  If the
 * id is absent we never write back; we only derive a deterministic id and mark
 * the identity state as "derived" (never a verified source).
 *
 * The sha256 is NOT the raw on-disk bytes.  It is computed over canonical note
 * bytes: UTF-8, LF newlines, BOM removed, body preserved, Front Matter
 * canonicalized as sorted JSON.
 */

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const BOM = "﻿";

export class NoteIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NoteIdentityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new NoteIdentityError(code, message);
}

function stripBom(text) {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/gu, "\n");
}

/**
 * Parse a note's Front Matter block.
 * Returns { frontMatter: object|null, bodyStart }.
 */
export function parseFrontMatter(raw) {
  const text = stripBom(normalizeNewlines(raw));
  const match = FRONT_MATTER_RE.exec(text);
  if (!match) return { frontMatter: null, bodyStart: 0 };
  let parsed;
  try {
    parsed = parseFrontMatterYaml(match[1]);
  } catch (error) {
    if (error instanceof YamlError) {
      fail("invalid_front_matter", "Front Matter is not valid YAML");
    }
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("invalid_front_matter", "Front Matter must be a mapping");
  }
  return { frontMatter: parsed, bodyStart: match[0].length };
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
 * Canonical note bytes: body preserved as-is (LF newlines), Front Matter
 * replaced by its canonical sorted-JSON form.
 */
export function canonicalNoteBytes(raw) {
  const text = stripBom(normalizeNewlines(raw));
  const { frontMatter, bodyStart } = parseFrontMatter(text);
  if (frontMatter === null) {
    return Buffer.from(text, "utf8");
  }
  const body = text.slice(bodyStart);
  const fmJson = canonicalJson(frontMatter);
  return Buffer.from(`---\n${fmJson}\n---\n${body}`, "utf8");
}

/**
 * Deterministic derived note id (used only when Front Matter has no id).
 * Based on the canonical bytes so it is stable across line endings.
 */
export function derivedNoteId(raw) {
  return createHash("sha256").update(canonicalNoteBytes(raw)).digest("hex").slice(0, 16);
}

/**
 * Build a note identity envelope (Evidence Hash Semantics v1).
 *
 * canonical_identity = vault-note:<id>@<source_sha256>
 *
 * The path is NOT part of the canonical identity — it is only a locator.  A
 * rename (A/design.md → B/design.md) with unchanged note_id and content keeps
 * the canonical source identity; the artifact may change because the locator is
 * bound into the artifact body.  See docs/adr/evidence-hash-semantics-v1.md §3.
 *
 * Returns {
 *   canonical_identity, note_id, sha256, source_sha256, identity_state,
 *   front_matter_id, has_front_matter_id, relative_path
 * }
 */
export function buildNoteIdentity(raw, relativePath) {
  const bytes = canonicalNoteBytes(raw);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const { frontMatter } = parseFrontMatter(raw);
  const fmId = frontMatter && typeof frontMatter.id === "string" ? frontMatter.id : null;
  const hasFrontMatterId = typeof fmId === "string" && fmId.length > 0;

  if (!hasFrontMatterId) {
    const noteId = derivedNoteId(raw);
    return {
      canonical_identity: `vault-note:${noteId}@${sourceSha256}`,
      note_id: noteId,
      sha256: sourceSha256,
      source_sha256: sourceSha256,
      identity_state: "derived",
      front_matter_id: null,
      has_front_matter_id: false,
      relative_path: relativePath,
    };
  }

  return {
    canonical_identity: `vault-note:${fmId}@${sourceSha256}`,
    note_id: fmId,
    sha256: sourceSha256,
    source_sha256: sourceSha256,
    identity_state: "front_matter",
    front_matter_id: fmId,
    has_front_matter_id: true,
    relative_path: relativePath,
  };
}

// buildNoteIdentity from raw bytes is the single source of note identity. Call
// sites must read the note once (readStableVaultNote) and pass the same bytes
// here so identity and payload derive from one stable read (C-INV-17).
export function readNoteIdentity(raw, relativePath) {
  if (typeof raw !== "string") {
    fail("invalid_note_content", "note content must be a string");
  }
  return buildNoteIdentity(raw, relativePath);
}
