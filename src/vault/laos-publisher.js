import path from "node:path";

import { createCoreRunner } from "../core-runner.js";
import { normalizeEvidenceIngress } from "../laos-memory-tool.js";

function isAbsolutePath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && path.isAbsolute(value);
}

/**
 * evidence.publish invocation through the LAOS CLI — the same task shape the
 * laos_memory_task dispatcher produces. Every production evidence ingress goes
 * through normalizeEvidenceIngress (the SAME profile scope gate + evidence
 * normalizer as laos_memory_task), so the vault-evidence CLI cannot bypass the
 * Bridge policy boundary (C-INV-16).
 */

// Exported so the env-publisher can invoke the Core CLI for the fd-rooted
// vault.read task (S8/GP3-01) through the same restricted task interface.
// This legacy export remains for callers that import it directly, but it has
// no independent spawn path: explicit bindings construct a TrustedCoreRunner
// and therefore inherit its verified environment and process-tree lifecycle.
export async function runCli(env, taskJson, codeRoot, options = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("legacy LAOS CLI requires an environment object");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)
    || !Object.hasOwn(options, "workspace") || !Object.hasOwn(options, "cwd")) {
    throw new Error("legacy LAOS CLI requires explicit workspace and immutable Core cwd bindings");
  }

  const runner = await createCoreRunner({ env, codeRoot: options.workspace });
  if (codeRoot !== undefined && codeRoot !== runner.coreRoot) {
    throw new Error("legacy LAOS CLI Core root conflicts with the TrustedCoreRunner root");
  }
  const execution = {
    workspace: options.workspace,
    cwd: options.cwd,
  };
  if (Object.hasOwn(options, "timeoutMs")) execution.timeoutMs = options.timeoutMs;
  if (Object.hasOwn(options, "extraEnv")) execution.extraEnv = options.extraEnv;
  return runner.runCli(taskJson, execution);
}

/**
 * Build an evidence.publish caller that goes through the unified Bridge
 * normalization (profile scope gate + evidence normalizer) and then invokes
 * the LAOS CLI.  The normalized task is the exact payload the laos_memory_task
 * dispatcher would forward, so behavior is identical to a live Bridge call.
 */
export function buildLaosEvidencePublisher(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("LAOS evidence publisher requires execution options");
  }
  const { env, runner, workspace, cwd, codeRoot } = options;
  // GP10-09: the vault publisher always uses the shared TrustedCoreRunner's
  // runCli (bounded, sanitized env, no ?. fallback to a bare spawn). The legacy
  // runCli export is kept only for direct test compatibility with runCli tests
  // that bypass the runner framework.
  // If no runner is provided, construction fails rather than silently
  // downgrading to a spawn that inherits process.env.
  if (!runner || typeof runner.runCli !== "function") {
    throw new Error("LAOS evidence publisher requires a TrustedCoreRunner");
  }
  const hasWorkspace = Object.hasOwn(options, "workspace");
  const hasCwd = Object.hasOwn(options, "cwd");
  const hasCodeRoot = Object.hasOwn(options, "codeRoot");
  if (!hasWorkspace || !isAbsolutePath(workspace)) {
    throw new Error("LAOS evidence publisher requires an explicit absolute workspace");
  }
  if (!hasCwd && !hasCodeRoot) {
    throw new Error("LAOS evidence publisher requires an immutable Core cwd");
  }
  if ((hasCwd && !isAbsolutePath(cwd)) || (hasCodeRoot && !isAbsolutePath(codeRoot))) {
    throw new Error("LAOS evidence publisher requires an absolute immutable Core cwd");
  }
  if (hasCwd && hasCodeRoot && cwd !== codeRoot) {
    throw new Error("LAOS evidence publisher received conflicting Core cwd values");
  }
  // `codeRoot` remains a compatibility alias for the immutable execution cwd,
  // never an implicit substitute for the current workspace.
  const executionCwd = hasCwd ? cwd : codeRoot;
  if (runner.coreRoot !== undefined && runner.coreRoot !== executionCwd) {
    throw new Error("LAOS evidence publisher Core cwd must match the TrustedCoreRunner root");
  }
  const run = runner.runCli.bind(runner);
  // The TrustedCoreRunner owns the restricted --task-json CLI invocation after
  // this unified normalization boundary; this module never opens a second
  // spawn path for evidence publication.
  const profileEnv = env ?? process.env;
  return async (input) => {
    const { task, expectedIdentity } = normalizeEvidenceIngress(
      { type: "evidence.publish", input },
      profileEnv,
    );
    const stdout = await run(JSON.stringify(task), { workspace, cwd: executionCwd });
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("LAOS CLI returned malformed JSON");
    }
    const output = parsed?.output;
    if (!output || typeof output.source_ref !== "string") {
      throw new Error("evidence.publish did not return an artifact ref");
    }
    if (expectedIdentity !== null && output.canonical_identity !== expectedIdentity) {
      throw new Error("canonical identity round-trip mismatch");
    }
    return {
      source_ref: output.source_ref,
      artifact_sha256: output.artifact_sha256,
      canonical_identity: output.canonical_identity,
      source_sha256: output.source_sha256,
      payload_sha256: output.payload_sha256,
    };
  };
}
