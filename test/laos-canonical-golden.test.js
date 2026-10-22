import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../src/laos-memory-tool.js";

// LAOS Canonical JSON v1 golden vectors (frozen in
// docs/adr/evidence-hash-semantics-v1.md). Fixed expected digests, verified
// independently in Node and Python — neither side trusts the other.
const GOLDEN = [
  {
    payload: { content: "hello", metadata: { title: "World" } },
    sha256: "740f2bd6ac530daabc4ab36e7dc17ae51886c8e81f473c1cb6ca366f5992d8f0",
  },
  {
    payload: { content: "你好世界", metadata: { title: "设计注意事项" } },
    sha256: "27206f916c8e44d94587ef0b36bf585a5e8db460a1ac0ef605565deafa4eed62",
  },
  {
    payload: { content: 'quote " and \n newline', metadata: { title: "esc" } },
    sha256: "82d48f49055144586ec61ebbd240be42d90bdba80b8d0abd8b6eecca3946d793",
  },
  {
    payload: { content: "nested", metadata: { a: { b: [1, 2, 3], c: "x" }, title: "t" } },
    sha256: "ae4a9663d705d259cdeddb429fc17406cba2a3cfadcda18b0701c61e623b1fd6",
  },
  {
    payload: { content: "k", metadata: {} },
    sha256: "da9af6ea9b3ccdae0b3ee710e839111d035ca5f9126a987183ec6baf27208533",
  },
  {
    payload: { content: "key order", metadata: { z: 1, a: { y: [3, 2], x: "n" }, m: null } },
    sha256: "35770bc99abfab12f2e410fc17608f6ac2a7cff7e4aada8f9cd5bde67c9d00c3",
  },
];

for (const [index, entry] of GOLDEN.entries()) {
  test(`LAOS canonical JSON v1 golden vector V${index} matches the frozen digest`, () => {
    const canonical = canonicalJson(entry.payload);
    const computed = createHash("sha256").update(canonical).digest("hex");
    assert.equal(computed, entry.sha256);
  });
}

test("LAOS canonical JSON v1 is key-order independent (same payload, same digest)", () => {
  const a = { content: "x", metadata: { z: 1, a: [1, 2] } };
  const b = { metadata: { a: [1, 2], z: 1 }, content: "x" };
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test("LAOS canonical JSON v1 sorts nested keys recursively", () => {
  const canonical = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  assert.equal(canonical, '{"a":{"c":3,"d":2},"b":1}');
});

test("LAOS canonical JSON v1 rejects non-finite numbers", () => {
  assert.throws(() => canonicalJson({ content: "x", metadata: { n: NaN } }));
  assert.throws(() => canonicalJson({ content: "x", metadata: { n: Infinity } }));
});
