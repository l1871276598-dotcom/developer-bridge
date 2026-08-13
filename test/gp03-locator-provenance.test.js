import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeVaultRelativePath, resolveNotePath } from "../src/vault/vault-root.js";

// GP-03: locator provenance — traversal intent is rejected outright, never
// normalized-then-accepted.

async function vaultFixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "gp03-")));
  const vault = path.join(base, "vault");
  await mkdir(path.join(vault, "00-System"), { recursive: true });
  await writeFile(path.join(vault, "00-System", "Policy.md"), "policy\n");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { vault };
}

const INVALID = [
  "../x",
  "a/../../x",
  "./x",
  "a/../x",
  "\\..\\x",
  "/absolute",
  "a//b", // empty segment
  "a/./b",
  "..",
  "a\\b", // backslash ambiguity
];

for (const bad of INVALID) {
  test(`GP-03: normalizeVaultRelativePath rejects traversal/ambiguous: ${JSON.stringify(bad)}`, () => {
    assert.throws(() => normalizeVaultRelativePath(bad), (e) => {
      return e.code === "note_path_escape" || e.code === "invalid_note_path";
    });
  });
}

test("GP-03: resolveNotePath rejects traversal intent before touching disk", async (t) => {
  const { vault } = await vaultFixture(t);
  for (const bad of ["../x", "a/../x", "\\..\\x", "/absolute"]) {
    await assert.rejects(resolveNotePath(vault, bad), (e) => {
      return e.code === "note_path_escape" || e.code === "invalid_note_path";
    });
  }
});

test("GP-03: a legitimate relative path normalizes and resolves", async (t) => {
  const { vault } = await vaultFixture(t);
  assert.equal(normalizeVaultRelativePath("00-System/Policy.md"), "00-System/Policy.md");
  const { absolute, relative } = await resolveNotePath(vault, "00-System/Policy.md");
  assert.equal(relative, "00-System/Policy.md");
  assert.equal(absolute, path.join(vault, "00-System", "Policy.md"));
});

test("GP-03: NUL is rejected", async (t) => {
  const { vault } = await vaultFixture(t);
  assert.throws(() => normalizeVaultRelativePath("a\0b"), (e) => e.code === "invalid_note_path");
  await assert.rejects(resolveNotePath(vault, "a\0b"), (e) => e.code === "invalid_note_path");
});
