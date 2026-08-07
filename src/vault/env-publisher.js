import { readFile } from "node:fs/promises";

import { buildPartitionMap, resolvePartition } from "./partition-map.js";
import { buildCanonicalNoteSnapshot } from "./snapshot.js";
import { resolveVaultRoot } from "./vault-root.js";
import { verifyScope } from "./publisher.js";

/**
 * Environment-configured vault evidence publisher (GP-01 + S8/GP3-01).
 *
 * The ONLY way an external caller can mint a vault-backed evidence artifact:
 * the Bridge calls Core's `vault.read` task, which performs an fd-rooted
 * traversal (Python os.open with dir_fd + O_NOFOLLOW on every component), so
 * the validated directory chain IS the opened directory chain. The note bytes
 * come back from Core; the Bridge then derives identity + source hash,
 * resolves the partition, verifies scope against the trusted Bridge profile,
 * and publishes through Core evidence.publish (internal). A caller can never
 * construct source identity, payload, or scope, and can never cause a
 * vault-outside file to be read (the fd-rooted read is atomic in Python).
 */

export async function loadVaultConfig(env) {
  const configPath = env.VAULT_EVIDENCE_CONFIG;
  if (!configPath) return null;
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    // Vault evidence is not configured for this Bridge — fail closed by
    // returning null so vault.snapshot.publish is unavailable, never by
    // crashing the whole tool.
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("vault config is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !parsed.vault?.root || !Array.isArray(parsed.partition_rules)) {
    throw new Error("vault config must define vault.root and partition_rules");
  }
  return parsed;
}

export async function buildEnvVaultPublisher(env, { codeRoot, runner } = {}) {
  const config = await loadVaultConfig(env);
  if (!config) return null;
  const root = await resolveVaultRoot(config.vault.root);
  const map = buildPartitionMap(config.partition_rules);
  const workspace = env.LAOS_CHECKPOINT_WORKSPACE;
  const project = env.LAOS_CHECKPOINT_PROJECT;
  const ceiling = env.LAOS_CHECKPOINT_CONFIDENTIALITY ?? (workspace === "work" ? "internal" : "personal");
  if (workspace !== "personal" && workspace !== "work") return null;
  if (!project) return null;
  const profile = { workspace, project, confidentiality_ceiling: ceiling };

  // The evidence.publish forwarding uses the default runCli (resolving the CLI
  // under codeRoot and spawning env.LAOS_PYTHON_EXECUTABLE), the same fixed
  // runner shape as laos_memory_task.
  const publish = async (evidenceInput) => {
    const { buildLaosEvidencePublisher } = await import("./laos-publisher.js");
    const publisher = buildLaosEvidencePublisher({ env, codeRoot });
    return publisher(evidenceInput);
  };

  // Core `vault.read`: fd-rooted traversal in Python closes GP3-01. The same
  // runner invokes the Core CLI restricted task interface. GP4-01: the caller
  // (and the Bridge) never supply vault_root — Core derives it from its own
  // administrator config (LAOS_VAULT_ROOT). The task carries only relative_path.
  const vaultRead = async (relativePath) => {
    const { runCli } = await import("./laos-publisher.js");
    const task = {
      type: "vault.read",
      input: { relative_path: relativePath },
    };
    const stdout = await runCli(env, JSON.stringify(task), codeRoot);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      const error = new Error("vault.read returned malformed JSON");
      error.code = "vault_read_failed";
      throw error;
    }
    if (parsed?.error) {
      const error = new Error(parsed.error.message || "vault.read failed");
      error.code = parsed.error.code || "vault_read_failed";
      throw error;
    }
    const content = parsed?.output?.content;
    if (typeof content !== "string") {
      const error = new Error("vault.read did not return content");
      error.code = "vault_read_failed";
      throw error;
    }
    return content;
  };

  return async (input) => {
    // input is { relative_path } — the only caller-supplied field (Phase 1).
    if (!input || typeof input !== "object" || typeof input.relative_path !== "string") {
      const error = new Error("vault snapshot requires relative_path");
      error.code = "invalid_request";
      throw error;
    }
    const noteRelativePath = input.relative_path;

    // fd-rooted vault read via Core (S8/GP3-01): the returned bytes are the
    // note content as read from the fd chain rooted at the trusted vault root.
    // The relative path Core validated is the same reject-all string, so the
    // read object, partition, and identity describe the same canonical note
    // (GP2-02).
    const raw = await vaultRead(noteRelativePath);
    const partition = resolvePartition(map, noteRelativePath);
    const confirmed = verifyScope(partition, profile);
    const { identity, input: snapshotInput } = buildCanonicalNoteSnapshot(raw, noteRelativePath, partition);

    const evidenceInput = {
      ...snapshotInput,
      workspace: confirmed.workspace,
      project: confirmed.project,
      confidentiality: confirmed.confidentiality,
    };
    const coreResult = await publish(evidenceInput);
    return {
      canonical_identity: identity.canonical_identity,
      note_id: identity.note_id,
      source_sha256: identity.source_sha256,
      identity_state: identity.identity_state,
      source_ref: coreResult.source_ref,
      artifact_sha256: coreResult.artifact_sha256,
      payload_sha256: coreResult.payload_sha256,
      partition: confirmed,
    };
  };
}
