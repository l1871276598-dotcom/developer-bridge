import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Red-Team Regression Pack coverage manifest (plan §12). Every RT-01..RT-19
// attack must be represented by a named fail-closed regression test. This file
// asserts each RT maps to real test coverage so a future change cannot silently
// drop an attack without the manifest catching it.

const TEST_DIR = path.resolve(import.meta.dirname, ".");

async function grepCount(glob, pattern) {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(TEST_DIR);
  const targets = files.filter((f) => f.endsWith(".test.js") && glob.test(f));
  let total = 0;
  for (const f of targets) {
    const content = await readFile(path.join(TEST_DIR, f), "utf8");
    total += (content.match(pattern) || []).length;
  }
  return { files: targets, count: total };
}

// Each entry: RT id, coverage files, a pattern that must appear (evidence the
// attack is exercised).
const RT = [
  { id: "RT-01", files: /gp01|bridge-true-e2e/, pattern: /operation_not_allowed|synthetic/i, desc: "synthetic vault evidence rejected" },
  { id: "RT-02", files: /laos-evidence-publish|gp01/, pattern: /invalid_source_identity|fake/i, desc: "fake note identity rejected" },
  { id: "RT-03", files: /gp03/, pattern: /rejects traversal|note_path_escape|invalid_note_path/, desc: "fake locator rejected" },
  { id: "RT-04", files: /laos-scope-boundary|constitutional-scope/, pattern: /scope_mismatch/, desc: "caller scope injection rejected" },
  { id: "RT-05", files: /gp02/, pattern: /CRLF/, desc: "source byte CRLF contract" },
  { id: "RT-06", files: /gp02/, pattern: /BOM/, desc: "source byte BOM contract" },
  { id: "RT-07", files: /vault-stable-read/, pattern: /same-inode|same-size/, desc: "same-size same-inode mutation detected" },
  { id: "RT-08", files: /vault-stable-read/, pattern: /inode swap|afterResolve/, desc: "symlink/path swap detected" },
  { id: "RT-09", files: /gp03/, pattern: /normalizeVaultRelativePath|rejects traversal/, desc: "traversal locator rejected" },
  { id: "RT-10", files: /s10-yaml-negative/, pattern: /verbatim tag/, desc: "YAML verbatim tag rejected" },
  { id: "RT-11", files: /s10-yaml-negative/, pattern: /bare tag/, desc: "YAML bare tag rejected" },
  { id: "RT-12", files: /s10-yaml-negative/, pattern: /merge key/, desc: "YAML merge rejected" },
  { id: "RT-13", files: /s10-yaml-negative/, pattern: /flow __proto__/, desc: "flow __proto__ rejected" },
  { id: "RT-14", files: /gp04-canonical-json/, pattern: /__proto__/, desc: "canonicalJson __proto__ safe" },
  { id: "RT-15", files: /projectmem-core-client/, pattern: /core_malformed_response/, desc: "malformed Core handle fails closed" },
  { id: "RT-16", files: /bridge-info/, pattern: /no side effects|independently recomputable/, desc: "bridge_info side-effect free / auditable" },
  { id: "RT-17", files: /s15-authority-trap/, pattern: /memory\.review|nested/, desc: "nested memory.review unreachable" },
  { id: "RT-18", files: /s15-authority-trap/, pattern: /memory\.activate/, desc: "nested memory.activate unreachable" },
  { id: "RT-19", files: /constitutional-ingress/, pattern: /publish_source_artifact|src\/laos\.py|EvidenceAgent/, desc: "direct Core evidence bypass blocked" },
];

for (const { id, files, pattern, desc } of RT) {
  test(`RT regression manifest: ${id} (${desc}) has real coverage`, async () => {
    const { files: matched, count } = await grepCount(files, pattern);
    assert.ok(matched.length > 0, `${id}: no test file matched ${files}`);
    assert.ok(count > 0, `${id}: pattern ${pattern} not found in ${matched.join(",")}`);
  });
}
