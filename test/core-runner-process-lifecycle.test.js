import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CoreRunnerError, createCoreRunner } from "../src/core-runner.js";
import { runCli as runLegacyCli } from "../src/vault/laos-publisher.js";

const execFileAsync = promisify(execFile);
let discoveredPython = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pythonExecutable() {
  if (typeof process.env.LAOS_PYTHON_EXECUTABLE === "string"
    && path.isAbsolute(process.env.LAOS_PYTHON_EXECUTABLE)
    && !process.env.LAOS_PYTHON_EXECUTABLE.includes("\0")) {
    return process.env.LAOS_PYTHON_EXECUTABLE;
  }
  if (discoveredPython === null) {
    discoveredPython = execFileAsync("python3", ["-c", "import sys; print(sys.executable)"])
      .then(({ stdout }) => stdout.trim());
  }
  return discoveredPython;
}

async function waitForPid(pidFile, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await readFile(pidFile, "utf8").catch(() => null);
    const pid = Number(raw?.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
    await sleep(10);
  }
  throw new Error("fixture descendant did not publish its pid");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await sleep(20);
  }
  return !processIsAlive(pid);
}

async function boundedResult(promise, watchdogMs = 1_500) {
  return Promise.race([
    promise.then(
      (value) => ({ kind: "resolved", value }),
      (error) => ({ kind: "rejected", error }),
    ),
    sleep(watchdogMs).then(() => ({ kind: "watchdog" })),
  ]);
}

async function fixture(t, script) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "core-runner-lifecycle-")));
  const coreRoot = path.join(root, "core");
  const workspace = path.join(root, "workspace");
  const dataRoot = path.join(root, "data");
  const stateDir = path.join(root, "state");
  const pidFile = path.join(root, "descendant.pid");
  await Promise.all([
    mkdir(path.join(coreRoot, "src"), { recursive: true }),
    mkdir(workspace),
    mkdir(dataRoot),
    mkdir(stateDir),
  ]);
  await writeFile(path.join(coreRoot, "src", "laos.py"), script(pidFile), "utf8");

  t.after(async () => {
    const raw = await readFile(pidFile, "utf8").catch(() => null);
    const pid = Number(raw?.trim());
    if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch (_) {}
    }
    await rm(root, { recursive: true, force: true });
  });

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LAOS_CORE_ROOT: coreRoot,
    LAOS_DATA_ROOT: dataRoot,
    LAOS_STATE_DIR: stateDir,
    LAOS_PYTHON_EXECUTABLE: await pythonExecutable(),
  };
  return { coreRoot, workspace, pidFile, env };
}

// The Python parent is the Core process. It spawns a descendant with inherited
// stdout/stderr and then remains alive. The process-tree tests exercise the
// supported POSIX lifecycle; the separate Windows test proves the fail-closed
// boundary before a Core child can spawn.
function inheritingPipeParent(pidFile, descendantSource) {
  return [
    "import subprocess",
    "import sys",
    "import time",
    `pid_file = ${JSON.stringify(pidFile)}`,
    `descendant_source = ${JSON.stringify(descendantSource)}`,
    "descendant = subprocess.Popen([sys.executable, '-c', descendant_source])",
    "with open(pid_file, \"w\", encoding=\"utf-8\") as handle:",
    "    handle.write(str(descendant.pid))",
    "while True:",
    "    time.sleep(1)",
  ].join("\n");
}

function inheritingTimeoutChild(pidFile) {
  return inheritingPipeParent(pidFile, [
    "import time",
    "time.sleep(3)",
  ].join("\n"));
}

function inheritingOutputChild(pidFile) {
  return inheritingPipeParent(pidFile, [
    "import sys",
    "import time",
    "time.sleep(0.05)",
    "sys.stdout.write(\"x\" * 1_300_000)",
    "sys.stdout.flush()",
    "while True:",
    "    time.sleep(1)",
  ].join("\n"));
}

function termIgnoringChild(pidFile) {
  return inheritingPipeParent(pidFile, [
    "import signal",
    "import time",
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    "while True:",
    "    time.sleep(1)",
  ].join("\n"));
}

// The parent exits immediately, while its descendant intentionally has no
// inherited Core output pipes left to keep the ChildProcess `close` event open.
// This is the normal-close case that must still clean the detached POSIX group.
function redirectedPipeExitParent(pidFile, exitCode) {
  return [
    "import os",
    "import subprocess",
    "import sys",
    `pid_file = ${JSON.stringify(pidFile)}`,
    "descendant_source = \"import time\\nwhile True:\\n    time.sleep(1)\"",
    "with open(os.devnull, \"wb\") as sink:",
    "    descendant = subprocess.Popen([sys.executable, '-c', descendant_source], stdout=sink, stderr=sink)",
    "with open(pid_file, \"w\", encoding=\"utf-8\") as handle:",
    "    handle.write(str(descendant.pid))",
    `raise SystemExit(${exitCode})`,
  ].join("\n");
}

test("GP13-01: runTask timeout cannot wait on a descendant retaining inherited pipes", async (t) => {
  const item = await fixture(t, inheritingTimeoutChild);
  const runner = await createCoreRunner({ env: item.env, codeRoot: item.workspace });
  const result = boundedResult(runner.runTask("{}", {
    workspace: item.workspace,
    cwd: item.coreRoot,
    timeoutMs: 400,
  }));
  const descendant = await waitForPid(item.pidFile);
  const settled = await result;

  assert.equal(settled.kind, "rejected", "timeout must not wait for an inherited pipe to close");
  assert.ok(settled.error instanceof CoreRunnerError);
  assert.equal(settled.error.code, "core_timeout");
  assert.equal(await waitForExit(descendant), true, "timeout must terminate the complete descendant tree");
});

test("GP13-01: runCli output cap terminates the descendant tree", async (t) => {
  const item = await fixture(t, inheritingOutputChild);
  const runner = await createCoreRunner({ env: item.env, codeRoot: item.workspace });
  const result = boundedResult(runner.runCli("{}", {
    workspace: item.workspace,
    cwd: item.coreRoot,
    timeoutMs: 4_000,
  }));
  const descendant = await waitForPid(item.pidFile);
  const settled = await result;

  assert.equal(settled.kind, "rejected", "output-cap termination must not wait for inherited pipes");
  assert.ok(settled.error instanceof CoreRunnerError);
  assert.equal(settled.error.code, "core_output_limit");
  assert.equal(await waitForExit(descendant), true, "output cap must terminate the complete descendant tree");
});

test("GP13-01: forced escalation terminates a TERM-ignoring descendant", async (t) => {
  const item = await fixture(t, termIgnoringChild);
  const runner = await createCoreRunner({ env: item.env, codeRoot: item.workspace });
  const result = boundedResult(runner.runCli("{}", {
    workspace: item.workspace,
    cwd: item.coreRoot,
    timeoutMs: 400,
  }));
  const descendant = await waitForPid(item.pidFile);
  const settled = await result;

  assert.equal(settled.kind, "rejected", "SIGKILL escalation must settle without waiting forever");
  assert.ok(settled.error instanceof CoreRunnerError);
  assert.equal(settled.error.code, "core_timeout");
  assert.equal(await waitForExit(descendant), true, "TERM-ignoring descendant must be gone after escalation");
});

test("GP13-01: zero-exit parent does not settle while its redirected-stdio descendant lives", async (t) => {
  const item = await fixture(t, (pidFile) => redirectedPipeExitParent(pidFile, 0));
  const runner = await createCoreRunner({ env: item.env, codeRoot: item.workspace });
  const result = boundedResult(runner.runCli("{}", {
    workspace: item.workspace,
    cwd: item.coreRoot,
  }));
  const descendant = await waitForPid(item.pidFile);
  const settled = await result;

  assert.equal(settled.kind, "resolved", "zero exit must retain its successful result after tree cleanup");
  assert.equal(processIsAlive(descendant), false, "zero-exit settlement must wait for the redirected-stdio descendant to exit");
});

test("GP13-01: nonzero-exit parent does not settle while its redirected-stdio descendant lives", async (t) => {
  const item = await fixture(t, (pidFile) => redirectedPipeExitParent(pidFile, 7));
  const runner = await createCoreRunner({ env: item.env, codeRoot: item.workspace });
  const result = boundedResult(runner.runCli("{}", {
    workspace: item.workspace,
    cwd: item.coreRoot,
  }));
  const descendant = await waitForPid(item.pidFile);
  const settled = await result;

  assert.equal(settled.kind, "rejected", "nonzero exit must retain its CoreRunnerError after tree cleanup");
  assert.ok(settled.error instanceof CoreRunnerError);
  assert.equal(settled.error.code, "core_exit");
  assert.equal(processIsAlive(descendant), false, "nonzero-exit settlement must wait for the redirected-stdio descendant to exit");
});

test("GP13-01: Windows fails closed before spawning an unverifiable Core process tree", { concurrency: false }, async (t) => {
  let marker = null;
  const item = await fixture(t, (pidFile) => {
    marker = path.join(path.dirname(pidFile), "unexpected-windows-spawn");
    return [
      "from pathlib import Path",
      `Path(${JSON.stringify(marker)}).write_text(\"spawned\", encoding=\"utf-8\")`,
    ].join("\n");
  });
  const runner = await createCoreRunner({ env: item.env, codeRoot: item.workspace });
  const platform = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await assert.rejects(
      () => runner.runCli("{}", { workspace: item.workspace, cwd: item.coreRoot }),
      (error) => error instanceof CoreRunnerError && error.code === "unsupported_platform",
    );
  } finally {
    Object.defineProperty(process, "platform", platform);
  }

  assert.equal(await readFile(marker, "utf8").catch(() => null), null, "Windows guard must reject before the Core child can run");
});

test("GP10-09: legacy runCli delegates to the shared bounded lifecycle", async (t) => {
  const item = await fixture(t, inheritingTimeoutChild);
  const result = boundedResult(runLegacyCli(item.env, "{}", item.coreRoot, {
    workspace: item.workspace,
    cwd: item.coreRoot,
    timeoutMs: 400,
  }));
  const descendant = await waitForPid(item.pidFile);
  const settled = await result;

  assert.equal(settled.kind, "rejected", "legacy export must share the bounded lifecycle");
  assert.match(settled.error.message, /timed out/i);
  assert.equal(await waitForExit(descendant), true, "legacy timeout must terminate the complete descendant tree");
});
