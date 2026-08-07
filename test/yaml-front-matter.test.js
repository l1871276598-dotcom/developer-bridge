import assert from "node:assert/strict";
import test from "node:test";

import { parseFrontMatterYaml } from "../src/vault/yaml-front-matter.js";

test("parses flat scalars and types", () => {
  const obj = parseFrontMatterYaml(`
id: abc123
title: LAOS Design
count: 42
ratio: 3.14
active: true
nothing: null
`);
  assert.equal(obj.id, "abc123");
  assert.equal(obj.title, "LAOS Design");
  assert.equal(obj.count, 42);
  assert.equal(obj.ratio, 3.14);
  assert.equal(obj.active, true);
  assert.equal(obj.nothing, null);
});

test("parses quoted strings", () => {
  const obj = parseFrontMatterYaml(`
title: "quoted \"value\""
path: 'single quoted'
`);
  assert.equal(obj.title, 'quoted "value"');
  assert.equal(obj.path, "single quoted");
});

test("parses block sequence under a key", () => {
  const obj = parseFrontMatterYaml(`
tags:
  - alpha
  - beta
  - gamma
`);
  assert.deepEqual(obj.tags, ["alpha", "beta", "gamma"]);
});

test("parses nested mapping", () => {
  const obj = parseFrontMatterYaml(`
author:
  name: Alice
  email: alice@example.com
`);
  assert.deepEqual(obj.author, { name: "Alice", email: "alice@example.com" });
});

test("skips comments and blank lines", () => {
  const obj = parseFrontMatterYaml(`
# top comment
id: x  # trailing comment
type: note

created: 2026-01-01
`);
  assert.equal(obj.id, "x");
  assert.equal(obj.type, "note");
});

test("parses flow sequences and maps inline", () => {
  const obj = parseFrontMatterYaml(`
tags: [a, b, c]
meta: {k: v, n: 1}
`);
  assert.deepEqual(obj.tags, ["a", "b", "c"]);
  assert.deepEqual(obj.meta, { k: "v", n: 1 });
});

test("parses mixed nesting: sequence of nested objects stays scalar-safe", () => {
  const obj = parseFrontMatterYaml(`
verified_scope:
  - memory_authority_chain_author_direction（长文本）
  - memory_authority_chain_language_r2（另一条）
project: LAOS
`);
  assert.equal(obj.project, "LAOS");
  assert.equal(obj.verified_scope.length, 2);
  assert.ok(obj.verified_scope[0].includes("author_direction"));
});

test("rejects a root-level block sequence (no mapping key)", () => {
  assert.throws(() => parseFrontMatterYaml(`- a\n- b`), { name: "YamlError" });
});
