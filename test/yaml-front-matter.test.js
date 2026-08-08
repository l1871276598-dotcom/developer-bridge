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
  // Parser uses Object.create(null) for mappings (F-06 prototype-pollution
  // defense); assert fields individually.
  assert.equal(obj.author.name, "Alice");
  assert.equal(obj.author.email, "alice@example.com");
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
  // Flow maps are Object.create(null) (prototype-pollution defense), so assert
  // fields individually.
  assert.equal(obj.meta.k, "v");
  assert.equal(obj.meta.n, 1);
  assert.equal(Object.getPrototypeOf(obj.meta), null);
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

test("F-06: rejects duplicate mapping keys instead of last-wins", () => {
  assert.throws(() => parseFrontMatterYaml(`id: A\nid: B\n`), { name: "YamlError" });
});

test("F-06: rejects duplicate keys inside nested mappings", () => {
  assert.throws(() => parseFrontMatterYaml(`meta:\n  k: 1\n  k: 2\n`), { name: "YamlError" });
});

test("F-06: rejects __proto__ as a mapping key (prototype pollution)", () => {
  assert.throws(() => parseFrontMatterYaml(`__proto__:\n  polluted: true\n`), { name: "YamlError" });
});

test("F-06: rejects constructor as a mapping key", () => {
  assert.throws(() => parseFrontMatterYaml(`constructor: evil\n`), { name: "YamlError" });
});

test("F-06: rejects prototype as a mapping key", () => {
  assert.throws(() => parseFrontMatterYaml(`prototype: evil\n`), { name: "YamlError" });
});

test("F-06: rejects YAML merge key (<<)", () => {
  assert.throws(() => parseFrontMatterYaml(`<<: *anchor\n`), { name: "YamlError" });
});

test("F-06: rejects anchors and aliases", () => {
  assert.throws(() => parseFrontMatterYaml(`base: &base\n  k: v\nother: *base\n`), { name: "YamlError" });
});

test("F-06: rejects custom tags", () => {
  assert.throws(() => parseFrontMatterYaml(`id: !!binary xyz\n`), { name: "YamlError" });
});

test("F-06: rejects keys that are not safe plain scalars", () => {
  assert.throws(() => parseFrontMatterYaml(`[a]: 1\n`), { name: "YamlError" });
});

test("GP6-02: rejects a nested key indented with spaces+tab (R11 bypass)", () => {
  // Leading spaces before the tab meant col-0-only tab checks let this through;
  // a tab anywhere in the leading whitespace is ambiguous and must fail closed.
  assert.throws(() => parseFrontMatterYaml("parent:\n \tchild: x\n"), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml("parent:\n   \tchild: x\n"), { name: "YamlError" });
});

test("GP6-02: rejects flow collections whose commas are inside quotes", () => {
  // Naive split(",") would turn ["a,b","c"] into ["a","b","c"] — a silent
  // misparse that must fail closed rather than drop quote boundaries.
  assert.throws(() => parseFrontMatterYaml('tags: ["a,b","c"]\n'), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml("tags: ['a,b','c']\n"), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml('meta: {k: "a,b", n: 1}\n'), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml('tags: ["a, b", "c d"]\n'), { name: "YamlError" });
});

test("GP7-05: rejects nested flow collections instead of silently mis-splitting", () => {
  // Naive split(",") would turn [a, [b, c]] into ["a", "[b", "c]"] and
  // {k: {a: 1}, n: 3} into {"k": "{a: 1", "b": "2}", "n": 3} — silent
  // misparse that must fail closed.
  assert.throws(() => parseFrontMatterYaml("tags: [a, [b, c]]\n"), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml("meta: {k: {a: 1, b: 2}, n: 3}\n"), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml("meta: {k: {a: 1,b: 2}, n: 3}\n"), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml("tags: [a, {k: v}, c]\n"), { name: "YamlError" });
});

test("GP8-04: strips a comment after a completed quoted scalar (no silent divergence)", () => {
  // Previously `id: "alpha" # comment` fell through to raw-text return and
  // silently kept the quotes+comment in the value (`"alpha" # comment`).
  assert.equal(parseFrontMatterYaml('id: "alpha" # comment\n').id, "alpha");
  assert.equal(parseFrontMatterYaml("id: 'alpha' # comment\n").id, "alpha");
});

test("GP8-04: rejects malformed quoted scalars and unbalanced flow (fail closed)", () => {
  // Trailing junk after a closed quote, unterminated quotes, and unbalanced
  // flow collections are silent-misparse vectors and must reject.
  assert.throws(() => parseFrontMatterYaml('id: "alpha" junk\n'), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml('id: "alpha\n'), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml("x: [a, b]]\n"), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml("x: [a, b\n"), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml("x: {a: 1\n"), { name: "YamlError" });
  assert.throws(() => parseFrontMatterYaml('x: ["a, b]\n'), { name: "YamlError" });
});
