import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Vault root security — the only entry point for resolving a note path.
 *
 * The vault root is an administrator-frozen absolute path.  It is canonicalized
 * at startup and every resolved note path is forced to stay inside it:
 *   - absolute path required, no scheme/`..`/`\0`;
 *   - symlink traversal is rejected (lexical !== canonical, or any path part is
 *     a symlink);
 *   - non-directory roots are rejected;
 *   - note paths that escape the root are rejected.
 */

export class VaultRootError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VaultRootError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new VaultRootError(code, message);
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch {
    return null;
  }
}

/**
 * Canonicalize and validate a configured vault root.
 * Returns the resolved absolute canonical path.
 */
export async function resolveVaultRoot(input) {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.includes("\0") ||
    !path.isAbsolute(input)
  ) {
    fail("invalid_vault_root", "vault root must be an absolute local directory");
  }
  const lexical = path.resolve(input);
  const lexicalStat = await lstatOrNull(lexical);
  if (lexicalStat === null) {
    fail("vault_root_missing", "vault root does not exist");
  }
  if (lexicalStat.isSymbolicLink()) {
    fail("vault_root_symlink", "vault root must not be a symbolic link");
  }
  if (!lexicalStat.isDirectory()) {
    fail("vault_root_not_directory", "vault root must be a directory");
  }
  const canonical = await realpath(lexical);
  if (canonical !== lexical) {
    fail("vault_root_symlink", "vault root must not traverse a symbolic link");
  }
  return canonical;
}

/**
 * Normalize and validate a vault-relative path (GP-03). This is the SINGLE
 * locator validation used by the vault adapter and evidence snapshot. It
 * rejects traversal intent outright — `foo/../bar.md` is never normalized and
 * accepted, it fails. Also rejects:
 *   - absolute paths, drive/URL schemes
 *   - NUL, backslash (Windows separator ambiguity)
 *   - "." and ".." segments
 *   - empty segments where unsafe
 *   - empty or whitespace-only paths
 * Returns a canonical relative path (no leading/trailing slashes, no "." or
 * ".." segments, forward-slash separated).
 */
export function normalizeVaultRelativePath(notePath) {
  if (
    typeof notePath !== "string" ||
    notePath.length === 0 ||
    notePath.includes("\0") ||
    notePath.includes("\\") ||
    path.isAbsolute(notePath) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(notePath)
  ) {
    fail("invalid_note_path", "note path must be a non-empty relative path");
  }
  const segments = notePath.split("/");
  const cleaned = [];
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      fail("note_path_escape", "note path must not contain traversal segments");
    }
    if (segment === "") {
      fail("invalid_note_path", "note path must not contain empty segments");
    }
    cleaned.push(segment);
  }
  return cleaned.join("/");
}

/**
 * Resolve a note-relative path against a canonical vault root and prove the
 * result stays inside the root with no symlink traversal.
 * Returns { absolute, relative }.
 */
export async function resolveNotePath(root, notePath) {
  const relative = normalizeVaultRelativePath(notePath);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    fail("note_path_escape", "note path escapes the vault root");
  }

  // Walk each component and reject symlinks along the way.
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const info = await lstatOrNull(current);
    if (info === null) {
      fail("note_missing", "note does not exist");
    }
    if (info.isSymbolicLink()) {
      fail("note_path_symlink", "note path must not traverse a symbolic link");
    }
  }
  const fileStat = await stat(absolute, { bigint: true });
  if (!fileStat.isFile()) {
    fail("note_not_file", "note path must identify a regular file");
  }
  if (fileStat.nlink !== 1n) {
    fail("note_not_file", "note path must identify a single-link regular file");
  }
  return { absolute, relative, fileStat };
}
