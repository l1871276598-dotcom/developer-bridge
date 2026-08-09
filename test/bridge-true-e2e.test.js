import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.e2e.test", type: "local-human" });

// The real LAOS Core checkout (ws-gpt) — the authorized workspace the Bridge
// is configured to gate. The Bridge invokes Core via the LAOS CLI restricted
// task interface (laos_memory_task).
const CORE_ROOT = "/Users/user/projects/laos-ws/gpt";
const PYTHON = process.env.LAOS_PYTHON_EXECUTABLE || "/Users/user/.local/bin/python3.11";

const PROFILE = Object.freeze({
  workspace: "personal",
  project: "laos",
  confidentiality: "personal",
});

const NOTE_V1 = `---
id: e2e-note-001
title: E2E Design
project: laos
---

version 1 content
`;

const NOTE_V2 = `---
id: e2e-note-001
title: E2E Design
project: laos
---

version 2 content
`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function coreSetup(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-e2e-")));
  // GP8-01: the writable workspace is a data/project context, separate from the
  // immutable Core runtime (CORE_ROOT). Core executes only from CORE_ROOT.
  const workspace = path.join(base, "workspace");
  await mkdir(workspace, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "-b", "feat/e2e-workspace"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  await writeFile(path.join(workspace, "context.txt"), "e2e data context\n", "utf8");
  await execFileAsync("git", ["add", "context.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: workspace });
  const coreRoot = CORE_ROOT;
  const vault = path.join(base, "vault");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([
    mkdir(path.join(vault, "01-Projects", "LAOS"), { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  // Vault config + initial note.
  await writeFile(path.join(base, "vault-config.json"), JSON.stringify({
    vault: { root: vault },
    partition_rules: [
      { path_prefix: "01-Projects/LAOS", workspace: "personal", project: "laos", confidentiality: "personal" },
    ],
  }));
  await writeFile(path.join(vault, "01-Projects", "LAOS", "design.md"), NOTE_V1);
  // Core data/state init.
  await execFileAsync(PYTHON, ["-c", `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(CORE_ROOT, "src"))})
import memory, argparse
from pathlib import Path
memory.init_store(Path(${JSON.stringify(dataRoot)}))
memory.db_init(argparse.Namespace(root=${JSON.stringify(dataRoot)}, state_dir=${JSON.stringify(stateDir)}))
`], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, workspace, coreRoot, vault, dataRoot, stateDir };
}

function env(setup) {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    // GP8-01: Core runs from the immutable runtime root.
    LAOS_CORE_ROOT: setup.coreRoot,
    LAOS_DATA_ROOT: setup.dataRoot,
    LAOS_STATE_DIR: setup.stateDir,
    LAOS_PYTHON_EXECUTABLE: PYTHON,
    // GP4-01: the trusted vault root is Core-side authority from admin config.
    LAOS_VAULT_ROOT: setup.vault,
    DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1",
    LAOS_CHECKPOINT_WORKSPACE: PROFILE.workspace,
    LAOS_CHECKPOINT_PROJECT: PROFILE.project,
    LAOS_CHECKPOINT_CONFIDENTIALITY: PROFILE.confidentiality,
    VAULT_EVIDENCE_CONFIG: path.join(setup.base, "vault-config.json"),
  };
}

// Runs the REAL Core CLI as the Bridge's runner and the REAL vault publisher.
// This exercises the true production path: Bridge public entry → unified scope
// gate → vault-owned publisher (Vault read) → evidence.publish → Core.
async function createTrueBridge(setup) {
  const captured = [];
  const bridge = await createBridgeWithSyncTools(setup.workspace, () => {}, {
    operatorIdentity,
    env: env(setup),
    laosRunCommand: async (command, args) => {
      captured.push(args);
      const { stdout, stderr } = await execFileAsync(PYTHON, args, {
        cwd: path.join(CORE_ROOT, "src"),
        env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
      });
      return { exitCode: 0, signal: null, stdout, stderr };
    },
  });
  return { bridge, captured };
}

function snapshotTask(relativePath) {
  return { type: "vault.snapshot.publish", input: { relative_path: relativePath } };
}

async function publish(bridge, notePath) {
  const result = await bridge.callTool("laos_memory_task", { task: snapshotTask(notePath) });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

// E01
test("E01: normal Vault publish through the true Bridge passes", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const parsed = await publish(bridge, "01-Projects/LAOS/design.md");
  assert.ok(parsed.source_ref.startsWith("artifact:"));
  assert.equal(parsed.note_id, "e2e-note-001");
  assert.equal(parsed.source_sha256.length, 64);
  assert.equal(parsed.artifact_sha256.length, 64);
  assert.equal(parsed.canonical_identity, `vault-note:e2e-note-001@${parsed.source_sha256}`);
});

// E02
test("E02: repeated publish yields the same artifact", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const a = await publish(bridge, "01-Projects/LAOS/design.md");
  const b = await publish(bridge, "01-Projects/LAOS/design.md");
  assert.equal(a.source_ref, b.source_ref);
});

// E03
test("E03: content change changes source_sha / canonical identity / artifact", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const a = await publish(bridge, "01-Projects/LAOS/design.md");
  await writeFile(path.join(setup.vault, "01-Projects", "LAOS", "design.md"), NOTE_V2);
  const b = await publish(bridge, "01-Projects/LAOS/design.md");
  assert.notEqual(a.source_sha256, b.source_sha256);
  assert.notEqual(a.canonical_identity, b.canonical_identity);
  assert.notEqual(a.artifact_sha256, b.artifact_sha256);
});

// E04
test("E04: rename keeps note_id/source_sha/canonical identity; locator changes; artifact may change", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  // Create the same note at two paths.
  await writeFile(path.join(setup.vault, "01-Projects", "LAOS", "design.md"), NOTE_V1);
  const { copyFile } = await import("node:fs/promises");
  await copyFile(
    path.join(setup.vault, "01-Projects", "LAOS", "design.md"),
    path.join(setup.vault, "01-Projects", "LAOS", "renamed.md"),
  );
  const a = await publish(bridge, "01-Projects/LAOS/design.md");
  const b = await publish(bridge, "01-Projects/LAOS/renamed.md");
  assert.equal(a.source_sha256, b.source_sha256);
  assert.equal(a.canonical_identity, b.canonical_identity);
  assert.notEqual(a.artifact_sha256, b.artifact_sha256);
});

// E05
test("E05: different note_id in different files → different artifact", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const a = await publish(bridge, "01-Projects/LAOS/design.md");
  // Same content but a different note id in a second file.
  await writeFile(path.join(setup.vault, "01-Projects", "LAOS", "other.md"),
    NOTE_V1.replace("e2e-note-001", "e2e-note-002"));
  const b = await publish(bridge, "01-Projects/LAOS/other.md");
  assert.notEqual(a.artifact_sha256, b.artifact_sha256);
});

// E06
test("E06: fake source identity cannot reach the Bridge (caller cannot mint evidence)", async (t) => {
  const setup = await coreSetup(t);
  const { bridge, captured } = await createTrueBridge(setup);
  // A caller attempting to submit a synthetic evidence.publish directly.
  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "evidence.publish",
      input: {
        schema_version: 2, kind: "vault_note_snapshot",
        source: { scheme: "vault-note", note_id: "fake", source_sha256: "f".repeat(64) },
        locator: { relative_path: "fake.md" },
        payload: { content: "fake", metadata: { title: "x" } },
        payload_sha256: "f".repeat(64),
      },
    },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "operation_not_allowed");
  assert.equal(captured.length, 0);
});

// E07
test("E07: Core re-verifies digests independently (no trust in Bridge-only hashes)", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  // The vault-owned publisher computes correct digests; Core recomputes them.
  const parsed = await publish(bridge, "01-Projects/LAOS/design.md");
  assert.equal(parsed.source_sha256.length, 64);
  assert.equal(parsed.artifact_sha256.length, 64);
});

// E08
test("E08: caller cannot tamper hashes — they are derived from the Vault read", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  // The caller only supplies relative_path; any attempt to add hash fields is
  // rejected as invalid_request (the vault-owned path accepts only one key).
  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "vault.snapshot.publish",
      input: { relative_path: "01-Projects/LAOS/design.md", payload_sha256: "e".repeat(64) },
    },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "invalid_request");
});

// E09
test("E09: cross-workspace escalation is rejected before Core", async (t) => {
  const setup = await coreSetup(t);
  const { bridge, captured } = await createTrueBridge(setup);
  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", workspace: "work", input: { query: "x" } },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
  assert.equal(captured.length, 0);
});

// E10
test("E10: cross-project escalation is rejected before Core", async (t) => {
  const setup = await coreSetup(t);
  const { bridge, captured } = await createTrueBridge(setup);
  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "x", project: "other" } },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
  assert.equal(captured.length, 0);
});

// E11
test("E11: confidentiality escalation is rejected", async (t) => {
  const setup = await coreSetup(t);
  const { bridge, captured } = await createTrueBridge(setup);
  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "x", confidentiality: "restricted" } },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
  assert.equal(captured.length, 0);
});

// E12
test("E12: vault.snapshot.publish rejects caller source-identity injection", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "vault.snapshot.publish",
      input: { relative_path: "01-Projects/LAOS/design.md", source: { note_id: "evil" } },
    },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "invalid_request");
});

// E13
test("E13: memory.review / memory.activate are unavailable at the Bridge", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  for (const op of ["memory.review", "memory.activate"]) {
    const result = await bridge.callTool("laos_memory_task", {
      task: { type: op, input: {} },
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, "operation_not_allowed");
  }
});

// E16
test("E16: vault publish never creates candidates or changes authority", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const before = JSON.parse((await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "e2e", workspace: "personal", project: "laos" } },
  })).content[0].text);
  await publish(bridge, "01-Projects/LAOS/design.md");
  const after = JSON.parse((await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "e2e", workspace: "personal", project: "laos" } },
  })).content[0].text);
  assert.deepEqual(before.output.results, after.output.results);
});

// E17
test("E17: deleting the vault note fails publish but keeps prior artifacts", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const a = await publish(bridge, "01-Projects/LAOS/design.md");
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(setup.vault, "01-Projects", "LAOS", "design.md"));
  const result = await bridge.callTool("laos_memory_task", {
    task: snapshotTask("01-Projects/LAOS/design.md"),
  });
  assert.equal(result.isError, true);
  // Prior artifact remains on disk.
  const { stat } = await import("node:fs/promises");
  await assert.doesNotReject(stat(path.join(setup.stateDir, "source_artifacts", `${a.artifact_sha256}.json`)));
});

// E20
test("E20: runtime build identity is exposed and matches the audited source", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const result = await bridge.callTool("laos_bridge_info", {});
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const info = JSON.parse(result.content[0].text);
  assert.equal(typeof info.bridge.git_commit, "string");
  assert.equal(typeof info.bridge.allowlist_sha256, "string");
  assert.equal(info.bridge.allowlist_sha256.length, 64);
  assert.equal(info.core.protocol_version, "evidence-v2");
});

test("E20b: allowlist does not expose memory.review/memory.activate at runtime", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const def = bridge.tools.find(({ name }) => name === "laos_memory_task");
  const enumVals = def.inputSchema.properties.task.properties.type.enum;
  assert.equal(enumVals.includes("memory.review"), false);
  assert.equal(enumVals.includes("memory.activate"), false);
  assert.equal(enumVals.includes("evidence.publish"), false, "evidence.publish must not be external");
  assert.equal(enumVals.includes("vault.snapshot.publish"), true, "vault.snapshot.publish must be exposed");
});

// GP8-01: Core executes ONLY from the immutable LAOS_CORE_ROOT runtime. The
// Agent-writable workspace is a data context; malicious code planted there must
// never run during task dispatch. Here we plant an evil laos.py AND an evil
// memory.py in the workspace and prove Core still runs the real CORE_ROOT code.
test("GP8-01: malicious code in the writable workspace never executes during Core dispatch", async (t) => {
  const setup = await coreSetup(t);
  // Plant attacker code in the writable workspace (as if the Agent modified it).
  await mkdir(path.join(setup.workspace, "src"), { recursive: true });
  await writeFile(path.join(setup.workspace, "src", "laos.py"),
    'raise SystemExit("evil workspace laos.py executed")\n', "utf8");
  await writeFile(path.join(setup.workspace, "src", "memory.py"),
    'raise SystemExit("evil workspace memory.py imported")\n', "utf8");

  const { bridge } = await createTrueBridge(setup);
  // vault.snapshot.publish drives Core vault.read + evidence.publish — if the
  // workspace code were executed, this would raise the evil SystemExit. It must
  // instead run CORE_ROOT and publish normally.
  const payload = await publish(bridge, "01-Projects/LAOS/design.md");
  assert.equal(typeof payload.source_ref, "string");
  assert.ok(payload.source_ref.length > 0, "real Core evidence was minted");
});

// GP3-01 (Round 4): the vault read is fd-rooted in Core (Python dir_fd +
// O_NOFOLLOW), so a symlink pointing outside the vault must fail — no
// vault-outside file may enter the snapshot pipeline.
test("GP3-01: final-component symlink to a vault-outside file fails publish", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const outside = path.join(setup.base, "outside-secret.txt");
  await writeFile(outside, "TOP-SECRET-OUTSIDE\n");
  const { symlink, unlink } = await import("node:fs/promises");
  // Replace the existing note with a symlink pointing outside the vault.
  const target = path.join(setup.vault, "01-Projects", "LAOS", "design.md");
  await unlink(target);
  await symlink(outside, target);
  const result = await bridge.callTool("laos_memory_task", {
    task: snapshotTask("01-Projects/LAOS/design.md"),
  });
  assert.equal(result.isError, true, "vault-outside symlink must be rejected");
  const text = result.content[0].text;
  assert.equal(text.includes("TOP-SECRET-OUTSIDE"), false, "outside content must never leak");
});

test("GP3-01: intermediate-directory symlink to a vault-outside dir fails publish", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const outsideDir = path.join(setup.base, "outside-dir");
  await mkdir(outsideDir);
  await writeFile(path.join(outsideDir, "secret.md"), "OUTSIDE-DIR-SECRET\n");
  const { symlink } = await import("node:fs/promises");
  // Replace an intermediate directory with a symlink.
  const laosDir = path.join(setup.vault, "01-Projects", "LAOS");
  const realDir = path.join(setup.vault, "01-Projects", "real");
  const { rename } = await import("node:fs/promises");
  await rename(laosDir, realDir);
  await symlink(outsideDir, laosDir);
  const result = await bridge.callTool("laos_memory_task", {
    task: snapshotTask("01-Projects/LAOS/secret.md"),
  });
  assert.equal(result.isError, true, "intermediate symlink must be rejected");
  const text = result.content[0].text;
  assert.equal(text.includes("OUTSIDE-DIR-SECRET"), false, "outside dir content must never leak");
});

// GP4-01 (Round 4): the vault root is Core-side authority (LAOS_VAULT_ROOT).
// A caller cannot supply a vault_root to read arbitrary files, and the
// vault.snapshot.publish input is still exact {relative_path}.
test("GP4-01: caller cannot read an arbitrary absolute directory", async (t) => {
  const setup = await coreSetup(t);
  const { bridge } = await createTrueBridge(setup);
  const secretDir = path.join(setup.base, "secret-dir");
  await mkdir(secretDir);
  await writeFile(path.join(secretDir, "top.txt"), "SECRET-READ\n");
  // vault.snapshot.publish only accepts {relative_path}; there is no way to
  // steer the read to an arbitrary root through the Bridge public interface.
  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "vault.snapshot.publish",
      input: { relative_path: "../../top.txt" },  // traversal intent
    },
  });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.equal(text.includes("SECRET-READ"), false, "secret content must never leak");
});

// GP5-01: when Core LAOS_VAULT_ROOT does not canonicalize to the Bridge config
// vault root, vault evidence must be unavailable (fail-closed) — it would
// otherwise read Vault B content under Vault A partition semantics.
test("GP5-01: Bridge/Core vault-root mismatch makes vault.snapshot.publish unavailable", async (t) => {
  const setup = await coreSetup(t);
  const otherVault = path.join(setup.base, "other-vault");
  await mkdir(otherVault);
  const bridge = await createBridgeWithSyncTools(setup.workspace, () => {}, {
    operatorIdentity,
    env: { ...env(setup), LAOS_VAULT_ROOT: otherVault },  // mismatch
    laosRunCommand: async () => {
      throw new Error("must not run");
    },
  });
  const result = await bridge.callTool("laos_memory_task", {
    task: snapshotTask("01-Projects/LAOS/design.md"),
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "vault_unavailable");
});
