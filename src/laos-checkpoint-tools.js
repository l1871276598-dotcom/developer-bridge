import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LaosMemoryToolError } from "./laos-memory-tool.js";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_OPTION_LENGTH = 256;
const TIMEOUT_MS = 120_000;
const SAFE_ADAPTER_CODES = new Set([
  "invalid_configuration",
  "invalid_request",
  "scope_violation",
  "session_not_found",
  "request_failed",
]);
const OPERATION_BY_TOOL = Object.freeze({
  laos_capture_checkpoint: "capture_checkpoint",
  laos_session_search: "session_search",
  laos_session_get: "session_get",
});
const SAFE_ENVIRONMENT_KEYS = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
  "SYSTEMROOT", "WINDIR",
];

const text = (maxLength, extra = {}) => ({ type: "string", minLength: 1, maxLength, ...extra });

const capture = Object.freeze({
  name: "laos_capture_checkpoint",
  description: "Explicitly save one completed user/assistant exchange to the configured LAOS checkpoint scope.",
  inputSchema: {
    type: "object",
    properties: {
      session_alias: text(256),
      user_message: text(262_144),
      assistant_response: text(262_144),
      checkpoint_id: text(256),
      conversation_summary: text(65_536),
      assistant_response_complete: { type: "boolean", default: true },
      source_conversation_id: text(256),
      source_user_message_id: text(256),
      source_assistant_message_id: text(256),
      branch_id: text(256, { default: "main" }),
      version: { type: "integer", minimum: 1, default: 1 },
      captured_at: text(128),
      force_review: { type: "boolean", default: false },
    },
    required: ["session_alias", "user_message", "assistant_response"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

const search = Object.freeze({
  name: "laos_session_search",
  description: "Search saved LAOS sessions within the configured workspace and project scope.",
  inputSchema: {
    type: "object",
    properties: {
      query: text(4096),
      workspace: { type: "string", enum: ["personal", "work"] },
      project: text(256),
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

const get = Object.freeze({
  name: "laos_session_get",
  description: "Get one saved LAOS session by its identifier within the configured scope.",
  inputSchema: {
    type: "object",
    properties: { session_id: text(256, { pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$" }) },
    required: ["session_id"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

export const LAOS_CHECKPOINT_TOOL_DEFINITIONS = Object.freeze([capture, search, get]);
export const LAOS_CHECKPOINT_INSTRUCTIONS = "LAOS checkpoint capture is explicit, not passive. Call laos_capture_checkpoint once only when the user explicitly asks to save the current complete turn and the exact completed assistant response is available. In a new conversation, call laos_session_search first, then laos_session_get with the returned session ID. Do not use memory.create as a checkpoint substitute. Do not invent source conversation or message IDs. Do not save ordinary conversations automatically.";

function fail(code) {
  throw new LaosMemoryToolError(code);
}

function configurationFailure() {
  throw new Error("Invalid LAOS checkpoint configuration.");
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

async function canonicalDirectory(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value)) {
    configurationFailure();
  }
  const lexical = path.resolve(value);
  if (value !== lexical) configurationFailure();
  const info = await lstat(lexical).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) configurationFailure();
  const canonical = await realpath(lexical).catch(configurationFailure);
  const canonicalInfo = await stat(canonical).catch(() => null);
  if (canonical !== lexical || !canonicalInfo?.isDirectory()) configurationFailure();
  return canonical;
}

async function canonicalFile(value, { root, executable = false, singleLink = false } = {}) {
  if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value)) {
    configurationFailure();
  }
  const lexical = path.resolve(value);
  if (value !== lexical) configurationFailure();
  const info = await lstat(lexical).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || (singleLink && info.nlink !== 1)) {
    configurationFailure();
  }
  const canonical = await realpath(lexical).catch(configurationFailure);
  if (canonical !== lexical || (root && !isContained(root, canonical))) configurationFailure();
  if (executable) await access(canonical, constants.X_OK).catch(configurationFailure);
  return canonical;
}

async function validateDataRoot(dataRoot) {
  const marker = path.join(dataRoot, ".research-agent-root");
  const markerInfo = await lstat(marker).catch(() => null);
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) configurationFailure();
  let value;
  try {
    value = JSON.parse(await readFile(marker, "utf8"));
  } catch {
    configurationFailure();
  }
  if (!isPlainObject(value) || Object.keys(value).length !== 2 ||
      value.type !== "research-agent-data-root" || value.format_version !== 1) {
    configurationFailure();
  }
}

function option(env, name, { required = false, allowed } = {}) {
  const value = env[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_OPTION_LENGTH || value.includes("\0")) {
    configurationFailure();
  }
  if (allowed && !allowed.includes(value)) configurationFailure();
  return value;
}

function validateSeparateRoots(roots) {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (overlaps(roots[left], roots[right])) configurationFailure();
    }
  }
}

async function validateStableState(stateDir, env) {
  const fixed = [os.tmpdir(), "/tmp", "/var/tmp", "/usr/tmp"];
  if (process.platform === "win32") fixed.push("C:\\Windows\\Temp", "C:\\Temp");
  for (const name of ["TMPDIR", "TEMP", "TMP"]) {
    if (typeof env[name] === "string" && path.isAbsolute(env[name])) fixed.push(env[name]);
  }
  for (const candidate of fixed) {
    const root = await realpath(candidate).catch(() => null);
    if (root && overlaps(root, stateDir)) configurationFailure();
  }
  if (stateDir.split(path.sep).some((part) => part === "Mobile Documents" || part === "CloudStorage")) {
    configurationFailure();
  }
}

function safeEnvironment(env, configuration) {
  const safe = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (typeof env[key] === "string") safe[key] = env[key];
  }
  safe.PYTHONUTF8 = "1";
  for (const [key, value] of Object.entries(configuration)) {
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

function terminate(child, signal) {
  try {
    if (process.platform === "win32" || !child.pid) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The process may already have exited.
  }
}

function runFixed(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    let settled = false;
    let killTimer;

    const stop = () => {
      terminate(child, "SIGTERM");
      killTimer = setTimeout(() => terminate(child, "SIGKILL"), 2_000);
      killTimer.unref();
    };
    const collect = (chunks, chunk, stream) => {
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true;
          stop();
        }
        return;
      }
      chunks.push(chunk);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new LaosMemoryToolError("laos_command_unavailable"));
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputLimitExceeded,
        timedOut,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

function requiredString(value, maxLength) {
  if (typeof value !== "string" || !value || value.length > maxLength || value.includes("\0")) fail("invalid_request");
  return value;
}

function optionalString(value, maxLength) {
  return value === undefined ? undefined : requiredString(value, maxLength);
}

function exactKeys(args, allowed, required) {
  if (!isPlainObject(args) || Object.keys(args).some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(args, key))) {
    fail("invalid_request");
  }
}

function normalizeCapture(args) {
  const allowed = [
    "session_alias", "user_message", "assistant_response", "checkpoint_id",
    "conversation_summary", "assistant_response_complete", "source_conversation_id",
    "source_user_message_id", "source_assistant_message_id", "branch_id", "version",
    "captured_at", "force_review",
  ];
  exactKeys(args, allowed, ["session_alias", "user_message", "assistant_response"]);
  const normalized = { ...args };
  normalized.session_alias = requiredString(args.session_alias, 256);
  normalized.user_message = requiredString(args.user_message, 262_144);
  normalized.assistant_response = requiredString(args.assistant_response, 262_144);
  for (const [key, limit] of [
    ["checkpoint_id", 256], ["conversation_summary", 65_536],
    ["source_conversation_id", 256], ["source_user_message_id", 256],
    ["source_assistant_message_id", 256], ["branch_id", 256], ["captured_at", 128],
  ]) {
    if (args[key] !== undefined) normalized[key] = optionalString(args[key], limit);
  }
  if (args.assistant_response_complete !== undefined && args.assistant_response_complete !== true) fail("invalid_request");
  if (args.version !== undefined && (!Number.isInteger(args.version) || args.version < 1)) fail("invalid_request");
  if (args.force_review !== undefined && typeof args.force_review !== "boolean") fail("invalid_request");
  return normalized;
}

function normalizeSearch(args, scope) {
  exactKeys(args, ["query", "workspace", "project", "limit"], ["query"]);
  const normalized = { ...args, query: requiredString(args.query, 4096) };
  if (args.workspace !== undefined) {
    if (args.workspace !== "personal" && args.workspace !== "work") fail("invalid_request");
    if (args.workspace !== scope.workspace) fail("scope_violation");
  }
  if (args.project !== undefined) {
    requiredString(args.project, 256);
    if (args.project !== scope.project) fail("scope_violation");
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) {
    fail("invalid_request");
  }
  return normalized;
}

function normalizeGet(args) {
  exactKeys(args, ["session_id"], ["session_id"]);
  const sessionId = requiredString(args.session_id, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(sessionId)) fail("invalid_request");
  return { session_id: sessionId };
}

function normalize(name, args, scope) {
  if (name === "laos_capture_checkpoint") return normalizeCapture(args);
  if (name === "laos_session_search") return normalizeSearch(args, scope);
  if (name === "laos_session_get") return normalizeGet(args);
  fail("invalid_request");
}

function parseResponse(result) {
  if (result?.timedOut === true) fail("laos_task_timeout");
  if (result?.outputLimitExceeded === true) {
    fail("laos_output_limit_exceeded");
  }
  if (typeof result?.stdout !== "string" || typeof (result.stderr ?? "") !== "string") {
    fail("laos_malformed_response");
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES ||
      Buffer.byteLength(result.stderr ?? "", "utf8") > MAX_OUTPUT_BYTES) {
    fail("laos_output_limit_exceeded");
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout.trim());
  } catch {
    fail("laos_malformed_response");
  }
  if (!isPlainObject(payload)) fail("laos_malformed_response");
  if (payload.ok === true && result.exitCode === 0 &&
      Object.keys(payload).length === 2 && Object.hasOwn(payload, "result")) {
    return payload.result;
  }
  if (payload.ok === false && Object.keys(payload).length === 2 &&
      isPlainObject(payload.error) && Object.keys(payload.error).length === 1 &&
      SAFE_ADAPTER_CODES.has(payload.error.code)) {
    fail(payload.error.code);
  }
  if (payload.ok === false) fail("request_failed");
  fail("laos_malformed_response");
}

export async function createLaosCheckpointTools(env, codeRoot, options = {}) {
  if (!isPlainObject(env)) configurationFailure();
  const enabled = env.LAOS_ENABLE_CHECKPOINT_CAPTURE;
  if (enabled === undefined || enabled === "0") return null;
  if (enabled !== "1") configurationFailure();

  const runtimeRoot = await canonicalDirectory(path.resolve(import.meta.dirname, ".."));
  const pinnedCodeRoot = await canonicalDirectory(codeRoot);
  const dataRoot = await canonicalDirectory(env.LAOS_DATA_ROOT);
  const stateDir = await canonicalDirectory(env.LAOS_STATE_DIR);
  await validateDataRoot(dataRoot);
  await validateStableState(stateDir, env);
  validateSeparateRoots([runtimeRoot, pinnedCodeRoot, dataRoot, stateDir]);

  const workspace = option(env, "LAOS_CHECKPOINT_WORKSPACE", { required: true, allowed: ["personal", "work"] });
  const project = option(env, "LAOS_CHECKPOINT_PROJECT");
  const accountId = option(env, "LAOS_CHECKPOINT_ACCOUNT_ID");
  const profile = option(env, "LAOS_CHECKPOINT_PROFILE");
  const confidentiality = option(env, "LAOS_CHECKPOINT_CONFIDENTIALITY", {
    allowed: ["public", "personal", "internal", "restricted"],
  });
  const executable = await canonicalFile(env.LAOS_PYTHON_EXECUTABLE, { executable: true });
  const adapter = await canonicalFile(path.join(pinnedCodeRoot, "tools", "developer_bridge_adapter.py"), {
    root: pinnedCodeRoot,
    singleLink: true,
  });
  const adapterEnvironment = safeEnvironment(env, {
    LAOS_DATA_ROOT: dataRoot,
    LAOS_STATE_DIR: stateDir,
    LAOS_CHECKPOINT_WORKSPACE: workspace,
    LAOS_CHECKPOINT_PROJECT: project,
    LAOS_CHECKPOINT_ACCOUNT_ID: accountId,
    LAOS_CHECKPOINT_PROFILE: profile,
    LAOS_CHECKPOINT_CONFIDENTIALITY: confidentiality,
  });
  const runner = options.runCommand || runFixed;

  return Object.freeze({
    definitions: LAOS_CHECKPOINT_TOOL_DEFINITIONS,
    instructions: LAOS_CHECKPOINT_INSTRUCTIONS,
    async call(name, args) {
      const request = JSON.stringify({
        operation: OPERATION_BY_TOOL[name],
        arguments: normalize(name, args, { workspace, project }),
      });
      if (Buffer.byteLength(request, "utf8") > MAX_REQUEST_BYTES) fail("invalid_request");
      let result;
      try {
        result = await runner(executable, [adapter], {
          cwd: pinnedCodeRoot,
          env: adapterEnvironment,
          input: request,
          shell: false,
          detached: process.platform !== "win32",
          timeoutMs: TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof LaosMemoryToolError) throw error;
        fail("laos_command_unavailable");
      }
      return { text: JSON.stringify(parseResponse(result)) };
    },
  });
}
