import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.data.test", type: "local-human" });

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-laos-data-")));
  const workspace = path.join(base, "workspace");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([mkdir(workspace), mkdir(dataRoot), mkdir(stateDir)]);
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "laos.py"), "print('fixture')\n", "utf8");
  await git(workspace, "init", "--quiet", "-b", "feat/laos-data");
  await git(workspace, "config", "user.name", "Test User");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "add", "src/laos.py");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspace, dataRoot, stateDir };
}

function env(fixture, overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1",
    LAOS_DATA_ROOT: fixture.dataRoot,
    LAOS_STATE_DIR: fixture.stateDir,
    ...overrides,
  };
}

test("conditionally exposes one LAOS memory task bound to external data and state roots", async (t) => {
  const item = await fixture(t);
  const calls = [];
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: env(item),
    laosRunCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        exitCode: 0,
        signal: null,
        stdout: `${JSON.stringify({ ok: true, data_root: item.dataRoot })}\n`,
        stderr: "",
      };
    },
  });

  assert.equal(bridge.tools.at(-1).name, "laos_memory_task");
  assert.equal(bridge.tools.length, 52);

  const task = {
    type: "memory.create",
    workspace: "personal",
    input: {
      type: "principle",
      title: "最少代码",
      scope: "global",
      workspace: "personal",
      confidentiality: "personal",
      source: "manual:user_confirmed",
      confidence: "confirmed",
      content: "使用尽可能少的代码实现相同功能。",
    },
  };
  const result = await bridge.callTool("laos_memory_task", { task });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, data_root: "[laos-data]" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.platform === "win32" ? "python" : "python3");
  assert.equal(calls[0].options.cwd, item.workspace);
  assert.deepEqual(calls[0].args.slice(0, 5), [
    path.join(item.workspace, "src", "laos.py"),
    "--root",
    item.dataRoot,
    "--state-dir",
    item.stateDir,
  ]);
  assert.equal(calls[0].args[5], "--task-json");
  assert.deepEqual(JSON.parse(calls[0].args[6]), task);
});

test("allows handoff.write LAOS tasks through the fixed CLI", async (t) => {
  const item = await fixture(t);
  const calls = [];
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: env(item),
    laosRunCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        exitCode: 0,
        signal: null,
        stdout: `${JSON.stringify({ ok: true, task_type: "handoff.write" })}\n`,
        stderr: "",
      };
    },
  });

  const task = {
    type: "handoff.write",
    workspace: "personal",
    input: {
      project_slug: "skill-optimization",
      content: "# Handoff\n",
    },
  };
  const result = await bridge.callTool("laos_memory_task", { task });

  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: true,
    task_type: "handoff.write",
  });
  assert.equal(calls.length, 1);
  const taskJsonIndex = calls[0].args.indexOf("--task-json") + 1;
  assert.notEqual(taskJsonIndex, 0);
  assert.deepEqual(JSON.parse(calls[0].args[taskJsonIndex]), task);

  const rejected = await bridge.callTool("laos_memory_task", {
    task: { type: "handoff.read", workspace: "personal", input: {} },
  });
  assert.equal(rejected.isError, true);
  assert.ok(
    typeof rejected.content[0].text === "string" && rejected.content[0].text.length > 0,
    "error should include a non-empty message",
  );
  assert.equal(calls.length, 1);
});

test("runs the fixed LAOS CLI as a real subprocess against external roots", async (t) => {
  const item = await fixture(t);
  await writeFile(path.join(item.workspace, "src", "laos.py"), `
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
parser.add_argument("--state-dir", required=True)
parser.add_argument("--task-json", required=True)
args = parser.parse_args()
task = json.loads(args.task_json)
Path(args.root, "smoke-task.json").write_text(json.dumps(task, ensure_ascii=False), encoding="utf-8")
Path(args.state_dir, "smoke-state.txt").write_text("ok\\n", encoding="utf-8")
print(json.dumps({"ok": True, "task_type": task["type"], "data_root": args.root, "state_dir": args.state_dir}))
`, "utf8");

  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: env(item),
  });
  const task = {
    type: "memory.search",
    workspace: "personal",
    input: { query: "bridge smoke" },
  };
  const result = await bridge.callTool("laos_memory_task", { task });

  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: true,
    task_type: "memory.search",
    data_root: "[laos-data]",
    state_dir: "[laos-state]",
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(item.dataRoot, "smoke-task.json"), "utf8")), task);
  assert.equal(await readFile(path.join(item.stateDir, "smoke-state.txt"), "utf8"), "ok\n");
});

test("does not advertise the LAOS task without both roots and rejects partial configuration", async (t) => {
  const item = await fixture(t);
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: { DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1" },
  });
  assert.equal(bridge.tools.some(({ name }) => name === "laos_memory_task"), false);
  assert.equal(bridge.tools.length, 51);

  await assert.rejects(
    createBridgeWithSyncTools(item.workspace, () => {}, {
      operatorIdentity,
      env: env(item, { LAOS_STATE_DIR: undefined }),
    }),
    /LAOS_DATA_ROOT and LAOS_STATE_DIR must be configured together/u,
  );
});

test("rejects non-allowlisted LAOS tasks before command execution", async (t) => {
  const item = await fixture(t);
  let called = false;
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: env(item),
    laosRunCommand: async () => {
      called = true;
      throw new Error("must not run");
    },
  });

  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "import.file", input: { path: "/tmp/private.txt" } },
  });
  assert.equal(result.isError, true);
  assert.equal(called, false);
});
