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

export async function buildEnvVaultPublisher(env, { coreRoot, codeRoot, runner } = {}) {
  const config = await loadVaultConfig(env);
  if (!config) return null;
  const root = await resolveVaultRoot(config.vault.root);
  // GP5-01: there is exactly ONE vault-root authority. Core reads bytes from
  // LAOS_VAULT_ROOT (admin config); the Bridge config.vault.root is used only
  // for partition-map interpretation and MUST canonicalize to the same root.
  // A mismatch fails closed at startup — it would otherwise let evidence carry
  // Vault B content under Vault A partition/confidentiality semantics. Like
  // "not configured", a mismatch makes vault evidence UNAVAILABLE (returns
  // null) rather than crashing the whole tool.
  const configuredVaultRoot = env.LAOS_VAULT_ROOT;
  if (typeof configuredVaultRoot !== "string" || configuredVaultRoot.length === 0) {
    return null;
  }
  let canonicalCoreRoot;
  try {
    canonicalCoreRoot = await resolveVaultRoot(configuredVaultRoot);
  } catch {
    return null;
  }
  if (canonicalCoreRoot !== root) {
    return null;
  }
  // GP6-01: the verified canonical root is FROZEN here and explicitly injected
  // into the child-process environment. Neither runCli's `...process.env`
  // merge nor any later dynamic `env` change can substitute a different
  // LAOS_VAULT_ROOT — the Core child always reads from this exact root.
  const childEnv = {
    ...env,
    LAOS_VAULT_ROOT: canonicalCoreRoot,
  };
  const map = buildPartitionMap(config.partition_rules);
  const workspace = env.LAOS_CHECKPOINT_WORKSPACE;
  const project = env.LAOS_CHECKPOINT_PROJECT;
  const ceiling = env.LAOS_CHECKPOINT_CONFIDENTIALITY ?? (workspace === "work" ? "internal" : "personal");
  if (workspace !== "personal" && workspace !== "work") return null;
  if (!project) return null;
  const profile = { workspace, project, confidentiality_ceiling: ceiling };
  // `codeRoot` is retained as a factory-input alias for existing callers. It
  // always meant the trusted Core runtime here; call-time workspace identity is
  // supplied separately for every request below.
  const immutableCoreRoot = coreRoot ?? codeRoot ?? runner?.coreRoot;
  if (typeof immutableCoreRoot !== "string" || !immutableCoreRoot) return null;

  function executionOptions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.hasOwn(value, "workspace") || !Object.hasOwn(value, "cwd")) {
      const error = new Error("vault publisher requires a workspace and immutable Core cwd");
      error.code = "invalid_workspace";
      throw error;
    }
    if (value.cwd !== immutableCoreRoot) {
      const error = new Error("vault publisher must execute from the immutable Core runtime");
      error.code = "invalid_workspace";
      throw error;
    }
    return { workspace: value.workspace, cwd: immutableCoreRoot };
  }

  // The evidence.publish forwarding uses the shared TrustedCoreRunner (GP9-01):
  // the same bounded spawn + verified interpreter + sanitized env as every
  // other Core child. childEnv carries the frozen verified root.
  // GP12-01: the current workspace is supplied per call, so a workspace swap
  // between construction and this request cannot bypass interpreter checks.
  const publish = async (evidenceInput, execution) => {
    const { buildLaosEvidencePublisher } = await import("./laos-publisher.js");
    const publisher = buildLaosEvidencePublisher({
      // This is not caller-controlled scope: evidenceInput is assembled below
      // from resolvePartition + verifyScope.  The normalizer must receive the
      // same verified source classification that will be persisted, while the
      // original profile ceiling has already authorized it in verifyScope.
      env: {
        ...childEnv,
        LAOS_CHECKPOINT_CONFIDENTIALITY: evidenceInput.confidentiality,
      },
      workspace: execution.workspace,
      cwd: execution.cwd,
      runner,
    });
    return publisher(evidenceInput);
  };

  // Core `vault.read`: fd-rooted traversal in Python closes GP3-01. The same
  // runner invokes the Core CLI restricted task interface. GP4-01: the caller
  // (and the Bridge) never supply vault_root — Core derives it from its own
  // administrator config (LAOS_VAULT_ROOT). The task carries only relative_path.
  const vaultRead = async (relativePath, execution) => {
    const task = {
      type: "vault.read",
      input: { relative_path: relativePath },
    };
    // Pass ONLY the frozen LAOS_VAULT_ROOT as an extra env field (GP10-01:
    // field-level allowlist — the TrustedCoreRunner only permits LAOS_VAULT_ROOT
    // and LAOS_STATE_DIR through extraEnv; all other keys are silently dropped).
    const stdout = await runner.runCli(JSON.stringify(task), {
      workspace: execution.workspace,
      cwd: execution.cwd,
      extraEnv: { LAOS_VAULT_ROOT: childEnv.LAOS_VAULT_ROOT },
    });
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

  // GP12-01: the dispatcher supplies the current validated workspace per
  // request, while this factory preserves the immutable Core execution cwd.
  return async (input, execution) => {
    // input is { relative_path } — the only caller-supplied field (Phase 1).
    if (!input || typeof input !== "object" || typeof input.relative_path !== "string") {
      const error = new Error("vault snapshot requires relative_path");
      error.code = "invalid_request";
      throw error;
    }
    const noteRelativePath = input.relative_path;
    const runOptions = executionOptions(execution);

    // fd-rooted vault read via Core (S8/GP3-01): the returned bytes are the
    // note content as read from the fd chain rooted at the trusted vault root.
    // The relative path Core validated is the same reject-all string, so the
    // read object, partition, and identity describe the same canonical note
    // (GP2-02).
    const raw = await vaultRead(noteRelativePath, runOptions);
    const partition = resolvePartition(map, noteRelativePath);
    const confirmed = verifyScope(partition, profile);
    const { identity, input: snapshotInput } = buildCanonicalNoteSnapshot(raw, noteRelativePath, partition);

    // GP10-08: the profile ceiling remains an authorization upper-bound check
    // in verifyScope, but Core must persist the note's actual verified
    // classification. The returned partition and persisted evidence request
    // therefore carry the same confidentiality value.
    const evidenceInput = {
      ...snapshotInput,
      workspace: confirmed.workspace,
      project: confirmed.project,
      confidentiality: confirmed.confidentiality,
    };
    const coreResult = await publish(evidenceInput, runOptions);
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
