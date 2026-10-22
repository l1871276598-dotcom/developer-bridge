import path from "node:path";

import { resolveVaultRoot, resolveNotePath } from "./vault-root.js";
import { readNoteIdentity } from "./note-identity.js";
import { buildPartitionMap, resolvePartition } from "./partition-map.js";
import { buildSnapshotFromRaw } from "./snapshot.js";
import { readStableVaultNote } from "./stable-read.js";
import { verifyScope, saveEvidenceHandle, PublisherError } from "./publisher.js";

/**
 * Vault evidence flow orchestrator.
 *
 *   Vault note → snapshot → scope verify → evidence.publish → handle save
 *
 * publishNote() is pure adapter logic; the actual evidence.publish invocation
 * is delegated to a caller-supplied publishEvidence function so this module
 * stays testable without a live Core.
 */

export class VaultEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VaultEvidenceError";
    this.code = code;
  }
}

function wrap(code, message) {
  return new VaultEvidenceError(code, message);
}

/**
 * Load a partition map from a JSON config file.
 * config: { vault: { root }, partition_rules: [...] }
 */
export function loadConfig(filePath) {
  // Deferred require so CLI and tests can pass a config object directly.
  return import("node:fs/promises").then(async (fs) => {
    const raw = await fs.readFile(filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw wrap("invalid_config", "config file is not valid JSON");
    }
    return parsed;
  });
}

/**
 * Run the full evidence publish flow for one note.
 * Returns the result envelope.
 */
export async function publishNote({
  config,
  vaultRoot,
  partitionMap,
  profile,
  noteRelativePath,
  workspaceRoot,
  publishEvidence,
}) {
  const root = vaultRoot ?? (await resolveVaultRoot(config.vault.root));
  const map = partitionMap ?? buildPartitionMap(config.partition_rules);

  // One stable read: identity and payload derive from the SAME raw bytes
  // (C-INV-17 / F-04 TOCTOU).
  const { raw } = await readStableVaultNote(root, noteRelativePath);
  const identity = readNoteIdentity(raw, noteRelativePath);
  const partition = resolvePartition(map, noteRelativePath);

  if (identity.identity_state === "derived" && !identity.has_front_matter_id) {
    // Derived identity is not a verified source; still publishable, but the
    // result must mark the identity state so downstream knows.
  }

  const snapshot = buildSnapshotFromRaw(raw, identity, partition);
  const confirmed = verifyScope(partition, profile);

  // The adapter injects the profile-confirmed scope into the evidence.publish
  // input.  When called through the Bridge this matches the Bridge's own scope
  // injection; when called directly via the CLI it supplies the fields the Core
  // EvidenceAgent requires.  The scope values are profile-confirmed, never
  // caller-supplied.
  const input = {
    ...snapshot.input,
    workspace: confirmed.workspace,
    project: confirmed.project,
    confidentiality: confirmed.confidentiality,
  };

  const coreResult = await publishEvidence(input);

  const handle = {
    note_id: identity.note_id,
    relative_path: identity.relative_path,
    canonical_identity: identity.canonical_identity,
    identity_state: identity.identity_state,
    artifact_ref: coreResult.source_ref,
    artifact_sha256: coreResult.artifact_sha256,
    partition: confirmed,
    published_at: new Date().toISOString(),
  };

  let handle_path = null;
  if (workspaceRoot) {
    handle_path = await saveEvidenceHandle(workspaceRoot, handle);
  }

  return {
    canonical_identity: identity.canonical_identity,
    note_id: identity.note_id,
    sha256: identity.sha256,
    identity_state: identity.identity_state,
    source_ref: coreResult.source_ref,
    artifact_sha256: coreResult.artifact_sha256,
    partition: confirmed,
    handle_path,
  };
}

export {
  resolveVaultRoot,
  resolveNotePath,
  readNoteIdentity,
  buildPartitionMap,
  resolvePartition,
  buildSnapshotFromRaw,
  verifyScope,
  saveEvidenceHandle,
  PublisherError,
};

export function errorCode(error) {
  if (error && typeof error.code === "string") return error.code;
  return "vault_evidence_failed";
}

export function errorMessage(error) {
  if (error && typeof error.message === "string") return error.message;
  return "vault evidence failed";
}
