import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.error.test", type: "local-human" });

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-laos-error-")));
  const workspace = path.join(base, "workspace");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([mkdir(workspace), mkdir(dataRoot), mkdir(stateDir)]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), "{}\n", "utf8");
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "laos.py"), "print('fixture')\n", "utf8");
  await git(workspace, "init", "--quiet", "-b", "feat/laos-errors");
  await git(workspace, "config", "user.name", "Test User");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "add", "src/laos.py");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspace, dataRoot, stateDir };
}

function env(item) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1",
    LAOS_DATA_ROOT: item.dataRoot,
    LAOS_STATE_DIR: item.stateDir,
  };
}

async function callFailingTask(item, laosRunCommand) {
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: env(item),
    laosRunCommand,
  });
  return bridge.callTool("laos_memory_task", {
    task: {
      type: "memory.search",
      input: { query: "migration", workspace: "personal" },
    },
  });
}

test("returns an allowlisted LAOS CLI error code without leaking stderr details", async (t) => {
  const item = await fixture(t);
  const secret = `${item.dataRoot}/private-patient-file.md`;
  const result = await callFailingTask(item, async () => ({
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: `${JSON.stringify({
      error: {
        code: "memory_store_validation_failed",
        message: secret,
      },
    })}\n`,
  }));

  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    error: {
      code: "memory_store_validation_failed",
      message: "LAOS task failed.",
    },
  });
  assert.equal(result.content[0].text.includes(secret), false);
  assert.equal(result.content[0].text.includes(item.dataRoot), false);
});

test("maps unexpected runner failures to a stable generic LAOS error", async (t) => {
  const item = await fixture(t);
  const secret = `${item.stateDir}/sensitive-state.db`;
  const result = await callFailingTask(item, async () => {
    throw new Error(secret);
  });

  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    error: {
      code: "tool_operation_failed",
      message: "LAOS task failed.",
    },
  });
  assert.equal(result.content[0].text.includes(secret), false);
  assert.equal(result.content[0].text.includes(item.stateDir), false);
});
