import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * projectmem manifest — the immutable repo-local binding.
 *
 * Canonical JSON rules (must match laos-json-v2 semantics):
 *   - UTF-8, LF newlines, sorted keys, compact separators, no trailing newline;
 *   - manifest_sha256 is the SHA-256 of the canonical body WITHOUT the
 *     manifest_sha256 field.
 */

export const PROJECTMEM_MANIFEST_SCHEMA = "laos-projectmem/v1";

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

function validateWritePolicy(writePolicy) {
  if (!writePolicy || typeof writePolicy !== "object" || Array.isArray(writePolicy)) {
    fail("invalid_manifest", "write_policy must be an object");
  }
  const memoryReview = writePolicy.memory_review;
  const memoryActivate = writePolicy.memory_activate;
  if (memoryReview === true || memoryActivate === true) {
    fail("invalid_manifest", "write_policy must not enable memory_review or memory_activate");
  }
  const allowed = { memory_create: true, handoff_write: true, memory_review: false, memory_activate: false };
  for (const key of Object.keys(writePolicy)) {
    if (!(key in allowed)) fail("invalid_manifest", `write_policy has unknown key: ${key}`);
  }
  if (writePolicy.memory_review !== false || writePolicy.memory_activate !== false) {
    fail("invalid_manifest", "memory_review and memory_activate must be false");
  }
  for (const key of ["memory_create", "handoff_write"]) {
    if (typeof writePolicy[key] !== "boolean") fail("invalid_manifest", `${key} must be a boolean`);
  }
}

export function buildManifestBody({
  repo_key: repoKey,
  component,
  workspace,
  project,
  confidentiality_ceiling: confidentialityCeiling,
  bridge_profile: bridgeProfile,
}) {
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
  if (!["public", "personal", "internal", "restricted"].includes(confidentialityCeiling)) {
    fail("invalid_manifest", "confidentiality_ceiling is invalid");
  }
  if (typeof bridgeProfile !== "string" || bridgeProfile.length === 0) {
    fail("invalid_manifest", "bridge_profile must be a non-empty string");
  }

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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("invalid_manifest", "manifest must be an object");
  }
  if (body.schema !== PROJECTMEM_MANIFEST_SCHEMA) {
    fail("invalid_manifest", "manifest schema is not laos-projectmem/v1");
  }
  validateWritePolicy(body.write_policy);
  if (typeof body.manifest_sha256 !== "string" || body.manifest_sha256.length !== 64) {
    fail("invalid_manifest", "manifest_sha256 must be a 64-char hex string");
  }
  const bodyWithoutHash = { ...body };
  delete bodyWithoutHash.manifest_sha256;
  const computed = manifestSha256(bodyWithoutHash);
  if (computed !== body.manifest_sha256) {
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
