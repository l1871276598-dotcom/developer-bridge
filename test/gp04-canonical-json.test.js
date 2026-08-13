import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../src/laos-memory-tool.js";

// GP-04: canonical JSON must be prototype-safe. A key named __proto__,
// constructor, or prototype must be treated as a plain own property — never
// trigger prototype/setter semantics that could collapse distinct payloads to
// one canonical form.

test("GP-04: canonicalJson sorts keys into a prototype-less object", () => {
  const canonical = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  assert.equal(canonical, '{"a":{"c":3,"d":2},"b":1}');
});

test("GP-04: __proto__ as a key is canonicalized as a plain own property", () => {
  const input = { content: "x", metadata: { title: "t" }, ["__proto__"]: { evil: 1 } };
  const canonical = canonicalJson(input);
  // __proto__ must appear as a real key in the output, not set the prototype.
  assert.ok(canonical.includes('"__proto__":'));
  // And the input object's own prototype must not have been polluted.
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test("GP-04: distinct payloads with __proto__ / constructor keys canonicalize differently", () => {
  const a = { content: "x", metadata: { title: "t" }, ["__proto__"]: { p: 1 } };
  const b = { content: "x", metadata: { title: "t" }, ["__proto__"]: { p: 2 } };
  const c = { content: "x", metadata: { title: "t" }, constructor: "c" };
  const shaA = canonicalJson(a);
  const shaB = canonicalJson(b);
  const shaC = canonicalJson(c);
  assert.notEqual(shaA, shaB);
  assert.notEqual(shaA, shaC);
  assert.notEqual(shaB, shaC);
});

test("GP-04: nested __proto__ keys are sorted and preserved", () => {
  const input = { content: "x", metadata: { ["__proto__"]: { z: 1 }, title: "t" } };
  const canonical = canonicalJson(input);
  assert.ok(canonical.includes('"__proto__":'));
  assert.ok(canonical.indexOf('"__proto__"') < canonical.indexOf('"title"'));
});

test("GP-04: key order does not affect the canonical form even with risky keys", () => {
  const inputA = { content: "x", metadata: { title: "t" }, constructor: "a" };
  const inputB = { constructor: "a", metadata: { title: "t" }, content: "x" };
  assert.equal(canonicalJson(inputA), canonicalJson(inputB));
});
