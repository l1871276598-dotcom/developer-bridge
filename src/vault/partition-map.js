/**
 * Vault partition mapping — administrator-frozen path → workspace/project/
 * confidentiality.  This is the ONLY source of partition scope for Vault
 * notes.  The adapter never infers scope from a path or from Front Matter.
 *
 * Rules:
 *   - match by longest path prefix;
 *   - an exact duplicate prefix is a configuration error;
 *   - no match → partition_not_found;
 *   - confidentiality is validated against the fixed level ladder.
 */

const CONFIDENTIALITY_LEVELS = ["public", "personal", "internal", "restricted"];

export class PartitionMapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PartitionMapError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PartitionMapError(code, message);
}

function normalizePrefix(prefix) {
  if (typeof prefix !== "string" || prefix.length === 0) {
    fail("invalid_partition_rule", "path_prefix must be a non-empty string");
  }
  return prefix.split("/").filter((seg) => seg !== "" && seg !== ".").join("/");
}

function validateWorkspace(value) {
  if (value !== "personal" && value !== "work") {
    fail("invalid_partition_rule", "workspace must be personal or work");
  }
}

function validateConfidentiality(value) {
  if (!CONFIDENTIALITY_LEVELS.includes(value)) {
    fail("invalid_partition_rule", "confidentiality is invalid");
  }
}

/**
 * Build a partition map from admin rules.
 * rules: [{ path_prefix, workspace, project, confidentiality }]
 * Returns a frozen, sorted-by-length-desc map keyed by normalized prefix.
 */
export function buildPartitionMap(rules) {
  if (!Array.isArray(rules)) {
    fail("invalid_partition_config", "partition rules must be an array");
  }
  const seen = new Set();
  const entries = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      fail("invalid_partition_rule", "partition rule must be an object");
    }
    const keys = Object.keys(rule).sort().join(",");
    if (keys !== "confidentiality,path_prefix,project,workspace") {
      fail("invalid_partition_rule", "partition rule has invalid keys");
    }
    const prefix = normalizePrefix(rule.path_prefix);
    validateWorkspace(rule.workspace);
    validateConfidentiality(rule.confidentiality);
    if (typeof rule.project !== "string" || rule.project.length === 0) {
      fail("invalid_partition_rule", "project must be a non-empty string");
    }
    if (seen.has(prefix)) {
      fail("partition_rule_conflict", `duplicate path_prefix: ${prefix}`);
    }
    seen.add(prefix);
    entries.push({ prefix, rule });
  }
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  // Deep freeze: each rule object is immutable as well as the array (F-05).
  return Object.freeze(
    entries.map(({ prefix, rule }) =>
      Object.freeze({
        path_prefix: prefix,
        workspace: rule.workspace,
        project: rule.project,
        confidentiality: rule.confidentiality,
      }),
    ),
  );
}

/**
 * Resolve partition for a note-relative path.
 * Returns a frozen { workspace, project, confidentiality, path_prefix }.
 * Throws partition_not_found when no rule matches.
 */
export function resolvePartition(map, noteRelativePath) {
  if (typeof noteRelativePath !== "string" || noteRelativePath.length === 0) {
    fail("partition_not_found", "no partition rule matches this note");
  }
  const normalized = noteRelativePath.split("/").filter((seg) => seg !== "" && seg !== ".").join("/");
  let best = null;
  for (const rule of map) {
    if (normalized === rule.path_prefix || normalized.startsWith(`${rule.path_prefix}/`)) {
      best = rule;
      break;
    }
  }
  if (best === null) {
    fail("partition_not_found", `no partition rule matches ${noteRelativePath}`);
  }
  return Object.freeze({
    workspace: best.workspace,
    project: best.project,
    confidentiality: best.confidentiality,
    path_prefix: best.path_prefix,
  });
}
