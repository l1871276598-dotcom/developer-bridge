import { spawn } from "node:child_process";
import path from "node:path";

import { normalizeEvidenceIngress } from "../laos-memory-tool.js";

/**
 * evidence.publish invocation through the LAOS CLI — the same task shape the
 * laos_memory_task dispatcher produces. Every production evidence ingress goes
 * through normalizeEvidenceIngress (the SAME profile scope gate + evidence
 * normalizer as laos_memory_task), so the vault-evidence CLI cannot bypass the
 * Bridge policy boundary (C-INV-16).
 */

function findCodeRoot() {
  const workspace = process.env.DEVELOPER_BRIDGE_WORKSPACE;
  if (!workspace) throw new Error("DEVELOPER_BRIDGE_WORKSPACE is not set");
  return workspace;
}

function findCli() {
  const codeRoot = findCodeRoot();
  const cli = path.join(codeRoot, "src", "laos.py");
  return cli;
}

function runCli(env, taskJson) {
  return new Promise((resolve, reject) => {
    const cli = findCli();
    const args = [
      cli,
      "--root", env.LAOS_DATA_ROOT,
      "--state-dir", env.LAOS_STATE_DIR,
      "--task-json", taskJson,
    ];
    const child = spawn(env.LAOS_PYTHON_EXECUTABLE || "python3", args, {
      cwd: path.dirname(cli),
      env: { ...process.env, ...env, PYTHONUTF8: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`LAOS CLI exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 400)}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

/**
 * Build an evidence.publish caller that goes through the unified Bridge
 * normalization (profile scope gate + evidence normalizer) and then invokes
 * the LAOS CLI.  The normalized task is the exact payload the laos_memory_task
 * dispatcher would forward, so behavior is identical to a live Bridge call.
 */
export function buildLaosEvidencePublisher({ env, runner } = {}) {
  const run = runner ?? runCli;
  const profileEnv = env ?? process.env;
  return async (input) => {
    const { task, expectedIdentity } = normalizeEvidenceIngress(
      { type: "evidence.publish", input },
      profileEnv,
    );
    const stdout = await run(profileEnv, JSON.stringify(task));
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
