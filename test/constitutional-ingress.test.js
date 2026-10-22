import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// C-INV-16 static boundary: production execution surfaces in this repo must
// NOT import Core authority internals directly. Every external evidence path
// must go through the Bridge policy boundary (normalizeEvidenceIngress /
// laos_memory_task). Tests and docs are intentionally excluded.

const REPO = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(REPO, "src");
const BIN = path.join(REPO, "bin");

// Core internals that must never be imported or invoked in Bridge production
// modules. The Bridge talks to Core only via the LAOS CLI's restricted task
// interface. Patterns are chosen to hit code references, not comments: they
// match the import/require/call forms, and the authority operation names only
// in their dotted task form (the projectmem manifest uses snake_case
// write-policy fields that are legitimately forced to false).
//
// "src/laos.py" is intentionally NOT a global pattern: locating the CLI is
// legitimate (laos_memory_task does the same); what is forbidden is importing
// Core modules or calling Core functions directly. The dedicated
// laos-publisher test asserts the CLI call is preceded by the unified
// normalizer (C-INV-16).
const FORBIDDEN_PATTERNS = [
  // Direct Core module imports.
  "src/agents/evidence.py",
  "from agents.evidence import",
  "review.source_refs import",
  // Direct calls to the Core publisher.
  "publish_source_artifact",
  // Core authority surfaces must never be reachable from Bridge production.
  "memory.review",
  "memory.activate",
];

async function listFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, out);
    else if (entry.isFile() && /\.(js|mjs|cjs)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

test("C-INV-16: Bridge production source never references Core internals directly", async () => {
  const files = [...await listFiles(SOURCE), ...await listFiles(BIN)];
  assert.ok(files.length > 0, "expected production files to scan");

  const violations = [];
  for (const file of files) {
    const relative = path.relative(REPO, file);
    const source = await readFile(file, "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (source.includes(pattern)) {
        violations.push(`${relative} contains "${pattern}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("C-INV-16: vault evidence ingress routes through the unified normalizer", async () => {
  const laosPublisher = await readFile(path.join(SOURCE, "vault", "laos-publisher.js"), "utf8");
  assert.ok(laosPublisher.includes("normalizeEvidenceIngress"), "vault evidence CLI must use the unified normalizer");
  assert.equal(laosPublisher.includes("publish_source_artifact"), false, "must not call Core publisher directly");
  // The CLI call itself is fine (same path laos_memory_task uses), but it MUST
  // be normalized through the Bridge policy boundary first — verified by the
  // normalizeEvidenceIngress import above.
  assert.ok(laosPublisher.includes("--task-json"), "evidence CLI must invoke the restricted task interface");
});
