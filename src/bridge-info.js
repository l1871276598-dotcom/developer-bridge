import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { canonicalJson, FROZEN_LAOS_TASKS } from "./laos-memory-tool.js";

const execFileAsync = promisify(execFile);

/**
 * Read-only build identity for the Developer Bridge (C-INV-19 / deployment
 * parity). Lets a red team prove the audited source tree is what is running.
 *
 * This is diagnostics only: it never routes through memory.*, never produces a
 * side effect, and is NOT part of the task authority surface.
 */

export const LAOS_BRIDGE_INFO_DEFINITION = Object.freeze({
  name: "laos_bridge_info",
  description:
    "Read-only Developer Bridge build identity: git commit/tree, dirty flag, " +
    "allowlist digest, protocol version, and the connected Core commit. " +
    "Proves the audited source matches the deployed runtime.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
});

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function gitAt(cwd, ...args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function buildBridgeInfo({ bridgeRoot, codeRoot, env, allowlist = FROZEN_LAOS_TASKS } = {}) {
  const dirty = await gitAt(bridgeRoot, "status", "--porcelain");
  const commit = await gitAt(bridgeRoot, "rev-parse", "HEAD");
  const tree = await gitAt(bridgeRoot, "rev-parse", "HEAD^{tree}");
  const coreCommit = await gitAt(codeRoot, "rev-parse", "HEAD");

  // Runtime allowlist canonical digest — a red team compares this against the
  // reviewed allowlist (plan §54).
  const allowlistSha = sha256Hex(canonicalJson({ tasks: [...allowlist] }));

  return {
    bridge: {
      git_commit: commit ?? "unavailable",
      git_tree: tree ?? "unavailable",
      dirty: dirty !== null && dirty.length > 0,
      allowlist_sha256: allowlistSha,
      protocol_version: "laos-task-v2",
    },
    core: {
      git_commit: coreCommit ?? "unavailable",
      protocol_version: "evidence-v2",
    },
    governance: {
      constitution_version: "1.0",
    },
  };
}

export function createBridgeInfoTool(bridgeRoot, codeRoot, env) {
  return Object.freeze({
    definition: LAOS_BRIDGE_INFO_DEFINITION,
    async call() {
      const info = await buildBridgeInfo({ bridgeRoot, codeRoot, env });
      return { text: JSON.stringify(info, null, 2) };
    },
  });
}
