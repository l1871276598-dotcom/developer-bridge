import { spawn } from "node:child_process";
import path from "node:path";

import { normalizeEvidenceIngress } from "../laos-memory-tool.js";

const RUNCLI_TIMEOUT_MS = 120_000;
const RUNCLI_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * evidence.publish invocation through the LAOS CLI — the same task shape the
 * laos_memory_task dispatcher produces. Every production evidence ingress goes
 * through normalizeEvidenceIngress (the SAME profile scope gate + evidence
 * normalizer as laos_memory_task), so the vault-evidence CLI cannot bypass the
 * Bridge policy boundary (C-INV-16).
 */

function findCli(codeRoot) {
  // GP8-01: Core runs from the immutable LAOS_CORE_ROOT runtime, never from a
  // caller-derived path. The codeRoot argument is the validated runtime root.
  const resolved = codeRoot ?? process.env.LAOS_CORE_ROOT;
  if (!resolved) throw new Error("LAOS_CORE_ROOT is not set");
  const cli = path.join(resolved, "src", "laos.py");
  return cli;
}

// Exported so the env-publisher can invoke the Core CLI for the fd-rooted
// vault.read task (S8/GP3-01) through the same restricted task interface.
// GP7-04: the child is bounded (timeout + output cap) so a hung or chatty Core
// child (e.g. a FIFO the O_NONBLOCK guard missed) cannot block the Bridge
// forever or exhaust memory. runCli is also where the verified childEnv is
// applied — the caller passes the frozen root, never a dynamic value.
export function runCli(env, taskJson, codeRoot, options = {}) {
  return new Promise((resolve, reject) => {
    const cli = findCli(codeRoot);
    const args = [
      cli,
      "--root", env.LAOS_DATA_ROOT,
      "--state-dir", env.LAOS_STATE_DIR,
      "--task-json", taskJson,
    ];
    const timeoutMs = options.timeoutMs ?? RUNCLI_TIMEOUT_MS;
    const child = spawn(env.LAOS_PYTHON_EXECUTABLE || "python3", args, {
      cwd: path.dirname(cli),
      env: { ...process.env, ...env, PYTHONUTF8: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let timer;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const collect = (target, chunk, isStdout) => {
      // Always push so the pipe keeps draining (a blocked child would never
      // emit more chunks and the cap would never trip). Track the byte count
      // separately; once it exceeds the cap we kill and reject.
      if (isStdout) stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > RUNCLI_MAX_OUTPUT_BYTES || stderrBytes > RUNCLI_MAX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk) => collect(stdout, chunk, true));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, false));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (outputLimitExceeded) {
        finish(new Error("LAOS CLI output limit exceeded"));
        return;
      }
      if (timedOut) {
        finish(new Error("LAOS CLI timed out"));
        return;
      }
      if (code !== 0) {
        finish(new Error(`LAOS CLI exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 400)}`));
        return;
      }
      finish(null, Buffer.concat(stdout).toString("utf8"));
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timer.unref();
  });
}

/**
 * Build an evidence.publish caller that goes through the unified Bridge
 * normalization (profile scope gate + evidence normalizer) and then invokes
 * the LAOS CLI.  The normalized task is the exact payload the laos_memory_task
 * dispatcher would forward, so behavior is identical to a live Bridge call.
 */
export function buildLaosEvidencePublisher({ env, runner, codeRoot } = {}) {
  // GP10-09: the vault publisher always uses the shared TrustedCoreRunner's
  // runCli (bounded, sanitized env, no ?. fallback to a bare spawn). The legacy
  // runCli export is kept only for direct test compatibility with runCli tests
  // that bypass the runner framework.
  // If no runner is provided, construction fails rather than silently
  // downgrading to a spawn that inherits process.env.
  if (!runner || !runner.runCli) {
    throw new Error("LAOS evidence publisher requires a TrustedCoreRunner");
  }
  const run = runner.runCli.bind(runner);
  const profileEnv = env ?? process.env;
  return async (input) => {
    const { task, expectedIdentity } = normalizeEvidenceIngress(
      { type: "evidence.publish", input },
      profileEnv,
    );
    const stdout = await run(JSON.stringify(task), { cwd: codeRoot });
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
