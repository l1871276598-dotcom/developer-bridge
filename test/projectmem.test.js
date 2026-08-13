import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildManifestBody,
  canonicalJson,
  finalizeManifest,
  validateManifest,
  manifestSha256,
  PROJECTMEM_MANIFEST_SCHEMA,
} from "../src/projectmem/manifest.js";
import {
  initProjectmem,
  PROJECTMEM_SUMMARY_SCHEMA,
  reconcileManifestWithProfile,
} from "../src/projectmem/index.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function repoFixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "projectmem-")));
  const repo = path.join(base, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "README.md"), "# repo\n");
  await git(repo, "init", "--quiet", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "t@invalid.example");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "--quiet", "-m", "init");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, repo };
}

const DEFAULT_ARGS = {
  repoKey: "laos",
  component: "ws-gpt",
  workspace: "personal",
  project: "laos",
  confidentialityCeiling: "internal",
  bridgeProfile: "ws-gpt",
};

const DEFAULT_MANIFEST_ARGS = {
  repo_key: "laos",
  component: "ws-gpt",
  workspace: "personal",
  project: "laos",
  confidentiality_ceiling: "internal",
  bridge_profile: "ws-gpt",
};

test("manifest canonical JSON is sorted, compact, no trailing newline", () => {
  const body = buildManifestBody(DEFAULT_MANIFEST_ARGS);
  const canonical = canonicalJson(body);
  assert.equal(canonical.endsWith("\n"), false);
  const parsed = JSON.parse(canonical);
  assert.equal(parsed.schema, PROJECTMEM_MANIFEST_SCHEMA);
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(parsed));
});

test("manifest rejects memory_review/memory_activate enabled", () => {
  const body = buildManifestBody(DEFAULT_MANIFEST_ARGS);
  const tampered = { ...body, write_policy: { ...body.write_policy, memory_review: true } };
  assert.throws(() => validateManifest(finalizeManifest(tampered)), {
    name: "ManifestError",
  });
});

test("manifest sha256 is stable across key order", () => {
  const body = buildManifestBody(DEFAULT_MANIFEST_ARGS);
  const sha = manifestSha256(body);
  const reordered = Object.fromEntries(Object.entries(body).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  assert.equal(manifestSha256(reordered), sha);
});

test("init creates manifest with correct write_policy and rejects review/activate", async (t) => {
  const { repo } = await repoFixture(t);
  const result = await initProjectmem({ repoRoot: repo, ...DEFAULT_ARGS, contextSha256: "c".repeat(64) });
  assert.equal(result.status, "initialized");
  assert.equal(result.manifest.write_policy.memory_review, false);
  assert.equal(result.manifest.write_policy.memory_activate, false);
  assert.equal(result.manifest.write_policy.memory_create, true);

  const manifest = JSON.parse(await readFile(path.join(repo, ".projectmem", "manifest.json"), "utf8"));
  validateManifest(manifest);
  assert.equal(manifest.repo_key, "laos");
  assert.equal(manifest.project, "laos");
});

test("init is idempotent with identical binding", async (t) => {
  const { repo } = await repoFixture(t);
  const first = await initProjectmem({ repoRoot: repo, ...DEFAULT_ARGS });
  const manifestJson = await readFile(path.join(repo, ".projectmem", "manifest.json"), "utf8");
  const second = await initProjectmem({ repoRoot: repo, ...DEFAULT_ARGS });
  assert.equal(second.status, "already_initialized");
  const manifestJson2 = await readFile(path.join(repo, ".projectmem", "manifest.json"), "utf8");
  assert.equal(manifestJson, manifestJson2);
});

test("init rejects a conflicting binding", async (t) => {
  const { repo } = await repoFixture(t);
  await initProjectmem({ repoRoot: repo, ...DEFAULT_ARGS });
  await assert.rejects(
    initProjectmem({ repoRoot: repo, ...DEFAULT_ARGS, project: "other" }),
    (e) => e.code === "projectmem_binding_conflict",
  );
});

test("init rejects a non-repo directory", async (t) => {
  const { base } = await repoFixture(t);
  const plain = path.join(base, "plain");
  await mkdir(plain);
  await assert.rejects(
    initProjectmem({ repoRoot: plain, ...DEFAULT_ARGS }),
    (e) => e.code === "projectmem_invalid_repo",
  );
});

test("init creates summary with context_sha256 and vault notes", async (t) => {
  const { repo } = await repoFixture(t);
  const handles = ["memory:abc", "memory:def"];
  const vaultNotes = [
    { canonical_identity: "vault-note:a@111", artifact: "artifact:111" },
    { canonical_identity: "vault-note:b@222", artifact: "artifact:222" },
  ];
  const result = await initProjectmem({
    repoRoot: repo,
    ...DEFAULT_ARGS,
    contextSha256: "abc".padEnd(64, "0"),
    handles,
    vaultNotes,
  });
  const summary = JSON.parse(await readFile(path.join(repo, ".projectmem", "summaries", "current.json"), "utf8"));
  assert.equal(summary.schema, PROJECTMEM_SUMMARY_SCHEMA);
  // F-07 / C-INV-18: live-seeded cache is "refreshed", never "verified".
  assert.equal(summary.binding_info.binding_state, "refreshed");
  assert.equal(summary.binding_info.manifest_integrity_sha256, result.manifest.manifest_sha256);
  assert.equal(summary.binding_info.bridge_profile, "ws-gpt");
  assert.equal(summary.core.context_sha256, "abc".padEnd(64, "0"));
  assert.deepEqual(summary.core.handles, handles);
  assert.deepEqual(summary.vault.notes, vaultNotes);
  assert.ok(result.summary_sha256.length === 64);

  const md = await readFile(path.join(repo, ".projectmem", "summaries", "current.md"), "utf8");
  assert.ok(md.includes("vault-note:a@111"));
  assert.ok(md.includes("binding_state: refreshed"));
});

test("F-07: a locally-derived summary (no live Core) is binding_state=derived, never verified", async (t) => {
  const { repo } = await repoFixture(t);
  const result = await initProjectmem({ repoRoot: repo, ...DEFAULT_ARGS, contextSha256: "" });
  const summary = JSON.parse(await readFile(path.join(repo, ".projectmem", "summaries", "current.json"), "utf8"));
  assert.equal(summary.binding_info.binding_state, "derived");
  assert.notEqual(summary.binding_info.binding_state, "verified");
});

test("F-07: summary never contains the literal binding_state=verified", async (t) => {
  const { repo } = await repoFixture(t);
  await initProjectmem({ repoRoot: repo, ...DEFAULT_ARGS, contextSha256: "c".repeat(64) });
  const raw = await readFile(path.join(repo, ".projectmem", "summaries", "current.json"), "utf8");
  assert.equal(raw.includes('"binding_state":"verified"'), false);
  assert.equal(raw.includes('binding_state: verified'), false);
});

test("F-07: reconcileManifestWithProfile rejects a manifest that disagrees with the profile", async () => {
  const { reconcileManifestWithProfile } = await import("../src/projectmem/index.js");
  const manifest = buildManifestBody(DEFAULT_MANIFEST_ARGS);
  const reconciled = reconcileManifestWithProfile(
    finalizeManifest(manifest),
    { workspace: "personal", project: "laos", confidentiality_ceiling: "internal" },
  );
  assert.equal(reconciled.project, "laos");

  assert.throws(
    () => reconcileManifestWithProfile(
      finalizeManifest(manifest),
      { workspace: "work", project: "laos", confidentiality_ceiling: "internal" },
    ),
    (e) => e.code === "projectmem_binding_conflict",
  );
  assert.throws(
    () => reconcileManifestWithProfile(
      finalizeManifest(manifest),
      { workspace: "personal", project: "evil", confidentiality_ceiling: "internal" },
    ),
    (e) => e.code === "projectmem_binding_conflict",
  );
});

test("GP12-05/GP10-10: projectmem accepts only exact own-data schemas and own rank names", () => {
  const body = buildManifestBody(DEFAULT_MANIFEST_ARGS);
  const manifest = finalizeManifest(body);
  const profile = {
    workspace: "personal",
    project: "laos",
    confidentiality_ceiling: "internal",
  };

  // The two permitted ordinary-record forms remain accepted.
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.doesNotThrow(() => validateManifest(Object.assign(Object.create(null), manifest)));
  assert.doesNotThrow(() => reconcileManifestWithProfile(manifest, profile));
  assert.doesNotThrow(() => reconcileManifestWithProfile(
    manifest,
    Object.assign(Object.create(null), profile),
  ));

  const missingBody = { ...body };
  delete missingBody.component;
  const missingManifest = finalizeManifest(missingBody);
  const inheritedManifest = finalizeManifest(missingBody);
  Object.setPrototypeOf(inheritedManifest, { component: body.component });
  const extraManifest = finalizeManifest({ ...body, forged: true });
  let manifestAccessorReads = 0;
  const accessorManifest = finalizeManifest(body);
  Object.defineProperty(accessorManifest, "component", {
    enumerable: true,
    get() {
      manifestAccessorReads += 1;
      return body.component;
    },
  });
  const classManifest = Object.assign(new (class ManifestRecord {})(), manifest);
  const proxyManifest = new Proxy(finalizeManifest(body), {});
  const arrayManifest = Object.assign([], manifest);

  for (const [label, candidate] of [
    ["missing field", missingManifest],
    ["inherited field", inheritedManifest],
    ["extra field", extraManifest],
    ["accessor field", accessorManifest],
    ["class instance", classManifest],
    ["proxy", proxyManifest],
    ["array", arrayManifest],
  ]) {
    assert.throws(() => validateManifest(candidate), (e) => e?.code === "invalid_manifest", label);
  }
  assert.equal(manifestAccessorReads, 0, "manifest accessors must not run during validation");

  const constructorPolicy = finalizeManifest({
    ...body,
    write_policy: { ...body.write_policy, constructor: true },
  });
  const inheritedPolicy = { ...body.write_policy };
  delete inheritedPolicy.memory_create;
  Object.setPrototypeOf(inheritedPolicy, { memory_create: true });
  const inheritedPolicyManifest = finalizeManifest({ ...body, write_policy: inheritedPolicy });
  let policyAccessorReads = 0;
  const accessorPolicy = { ...body.write_policy };
  Object.defineProperty(accessorPolicy, "memory_create", {
    enumerable: true,
    get() {
      policyAccessorReads += 1;
      return true;
    },
  });
  const accessorPolicyManifest = finalizeManifest({ ...body, write_policy: accessorPolicy });
  policyAccessorReads = 0;
  const classPolicyManifest = finalizeManifest({
    ...body,
    write_policy: Object.assign(new (class WritePolicyRecord {})(), body.write_policy),
  });
  const proxyPolicyManifest = finalizeManifest({
    ...body,
    write_policy: new Proxy({ ...body.write_policy }, {}),
  });
  const arrayPolicyManifest = finalizeManifest({
    ...body,
    write_policy: Object.assign([], body.write_policy),
  });

  for (const [label, candidate] of [
    ["prototype-name policy key", constructorPolicy],
    ["inherited policy field", inheritedPolicyManifest],
    ["accessor policy field", accessorPolicyManifest],
    ["policy class instance", classPolicyManifest],
    ["policy proxy", proxyPolicyManifest],
    ["policy array", arrayPolicyManifest],
  ]) {
    assert.throws(() => validateManifest(candidate), (e) => e?.code === "invalid_manifest", label);
  }
  assert.equal(policyAccessorReads, 0, "write_policy accessors must not run during validation");

  const profileMissing = { workspace: "personal", project: "laos" };
  const inheritedProfile = Object.create({ confidentiality_ceiling: "internal" });
  inheritedProfile.workspace = "personal";
  inheritedProfile.project = "laos";
  const extraProfile = { ...profile, forged: true };
  let profileAccessorReads = 0;
  const accessorProfile = { ...profile };
  Object.defineProperty(accessorProfile, "confidentiality_ceiling", {
    enumerable: true,
    get() {
      profileAccessorReads += 1;
      return "internal";
    },
  });
  const classProfile = Object.assign(new (class ProfileRecord {})(), profile);
  const proxyProfile = new Proxy({ ...profile }, {});

  for (const [label, candidate] of [
    ["missing profile field", profileMissing],
    ["inherited profile field", inheritedProfile],
    ["extra profile field", extraProfile],
    ["accessor profile field", accessorProfile],
    ["profile class instance", classProfile],
    ["profile proxy", proxyProfile],
  ]) {
    assert.throws(
      () => reconcileManifestWithProfile(manifest, candidate),
      (e) => e?.code === "projectmem_invalid_profile",
      label,
    );
  }
  assert.equal(profileAccessorReads, 0, "profile accessors must not run during validation");

  for (const rankName of ["constructor", "toString", "__proto__", "__defineGetter__", "valueOf"]) {
    const manifestWithPrototypeRank = finalizeManifest({ ...body, confidentiality_ceiling: rankName });
    assert.throws(
      () => reconcileManifestWithProfile(manifestWithPrototypeRank, profile),
      (e) => e?.code === "invalid_manifest",
      `manifest rank ${rankName}`,
    );
    assert.throws(
      () => reconcileManifestWithProfile(manifest, { ...profile, confidentiality_ceiling: rankName }),
      (e) => e?.code === "projectmem_invalid_profile",
      `profile rank ${rankName}`,
    );
  }
});

test("summaries are gitignored but manifest is tracked", async (t) => {
  const { repo } = await repoFixture(t);
  await initProjectmem({ repoRoot: repo, ...DEFAULT_ARGS });
  const gitignore = await readFile(path.join(repo, ".projectmem", ".gitignore"), "utf8");
  assert.ok(gitignore.includes("/summaries/*"));
});
