import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";
import { handleGitWriteTool } from "../src/git-write-tools.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.regression", type: "local-human" });
const capabilityEnv = { DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1" };

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function repository(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-laos-")));
  const primary = path.join(base, "workspace");
  const managedRoot = path.join(base, "workspace-worktrees");
  const managed = path.join(managedRoot, "feat--laos");
  await mkdir(primary);
  await git(primary, "init", "--quiet", "-b", "feat/start");
  await git(primary, "config", "user.name", "Test User");
  await git(primary, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(primary, "README.md"), "fixture\n", "utf8");
  await git(primary, "add", "README.md");
  await git(primary, "commit", "--quiet", "-m", "fixture");
  await git(primary, "worktree", "add", "--quiet", "-b", "feat/laos", managed, "HEAD");
  t.after(() => rm(base, { recursive: true, force: true }));
  return {
    primary,
    managed,
    commonDir: await realpath(path.join(primary, ".git")),
  };
}

function bridgeOptions() {
  return { operatorIdentity, env: capabilityEnv };
}

async function assertGitContextTools(bridge) {
  const names = new Set(bridge.tools.map(({ name }) => name));
  assert.equal(names.has("git_context"), true);
  assert.equal(names.has("git_log"), true);

  const context = await bridge.callTool("git_context", {});
  assert.equal(context.isError, undefined, context.content?.[0]?.text);
  assert.equal(JSON.parse(context.content[0].text).branch, "feat/laos");

  const history = await bridge.callTool("git_log", { limit: 1 });
  assert.equal(history.isError, undefined, history.content?.[0]?.text);
  assert.equal(JSON.parse(history.content[0].text).commits.length, 1);
}

test("managed LAOS worktree startup keeps advertised Git context tools callable", async (t) => {
  const fixture = await repository(t);
  const bridge = await createBridgeWithSyncTools(fixture.managed, () => {}, bridgeOptions());
  await assertGitContextTools(bridge);
});

test("live LAOS worktree switch keeps advertised Git context tools callable", async (t) => {
  const fixture = await repository(t);
  const logs = [];
  const bridge = await createBridgeWithSyncTools(
    fixture.primary,
    (line) => logs.push(line),
    bridgeOptions(),
  );
  const switched = await bridge.callTool("git_worktree_switch", { branch: "feat/laos" });
  assert.equal(switched.isError, undefined, `${switched.content?.[0]?.text}\n${logs.join("\n")}`);
  assert.equal(JSON.parse(switched.content[0].text).branch, "feat/laos");

  await assertGitContextTools(bridge);
});

test("run_validation returns the failed step with bounded stdout and stderr", async (t) => {
  const fixture = await repository(t);
  const snapshot = {
    root: fixture.managed,
    branch: "feat/laos",
    commonDir: fixture.commonDir,
  };
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, allowFailure: options.allowFailure });
    return {
      exitCode: 5,
      signal: null,
      stdout: "no tests ran\n",
      stderr: "pytest collected no tests\n",
    };
  };

  const result = await handleGitWriteTool("run_validation", {}, snapshot, { runCommand });
  const payload = JSON.parse(result.text);
  assert.equal(payload.passed, false);
  assert.equal(payload.branch, "feat/laos");
  assert.equal(payload.failed_step, "pytest");
  assert.deepEqual(payload.results, [{
    step: "pytest",
    exitCode: 5,
    signal: null,
    stdout: "no tests ran\n",
    stderr: "pytest collected no tests\n",
    passed: false,
  }]);
  assert.deepEqual(calls, [{
    command: "python3",
    args: ["-m", "pytest", "-q"],
    cwd: fixture.managed,
    allowFailure: true,
  }]);
});

test("run_validation uses unittest discovery for a unittest project", async (t) => {
  const fixture = await repository(t);
  await mkdir(path.join(fixture.managed, "tests"));
  await writeFile(
    path.join(fixture.managed, "tests", "test_example.py"),
    [
      "import unittest",
      "",
      "class ExampleTests(unittest.TestCase):",
      "    def test_example(self):",
      "        self.assertTrue(True)",
      "",
    ].join("\n"),
    "utf8",
  );
  const snapshot = {
    root: fixture.managed,
    branch: "feat/laos",
    commonDir: fixture.commonDir,
  };
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, allowFailure: options.allowFailure });
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  };

  const result = await handleGitWriteTool("run_validation", {}, snapshot, { runCommand });
  const payload = JSON.parse(result.text);
  assert.equal(payload.passed, true);
  assert.equal(payload.failed_step, null);
  assert.equal(payload.results[0].step, "unittest");
  assert.deepEqual(calls[0], {
    command: "python3",
    args: ["-m", "unittest", "discover", "-s", "tests", "-p", "test*.py", "-v"],
    cwd: fixture.managed,
    allowFailure: true,
  });
});
