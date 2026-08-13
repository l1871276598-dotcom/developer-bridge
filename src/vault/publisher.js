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

const CONFIDENTIALITY_RANK = Object.freeze(Object.assign(Object.create(null), {
  public: 0,
  personal: 1,
  internal: 2,
  restricted: 3,
}));
const PROFILE_KEYS = ["workspace", "project", "confidentiality_ceiling"];
const PARTITION_KEY_SETS = [
  ["workspace", "project", "confidentiality"],
  // resolvePartition preserves its matched path prefix as trusted mapping
  // metadata. It is the only non-scope field accepted at this boundary.
  ["workspace", "project", "confidentiality", "path_prefix"],
];

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

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactOwnDataKeys(value, acceptedKeySets) {
  if (!isPlainRecord(value)) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    return acceptedKeySets.some((expected) => {
      if (ownKeys.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) {
        return false;
      }
      return expected.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return Boolean(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
      });
    });
  } catch {
    return false;
  }
}

/**
 * Verify a partition against the Bridge profile.
 * profile: { workspace, project, confidentiality_ceiling }
 * Returns the confirmed scope (profile workspace/project + note confidentiality).
 */
export function verifyScope(partition, profile) {
  if (!hasExactOwnDataKeys(profile, [PROFILE_KEYS])) {
    fail("invalid_profile", "Bridge profile must be an exact plain scope record");
  }
  const { workspace, project, confidentiality_ceiling: ceiling } = profile;
  if (workspace !== "personal" && workspace !== "work") {
    fail("invalid_profile", "profile workspace is invalid");
  }
  if (typeof project !== "string" || project.length === 0) {
    fail("invalid_profile", "profile project is invalid");
  }
  if (typeof ceiling !== "string" || !Object.hasOwn(CONFIDENTIALITY_RANK, ceiling)) {
    fail("invalid_profile", "profile confidentiality ceiling is invalid");
  }

  if (!hasExactOwnDataKeys(partition, PARTITION_KEY_SETS)) {
    fail("scope_mismatch", "note partition must be an exact plain scope record");
  }
  if (typeof partition.workspace !== "string" || typeof partition.project !== "string"
    || typeof partition.confidentiality !== "string") {
    fail("scope_mismatch", "note partition fields are invalid");
  }
  if (Object.hasOwn(partition, "path_prefix")
    && (typeof partition.path_prefix !== "string" || partition.path_prefix.length === 0)) {
    fail("scope_mismatch", "note partition path prefix is invalid");
  }
  if (!Object.hasOwn(CONFIDENTIALITY_RANK, partition.confidentiality)) {
    fail("scope_mismatch", "note confidentiality is invalid");
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
