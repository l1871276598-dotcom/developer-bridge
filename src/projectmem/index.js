import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildManifestBody,
  canonicalJson,
  finalizeManifest,
  readManifest,
  validateManifest,
  writeManifest,
  ManifestError,
} from "./manifest.js";

/**
 * projectmem v2 — repo-local project context cache.
 *
 * Not a memory authority, review authority, or activation authority.  It only
 * caches derived context/search views and vault evidence handles.
 *
 * binding_state semantics (C-INV-18): a derived view never claims `verified`
 * without a machine-verifiable authority proof.  projectmem has no such proof,
 * so the strongest state it may report is `refreshed` (just re-read through
 * the Bridge/Core, still a cache) or `derived` (local generation only).
 */

export const PROJECTMEM_SUMMARY_SCHEMA = "laos-projectmem-summary/v2";

export class ProjectmemError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProjectmemError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProjectmemError(code, message);
}

function canonicalJsonCompact(value) {
  return canonicalJson(value);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

const BINDING_STATES = Object.freeze(["derived", "refreshed", "stale", "invalid"]);

async function safeProjectmemDir(repoRoot) {
  const target = path.join(repoRoot, ".projectmem");
  const info = await lstat(target).catch(() => null);
  if (info === null) return { exists: false, target };
  if (info.isSymbolicLink()) fail("projectmem_invalid_repo", ".projectmem must not be a symbolic link");
  if (!info.isDirectory()) fail("projectmem_invalid_repo", ".projectmem must be a directory");
  return { exists: true, target };
}

/**
 * Verify a repo root is usable for projectmem init.
 */
export async function verifyRepoRoot(repoRoot) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    fail("projectmem_invalid_repo", "repo root must be a non-empty path");
  }
  const info = await lstat(repoRoot).catch(() => null);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) {
    fail("projectmem_invalid_repo", "repo root must be an existing real directory");
  }
  const gitDir = await lstat(path.join(repoRoot, ".git")).catch(() => null);
  if (gitDir === null) fail("projectmem_invalid_repo", "repo root must contain a .git entry");
}

/**
 * Build the v2 summary object from manifest + core context/search + vault
 * handles. binding_state is a derived-view state (C-INV-18), never "verified".
 */
export function buildSummary(manifest, {
  contextSha256,
  handles,
  vaultNotes,
  generatedAt,
  bindingState = "derived",
}) {
  if (!BINDING_STATES.includes(bindingState)) {
    fail("projectmem_invalid_binding_state", "binding_state is invalid");
  }
  return {
    schema: PROJECTMEM_SUMMARY_SCHEMA,
    project: manifest.project,
    workspace: manifest.workspace,
    binding_info: {
      manifest_integrity_sha256: manifest.manifest_sha256,
      bridge_profile: manifest.bridge_profile,
      context_sha256: contextSha256 ?? "",
      core_response_sha256: sha256Hex(canonicalJsonCompact({
        context_sha256: contextSha256 ?? "",
        handles: handles ?? [],
      })),
      generated_at: generatedAt ?? new Date().toISOString(),
      binding_state: bindingState,
    },
    core: {
      context_sha256: contextSha256 ?? "",
      handles: handles ?? [],
    },
    vault: {
      notes: vaultNotes ?? [],
    },
  };
}

/**
 * Reconcile a manifest against the trusted Bridge profile (plan §47).
 * Returns the manifest on success; throws projectmem_binding_conflict when the
 * manifest scope disagrees with the profile.
 */
export function reconcileManifestWithProfile(manifest, profile) {
  if (!profile || typeof profile !== "object") {
    fail("projectmem_invalid_profile", "Bridge profile is not configured");
  }
  const { workspace, project, confidentiality_ceiling: ceiling } = profile;
  if (workspace !== "personal" && workspace !== "work") {
    fail("projectmem_invalid_profile", "profile workspace is invalid");
  }
  if (typeof project !== "string" || project.length === 0) {
    fail("projectmem_invalid_profile", "profile project is invalid");
  }
  const rank = { public: 0, personal: 1, internal: 2, restricted: 3 };
  if (manifest.workspace !== workspace) {
    fail("projectmem_binding_conflict", "manifest workspace does not match the Bridge profile");
  }
  if (manifest.project !== project) {
    fail("projectmem_binding_conflict", "manifest project does not match the Bridge profile");
  }
  if (rank[manifest.confidentiality_ceiling] > rank[ceiling ?? "internal"]) {
    fail("projectmem_binding_conflict", "manifest confidentiality exceeds the Bridge profile ceiling");
  }
  return manifest;
}

/**
 * Initialize projectmem for a repo.
 * Returns { status, manifest, summary_sha256 }.
 */
export async function initProjectmem({
  repoRoot,
  repoKey,
  component,
  workspace,
  project,
  confidentialityCeiling,
  bridgeProfile,
  contextSha256,
  handles,
  vaultNotes,
  created_at: createdAt,
  trustedProfile,
}) {
  await verifyRepoRoot(repoRoot);
  const { exists } = await safeProjectmemDir(repoRoot);

  const body = buildManifestBody({
    repo_key: repoKey,
    component,
    workspace,
    project,
    confidentiality_ceiling: confidentialityCeiling,
    bridge_profile: bridgeProfile,
  });
  const manifest = finalizeManifest(body);

  // Reconcile the manifest scope against the trusted Bridge profile before
  // anything is written (plan §47). A forged or mis-scoped manifest can never
  // claim a binding it does not have.
  const profile = trustedProfile ?? {
    workspace,
    project,
    confidentiality_ceiling: confidentialityCeiling ?? "personal",
  };
  reconcileManifestWithProfile(manifest, profile);

  if (exists) {
    const existing = await readManifest(repoRoot);
    const sameBinding =
      existing.repo_key === manifest.repo_key &&
      existing.component === manifest.component &&
      existing.workspace === manifest.workspace &&
      existing.project === manifest.project &&
      existing.confidentiality_ceiling === manifest.confidentiality_ceiling &&
      existing.bridge_profile === manifest.bridge_profile;
    if (sameBinding) {
      return {
        status: "already_initialized",
        manifest: existing,
        summary_sha256: null,
      };
    }
    fail("projectmem_binding_conflict", "existing .projectmem has a conflicting binding");
  }

  await mkdir(path.join(repoRoot, ".projectmem"), { recursive: true });
  await writeManifest(repoRoot, manifest);

  const gitignoreBody = "/summaries/*\n!/summaries/.gitkeep\n";
  await writeFile(path.join(repoRoot, ".projectmem", ".gitignore"), gitignoreBody);
  await mkdir(path.join(repoRoot, ".projectmem", "summaries"), { recursive: true });
  await writeFile(path.join(repoRoot, ".projectmem", "summaries", ".gitkeep"), "");

  // When live Core context/search seeded this summary, it was just refreshed
  // through the Bridge/Core but remains a cache — "refreshed", never
  // "verified" (C-INV-18).
  const bindingState = contextSha256 ? "refreshed" : "derived";
  const summary = buildSummary(manifest, {
    contextSha256,
    handles,
    vaultNotes,
    generatedAt: createdAt,
    bindingState,
  });
  const summarySha = sha256Hex(canonicalJsonCompact(summary));
  const currentJson = path.join(repoRoot, ".projectmem", "summaries", "current.json");
  const currentMd = path.join(repoRoot, ".projectmem", "summaries", "current.md");
  await writeFile(currentJson, `${canonicalJsonCompact(summary)}\n`);
  await writeFile(currentMd, renderSummaryMarkdown(summary));

  return {
    status: "initialized",
    manifest,
    summary_sha256: summarySha,
  };
}

function renderSummaryMarkdown(summary) {
  const binding = summary.binding_info;
  const lines = [
    "# projectmem summary",
    "",
    `- project: ${summary.project}`,
    `- workspace: ${summary.workspace}`,
    `- generated_at: ${binding.generated_at}`,
    `- binding_state: ${binding.binding_state}`,
    "",
    "## binding",
    "",
    `- manifest_integrity_sha256: ${binding.manifest_integrity_sha256}`,
    `- bridge_profile: ${binding.bridge_profile}`,
    `- context_sha256: ${binding.context_sha256 || "(empty)"}`,
    `- core_response_sha256: ${binding.core_response_sha256}`,
    "",
    "## core",
    "",
    `- context_sha256: ${summary.core.context_sha256 || "(empty)"}`,
    `- handles: ${summary.core.handles.length}`,
    "",
    "## vault",
    "",
  ];
  for (const note of summary.vault.notes) {
    lines.push(`- ${note.canonical_identity} → ${note.artifact}`);
  }
  lines.push("");
  return lines.join("\n");
}

export { canonicalJson, validateManifest, ManifestError };
