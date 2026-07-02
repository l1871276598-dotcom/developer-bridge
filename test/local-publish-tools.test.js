import assert from "node:assert/strict";
import { access, chmod, link, mkdtemp, mkdir, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_COMMAND_OUTPUT_BYTES } from "../src/bounded-process.js";
import { createBridgeCore } from "../src/bridge-core.js";
import { createLocalPublishTools } from "../src/local-publish-tools.js";

function resultText(result) {
  return result.content[0].text;
}

async function fixture(t, coreOptions = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-python-"));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  t.after(() => rm(base, { recursive: true, force: true }));
  const core = await createBridgeCore(workspace, () => {}, coreOptions);
  return { base, workspace, outside, core };
}

async function runScript(core, workspace, source, options = {}) {
  const script = options.name ?? "task.py";
  await writeFile(path.join(workspace, script), source, "utf8");
  return core.callTool("run_python_file", { path: script });
}

test("run_python_file exposes a strict destructive, open-world schema", async (t) => {
  const { core } = await fixture(t);
  const definition = core.tools.find(({ name }) => name === "run_python_file");
  assert.deepEqual(definition.inputSchema, {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  });
  assert.deepEqual(definition.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
});

test("run_python_file executes one workspace script in isolated mode with a fixed cwd", async (t) => {
  const { workspace, core } = await fixture(t, { publishTimeoutMs: 2_000 });
  const result = await runScript(core, workspace, [
    "import json, os, sys",
    "print(json.dumps({'cwd': os.getcwd(), 'isolated': sys.flags.isolated}))",
    "",
  ].join("\n"));

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.signal, null);
  assert.equal(payload.timedOut, false);
  assert.equal(payload.outputLimitExceeded, false);
  assert.equal(payload.stderr, "");
  assert.deepEqual(JSON.parse(payload.stdout), { cwd: await realpath(workspace), isolated: 1 });
});

test("run_python_file rejects lexical escapes, absolute paths, non-Python files, and interpreter flags", async (t) => {
  const { workspace, core } = await fixture(t);
  await writeFile(path.join(workspace, "task.txt"), "print('no')\n", "utf8");
  for (const invalidPath of [
    "../outside.py",
    path.join(workspace, "absolute.py"),
    "task.txt",
    "-c",
  ]) {
    const result = await core.callTool("run_python_file", { path: invalidPath });
    assert.equal(result.isError, true, `expected rejection for ${invalidPath}`);
  }
});

test("run_python_file rejects a symlink escape", async (t) => {
  const { workspace, outside, core } = await fixture(t);
  await writeFile(path.join(outside, "outside.py"), "print('no')\n", "utf8");
  await symlink(path.join(outside, "outside.py"), path.join(workspace, "link.py"), "file");
  const result = await core.callTool("run_python_file", { path: "link.py" });
  assert.equal(result.isError, true);
});

test("run_python_file rejects every in-workspace symlink component and canonical non-.py target", async (t) => {
  const { workspace, core } = await fixture(t);
  const realDirectory = path.join(workspace, "real-directory");
  await mkdir(realDirectory);
  await writeFile(path.join(workspace, "payload.py"), "print('python')\n", "utf8");
  await writeFile(path.join(workspace, "payload.txt"), "print('text')\n", "utf8");
  await writeFile(path.join(realDirectory, "task.py"), "print('directory')\n", "utf8");
  await symlink(path.join(workspace, "payload.py"), path.join(workspace, "python-alias.py"), "file");
  await symlink(path.join(workspace, "payload.txt"), path.join(workspace, "text-alias.py"), "file");
  await symlink(realDirectory, path.join(workspace, "directory-alias"), "dir");

  for (const invalidPath of ["python-alias.py", "text-alias.py", "directory-alias/task.py"]) {
    const result = await core.callTool("run_python_file", { path: invalidPath });
    assert.equal(result.isError, true, `expected rejection for ${invalidPath}`);
  }
});

test("run_python_file rejects hard-linked files", async (t) => {
  const { workspace, outside, core } = await fixture(t);
  const outsideScript = path.join(outside, "outside.py");
  await writeFile(outsideScript, "print('no')\n", "utf8");
  await link(outsideScript, path.join(workspace, "alias.py"));
  const result = await core.callTool("run_python_file", { path: "alias.py" });
  assert.equal(result.isError, true);
});

test("run_python_file rejects directories and missing files", async (t) => {
  const { workspace, core } = await fixture(t);
  await mkdir(path.join(workspace, "directory.py"));
  for (const invalidPath of ["directory.py", "missing.py"]) {
    const result = await core.callTool("run_python_file", { path: invalidPath });
    assert.equal(result.isError, true, `expected rejection for ${invalidPath}`);
  }
});

test("run_python_file requires exactly one string path argument", async (t) => {
  const { core } = await fixture(t);
  for (const args of [
    {},
    { path: 12 },
    { path: null },
    { path: "task.py", args: ["--unsafe"] },
    { path: "task.py", module: "task" },
    { path: "task.py", stdin: "print('unsafe')" },
    null,
    [],
  ]) {
    const result = await core.callTool("run_python_file", args);
    assert.equal(result.isError, true, `expected rejection for ${JSON.stringify(args)}`);
  }
});

test("run_python_file preserves a nonzero Python exit and both output streams", async (t) => {
  const { workspace, core } = await fixture(t);
  const result = await runScript(core, workspace, [
    "import sys",
    "print('OUT')",
    "print('ERR', file=sys.stderr)",
    "raise SystemExit(7)",
    "",
  ].join("\n"));

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.exitCode, 7);
  assert.equal(payload.stdout, "OUT\n");
  assert.equal(payload.stderr, "ERR\n");
  assert.equal(payload.timedOut, false);
  assert.equal(payload.outputLimitExceeded, false);
});

test("run_python_file executes the verified file object when its pathname is swapped before Python starts", async (t) => {
  const { workspace, outside } = await fixture(t);
  const target = path.join(workspace, "task.py");
  const saved = path.join(workspace, "task.saved.py");
  const outsideScript = path.join(outside, "outside.py");
  const canary = path.join(outside, "outside-ran");
  const racingPython = path.join(workspace, "python-racer.sh");
  await writeFile(target, "print('SAFE')\n", "utf8");
  await writeFile(outsideScript, [
    "from pathlib import Path",
    `Path(${JSON.stringify(canary)}).write_text('outside ran')`,
    "print('OUTSIDE')",
    "",
  ].join("\n"), "utf8");
  await writeFile(racingPython, [
    "#!/bin/sh",
    `mv ${JSON.stringify(target)} ${JSON.stringify(saved)}`,
    `ln -s ${JSON.stringify(outsideScript)} ${JSON.stringify(target)}`,
    'exec python3 "$@"',
    "",
  ].join("\n"), "utf8");
  await chmod(racingPython, 0o755);
  const core = await createBridgeCore(workspace, () => {}, { pythonCommand: racingPython });

  const result = await core.callTool("run_python_file", { path: "task.py" });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.stdout, "SAFE\n");
  await assert.rejects(access(canary));
});

test("run_python_file preserves direct-script metadata without adding the script directory to sys.path", async (t) => {
  const { workspace, core } = await fixture(t);
  const result = await runScript(core, workspace, [
    "import json, os, sys",
    "print(json.dumps({'argv0': sys.argv[0], 'file': __file__, 'script_dir_on_path': os.path.dirname(__file__) in sys.path}))",
    "",
  ].join("\n"));
  const payload = JSON.parse(resultText(result));
  const metadata = JSON.parse(payload.stdout);
  const canonical = path.join(await realpath(workspace), "task.py");
  assert.deepEqual(metadata, { argv0: canonical, file: canonical, script_dir_on_path: false });
});

test("run_python_file independently caps stdout at 1 MiB", async (t) => {
  const { workspace, core } = await fixture(t, {
    publishTimeoutMs: 5_000,
    publishTerminationGraceMs: 50,
  });
  const result = await runScript(core, workspace,
    `import sys\nsys.stdout.write('x' * ${MAX_COMMAND_OUTPUT_BYTES + 1})\nsys.stdout.flush()\n`);
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.outputLimitExceeded, true);
  assert.equal(payload.timedOut, false);
  assert.equal(Buffer.byteLength(payload.stdout, "utf8"), MAX_COMMAND_OUTPUT_BYTES);
  assert.equal(payload.stderr, "");
});

test("run_python_file independently caps stderr at 1 MiB", async (t) => {
  const { workspace, core } = await fixture(t, {
    publishTimeoutMs: 5_000,
    publishTerminationGraceMs: 50,
  });
  const result = await runScript(core, workspace,
    `import sys\nsys.stderr.write('x' * ${MAX_COMMAND_OUTPUT_BYTES + 1})\nsys.stderr.flush()\n`);
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.outputLimitExceeded, true);
  assert.equal(payload.timedOut, false);
  assert.equal(payload.stdout, "");
  assert.equal(Buffer.byteLength(payload.stderr, "utf8"), MAX_COMMAND_OUTPUT_BYTES);
});

test("run_python_file honors the internal timeout override", async (t) => {
  const { workspace, core } = await fixture(t, {
    publishTimeoutMs: 50,
    publishTerminationGraceMs: 50,
  });
  const result = await runScript(core, workspace, "import time\ntime.sleep(60)\n");
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.timedOut, true);
  assert.equal(payload.outputLimitExceeded, false);
  assert.notEqual(payload.signal, null);
});

test("run_python_file terminates descendant processes on timeout", async (t) => {
  const { workspace, core } = await fixture(t, {
    publishTimeoutMs: 200,
    publishTerminationGraceMs: 100,
  });
  const result = await runScript(core, workspace, [
    "import pathlib, subprocess, sys, time",
    "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])",
    "pathlib.Path('child.pid').write_text(str(child.pid))",
    "time.sleep(60)",
    "",
  ].join("\n"));
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.timedOut, true);

  const childPid = Number(await readFile(path.join(workspace, "child.pid"), "utf8"));
  await assert.rejects(async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(childPid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") throw error;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }, { code: "ESRCH" });
});

test("run_python_file sanitizes Python startup failures", async (t) => {
  const { workspace, core } = await fixture(t, { pythonCommand: "missing-python-command-for-test" });
  await writeFile(path.join(workspace, "task.py"), "print('no')\n", "utf8");
  const result = await core.callTool("run_python_file", { path: "task.py" });
  assert.equal(result.isError, true);
  assert.equal(resultText(result), "Python could not be started");
  assert.doesNotMatch(resultText(result), /ENOENT|missing-python-command/);
});

test("run_python_file closes verified file descriptors after success, timeout, and startup failure", async (t) => {
  const { workspace } = await fixture(t);
  const script = path.join(workspace, "task.py");
  await writeFile(script, "pass\n", "utf8");

  for (const runProcess of [
    async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, outputLimitExceeded: false }),
    async () => ({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: true, outputLimitExceeded: false }),
    async () => { throw new Error("startup failed"); },
  ]) {
    const handle = await open(script, "r");
    const tools = createLocalPublishTools({
      root: workspace,
      normalizePath: (value) => value,
      existingFile: async () => ({ canonical: script, handle }),
      runProcess,
      timeoutMs: 1_000,
      terminationGraceMs: 50,
      ToolError: Error,
    });
    await tools.invoke("run_python_file", { path: "task.py" }).catch(() => {});
    assert.equal(handle.fd, -1);
  }
});

test("run_python_file rejects a verified canonical target without a .py extension", async (t) => {
  const { workspace } = await fixture(t);
  const target = path.join(workspace, "payload.txt");
  await writeFile(target, "print('no')\n", "utf8");
  const handle = await open(target, "r");
  let runnerCalled = false;
  const tools = createLocalPublishTools({
    root: workspace,
    normalizePath: (value) => value,
    existingFile: async () => ({ canonical: target, handle }),
    runProcess: async () => { runnerCalled = true; },
    timeoutMs: 1_000,
    terminationGraceMs: 50,
    ToolError: Error,
  });

  await assert.rejects(tools.invoke("run_python_file", { path: "alias.py" }), /Python \.py file/);
  assert.equal(runnerCalled, false);
  assert.equal(handle.fd, -1);
});

test("createBridgeCore validates internal Python execution seams", async (t) => {
  const { workspace } = await fixture(t);
  for (const options of [
    { publishTimeoutMs: 0 },
    { publishTimeoutMs: 1.5 },
    { publishTerminationGraceMs: -1 },
    { publishTerminationGraceMs: 1.5 },
    { pythonCommand: "" },
    { pythonCommand: 12 },
  ]) {
    await assert.rejects(createBridgeCore(workspace, () => {}, options));
  }
});
