import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("npm test runs only the P0 test suite", async () => {
  const packagePath = path.resolve(import.meta.dirname, "..", "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(manifest.scripts?.test, "node --test test/*.test.js");
});
