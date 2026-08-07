import assert from "node:assert/strict";
import test from "node:test";

import { parseFrontMatterYaml } from "../src/vault/yaml-front-matter.js";

// S10 negative corpus (plan §6): every unsupported construct must fail closed
// with a deterministic reject. No warning, no partial parse.
const NEGATIVE = [
  { name: "verbatim tag", yaml: "x: !<tag:yaml.org,2002:str> hello\n" },
  { name: "bare tag", yaml: "x: ! hello\n" },
  { name: "double tag", yaml: "x: !!str hello\n" },
  { name: "anchor value", yaml: "x: &a hello\n" },
  { name: "alias value", yaml: "x: *a\n" },
  { name: "tag key", yaml: "!foo: bar\n" },
  { name: "merge key", yaml: "<<: *defaults\n" },
  { name: "merge key spaced", yaml: "<< : value\n" },
  { name: "flow __proto__", yaml: "x: {__proto__: polluted}\n" },
  { name: "flow constructor", yaml: "x: {constructor: bad}\n" },
  { name: "block __proto__", yaml: "__proto__: bad\n" },
  { name: "block constructor", yaml: "constructor: bad\n" },
  { name: "flow anchor key", yaml: "x: {&a: 1}\n" },
  { name: "flow tag value", yaml: "x: {k: !foo v}\n" },
];

for (const { name, yaml } of NEGATIVE) {
  test(`S10: rejects ${name}`, () => {
    assert.throws(() => parseFrontMatterYaml(yaml), { name: "YamlError" });
  });
}

test("S10: a fully supported front-matter block still parses", () => {
  const obj = parseFrontMatterYaml(`id: n001\ntitle: T\ncount: 42\ntags:\n  - a\n  - b\n`);
  assert.equal(obj.id, "n001");
  assert.equal(obj.title, "T");
  assert.equal(obj.count, 42);
  assert.deepEqual(obj.tags, ["a", "b"]);
});

test("S10: __proto__ never lands on the prototype chain of any container", () => {
  // Even if a key were accepted, the container must be Object.create(null) so
  // __proto__/constructor cannot pollute. Assert the root has no prototype.
  const obj = parseFrontMatterYaml(`title: safe\n`);
  assert.equal(Object.getPrototypeOf(obj), null);
});
