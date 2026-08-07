import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Vault evidence publisher — Phase 4 + Phase 5.
 *
 * Phase 4: before calling evidence.publish, verify the note's partition scope
 * equals the Bridge profile scope (workspace/project, with confidentiality at
 * or under the profile ceiling).  Any mismatch → scope_mismatch.
 *
 * Phase 5: after a successful publish, persist a lightweight handle
 * (not a Core memory copy) under .projectmem/summaries/evidence.json.
 */

const CONFIDENTIALITY_RANK = {
  public: 0,
  personal: 1,
  internal: 2,
  restricted: 3,
};

export class PublisherError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublisherError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PublisherError(code, message);
}

/**
 * Verify a partition against the Bridge profile.
 * profile: { workspace, project, confidentiality_ceiling }
 * Returns the confirmed scope (profile workspace/project + note confidentiality).
 */
export function verifyScope(partition, profile) {
  if (!profile || typeof profile !== "object") {
    fail("invalid_profile", "Bridge profile is not configured");
  }
  const { workspace, project, confidentiality_ceiling: ceiling } = profile;
  if (workspace !== "personal" && workspace !== "work") {
    fail("invalid_profile", "profile workspace is invalid");
  }
  if (typeof project !== "string" || project.length === 0) {
    fail("invalid_profile", "profile project is invalid");
  }
  if (!(ceiling in CONFIDENTIALITY_RANK)) {
    fail("invalid_profile", "profile confidentiality ceiling is invalid");
  }

  if (partition.workspace !== workspace) fail("scope_mismatch");
  if (partition.project !== project) fail("scope_mismatch");
  if (CONFIDENTIALITY_RANK[partition.confidentiality] > CONFIDENTIALITY_RANK[ceiling]) {
    fail("scope_exceeded", "note confidentiality exceeds the profile ceiling");
  }
  return {
    workspace,
    project,
    confidentiality: partition.confidentiality,
  };
}

/**
 * Save a handle to .projectmem/summaries/evidence.json under the workspace.
 * The handle is a pointer, not a Core memory copy.
 */
export async function saveEvidenceHandle(workspaceRoot, handle) {
  const dir = path.join(workspaceRoot, ".projectmem", "summaries");
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "evidence.json");
  const staged = path.join(dir, `.evidence.tmp.${process.pid}`);
  const payload = JSON.stringify(handle, null, 2) + "\n";
  await writeFile(staged, payload, "utf8");
  await rename(staged, target);
  return target;
}

export async function readEvidenceHandles(workspaceRoot) {
  const target = path.join(workspaceRoot, ".projectmem", "summaries", "evidence.json");
  try {
    const raw = await readFile(target, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export { CONFIDENTIALITY_RANK };
