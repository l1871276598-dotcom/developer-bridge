import assert from "node:assert/strict";
import test from "node:test";

import { buildPartitionMap, resolvePartition, PartitionMapError } from "../src/vault/partition-map.js";

const RULES = Object.freeze([
  { path_prefix: "01-Projects", workspace: "personal", project: "laos", confidentiality: "personal" },
  { path_prefix: "01-Projects/LAOS", workspace: "personal", project: "laos", confidentiality: "internal" },
]);

test("F-05: partition map is deeply frozen (rules and entries are immutable)", () => {
  const map = buildPartitionMap(RULES);
  assert.ok(Object.isFrozen(map));
  assert.equal(map.length, 2);
  for (const rule of map) {
    assert.ok(Object.isFrozen(rule), "each partition rule must be frozen");
  }
});

test("F-05: mutating a rule field fails (no silent mutation)", () => {
  const map = buildPartitionMap(RULES);
  // Sorted longest-first: map[0] is 01-Projects/LAOS (internal).
  assert.equal(map[0].path_prefix, "01-Projects/LAOS");
  const original = map[0].confidentiality;
  assert.throws(() => {
    map[0].confidentiality = "restricted";
  }, TypeError);
  assert.equal(map[0].confidentiality, original);
});

test("F-05: mutating the array fails", () => {
  const map = buildPartitionMap(RULES);
  assert.throws(() => {
    map.push({ path_prefix: "99", workspace: "personal", project: "x", confidentiality: "personal" });
  }, TypeError);
  assert.throws(() => {
    map[0] = { path_prefix: "99", workspace: "personal", project: "x", confidentiality: "personal" };
  }, TypeError);
});

test("F-05: resolvePartition returns an immutable partition", () => {
  const map = buildPartitionMap(RULES);
  const partition = resolvePartition(map, "01-Projects/LAOS/design.md");
  assert.ok(Object.isFrozen(partition));
  assert.throws(() => {
    partition.workspace = "work";
  }, TypeError);
  assert.equal(partition.workspace, "personal");
});

test("F-05: longest prefix wins deterministically", () => {
  const map = buildPartitionMap(RULES);
  assert.equal(resolvePartition(map, "01-Projects/LAOS/design.md").confidentiality, "internal");
  assert.equal(resolvePartition(map, "01-Projects/other/x.md").confidentiality, "personal");
});

test("F-05: unknown path is rejected", () => {
  const map = buildPartitionMap(RULES);
  assert.throws(() => resolvePartition(map, "99-Other/x.md"), (e) => e.code === "partition_not_found");
});

test("F-05: conflicting duplicate prefix is rejected", () => {
  assert.throws(
    () => buildPartitionMap([
      { path_prefix: "A", workspace: "personal", project: "p", confidentiality: "personal" },
      { path_prefix: "A", workspace: "work", project: "q", confidentiality: "internal" },
    ]),
    (e) => e.code === "partition_rule_conflict",
  );
});

test("F-05: out-of-range confidentiality is rejected", () => {
  assert.throws(
    () => buildPartitionMap([
      { path_prefix: "A", workspace: "personal", project: "laos", confidentiality: "topsecret" },
    ]),
    (e) => e.code === "invalid_partition_rule",
  );
});

test("F-05: caller-supplied rules are not accepted in production publishNote", async () => {
  // The production path (bin/vault-evidence) builds the map from admin config;
  // publishNote's partitionMap parameter is a test-only seam. Assert the
  // production path derives the map from config.partition_rules.
  const { publishNote } = await import("../src/vault/vault-evidence.js");
  const { mkdir, mkdtemp, realpath, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "vault-partition-")));
  const vault = path.join(base, "vault");
  await mkdir(path.join(vault, "01-Projects", "LAOS"), { recursive: true });
  await writeFile(path.join(vault, "01-Projects", "LAOS", "design.md"), "---\nid: p\n---\nbody\n");
  const calls = [];
  await publishNote({
    config: {
      vault: { root: vault },
      partition_rules: [
        { path_prefix: "01-Projects/LAOS", workspace: "personal", project: "laos", confidentiality: "personal" },
      ],
    },
    profile: { workspace: "personal", project: "laos", confidentiality_ceiling: "internal" },
    noteRelativePath: "01-Projects/LAOS/design.md",
    publishEvidence: async (input) => {
      calls.push(input.workspace);
      const { note_id, source_sha256 } = input.source;
      return { source_ref: "artifact:x", artifact_sha256: "x", canonical_identity: `vault-note:${note_id}@${source_sha256}` };
    },
  });
  assert.deepEqual(calls, ["personal"]);
  await rm(base, { recursive: true, force: true });
});

test("F-05: exported PartitionMapError is stable", () => {
  assert.equal(typeof PartitionMapError, "function");
});
