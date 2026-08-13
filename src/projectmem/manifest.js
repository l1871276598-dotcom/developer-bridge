import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";

/**
 * projectmem manifest — the immutable repo-local binding.
 *
 * Canonical JSON rules (must match laos-json-v2 semantics):
 *   - UTF-8, LF newlines, sorted keys, compact separators, no trailing newline;
 *   - manifest_sha256 is the SHA-256 of the canonical body WITHOUT the
 *     manifest_sha256 field.
 */

export const PROJECTMEM_MANIFEST_SCHEMA = "laos-projectmem/v1";

const MANIFEST_BODY_KEYS = [
  "schema",
  "repo_key",
  "component",
  "workspace",
  "project",
  "confidentiality_ceiling",
  "bridge_profile",
  "write_policy",
];
const MANIFEST_KEYS = [...MANIFEST_BODY_KEYS, "manifest_sha256"];
const WRITE_POLICY_KEYS = ["memory_create", "handoff_write", "memory_review", "memory_activate"];
const CONFIDENTIALITY_RANK = Object.freeze(Object.assign(Object.create(null), {
  public: 0,
  personal: 1,
  internal: 2,
  restricted: 3,
}));

export class ManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ManifestError(code, message);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortedValue(value[k])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortedValue(value));
}

function exactOwnDataRecord(value, expectedKeys) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length || !expectedKeys.every((key) => Object.hasOwn(value, key))) {
      return null;
    }

    const fields = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null;
      fields[key] = descriptor.value;
    }
    return fields;
  } catch {
    return null;
  }
}

function validateManifestFields({
  schema,
  repo_key: repoKey,
  component,
  workspace,
  project,
  confidentiality_ceiling: confidentialityCeiling,
  bridge_profile: bridgeProfile,
}) {
  if (schema !== PROJECTMEM_MANIFEST_SCHEMA) {
    fail("invalid_manifest", "manifest schema is not laos-projectmem/v1");
  }
  if (typeof repoKey !== "string" || !/^[A-Za-z0-9._-]+$/u.test(repoKey)) {
    fail("invalid_manifest", "repo_key must be a stable slug");
  }
  if (typeof component !== "string" || component.length === 0) {
    fail("invalid_manifest", "component must be a non-empty string");
  }
  if (workspace !== "personal" && workspace !== "work") {
    fail("invalid_manifest", "workspace must be personal or work");
  }
  if (typeof project !== "string" || project.length === 0) {
    fail("invalid_manifest", "project must be a non-empty string");
  }
  if (typeof confidentialityCeiling !== "string" || !Object.hasOwn(CONFIDENTIALITY_RANK, confidentialityCeiling)) {
    fail("invalid_manifest", "confidentiality_ceiling is invalid");
  }
  if (typeof bridgeProfile !== "string" || bridgeProfile.length === 0) {
    fail("invalid_manifest", "bridge_profile must be a non-empty string");
  }
}

function validateWritePolicy(writePolicy) {
  const fields = exactOwnDataRecord(writePolicy, WRITE_POLICY_KEYS);
  if (fields === null) fail("invalid_manifest", "write_policy must be an exact plain own-data object");
  const memoryReview = fields.memory_review;
  const memoryActivate = fields.memory_activate;
  if (memoryReview === true || memoryActivate === true) {
    fail("invalid_manifest", "write_policy must not enable memory_review or memory_activate");
  }
  if (memoryReview !== false || memoryActivate !== false) {
    fail("invalid_manifest", "memory_review and memory_activate must be false");
  }
  for (const key of ["memory_create", "handoff_write"]) {
    if (typeof fields[key] !== "boolean") fail("invalid_manifest", `${key} must be a boolean`);
  }
  return fields;
}

export function buildManifestBody({
  repo_key: repoKey,
  component,
  workspace,
  project,
  confidentiality_ceiling: confidentialityCeiling,
  bridge_profile: bridgeProfile,
}) {
  const body = {
    schema: PROJECTMEM_MANIFEST_SCHEMA,
    repo_key: repoKey,
    component,
    workspace,
    project,
    confidentiality_ceiling: confidentialityCeiling,
    bridge_profile: bridgeProfile,
    write_policy: {
      memory_create: true,
      handoff_write: true,
      memory_review: false,
      memory_activate: false,
    },
  };
  validateManifestFields(body);
  return body;
}

export function manifestSha256(body) {
  const canonical = canonicalJson(body);
  return createHash("sha256").update(canonical).digest("hex");
}

export function finalizeManifest(body) {
  return { ...body, manifest_sha256: manifestSha256(body) };
}

export function canonicalManifestBytes(manifest) {
  const body = { ...manifest };
  delete body.manifest_sha256;
  return canonicalJson(body);
}

export function validateManifest(body) {
  const fields = exactOwnDataRecord(body, MANIFEST_KEYS);
  if (fields === null) fail("invalid_manifest", "manifest must be an exact plain own-data object");
  validateManifestFields(fields);
  const writePolicy = validateWritePolicy(fields.write_policy);
  if (typeof fields.manifest_sha256 !== "string" || fields.manifest_sha256.length !== 64) {
    fail("invalid_manifest", "manifest_sha256 must be a 64-char hex string");
  }
  const bodyWithoutHash = Object.create(null);
  for (const key of MANIFEST_BODY_KEYS) {
    bodyWithoutHash[key] = key === "write_policy" ? writePolicy : fields[key];
  }
  const computed = manifestSha256(bodyWithoutHash);
  if (computed !== fields.manifest_sha256) {
    fail("invalid_manifest", "manifest_sha256 does not match canonical body");
  }
  return body;
}

export async function readManifest(repoRoot) {
  const target = path.join(repoRoot, ".projectmem", "manifest.json");
  let raw;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    fail("manifest_missing", "no .projectmem/manifest.json found");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("manifest_invalid", "manifest is not valid JSON");
  }
  return validateManifest(parsed);
}

export async function writeManifest(repoRoot, manifest) {
  const dir = path.join(repoRoot, ".projectmem");
  const target = path.join(dir, "manifest.json");
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  await writeFile(target, bytes);
  return target;
}
