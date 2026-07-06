import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.checkpoint.test", type: "local-human" });
const addedNames = new Set([
  "laos_capture_checkpoint",
  "laos_session_search",
  "laos_session_get",
]);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.homedir(), ".developer-bridge-checkpoint-test-")));
  const workspace = path.join(base, "workspace");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([
    mkdir(path.join(workspace, "src"), { recursive: true }),
    mkdir(path.join(workspace, "tools"), { recursive: true }),
    mkdir(dataRoot),
    mkdir(stateDir),
  ]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), JSON.stringify({
    type: "research-agent-data-root",
    format_version: 1,
  }), "utf8");
  await writeFile(path.join(workspace, "src", "laos.py"), "print('fixture')\n", "utf8");
  await writeFile(path.join(workspace, "tools", "developer_bridge_adapter.py"), "# fixture\n", "utf8");
  await git(workspace, "init", "--quiet", "-b", "feat/checkpoint");
  await git(workspace, "config", "user.name", "Test User");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, workspace, dataRoot, stateDir };
}

function environment(item, overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1",
    LAOS_DATA_ROOT: item.dataRoot,
    LAOS_STATE_DIR: item.stateDir,
    LAOS_ENABLE_CHECKPOINT_CAPTURE: "1",
    LAOS_CHECKPOINT_WORKSPACE: "personal",
    LAOS_CHECKPOINT_PROJECT: "checkpoint-tests",
    LAOS_PYTHON_EXECUTABLE: process.execPath,
    ...overrides,
  };
}

function success(result = { saved: true }) {
  return {
    exitCode: 0,
    signal: null,
    stdout: `${JSON.stringify({ ok: true, result })}\n`,
    stderr: "",
  };
}

async function bridge(item, overrides = {}) {
  return createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: environment(item, overrides.env),
    laosRunCommand: async () => success(),
    laosCheckpointRunCommand: overrides.runCommand ?? (async () => success()),
  });
}

test("conditionally appends exactly the three checkpoint tools while preserving existing tools", async (t) => {
  const item = await fixture(t);
  const disabled = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: environment(item, { LAOS_ENABLE_CHECKPOINT_CAPTURE: "0" }),
    laosRunCommand: async () => success(),
  });
  const enabled = await bridge(item);
  const disabledNames = disabled.tools.map(({ name }) => name);
  const enabledNames = enabled.tools.map(({ name }) => name);

  assert.deepEqual(new Set(enabledNames.filter((name) => !disabledNames.includes(name))), addedNames);
  assert.equal(enabledNames.includes("laos_memory_task"), true);
  assert.deepEqual(enabledNames.slice(0, disabledNames.length), disabledNames);
  assert.equal(typeof enabled.instructions, "string");
  assert.equal(disabled.instructions, undefined);

  const module = await import("../src/laos-checkpoint-tools.js");
  assert.deepEqual(new Set(module.LAOS_CHECKPOINT_TOOL_DEFINITIONS.map(({ name }) => name)), addedNames);
});

test("publishes strict schemas, correct annotations and concise explicit workflow instructions", async (t) => {
  const item = await fixture(t);
  const value = await bridge(item);
  const definitions = Object.fromEntries(value.tools.map((definition) => [definition.name, definition]));
  const capture = definitions.laos_capture_checkpoint;
  const search = definitions.laos_session_search;
  const get = definitions.laos_session_get;

  assert.deepEqual(capture.inputSchema.required, ["session_alias", "user_message", "assistant_response"]);
  assert.equal(capture.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(capture.inputSchema.properties), [
    "session_alias", "user_message", "assistant_response", "checkpoint_id",
    "conversation_summary", "assistant_response_complete", "source_conversation_id",
    "source_user_message_id", "source_assistant_message_id", "branch_id", "version",
    "captured_at", "force_review",
  ]);
  assert.equal(capture.inputSchema.properties.version.minimum, 1);
  assert.equal(capture.inputSchema.properties.version.type, "integer");
  assert.deepEqual(capture.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });

  assert.deepEqual(search.inputSchema.required, ["query"]);
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.deepEqual(search.inputSchema.properties.workspace.enum, ["personal", "work"]);
  assert.equal(search.inputSchema.properties.limit.minimum, 1);
  assert.equal(search.inputSchema.properties.limit.maximum, 50);
  assert.deepEqual(get.inputSchema.required, ["session_id"]);
  assert.deepEqual(Object.keys(get.inputSchema.properties), ["session_id"]);
  assert.equal(get.inputSchema.additionalProperties, false);
  for (const definition of [search, get]) {
    assert.deepEqual(definition.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(JSON.stringify(definition.inputSchema).match(/path|command|env|executable/iu), null);
  }

  const first512 = value.instructions.slice(0, 512);
  assert.match(first512, /explicit, not passive/iu);
  assert.match(first512, /once only when the user explicitly asks/iu);
  assert.match(first512, /exact completed assistant response/iu);
  assert.match(first512, /laos_session_search first, then laos_session_get/iu);
  assert.match(first512, /not use memory\.create.*substitute/iu);
  assert.match(first512, /not invent source/iu);
  assert.match(first512, /not save ordinary conversations automatically/iu);
  assert.ok(value.instructions.length < 512);
});

test("uses fixed executable, adapter, stdin, cwd and minimal validated environment", async (t) => {
  const item = await fixture(t);
  const calls = [];
  const value = await bridge(item, {
    env: {
      LAOS_CHECKPOINT_ACCOUNT_ID: "account-one",
      LAOS_CHECKPOINT_PROFILE: "focused",
      LAOS_CHECKPOINT_CONFIDENTIALITY: "internal",
      SECRET_TOKEN: "must-not-leak",
    },
    runCommand: async (...args) => {
      calls.push(args);
      return success({ checkpoint_id: "one" });
    },
  });
  const args = {
    session_alias: "session-one",
    user_message: "用户消息",
    assistant_response: "exact completed reply",
    assistant_response_complete: true,
    branch_id: "main",
    version: 1,
    force_review: false,
  };
  const result = await value.callTool("laos_capture_checkpoint", args);
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), { checkpoint_id: "one" });
  assert.equal(calls.length, 1);
  const [command, commandArgs, options] = calls[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(commandArgs, [path.join(item.workspace, "tools", "developer_bridge_adapter.py")]);
  assert.equal(options.cwd, item.workspace);
  assert.equal(options.shell, false);
  assert.equal(options.detached, process.platform !== "win32");
  assert.equal(options.timeoutMs, 120_000);
  assert.deepEqual(JSON.parse(options.input), { operation: "capture_checkpoint", arguments: args });
  assert.equal(commandArgs.join(" ").includes(args.user_message), false);
  assert.equal(options.env.SECRET_TOKEN, undefined);
  assert.equal(options.env.PYTHONUTF8, "1");
  assert.equal(options.env.LAOS_DATA_ROOT, item.dataRoot);
  assert.equal(options.env.LAOS_STATE_DIR, item.stateDir);
  assert.equal(options.env.LAOS_CHECKPOINT_WORKSPACE, "personal");
  assert.equal(options.env.LAOS_CHECKPOINT_ACCOUNT_ID, "account-one");
  assert.equal(options.env.LAOS_CHECKPOINT_PROFILE, "focused");
  assert.equal(options.env.LAOS_CHECKPOINT_CONFIDENTIALITY, "internal");
});

test("strictly normalizes arguments and rejects unknown, invalid, incomplete and oversized requests before spawn", async (t) => {
  const item = await fixture(t);
  let calls = 0;
  const value = await bridge(item, {
    runCommand: async () => {
      calls += 1;
      return success();
    },
  });
  const invalid = [
    ["laos_capture_checkpoint", {}],
    ["laos_capture_checkpoint", { session_alias: "s", user_message: "u", assistant_response: "a", path: "/tmp/x" }],
    ["laos_capture_checkpoint", { session_alias: "s", user_message: "u", assistant_response: "a", assistant_response_complete: false }],
    ["laos_capture_checkpoint", { session_alias: "s", user_message: "u", assistant_response: "a", version: true }],
    ["laos_session_search", { query: "q", limit: 51 }],
    ["laos_session_search", { query: "q", workspace: "work" }],
    ["laos_session_get", { session_id: "bad/id" }],
    ["laos_session_get", { session_id: "ok", command: "id" }],
    ["laos_capture_checkpoint", { session_alias: "s", user_message: "x".repeat(513 * 1024), assistant_response: "a" }],
  ];
  for (const [name, args] of invalid) {
    const result = await value.callTool(name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args).slice(0, 80)}`);
    const expected = name === "laos_session_search" && args.workspace === "work"
      ? "scope_violation"
      : "invalid_request";
    assert.equal(JSON.parse(result.content[0].text).error.code, expected);
  }
  assert.equal(calls, 0);
});

test("routes search and get through exact adapter envelopes", async (t) => {
  const item = await fixture(t);
  const inputs = [];
  const value = await bridge(item, {
    runCommand: async (_command, _args, options) => {
      inputs.push(JSON.parse(options.input));
      return success([]);
    },
  });
  await value.callTool("laos_session_search", { query: "old turn", workspace: "personal", project: "checkpoint-tests", limit: 3 });
  await value.callTool("laos_session_get", { session_id: "session:one" });
  assert.deepEqual(inputs, [
    { operation: "session_search", arguments: { query: "old turn", workspace: "personal", project: "checkpoint-tests", limit: 3 } },
    { operation: "session_get", arguments: { session_id: "session:one" } },
  ]);
});

test("disabled legacy configuration is unchanged and illegal or partial enabled configuration fails safely", async (t) => {
  const item = await fixture(t);
  for (const flag of [undefined, "0"]) {
    const value = await createBridgeWithSyncTools(item.workspace, () => {}, {
      operatorIdentity,
      env: environment(item, {
        LAOS_ENABLE_CHECKPOINT_CAPTURE: flag,
        LAOS_CHECKPOINT_WORKSPACE: undefined,
        LAOS_PYTHON_EXECUTABLE: undefined,
      }),
      laosRunCommand: async () => success(),
    });
    assert.equal(value.tools.some(({ name }) => addedNames.has(name)), false);
  }

  const cases = [
    { LAOS_ENABLE_CHECKPOINT_CAPTURE: "true" },
    { LAOS_DATA_ROOT: undefined },
    { LAOS_STATE_DIR: undefined },
    { LAOS_CHECKPOINT_WORKSPACE: undefined },
    { LAOS_CHECKPOINT_WORKSPACE: "other" },
    { LAOS_PYTHON_EXECUTABLE: undefined },
    { LAOS_CHECKPOINT_PROJECT: "" },
    { LAOS_CHECKPOINT_ACCOUNT_ID: "x".repeat(257) },
    { LAOS_CHECKPOINT_CONFIDENTIALITY: "secret" },
    { LAOS_PYTHON_EXECUTABLE: `${path.dirname(process.execPath)}/../${path.basename(path.dirname(process.execPath))}/${path.basename(process.execPath)}` },
  ];
  for (const overrides of cases) {
    await assert.rejects(bridge(item, { env: overrides }), (error) => {
      assert.doesNotMatch(error.message, new RegExp(item.base.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      return true;
    });
  }
});

test("rejects invalid marker, noncanonical adapter/interpreter, temporary or synced state and root overlap", async (t) => {
  const invalidMarker = await fixture(t);
  await writeFile(path.join(invalidMarker.dataRoot, ".research-agent-root"), "{}\n", "utf8");
  await assert.rejects(bridge(invalidMarker), /configuration/iu);

  const missingAdapter = await fixture(t);
  await unlink(path.join(missingAdapter.workspace, "tools", "developer_bridge_adapter.py"));
  await assert.rejects(bridge(missingAdapter), /configuration/iu);

  const adapterLink = await fixture(t);
  const adapter = path.join(adapterLink.workspace, "tools", "developer_bridge_adapter.py");
  const target = path.join(adapterLink.workspace, "tools", "adapter-target.py");
  await writeFile(target, "# target\n", "utf8");
  await unlink(adapter);
  await symlink(target, adapter);
  await assert.rejects(bridge(adapterLink), /configuration/iu);

  const executableLink = await fixture(t);
  const executable = path.join(executableLink.base, "python-link");
  await symlink(process.execPath, executable);
  await assert.rejects(bridge(executableLink, { env: { LAOS_PYTHON_EXECUTABLE: executable } }), /configuration/iu);

  const nonExecutable = await fixture(t);
  const plain = path.join(nonExecutable.base, "python");
  await writeFile(plain, "#!/bin/sh\n", "utf8");
  await chmod(plain, 0o600);
  await assert.rejects(bridge(nonExecutable, { env: { LAOS_PYTHON_EXECUTABLE: plain } }), /configuration/iu);

  const temp = await fixture(t);
  const temporaryState = await mkdtemp(path.join(os.tmpdir(), "laos-checkpoint-state-"));
  t.after(() => rm(temporaryState, { recursive: true, force: true }));
  await assert.rejects(bridge(temp, { env: { LAOS_STATE_DIR: temporaryState } }));

  const activeTemp = await fixture(t);
  await assert.rejects(bridge(activeTemp, { env: { TMPDIR: activeTemp.base } }), /configuration/iu);

  const synced = await fixture(t);
  const syncedState = path.join(synced.base, "CloudStorage", "state");
  await mkdir(syncedState, { recursive: true });
  await assert.rejects(bridge(synced, { env: { LAOS_STATE_DIR: syncedState } }), /configuration/iu);

  const overlap = await fixture(t);
  await assert.rejects(bridge(overlap, { env: { LAOS_STATE_DIR: overlap.dataRoot } }));
});

test("maps timeout, output, malformed, spawn and adapter failures to safe codes without leaking output", async (t) => {
  const item = await fixture(t);
  const secret = "raw-secret-output";
  const cases = [
    [{ timedOut: true, exitCode: null, stdout: secret, stderr: secret }, "laos_task_timeout"],
    [{ outputLimitExceeded: true, exitCode: null, stdout: secret, stderr: secret }, "laos_output_limit_exceeded"],
    [{ exitCode: 0, stdout: secret, stderr: secret }, "laos_malformed_response"],
    [{ exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code: "scope_violation" } }), stderr: secret }, "scope_violation"],
    [{ exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code: "not_allowlisted" } }), stderr: secret }, "request_failed"],
  ];
  for (const [response, code] of cases) {
    const value = await bridge(item, { runCommand: async () => response });
    const result = await value.callTool("laos_session_search", { query: "q" });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, code);
    assert.doesNotMatch(result.content[0].text, new RegExp(secret, "u"));
  }

  const value = await bridge(item, { runCommand: async () => { throw new Error(secret); } });
  const result = await value.callTool("laos_session_search", { query: "q" });
  assert.equal(JSON.parse(result.content[0].text).error.code, "laos_command_unavailable");
  assert.doesNotMatch(result.content[0].text, new RegExp(secret, "u"));
});

test("shares the bridge serialization queue", async (t) => {
  const item = await fixture(t);
  let active = 0;
  let maximum = 0;
  const value = await bridge(item, {
    runCommand: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return success();
    },
  });
  await Promise.all([
    value.callTool("laos_session_search", { query: "one" }),
    value.callTool("laos_session_search", { query: "two" }),
  ]);
  assert.equal(maximum, 1);
});

test("pins checkpoint code root and adapter across an active worktree switch", async (t) => {
  const item = await fixture(t);
  const managedRoot = `${item.workspace}-worktrees`;
  const managed = path.join(managedRoot, "feat--other");
  await mkdir(managedRoot);
  await git(item.workspace, "worktree", "add", "--quiet", "-b", "feat/other", managed, "HEAD");
  const calls = [];
  const value = await bridge(item, {
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return success();
    },
  });
  const switched = await value.callTool("git_worktree_switch", { branch: "feat/other" });
  assert.equal(switched.isError, undefined, switched.content?.[0]?.text);
  await value.callTool("laos_session_search", { query: "after" });
  assert.equal(calls[0].options.cwd, item.workspace);
  assert.deepEqual(calls[0].args, [path.join(item.workspace, "tools", "developer_bridge_adapter.py")]);
});
