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
import { initProjectmem, PROJECTMEM_SUMMARY_SCHEMA } from "../src/projectmem/index.js";

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

test("summaries are gitignored but manifest is tracked", async (t) => {
  const { repo } = await repoFixture(t);
  await initProjectmem({ repoRoot: repo, ...DEFAULT_ARGS });
  const gitignore = await readFile(path.join(repo, ".projectmem", ".gitignore"), "utf8");
  assert.ok(gitignore.includes("/summaries/*"));
});
