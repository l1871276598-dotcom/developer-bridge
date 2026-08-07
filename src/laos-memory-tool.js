import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_TASK_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 120_000;

export const FROZEN_LAOS_TASKS = Object.freeze([
  "memory.create",
  "memory.search",
  "context.build",
  "handoff.write",
  "vault.snapshot.publish",
  "loop.reflect",
  "loop.suggest-policies",
  "loop.generate-candidate",
  "loop.coordinate",
  "reflection.prepare",
  "reflection.apply",
  "reflection.record",
]);

export const ALLOWED_LAOS_TASKS = Object.freeze(new Set(FROZEN_LAOS_TASKS));

// LAOS Canonical JSON v1 (docs/adr/evidence-hash-semantics-v1.md). Export the
// canonicalizer so the golden-vector test can pin fixed cross-language digests.
export function canonicalJson(value) {
  let normalized;
  try {
    normalized = sortedValue(value);
  } catch (error) {
    if (error instanceof LaosMemoryToolError) throw error;
    fail("invalid_request");
  }
  return JSON.stringify(normalized, (key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) fail("invalid_request");
    return item;
  });
}

export class LaosMemoryToolError extends Error {
  constructor(code, detail) {
    super(detail?.message || "LAOS task failed");
    this.name = "LaosMemoryToolError";
    this.code = code;
    this.detail = detail || null;
  }
}

export const LAOS_MEMORY_TOOL_DEFINITION = Object.freeze({
  name: "laos_memory_task",
  description: "Run one allowlisted LAOS JSON task against the configured external memory data root while retaining the Git code workspace.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...FROZEN_LAOS_TASKS] },
          workspace: { type: "string", enum: ["personal", "work"] },
          input: { type: "object" },
        },
        required: ["type", "input"],
        additionalProperties: false,
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
});

function fail(code, detail) {
  throw new LaosMemoryToolError(code, detail);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function overlaps(left, right) {
  return isContained(left, right) || isContained(right, left);
}

async function canonicalDirectory(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) ||
    !path.isAbsolute(value)
  ) {
    throw new Error(`${label} must be an absolute local directory`);
  }
  const lexical = path.resolve(value);
  const lexicalStat = await lstat(lexical).catch(() => null);
  if (!lexicalStat?.isDirectory() || lexicalStat.isSymbolicLink()) {
    throw new Error(`${label} must identify a real directory`);
  }
  const canonical = await realpath(lexical);
  if (canonical !== lexical || !(await stat(canonical)).isDirectory()) {
    throw new Error(`${label} cannot traverse a symbolic link`);
  }
  return canonical;
}

async function resolveCli(codeRoot) {
  const cli = path.join(codeRoot, "src", "laos.py");
  const lexicalStat = await lstat(cli).catch(() => null);
  if (!lexicalStat?.isFile() || lexicalStat.isSymbolicLink() || lexicalStat.nlink !== 1) {
    throw new Error("The authorized workspace does not contain a safe LAOS CLI");
  }
  const canonical = await realpath(cli);
  if (!isContained(codeRoot, canonical) || canonical !== cli) {
    throw new Error("The LAOS CLI escapes the authorized workspace");
  }
  return cli;
}

async function requireDataRoot(dataRoot) {
  const marker = path.join(dataRoot, ".research-agent-root");
  const markerStat = await lstat(marker).catch(() => null);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
    throw new Error("LAOS_DATA_ROOT is not an initialized ResearchAgent data root");
  }
  const canonical = await realpath(marker);
  if (!isContained(dataRoot, canonical) || canonical !== marker) {
    throw new Error("LAOS_DATA_ROOT is not an initialized ResearchAgent data root");
  }
}

function requireSeparatedRoots(runtimeRoot, codeRoot, dataRoot, stateDir) {
  const roots = [runtimeRoot, codeRoot, dataRoot, stateDir];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (overlaps(roots[left], roots[right])) {
        throw new Error("Developer Bridge runtime, LAOS code, data and state directories must be separate");
      }
    }
  }
}

const MAX_EVIDENCE_PAYLOAD_BYTES = 256 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/u;

// Core agents read trusted scope from either the top-level task object
// (via _task_value) or from task.input. This table says which scope fields the
// Core agent for each task safely consumes from task.input, so the unified gate
// can re-inject the trusted profile value in the position Core reads. Tasks
// whose Core agent enforces a strict input schema (loop.reflect et al.) read
// workspace only from the top-level task object and appear with an empty list.
const SCOPE_INPUT_TASKS = Object.freeze({
  "memory.create": ["workspace", "project", "confidentiality"],
  "memory.search": ["workspace", "project"],
  "context.build": ["workspace", "project"],
  "handoff.write": ["workspace"],
  // evidence.publish is NOT an external dispatcher task (GP-01); it is the
  // internal-only publication target the Bridge-owned Vault publisher forwards
  // to Core. Its Core agent reads scope from input, so the internal normalizer
  // must know where to inject.
  "evidence.publish": ["workspace", "project", "confidentiality"],
  "vault.snapshot.publish": [],
  "loop.reflect": [],
  "loop.suggest-policies": [],
  "loop.generate-candidate": [],
  "loop.coordinate": ["workspace", "project"],
  "reflection.prepare": [],
  "reflection.apply": ["workspace", "project", "confidentiality"],
  "reflection.record": ["workspace", "project", "confidentiality"],
});

function trustedScope(env) {
  const workspace = env.LAOS_CHECKPOINT_WORKSPACE;
  const project = env.LAOS_CHECKPOINT_PROJECT;
  let confidentiality = env.LAOS_CHECKPOINT_CONFIDENTIALITY;
  if (confidentiality === undefined) {
    confidentiality = workspace === "work" ? "internal" : "personal";
  }
  if (workspace !== "personal" && workspace !== "work") fail("invalid_request");
  if (typeof project !== "string" || project.length === 0) fail("invalid_request");
  if (!["public", "personal", "internal", "restricted"].includes(confidentiality)) fail("invalid_request");
  return { workspace, project, confidentiality };
}

// One unified profile scope gate for every allowlisted task (C-INV-13).
// Scope is owned by the Bridge profile, never by the caller:
//   1. a caller top-level workspace that disagrees with the profile is rejected;
//   2. any caller-supplied workspace/project/confidentiality in input that
//      disagrees with the profile is rejected (scope_mismatch);
//   3. all caller scope is stripped from input;
//   4. the trusted profile scope is injected in the exact positions Core reads.
function normalizeScopedTask(task, env) {
  const scope = trustedScope(env);

  if (task.workspace !== undefined && task.workspace !== scope.workspace) {
    fail("scope_mismatch");
  }

  const input = task.input;
  const normalizedInput = { ...input };
  for (const name of ["workspace", "project", "confidentiality"]) {
    if (name in input && input[name] !== scope[name]) fail("scope_mismatch");
    delete normalizedInput[name];
  }

  const normalized = { ...task, workspace: scope.workspace };
  for (const name of SCOPE_INPUT_TASKS[task.type]) {
    normalizedInput[name] = scope[name];
  }
  return { ...normalized, input: normalizedInput };
}

// GP-04: canonicalization must be prototype-safe. `{}` would treat keys like
// __proto__/constructor with legacy setter semantics; Object.create(null)
// gives every key a plain own property so different JSON payloads never
// canonicalize to the same representation through prototype weirdness.
function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (isPlainObject(value)) {
    const sorted = Object.create(null);
    for (const key of Object.keys(value).sort()) sorted[key] = sortedValue(value[key]);
    return sorted;
  }
  return value;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEvidenceTask(task, env) {
  const input = task.input;
  if (!isPlainObject(input)) fail("invalid_request");
  const schemaVersion = input.schema_version;
  if (schemaVersion !== 2) fail("invalid_request");
  const kind = input.kind;
  if (kind !== "vault_note_snapshot") fail("invalid_request");
  const source = input.source;
  if (!isPlainObject(source)) fail("invalid_source_identity");
  const scheme = source.scheme;
  const noteId = source.note_id;
  const suppliedSourceSha = source.source_sha256;
  if (scheme !== "vault-note") fail("invalid_source_identity");
  if (typeof noteId !== "string" || noteId.length === 0 || noteId.length > 512) fail("invalid_source_identity");
  if (noteId.includes("/") || noteId.includes("\\") || noteId.includes("\0")) fail("invalid_source_identity");
  if (typeof suppliedSourceSha !== "string" || !SHA256_RE.test(suppliedSourceSha)) fail("invalid_source_identity");

  const locator = input.locator;
  if (!isPlainObject(locator) || Object.keys(locator).some((key) => key !== "relative_path")) fail("invalid_request");
  const relativePath = locator.relative_path;
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 4096 || relativePath.startsWith("/")) {
    fail("invalid_source_identity");
  }
  const payload = input.payload;
  if (!isPlainObject(payload)) fail("invalid_request");
  // GP-04 / exact-key schema: the vault snapshot payload allows ONLY content
  // and metadata.title. Unknown keys (including __proto__/constructor through
  // prototype quirks) are rejected, never canonicalized ambiguously.
  const payloadKeys = Object.keys(payload).sort();
  if (payloadKeys.length !== 2 || payloadKeys[0] !== "content" || payloadKeys[1] !== "metadata") {
    fail("invalid_request");
  }
  const metadata = payload.metadata;
  if (!isPlainObject(metadata)) fail("invalid_request");
  const metadataKeys = Object.keys(metadata).sort();
  if (metadataKeys.length !== 1 || metadataKeys[0] !== "title") {
    fail("invalid_request");
  }

  // Scope is owned by the Bridge profile, never by the caller. Reject any
  // caller-supplied scope that disagrees with the profile before touching
  // payload content, so scope attacks always surface as scope_mismatch.
  const workspace = env.LAOS_CHECKPOINT_WORKSPACE;
  const project = env.LAOS_CHECKPOINT_PROJECT;
  let confidentiality = env.LAOS_CHECKPOINT_CONFIDENTIALITY;
  if (confidentiality === undefined) {
    confidentiality = workspace === "work" ? "internal" : "personal";
  }
  if (workspace !== "personal" && workspace !== "work") fail("invalid_request");
  if (typeof project !== "string" || project.length === 0) fail("invalid_request");
  if (!["public", "personal", "internal", "restricted"].includes(confidentiality)) fail("invalid_request");

  const canonical = canonicalJson(payload);
  const payloadBytes = Buffer.byteLength(canonical, "utf8");
  if (payloadBytes > MAX_EVIDENCE_PAYLOAD_BYTES) fail("payload_too_large");

  // Evidence Hash Semantics v1 (docs/adr/evidence-hash-semantics-v1.md):
  //   - payload_sha256 = SHA256(LAOSCanonicalJSON(payload)), recomputed here;
  //   - source_sha256 must match SHA256(payload.content) — Core re-verifies
  //     this, and so does the Bridge (defense-in-depth, C-INV-15).
  const computedPayloadSha = sha256Hex(canonical);
  const suppliedPayloadSha = input.payload_sha256;
  if (typeof suppliedPayloadSha !== "string" || !SHA256_RE.test(suppliedPayloadSha)) fail("invalid_request");
  if (computedPayloadSha !== suppliedPayloadSha.toLowerCase()) fail("source_hash_mismatch");

  if (typeof payload.content !== "string") fail("invalid_request");
  const computedSourceSha = sha256Hex(Buffer.from(payload.content, "utf8"));
  if (computedSourceSha !== suppliedSourceSha.toLowerCase()) fail("source_hash_mismatch");

  // canonical identity is DERIVED, never taken from the caller. Core derives
  // and returns it too (C-INV-14); the Bridge validates the round-trip at the
  // dispatcher boundary but does NOT forward a caller-supplied identity.
  const canonicalIdentity = `vault-note:${noteId}@${computedSourceSha}`;

  return {
    ...task,
    input: {
      ...input,
      workspace,
      project,
      confidentiality,
      payload_sha256: computedPayloadSha,
      source: {
        ...source,
        source_sha256: computedSourceSha,
      },
    },
    // Internal expectation for the dispatcher to compare against Core's
    // returned canonical_identity. Stripped before Core sees it.
    _expected_canonical_identity: canonicalIdentity,
  };
}

// Evidence Hash Semantics v1 helper: normalize a caller-supplied
// evidence.publish input through the SAME profile scope gate and evidence
// normalizer the Bridge dispatcher uses. Exported so the vault-evidence CLI
// cannot bypass the Bridge policy boundary (C-INV-16) — every production
// evidence ingress goes through this single normalization path.
export function normalizeEvidenceIngress(task, env) {
  const scoped = normalizeScopedTask(task, env);
  const normalized = normalizeEvidenceTask(scoped, env);
  const expectedIdentity = normalized._expected_canonical_identity;
  delete normalized._expected_canonical_identity;
  return { task: normalized, expectedIdentity };
}

// GP-01 (Phase 1): `vault.snapshot.publish` is the ONLY external task that can
// produce a vault-backed evidence artifact. The caller supplies ONLY a
// relative_path; the Bridge performs the trusted Vault read + identity +
// partition resolution. Caller-supplied scope/source/payload are rejected —
// scope comes from the trusted profile, source identity and payload come from
// the Vault read. Anything else is invalid_request.
function normalizeVaultSnapshotTask(task, env) {
  const input = task.input;
  if (!isPlainObject(input)) fail("invalid_request");
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "relative_path") {
    fail("invalid_request");
  }
  const relativePath = input.relative_path;
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    fail("invalid_request");
  }
  return { ...task, input: { relative_path: relativePath } };
}

function normalizeTask(args, env) {
  if (!isPlainObject(args) || Object.keys(args).some((key) => key !== "task")) {
    fail("invalid_laos_task");
  }
  const task = args.task;
  if (!isPlainObject(task)) fail("invalid_laos_task");
  const keys = Object.keys(task);
  if (keys.some((key) => !["type", "workspace", "input"].includes(key))) {
    fail("invalid_laos_task");
  }
  if (!ALLOWED_LAOS_TASKS.has(task.type)) fail("operation_not_allowed");
  if (task.workspace !== undefined && !["personal", "work"].includes(task.workspace)) {
    fail("invalid_laos_task");
  }
  if (!isPlainObject(task.input)) fail("invalid_laos_task");
  let normalized = task;
  if (task.type === "vault.snapshot.publish") {
    // Vault-owned path: caller provides only relative_path; scope is injected
    // from the trusted profile (workspace only; vault partitions govern
    // project/confidentiality via the vault config).
    normalized = normalizeScopedTask(task, env);
    normalized = normalizeVaultSnapshotTask(normalized, env);
  } else {
    normalized = normalizeScopedTask(task, env);
  }
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, "utf8") > MAX_TASK_BYTES) fail("invalid_laos_task");
  return { encoded, expectedIdentity: null, type: task.type, input: normalized.input };
}

function safeEnvironment(env) {
  const safe = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"]) {
    if (typeof env[key] === "string") safe[key] = env[key];
  }
  safe.PYTHONUTF8 = "1";
  return safe;
}

function runFixed(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    let settled = false;
    let timer;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const collect = (target, chunk, type) => {
      if (type === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.once("error", () => finish(new LaosMemoryToolError("laos_command_unavailable")));
    child.once("close", (exitCode, signal) => finish(null, {
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      outputLimitExceeded,
      timedOut,
    }));

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, TIMEOUT_MS);
    timer.unref();
  });
}

function cliErrorDetail(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return null;
  try {
    const parsed = JSON.parse(stderr.trim());
    if (parsed?.error) {
      const code = typeof parsed.error.code === "string" ? parsed.error.code : "request_failed";
      return { code, message: parsed.error.message || "LAOS task failed", stage: parsed.error.stage };
    }
  } catch {}
  return null;
}

function redact(value, roots) {
  if (typeof value === "string") {
    return roots.reduce((text, [root, replacement]) => text.replaceAll(root, replacement), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, roots));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, roots)]));
  }
  return value;
}

export async function createLaosMemoryTool(env, getCodeRoot, options = {}) {
  const dataConfigured = typeof env.LAOS_DATA_ROOT === "string" && env.LAOS_DATA_ROOT.length > 0;
  const stateConfigured = typeof env.LAOS_STATE_DIR === "string" && env.LAOS_STATE_DIR.length > 0;
  if (!dataConfigured && !stateConfigured) return null;
  if (!dataConfigured || !stateConfigured) {
    throw new Error("LAOS_DATA_ROOT and LAOS_STATE_DIR must be configured together");
  }
  if (typeof getCodeRoot !== "function") throw new Error("LAOS code root resolver is required");

  const dataRoot = await canonicalDirectory(env.LAOS_DATA_ROOT, "LAOS_DATA_ROOT");
  const stateDir = await canonicalDirectory(env.LAOS_STATE_DIR, "LAOS_STATE_DIR");
  await requireDataRoot(dataRoot);
  if (overlaps(dataRoot, stateDir)) throw new Error("LAOS data and state directories must not overlap");
  const runtimeRoot = await canonicalDirectory(path.resolve(import.meta.dirname, ".."), "Developer Bridge runtime");
  const initialCodeRoot = await canonicalDirectory(getCodeRoot(), "Authorized workspace");
  requireSeparatedRoots(runtimeRoot, initialCodeRoot, dataRoot, stateDir);
  await resolveCli(initialCodeRoot);
  const runner = options.runCommand || runFixed;

  // Vault-owned evidence publisher (GP-01): injected by the host, or built
  // from the environment's vault configuration. It performs the trusted Vault
  // read + identity + partition resolution and then publishes through Core
  // evidence.publish (internal). The Bridge never forwards a caller-constructed
  // vault payload.
  let vaultPublish = options.vaultPublish;
  if (!vaultPublish) {
    const { buildEnvVaultPublisher } = await import("./vault/env-publisher.js");
    vaultPublish = await buildEnvVaultPublisher(env, { codeRoot: initialCodeRoot, runner });
  }

  return Object.freeze({
    definition: LAOS_MEMORY_TOOL_DEFINITION,
    async call(args) {
      const { encoded: taskJson, expectedIdentity, type, input } = normalizeTask(args, env);
      const codeRoot = await canonicalDirectory(getCodeRoot(), "Authorized workspace");
      requireSeparatedRoots(runtimeRoot, codeRoot, dataRoot, stateDir);
      const cli = await resolveCli(codeRoot);

      if (type === "vault.snapshot.publish") {
        // GP-01: only the Bridge-owned Vault adapter may mint a vault evidence
        // artifact. The caller supplies only relative_path; the adapter reads
        // the Vault, derives identity, resolves the partition, and publishes
        // through Core. Without a configured adapter this fails closed.
        if (!vaultPublish) {
          fail("vault_unavailable", { message: "Vault evidence publishing is not configured" });
        }
        const payload = await vaultPublish(input);
        return {
          text: JSON.stringify(redact(payload, [
            [codeRoot, "[workspace]"],
            [dataRoot, "[laos-data]"],
            [stateDir, "[laos-state]"],
          ])),
        };
      }

      const result = await runner(
        process.platform === "win32" ? "python" : "python3",
        [cli, "--root", dataRoot, "--state-dir", stateDir, "--task-json", taskJson],
        { cwd: codeRoot, env: safeEnvironment(env), timeoutMs: TIMEOUT_MS },
      );
      if (result?.timedOut === true) fail("laos_task_timeout");
      if (result?.outputLimitExceeded === true) fail("laos_output_limit_exceeded");
      if (result?.exitCode !== 0) {
        const detail = cliErrorDetail(result?.stderr);
        if (detail) fail(detail.code, detail);
        fail("request_failed");
      }
      if (typeof result?.stdout !== "string") fail("laos_malformed_response");

      let payload;
      try {
        payload = JSON.parse(result.stdout.trim());
      } catch {
        fail("laos_malformed_response");
      }
      if (expectedIdentity !== null) {
        // C-INV-14: Core must derive the same canonical identity the Bridge
        // derived from the same bytes. A mismatch means the source binding
        // round-trip is broken — fail closed. The Core CLI reports the agent
        // result under `output`.
        const returnedIdentity = payload?.output?.canonical_identity
          ?? payload?.result?.canonical_identity;
        if (returnedIdentity !== expectedIdentity) {
          fail("identity_mismatch");
        }
      }
      return {
        text: JSON.stringify(redact(payload, [
          [codeRoot, "[workspace]"],
          [dataRoot, "[laos-data]"],
          [stateDir, "[laos-state]"],
        ])),
      };
    },
  });
}
