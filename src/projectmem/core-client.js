import { createHash } from "node:crypto";

/**
 * Core context/search client for projectmem.
 *
 * Invokes the LAOS CLI (laos.py) for context.build and memory.search, the same
 * command path used by laos_memory_task at runtime.  Read-only: never creates
 * candidates or mutates memory.
 */

export class CoreClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CoreClientError";
    this.code = code;
  }
}

// The ONLY accepted handle grammar. Core memory ids are type-day-uuid8 slugs
// (e.g. principle-2026-08-07-3f2a1b9c), so a valid id MUST contain at least
// one "-". A bare slug like "unknown" or "memory:unknown" is never a valid Core
// id and fails closed, as do whitespace, control characters, path separators,
// and extra schema fields.
const MEMORY_ID_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/u;

/**
 * Parse a Core memory.search result into a validated memory:<id> handle.
 * Accepts only a "memory:" string whose id is a non-empty [A-Za-z0-9_-] slug,
 * or an object with exactly one own "id" string property matching the slug.
 * Everything else throws core_malformed_response (S12 / R14).
 */
export function parseMemoryHandle(item) {
  if (typeof item === "string") {
    if (!item.startsWith("memory:")) {
      throw new CoreClientError("core_malformed_response", "memory.search returned an unrecognized handle string");
    }
    const id = item.slice("memory:".length);
    if (!MEMORY_ID_RE.test(id)) {
      throw new CoreClientError("core_malformed_response", "memory.search returned a malformed memory handle id");
    }
    return item;
  }
  if (item && typeof item === "object") {
    // Exact schema: the object must have exactly one own "id" string property.
    const ownKeys = Object.keys(item);
    if (ownKeys.length !== 1 || ownKeys[0] !== "id") {
      throw new CoreClientError("core_malformed_response", "memory.search returned an unrecognized handle object");
    }
    if (!Object.prototype.hasOwnProperty.call(item, "id") || typeof item.id !== "string") {
      throw new CoreClientError("core_malformed_response", "memory.search returned a malformed handle id");
    }
    if (!MEMORY_ID_RE.test(item.id)) {
      throw new CoreClientError("core_malformed_response", "memory.search returned a malformed handle id");
    }
    return `memory:${item.id}`;
  }
  throw new CoreClientError("core_malformed_response", "memory.search returned an unrecognized handle");
}

/**
 * Build a projectmem core client bound to a trusted scope (F-07 / C-INV-13).
 *
 * The authoritative scope (workspace/project/confidentiality) is derived ONLY
 * from the trusted Bridge profile. The manifest is not trusted: it declares a
 * scope claim that must equal the profile, and any mismatch is a hard
 * scope_mismatch. This is defense-in-depth — a caller that skips
 * initProjectmem's reconcile cannot route a mis-scoped manifest into Core
 * through this client.
 */
export function buildCoreClient({ manifest, trustedProfile, runner } = {}) {
  if (!manifest || typeof manifest !== "object") {
    throw new CoreClientError("core_invalid_manifest", "projectmem manifest is required");
  }
  if (!trustedProfile || typeof trustedProfile !== "object") {
    throw new CoreClientError("core_invalid_profile", "trusted Bridge profile is required");
  }
  const { workspace, project, confidentiality_ceiling: ceiling } = trustedProfile;
  if (workspace !== "personal" && workspace !== "work") {
    throw new CoreClientError("core_invalid_profile", "trusted profile workspace is invalid");
  }
  if (typeof project !== "string" || project.length === 0) {
    throw new CoreClientError("core_invalid_profile", "trusted profile project is invalid");
  }
  // Manifest scope claims are NOT authoritative. They must equal the trusted
  // profile exactly (GP8-02 + GP9-03): workspace, project AND confidentiality
  // ceiling must be an exact match — not merely "not exceeding". An invalid or
  // unknown manifest ceiling value is a hard mismatch (undefined rank must not
  // silently pass the comparison).
  const manifestWorkspace = manifest.workspace;
  const manifestProject = manifest.project;
  if (manifestWorkspace !== workspace) {
    throw new CoreClientError("scope_mismatch", "manifest workspace does not match the trusted Bridge profile");
  }
  if (manifestProject !== project) {
    throw new CoreClientError("scope_mismatch", "manifest project does not match the trusted Bridge profile");
  }
  const rank = { public: 0, personal: 1, internal: 2, restricted: 3 };
  const manifestCeiling = manifest.confidentiality_ceiling;
  if (manifestCeiling === undefined) {
    throw new CoreClientError("scope_mismatch", "manifest must declare a confidentiality ceiling");
  }
  // GP10-10: use Object.hasOwn to reject prototype-inherited keys like
  // "toString"/"constructor"/"__proto__" that `in` would erroneously accept.
  if (typeof manifestCeiling !== "string" || !Object.hasOwn(rank, manifestCeiling)) {
    throw new CoreClientError("scope_mismatch", "manifest confidentiality ceiling is invalid");
  }
  if (typeof ceiling !== "string" || !Object.hasOwn(rank, ceiling)) {
    throw new CoreClientError("core_invalid_profile", "trusted profile confidentiality ceiling is invalid");
  }
  if (manifestCeiling !== ceiling) {
    throw new CoreClientError("scope_mismatch", "manifest confidentiality ceiling must match the trusted Bridge profile exactly");
  }
  // Authoritative scope comes from the trusted profile, never from the manifest.
  if (!runner || typeof runner !== "object" || typeof runner.runCli !== "function") {
    throw new CoreClientError("core_unavailable", "projectmem client requires a TrustedCoreRunner");
  }
  const run = (taskJson) => runner.runCli(taskJson, {});

  function checkCoreResponse(parsed, taskType) {
    if (!parsed || typeof parsed !== "object") {
      throw new CoreClientError("core_malformed_response", `${taskType} returned malformed JSON`);
    }
    if (parsed.error) {
      const code = parsed.error?.code ?? "core_call_failed";
      throw new CoreClientError(code, parsed.error?.message ?? `${taskType} failed`);
    }
  }

  async function contextSha256(query) {
    // GP9-02: the trusted confidentiality ceiling is a read-authorization
    // parameter on the Core request, not dropped at the Bridge.
    const task = {
      type: "context.build",
      input: { query, workspace, project, confidentiality: ceiling },
      context_limit: 16000,
    };
    const stdout = await run(JSON.stringify(task));
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new CoreClientError("core_malformed_response", "context.build returned malformed JSON");
    }
    checkCoreResponse(parsed, "context.build");
    const text = parsed?.output?.text;
    if (typeof text !== "string") {
      throw new CoreClientError("core_malformed_response", "context.build did not return a text payload");
    }
    return createHash("sha256").update(text).digest("hex");
  }

  async function searchHandles(limit = 20) {
    const task = {
      type: "memory.search",
      input: { query: project ?? workspace, workspace, project, confidentiality: ceiling, limit },
    };
    const stdout = await run(JSON.stringify(task));
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new CoreClientError("core_malformed_response", "memory.search returned malformed JSON");
    }
    checkCoreResponse(parsed, "memory.search");
    const results = parsed?.output?.results;
    if (!Array.isArray(results)) {
      throw new CoreClientError("core_malformed_response", "memory.search results must be an array");
    }
    // Fail closed on unknown/malformed handle shapes (S12 / R14). The ONLY
    // accepted handle is a memory:<id> string where <id> is a non-empty
    // [A-Za-z0-9_-] slug (Core ids are type-day-uuid8). Nothing is ever
    // wrapped as a fake "memory:unknown", "memory:", or any other namespace.
    return results.map(parseMemoryHandle);
  }

  return { contextSha256, searchHandles };
}
