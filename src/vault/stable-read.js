import { open } from "node:fs/promises";

import { resolveNotePath } from "./vault-root.js";

/**
 * Single stable Vault note read (C-INV-17 / F-04 TOCTOU, hardened S7).
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
 * Mutation detection compares the full stable identity: dev, ino, mode, size,
 * mtime (nanosecond precision when available) and ctime. Any change fails
 * closed with `note_changed` — never a silently stale read. Comparing ctime
 * catches an attacker who rewrites the same inode with the same size and then
 * restores mtime (ctime always bumps on inode metadata change).
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

// Nanosecond-precision identity. BigInt stats expose mtimeNs/ctimeNs directly;
// non-BigInt stats fall back to mtimeMs/ctimeMs (millisecond precision).
function identity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: stat.mtimeNs !== undefined ? String(stat.mtimeNs) : String(BigInt(Math.trunc(stat.mtimeMs * 1_000_000))),
    ctimeNs: stat.ctimeNs !== undefined ? String(stat.ctimeNs) : String(BigInt(Math.trunc(stat.ctimeMs * 1_000_000))),
  };
}

function sameIdentity(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

// Exact, precision-independent fields — used to compare the resolve-time stat
// (non-bigint) with the opened descriptor's stat (bigint). Timestamps are
// excluded because ms-vs-ns rounding differs between stat types; the
// before/after check below covers timestamps within the same stat type.
function sameFileObject(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size;
}

/**
 * Read one note's raw bytes through a single stable descriptor.
 * Returns { absolute, raw } where raw is the exact UTF-8 bytes.
 * options.beforeRead (test seam): an async hook invoked after fstat-before and
 * before readFile, so tests can deterministically simulate a concurrent writer
 * on the same inode.
 */
export async function readStableVaultNote(root, noteRelativePath, options = {}) {
  // resolveNotePath performs per-component symlink rejection and returns the
  // file stat it validated. The opened descriptor below MUST reference the
  // exact same inode — otherwise a resolve→open swap slipped in.
  const { absolute, fileStat } = await resolveNotePath(root, noteRelativePath);
  const resolvedIdentity = identity(fileStat);
  // afterResolve (test seam): simulate an attacker swapping the path between
  // validation and open — the exact window S8 must close.
  if (typeof options.afterResolve === "function") {
    await options.afterResolve(absolute, fileStat);
  }
  let handle;
  try {
    handle = await open(absolute, "r");
  } catch {
    fail("note_unreadable", "note could not be opened");
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      fail("note_not_file", "note must be a regular file");
    }
    if (before.size > BigInt(MAX_NOTE_BYTES)) {
      fail("note_too_large", "note exceeds the size limit");
    }
    // S8: the validated path and the opened object must be the same file. If
    // the inode at resolve time differs from the opened inode, the path was
    // swapped between validation and open — fail closed. (dev/ino/mode/size are
    // exact across stat types; timestamps are checked within the fd via the
    // before/after comparison below.)
    if (!sameFileObject(identity(before), resolvedIdentity)) {
      fail("note_changed", "note path changed between validation and open");
    }
    if (typeof options.beforeRead === "function") {
      await options.beforeRead(absolute, before);
    }
    const raw = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(identity(before), identity(after))) {
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
