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
    runner: runnerReturning({ output: { results: [{ id: "abc" }, "memory:def", { id: "ghi" }] } }),
  });
  const handles = await client.searchHandles();
  assert.deepEqual(handles, ["memory:abc", "memory:def", "memory:ghi"]);
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
