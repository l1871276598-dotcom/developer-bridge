import { readFile } from "node:fs/promises";

import { buildPartitionMap, resolvePartition } from "./partition-map.js";
import { buildCanonicalNoteSnapshot } from "./snapshot.js";
import { readStableVaultNote } from "./stable-read.js";
import { resolveVaultRoot } from "./vault-root.js";
import { verifyScope } from "./publisher.js";

/**
 * Environment-configured vault evidence publisher (GP-01).
 *
 * The ONLY way an external caller can mint a vault-backed evidence artifact:
 * the Bridge reads the Vault (stable single read), derives identity + source
 * hash, resolves the partition, verifies scope against the trusted Bridge
 * profile, and only then publishes through Core evidence.publish (internal).
 * A caller can never construct source identity, payload, or scope.
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
  // runner shape as laos_memory_task. An injected laosRunCommand is NOT used
  // here — it is only for the main dispatcher; the vault publisher must run
  // through the real Core CLI so the artifact is genuinely minted.
  const publish = async (evidenceInput) => {
    const { buildLaosEvidencePublisher } = await import("./laos-publisher.js");
    const publisher = buildLaosEvidencePublisher({ env, codeRoot });
    return publisher(evidenceInput);
  };

  return async (input) => {
    // input is { relative_path } — the only caller-supplied field (Phase 1).
    if (!input || typeof input !== "object" || typeof input.relative_path !== "string") {
      const error = new Error("vault snapshot requires relative_path");
      error.code = "invalid_request";
      throw error;
    }
    const noteRelativePath = input.relative_path;

    // One stable read: identity and payload from the SAME bytes (C-INV-17),
    // through the single source-byte contract (GP-02). The canonical relative
    // path returned by the resolver is the ONLY locator used downstream — the
    // caller's original string never reaches partition/identity/source locator
    // (GP2-02): the read object, partition, and identity must describe the same
    // canonical note.
    const { raw, relative: canonicalRelative } = await readStableVaultNote(root, noteRelativePath);
    const partition = resolvePartition(map, canonicalRelative);
    const confirmed = verifyScope(partition, profile);
    const { identity, input: snapshotInput } = buildCanonicalNoteSnapshot(raw, canonicalRelative, partition);

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
