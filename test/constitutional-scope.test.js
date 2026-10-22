import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.constitution.scope", type: "local-human" });
const PROFILE = Object.freeze({
  workspace: "personal",
  project: "laos",
  confidentiality: "personal",
});
const PYTHON_EXECUTABLE = (
  typeof process.env.LAOS_PYTHON_EXECUTABLE === "string" &&
  path.isAbsolute(process.env.LAOS_PYTHON_EXECUTABLE)
) ? process.env.LAOS_PYTHON_EXECUTABLE : process.execPath;

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "laos-constitution-scope-")));
  const workspace = path.join(base, "workspace");
  const coreRoot = path.join(base, "core-runtime");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([mkdir(workspace), mkdir(coreRoot), mkdir(dataRoot), mkdir(stateDir)]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), "{}\n", "utf8");
  await mkdir(path.join(coreRoot, "src"));
  await writeFile(path.join(coreRoot, "src", "laos.py"), "print('fixture')\n", "utf8");
  await git(workspace, "init", "--quiet", "-b", "feat/constitution-scope");
  await git(workspace, "config", "user.name", "Test");
  await git(workspace, "config", "user.email", "t@invalid.example");
  await writeFile(path.join(workspace, "context.txt"), "fixture\n", "utf8");
  await git(workspace, "add", "context.txt");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspace, coreRoot, dataRoot, stateDir };
}

async function createBridge(item) {
  let calls = 0;
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LAOS_CORE_ROOT: item.coreRoot,
      LAOS_DATA_ROOT: item.dataRoot,
      LAOS_STATE_DIR: item.stateDir,
      LAOS_PYTHON_EXECUTABLE: PYTHON_EXECUTABLE,
      LAOS_CHECKPOINT_WORKSPACE: PROFILE.workspace,
      LAOS_CHECKPOINT_PROJECT: PROFILE.project,
      LAOS_CHECKPOINT_CONFIDENTIALITY: PROFILE.confidentiality,
    },
    laosRunCommand: async () => {
      calls += 1;
      return { exitCode: 0, signal: null, stdout: `${JSON.stringify({ ok: true })}\n`, stderr: "" };
    },
  });
  return { bridge, get calls() { return calls; } };
}

test("C-INV-13: every scope-bearing task forwards ONLY the trusted profile scope", async (t) => {
  const item = await fixture(t);
  const { bridge, calls } = await createBridge(item);

  const tasks = [
    { type: "memory.search", input: { query: "x", workspace: "work" } },
    { type: "memory.search", input: { query: "x", project: "other" } },
    { type: "context.build", input: { query: "x", workspace: "work" } },
    { type: "memory.create", input: { workspace: "work", type: "principle", title: "t", scope: "global", confidentiality: "restricted", source: "m", confidence: "confirmed", content: "c" } },
    { type: "handoff.write", input: { project_slug: "p", content: "c", workspace: "work" } },
    { type: "loop.coordinate", input: { task: "t", result: "r", outcome: "pass", workspace: "work" } },
    { type: "reflection.apply", input: { response: "r", workspace: "work" } },
    { type: "reflection.record", input: { workspace: "work" } },
  ];

  for (const task of tasks) {
    const before = calls;
    const result = await bridge.callTool("laos_memory_task", { task });
    assert.equal(result.isError, true, `${task.type} should be rejected`);
    assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
    assert.equal(calls, before, `Core must not be invoked for ${task.type}`);
  }
});

test("C-INV-13: same-scope caller values are normalized to the trusted profile", async (t) => {
  const item = await fixture(t);
  const forwarded = [];
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LAOS_CORE_ROOT: item.coreRoot,
      LAOS_DATA_ROOT: item.dataRoot,
      LAOS_STATE_DIR: item.stateDir,
      LAOS_PYTHON_EXECUTABLE: PYTHON_EXECUTABLE,
      LAOS_CHECKPOINT_WORKSPACE: PROFILE.workspace,
      LAOS_CHECKPOINT_PROJECT: PROFILE.project,
      LAOS_CHECKPOINT_CONFIDENTIALITY: PROFILE.confidentiality,
    },
    laosRunCommand: async (command, args) => {
      const idx = args.indexOf("--task-json") + 1;
      forwarded.push(JSON.parse(args[idx]));
      return { exitCode: 0, signal: null, stdout: `${JSON.stringify({ ok: true })}\n`, stderr: "" };
    },
  });
  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "memory.search",
      workspace: "personal",
      input: { query: "x", workspace: "personal", project: "laos", confidentiality: "personal" },
    },
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(forwarded[0].workspace, "personal");
  assert.equal(forwarded[0].input.workspace, "personal");
  assert.equal(forwarded[0].input.project, "laos");
});

test("C-INV-13: scope-bearing task with omitted scope is injected from the profile", async (t) => {
  const item = await fixture(t);
  const forwarded = [];
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LAOS_CORE_ROOT: item.coreRoot,
      LAOS_DATA_ROOT: item.dataRoot,
      LAOS_STATE_DIR: item.stateDir,
      LAOS_PYTHON_EXECUTABLE: PYTHON_EXECUTABLE,
      LAOS_CHECKPOINT_WORKSPACE: PROFILE.workspace,
      LAOS_CHECKPOINT_PROJECT: PROFILE.project,
      LAOS_CHECKPOINT_CONFIDENTIALITY: PROFILE.confidentiality,
    },
    laosRunCommand: async (command, args) => {
      const idx = args.indexOf("--task-json") + 1;
      forwarded.push(JSON.parse(args[idx]));
      return { exitCode: 0, signal: null, stdout: `${JSON.stringify({ ok: true })}\n`, stderr: "" };
    },
  });
  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "x" } },
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(forwarded[0].workspace, "personal");
  assert.equal(forwarded[0].input.workspace, "personal");
  assert.equal(forwarded[0].input.project, "laos");
});

test("C-INV-13: fail-closed when the Bridge profile is absent", async (t) => {
  const item = await fixture(t);
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LAOS_CORE_ROOT: item.coreRoot,
      LAOS_DATA_ROOT: item.dataRoot,
      LAOS_STATE_DIR: item.stateDir,
      LAOS_PYTHON_EXECUTABLE: PYTHON_EXECUTABLE,
      // No LAOS_CHECKPOINT_WORKSPACE → no trusted scope.
    },
    laosRunCommand: async () => {
      throw new Error("must not run");
    },
  });
  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "x", workspace: "personal" } },
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "invalid_request");
});
