import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";
import { FROZEN_LAOS_TASKS, ALLOWED_LAOS_TASKS } from "../src/laos-memory-tool.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.gp01.test", type: "local-human" });

const PROFILE = Object.freeze({
  workspace: "personal",
  project: "laos",
  confidentiality: "personal",
});

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

// Bridge workspace (authorized repo) + vault root + Core data/state.
async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "laos-gp01-")));
  const workspace = path.join(base, "workspace");
  const vault = path.join(base, "vault");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([
    mkdir(path.join(workspace, "src"), { recursive: true }),
    mkdir(path.join(vault, "01-Projects", "LAOS"), { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), "{}\n", "utf8");
  await writeFile(path.join(workspace, "src", "laos.py"), "print('fixture')\n", "utf8");
  await git(workspace, "init", "--quiet", "-b", "feat/gp01");
  await git(workspace, "config", "user.name", "Test");
  await git(workspace, "config", "user.email", "t@invalid.example");
  await git(workspace, "add", "src/laos.py");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  // Vault config with a partition rule.
  await writeFile(path.join(base, "vault-config.json"), JSON.stringify({
    vault: { root: vault },
    partition_rules: [
      { path_prefix: "01-Projects/LAOS", workspace: "personal", project: "laos", confidentiality: "personal" },
    ],
  }));
  const NOTE = `---\nid: gp01-note-001\ntitle: GP01\n---\n\nreal vault body\n`;
  await writeFile(path.join(vault, "01-Projects", "LAOS", "design.md"), NOTE);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, workspace, vault, dataRoot, stateDir, noteContent: NOTE };
}

function env(item, overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1",
    LAOS_DATA_ROOT: item.dataRoot,
    LAOS_STATE_DIR: item.stateDir,
    LAOS_CHECKPOINT_WORKSPACE: PROFILE.workspace,
    LAOS_CHECKPOINT_PROJECT: PROFILE.project,
    LAOS_CHECKPOINT_CONFIDENTIALITY: PROFILE.confidentiality,
    VAULT_EVIDENCE_CONFIG: path.join(item.base, "vault-config.json"),
    // GP5-01: Core LAOS_VAULT_ROOT must equal the Bridge config vault root.
    LAOS_VAULT_ROOT: item.vault,
    ...overrides,
  };
}

async function createBridge(item, overrides = {}) {
  return createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: env(item),
    laosRunCommand: overrides.laosRunCommand ?? (async () => {
      throw new Error("unexpected runner call");
    }),
    vaultPublish: overrides.vaultPublish,
  });
}

test("GP-01: evidence.publish is removed from the external allowlist", () => {
  assert.equal(ALLOWED_LAOS_TASKS.has("evidence.publish"), false);
  assert.equal(FROZEN_LAOS_TASKS.includes("evidence.publish"), false);
});

test("GP-01: vault.snapshot.publish is the vault-owned task in the allowlist", () => {
  assert.equal(ALLOWED_LAOS_TASKS.has("vault.snapshot.publish"), true);
  assert.ok(FROZEN_LAOS_TASKS.includes("vault.snapshot.publish"));
});

// T1: synthetic evidence.publish directly → operation_not_allowed
test("T1: caller cannot mint evidence.publish directly (synthetic forgery)", async (t) => {
  const item = await fixture(t);
  const bridge = await createBridge(item);
  const task = {
    type: "evidence.publish",
    input: {
      schema_version: 2,
      kind: "vault_note_snapshot",
      source: { scheme: "vault-note", note_id: "fake", source_sha256: "f".repeat(64) },
      locator: { relative_path: "fake.md" },
      payload: { content: "fake", metadata: { title: "x" } },
      payload_sha256: "f".repeat(64),
    },
  };
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "operation_not_allowed");
});

// T2: nonexistent vault note → fail
test("T2: vault.snapshot.publish with nonexistent note fails", async (t) => {
  const item = await fixture(t);
  const bridge = await createBridge(item);
  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "vault.snapshot.publish", input: { relative_path: "01-Projects/LAOS/missing.md" } },
  });
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  // vault_root / note_missing style fail-closed error
  assert.ok(["note_missing", "note_unreadable", "vault_evidence_failed", "tool_operation_failed"].includes(parsed.error.code), `got ${parsed.error.code}`);
});

// T3: caller source identity injection → invalid_request
test("T3: caller injecting source identity / payload is rejected", async (t) => {
  const item = await fixture(t);
  const bridge = await createBridge(item);
  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "vault.snapshot.publish",
      input: { relative_path: "01-Projects/LAOS/design.md", note_id: "evil", source_sha256: "0".repeat(64), payload: { content: "x" } },
    },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "invalid_request");
});

// R2 (Round 3): extra scope fields equal to the trusted profile must NOT be
// accepted — the vault.snapshot.publish input is exact {relative_path} only,
// validated before any scope normalization.
test("R2: caller scope fields equal to trusted profile are rejected, not washed out", async (t) => {
  const item = await fixture(t);
  const bridge = await createBridge(item);
  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "vault.snapshot.publish",
      input: {
        relative_path: "01-Projects/LAOS/design.md",
        workspace: "personal",
        project: "laos",
        confidentiality: "personal",
      },
    },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "invalid_request");
});

// T4: caller scope injection → rejected by unified scope policy
test("T4: caller scope injection on vault.snapshot.publish is rejected", async (t) => {
  const item = await fixture(t);
  const bridge = await createBridge(item);
  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "vault.snapshot.publish",
      workspace: "work", // conflicts with profile personal
      input: { relative_path: "01-Projects/LAOS/design.md" },
    },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
});

// T5: legitimate vault note → succeeds with artifact
test("T5: legitimate vault note publishes to an artifact via the vault-owned path", async (t) => {
  const item = await fixture(t);
  let published = null;
  const vaultPublish = async (input) => {
    // The Bridge adapter performs the Vault read; the injected publisher only
    // simulates the Core evidence.publish result for the test seam.
    return {
      canonical_identity: "vault-note:gp01-note-001@placeholder",
      note_id: "gp01-note-001",
      source_sha256: "0".repeat(64),
      identity_state: "front_matter",
      source_ref: "artifact:abc",
      artifact_sha256: "abc",
      payload_sha256: "0".repeat(64),
      partition: { workspace: "personal", project: "laos", confidentiality: "personal" },
    };
  };
  const bridge = await createBridge(item, { vaultPublish });
  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "vault.snapshot.publish", input: { relative_path: "01-Projects/LAOS/design.md" } },
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.source_ref.startsWith("artifact:"));
  assert.equal(parsed.note_id, "gp01-note-001");
});
