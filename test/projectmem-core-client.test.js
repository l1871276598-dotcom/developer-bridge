import assert from "node:assert/strict";
import test from "node:test";

import { buildCoreClient, CoreClientError } from "../src/projectmem/core-client.js";

const MANIFEST = Object.freeze({
  schema: "laos-projectmem/v1",
  repo_key: "laos",
  component: "ws-gpt",
  workspace: "personal",
  project: "laos",
  confidentiality_ceiling: "internal",
  bridge_profile: "ws-gpt",
  manifest_sha256: "0".repeat(64),
});

const PROFILE = Object.freeze({
  workspace: "personal",
  project: "laos",
  confidentiality_ceiling: "internal",
});

function runnerReturning(payload) {
  return async (env, taskJson) => JSON.stringify(payload);
}

test("F-07: buildCoreClient requires a manifest and trusted profile", () => {
  assert.throws(() => buildCoreClient({}), CoreClientError);
  assert.throws(() => buildCoreClient({ manifest: MANIFEST }), CoreClientError);
});

// GP8-02: the manifest scope is a CLAIM, not authority. buildCoreClient must
// derive the authoritative scope from the trusted profile and reject any
// manifest that disagrees — a workspace-controlled manifest must never route
// cross-scope context.build / memory.search into Core.
test("GP8-02: buildCoreClient rejects a manifest whose scope disagrees with the trusted profile", () => {
  const misScoped = { ...MANIFEST, workspace: "work", project: "victim-project" };
  assert.throws(
    () => buildCoreClient({ manifest: misScoped, trustedProfile: PROFILE }),
    (e) => e instanceof CoreClientError && e.code === "scope_mismatch",
  );
  const badWorkspace = { ...MANIFEST, workspace: "work" };
  assert.throws(
    () => buildCoreClient({ manifest: badWorkspace, trustedProfile: PROFILE }),
    (e) => e instanceof CoreClientError && e.code === "scope_mismatch",
  );
  const badProject = { ...MANIFEST, project: "other" };
  assert.throws(
    () => buildCoreClient({ manifest: badProject, trustedProfile: PROFILE }),
    (e) => e instanceof CoreClientError && e.code === "scope_mismatch",
  );
test("GP9-03: an exact match in confidentiality ceiling constructs a valid client", () => {
  const ok = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { text: "ctx" } }),
  });
  assert.ok(ok);
});

test("GP10-10: manifest ceiling rejects prototype-inherited keys (constructor/toString/__proto__)", () => {
  for (const bad of ["constructor", "toString", "__proto__"]) {
    assert.throws(
      () => buildCoreClient({
        manifest: { ...MANIFEST, confidentiality_ceiling: bad },
        trustedProfile: PROFILE,
      }),
      (e) => e instanceof CoreClientError && e.code === "scope_mismatch",
    );
  }
});

// GP9-03: the manifest confidentiality ceiling must be an EXACT match — not a
// "must not exceed" comparison. An unknown/invalid value must reject too
// (rank[value] === undefined silently passed the old `>` comparison).
test("GP9-03: manifest confidentiality ceiling must match the trusted profile exactly", () => {
  // lower ceiling in manifest than profile → previously accepted; now mismatch.
  const lower = { ...MANIFEST, confidentiality_ceiling: "public" };
  assert.throws(
    () => buildCoreClient({ manifest: lower, trustedProfile: PROFILE }),
    (e) => e instanceof CoreClientError && e.code === "scope_mismatch",
  );
  // invalid/unknown ceiling → must reject, not silently pass.
  const invalid = { ...MANIFEST, confidentiality_ceiling: "attacker-value" };
  assert.throws(
    () => buildCoreClient({ manifest: invalid, trustedProfile: PROFILE }),
    (e) => e instanceof CoreClientError && e.code === "scope_mismatch",
  );
  // missing ceiling → reject.
  const missing = { ...MANIFEST };
  delete missing.confidentiality_ceiling;
  assert.throws(
    () => buildCoreClient({ manifest: missing, trustedProfile: PROFILE }),
    (e) => e instanceof CoreClientError && e.code === "scope_mismatch",
  );
test("GP9-03: an exact match in confidentiality ceiling constructs a valid client", () => {
  const ok = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { text: "ctx" } }),
  });
  assert.ok(ok);
});

test("GP10-10: manifest ceiling rejects prototype-inherited keys (constructor/toString/__proto__)", () => {
  for (const bad of ["constructor", "toString", "__proto__"]) {
    assert.throws(
      () => buildCoreClient({
        manifest: { ...MANIFEST, confidentiality_ceiling: bad },
        trustedProfile: PROFILE,
      }),
      (e) => e instanceof CoreClientError && e.code === "scope_mismatch",
    );
  }
  // "personal" is a real rank key and still accepted.
  assert.doesNotThrow(() => buildCoreClient({
    manifest: { ...MANIFEST, confidentiality_ceiling: "personal" },
    trustedProfile: { ...PROFILE, confidentiality_ceiling: "personal" },
    runner: runnerReturning({ output: { text: "ctx" } }),
  }));
});

test("GP8-02: a matching manifest constructs a client bound to the trusted profile scope", () => {
  let seenTask = null;
  const runner = async (env, taskJson) => {
    seenTask = JSON.parse(taskJson);
    return JSON.stringify({ output: { text: "ctx" } });
  };
  const client = buildCoreClient({ manifest: MANIFEST, trustedProfile: PROFILE, runner });
  assert.ok(client);
  // The scope in the emitted Core task must be the trusted profile's scope.
  client.contextSha256("q").then(() => {
    assert.equal(seenTask.input.workspace, PROFILE.workspace);
    assert.equal(seenTask.input.project, PROFILE.project);
  });
});

test("F-07: searchHandles fails closed on unrecognized handle objects", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: [{ weird: true }] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e instanceof CoreClientError);
});

test("F-07: searchHandles never fabricates memory:unknown", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: [{ id: "principle-2026-08-07-aaaa1111" }, "memory:procedure-2026-08-07-bbbb2222", { id: "context-2026-08-07-cccc3333" }] } }),
  });
  const handles = await client.searchHandles();
  assert.deepEqual(handles, ["memory:principle-2026-08-07-aaaa1111", "memory:procedure-2026-08-07-bbbb2222", "memory:context-2026-08-07-cccc3333"]);
  assert.equal(handles.some((h) => h === "memory:unknown"), false);
});

test("F-07: searchHandles rejects a malformed Core response (not an array)", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: "not-an-array" } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e instanceof CoreClientError);
});

test("S12: searchHandles fails closed on a bare string handle (no memory: prefix)", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: ["def"] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

test("S12: searchHandles fails closed on an empty memory: handle", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: ["memory:"] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

test("S12: searchHandles fails closed on a non-memory string handle", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: ["file:/etc/passwd"] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

test("S12: searchHandles fails closed on a number handle", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: [42] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

test("S12: searchHandles fails closed on an object with empty id", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: [{ id: "" }] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

// R14 (Round 3): these were previously ACCEPTED by the loose string branch;
// they must now fail closed.
test("R14: searchHandles rejects memory:unknown", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: ["memory:unknown"] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

test("R14: searchHandles rejects a memory: id with whitespace", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: ["memory: "] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

test("R14: searchHandles rejects a memory: id with control characters", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: ["memory:principle x"] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

test("R14: searchHandles rejects a memory: id with path separators", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: ["memory:../etc"] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

test("R14: searchHandles rejects an object with an extra schema field", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: [{ id: "unknown", unexpected: "field" }] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

test("R14: searchHandles rejects an object whose id is not an own property", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: [Object.create({ id: "inherited" })] } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "core_malformed_response");
});

test("R14: searchHandles accepts a valid Core-style slug id", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { results: [{ id: "principle-2026-08-07-3f2a1b9c" }, "memory:procedure-2026-08-07-aabbccdd"] } }),
  });
  const handles = await client.searchHandles();
  assert.deepEqual(handles, ["memory:principle-2026-08-07-3f2a1b9c", "memory:procedure-2026-08-07-aabbccdd"]);
});

test("F-07: searchHandles rejects a Core error response", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ error: { code: "memory_store_validation_failed", message: "boom" } }),
  });
  await assert.rejects(() => client.searchHandles(), (e) => e.code === "memory_store_validation_failed");
});

test("F-07: contextSha256 hashes the returned text and fails on malformed response", async () => {
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: { text: "context body" } }),
  });
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256").update("context body").digest("hex");
  assert.equal(await client.contextSha256("query"), expected);

  const bad = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: runnerReturning({ output: {} }),
  });
  await assert.rejects(() => bad.contextSha256("query"), CoreClientError);
});

test("F-07: scope is bound at construction, not per call", async () => {
  // The task JSON forwarded to Core must carry the manifest-scope, regardless
  // of any caller attempt to widen it (the client API has no scope parameter).
  let capturedTask = null;
  const client = buildCoreClient({
    manifest: MANIFEST,
    trustedProfile: PROFILE,
    runner: async (env, taskJson) => {
      capturedTask = JSON.parse(taskJson);
      return JSON.stringify({ output: { text: "x", results: [] } });
    },
  });
  await client.searchHandles();
  assert.equal(capturedTask.input.workspace, "personal");
  assert.equal(capturedTask.input.project, "laos");
  await client.contextSha256("q");
  assert.equal(capturedTask.input.workspace, "personal");
});
