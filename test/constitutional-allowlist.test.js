import assert from "node:assert/strict";
import test from "node:test";

import { ALLOWED_LAOS_TASKS, FROZEN_LAOS_TASKS } from "../src/laos-memory-tool.js";

// C-INV-20: the Bridge allowlist is the restricted laos_memory_task interface.
// It MUST contain only the frozen task set, and MUST never expose the generic
// Core authority dispatch surface.
const EXPECTED = Object.freeze([
  "memory.create",
  "memory.search",
  "context.build",
  "handoff.write",
  "evidence.publish",
  "loop.reflect",
  "loop.suggest-policies",
  "loop.generate-candidate",
  "loop.coordinate",
  "reflection.prepare",
  "reflection.apply",
  "reflection.record",
]);

const AUTHORITY_OPS = Object.freeze(["memory.review", "memory.activate", "review.list", "review.show", "review.decide", "import.file", "import.chatgpt"]);

test("C-INV-20: allowlist equals the frozen task set exactly", () => {
  assert.deepEqual([...FROZEN_LAOS_TASKS], EXPECTED);
  assert.deepEqual([...ALLOWED_LAOS_TASKS].sort(), [...EXPECTED].sort());
});

test("C-INV-20: authority and generic dispatch operations are excluded", () => {
  for (const op of AUTHORITY_OPS) {
    assert.equal(ALLOWED_LAOS_TASKS.has(op), false, `allowlist must not contain ${op}`);
  }
});

test("C-INV-20: allowlist is immutable", () => {
  assert.ok(Object.isFrozen(FROZEN_LAOS_TASKS));
  assert.ok(Object.isFrozen(ALLOWED_LAOS_TASKS));
  assert.throws(() => {
    FROZEN_LAOS_TASKS.push("memory.review");
  }, TypeError);
});

test("C-INV-20: allowlist is stable and documented (no drift)", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const repo = path.resolve(import.meta.dirname, "..");
  const adr = await fs.readFile(path.join(repo, "docs", "adr", "evidence-hash-semantics-v1.md"), "utf8");
  const constitution = await fs.readFile(path.join(repo, "docs", "governance", "LAOS-CONSTITUTION.md"), "utf8");
  assert.ok(constitution.includes("C-INV-20"));
  assert.ok(adr.length > 0);
});
