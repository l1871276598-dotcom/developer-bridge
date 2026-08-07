import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

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

function findCodeRoot() {
  const workspace = process.env.DEVELOPER_BRIDGE_WORKSPACE;
  if (!workspace) throw new CoreClientError("core_unavailable", "DEVELOPER_BRIDGE_WORKSPACE is not set");
  return workspace;
}

function findCli() {
  return path.join(findCodeRoot(), "src", "laos.py");
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
        reject(new CoreClientError("core_call_failed", `LAOS CLI exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 400)}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

/**
 * Build a projectmem core client bound to a trusted scope (F-07 / C-INV-13).
 *
 * The scope (workspace/project/confidentiality) is bound at construction from
 * the validated manifest + trusted Bridge profile. Callers of
 * searchHandles()/buildContext() cannot supply their own scope per call — the
 * manifest is reconciled against the profile before the client exists, so a
 * forged or mis-scoped manifest can never reach Core through this client.
 */
export function buildCoreClient({ manifest, trustedProfile, env, runner } = {}) {
  if (!manifest || typeof manifest !== "object") {
    throw new CoreClientError("core_invalid_manifest", "projectmem manifest is required");
  }
  if (!trustedProfile || typeof trustedProfile !== "object") {
    throw new CoreClientError("core_invalid_profile", "trusted Bridge profile is required");
  }
  // Scope is fixed at construction. The manifest must already be reconciled
  // with the profile (see initProjectmem); this client never re-derives scope.
  const workspace = manifest.workspace;
  const project = manifest.project;
  const run = runner ?? runCli;
  const resolveEnv = env ?? process.env;

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
    const task = {
      type: "context.build",
      input: { query, workspace, project },
      context_limit: 16000,
    };
    const stdout = await run(resolveEnv, JSON.stringify(task));
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
      input: { query: project ?? workspace, workspace, project, limit },
    };
    const stdout = await run(resolveEnv, JSON.stringify(task));
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
    // Fail closed on unknown/malformed handle shapes (S12 / plan §49). A
    // handle is either a memory:<id> string with a non-empty id, or an object
    // with a non-empty id. Anything else — empty string, wrong type, unknown
    // shape — fails the entire refresh; nothing is ever wrapped as a fake
    // "memory:unknown" or "memory:" namespace.
    return results.map((item) => {
      if (typeof item === "string") {
        if (!item.startsWith("memory:")) {
          throw new CoreClientError("core_malformed_response", "memory.search returned an unrecognized handle string");
        }
        const id = item.slice("memory:".length);
        if (!id || id.length === 0) {
          throw new CoreClientError("core_malformed_response", "memory.search returned an empty memory handle");
        }
        return item;
      }
      if (item && typeof item === "object" && typeof item.id === "string" && item.id.length > 0) {
        return `memory:${item.id}`;
      }
      throw new CoreClientError("core_malformed_response", "memory.search returned an unrecognized handle");
    });
  }

  return { contextSha256, searchHandles };
}
