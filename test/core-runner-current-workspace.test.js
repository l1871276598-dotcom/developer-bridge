import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRunnerError, createCoreRunner } from "../src/core-runner.js";

async function fixture(t, { interpreterInCallWorkspace = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "core-runner-workspace-")));
  const coreRoot = path.join(root, "core");
  const dataRoot = path.join(root, "data");
  const stateDir = path.join(root, "state");
  const initialWorkspace = path.join(root, "initial-workspace");
  const callWorkspace = path.join(root, "call-workspace");
  await Promise.all([
    mkdir(path.join(coreRoot, "src"), { recursive: true }),
    mkdir(dataRoot),
    mkdir(stateDir),
    mkdir(initialWorkspace),
    mkdir(callWorkspace),
  ]);
  await writeFile(path.join(coreRoot, "src", "laos.py"), "# fixture\n", "utf8");
  const interpreter = path.join(
    interpreterInCallWorkspace ? callWorkspace : root,
    "trusted-python",
  );
  await writeFile(interpreter, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(interpreter, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    coreRoot,
    dataRoot,
    stateDir,
    initialWorkspace,
    callWorkspace,
    env: {
      LAOS_CORE_ROOT: coreRoot,
      LAOS_DATA_ROOT: dataRoot,
      LAOS_STATE_DIR: stateDir,
      LAOS_PYTHON_EXECUTABLE: interpreter,
    },
  };
}

test("GP10-03: runTask forwards an injected command with explicit workspace distinct from process cwd", async (t) => {
  const item = await fixture(t);
  let observed = null;
  const runner = await createCoreRunner({
    env: item.env,
    codeRoot: item.initialWorkspace,
    runCommand: async (command, args, options) => {
      observed = { command, args, options };
      return { stdout: "{}", stderr: "", exitCode: 0, signal: null };
    },
  });

  const result = await runner.runTask("{}", {
    workspace: item.callWorkspace,
    cwd: item.coreRoot,
    timeoutMs: 123,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(observed.command, runner.interpreter);
  assert.equal(observed.options.cwd, item.coreRoot);
  assert.equal(observed.options.timeoutMs, 123);
});

test("GP10-03: runTask rejects a call-time workspace containing the interpreter before downstream execution", async (t) => {
  const item = await fixture(t, { interpreterInCallWorkspace: true });
  let calls = 0;
  const runner = await createCoreRunner({
    env: item.env,
    codeRoot: item.initialWorkspace,
    runCommand: async () => {
      calls += 1;
      return { stdout: "{}", stderr: "", exitCode: 0, signal: null };
    },
  });

  await assert.rejects(
    () => runner.runTask("{}", { workspace: item.callWorkspace, cwd: item.coreRoot }),
    (error) => error instanceof CoreRunnerError && error.code === "invalid_workspace",
  );
  assert.equal(calls, 0);
});
