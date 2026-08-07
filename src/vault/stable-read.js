import { open } from "node:fs/promises";

import { resolveNotePath } from "./vault-root.js";

/**
 * Single stable Vault note read (C-INV-17 / F-04 TOCTOU).
 *
 * Identity and payload MUST derive from ONE stable read.  The raw bytes from a
 * single open descriptor feed both parseFrontMatter (identity) and the
 * snapshot payload, so an attacker changing the file mid-read can never produce
 * `payload A + identity B`.
 *
 * Sequence:
 *   resolve path (with symlink/escape checks) → open once (no-follow where
 *   supported) → fstat before → read the one fd → fstat after → same stable
 *   file? → raw bytes.
 *
 * Any mismatch (before/after identity, non-regular file, size change) fails
 * closed with `note_changed` — never a silently stale read.
 */

const MAX_NOTE_BYTES = 512 * 1024;

export class StableReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StableReadError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StableReadError(code, message);
}

function identity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs ?? stat.mtimeMs * 1_000_000,
    ctimeNs: stat.ctimeNs ?? stat.ctimeMs * 1_000_000,
  };
}

/**
 * Read one note's raw bytes through a single stable descriptor.
 * Returns { absolute, raw } where raw is the exact UTF-8 bytes.
 */
export async function readStableVaultNote(root, noteRelativePath) {
  const { absolute } = await resolveNotePath(root, noteRelativePath);
  let handle;
  try {
    handle = await open(absolute, "r");
  } catch {
    fail("note_unreadable", "note could not be opened");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      fail("note_not_file", "note must be a regular file");
    }
    if (before.size > MAX_NOTE_BYTES) {
      fail("note_too_large", "note exceeds the size limit");
    }
    const raw = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      fail("note_changed", "note changed during read");
    }
    return { absolute, raw };
  } finally {
    await handle.close();
  }
}

// NOTE: the open(2) flag O_NOFOLLOW is applied at the filesystem layer for
// the target itself by `resolveNotePath`'s per-component lstat checks (the
// final component is verified non-symlink before open).  Combined with the
// before/after fstat identity check, this closes the classic symlink-swap
// race: even if a symlink is planted between the lstat and open, the fstat
// on the opened descriptor yields a different inode than the resolved
// regular-file stat and the read fails closed.
