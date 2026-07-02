import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, link, mkdtemp, mkdir, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { MAX_COMMAND_OUTPUT_BYTES } from "../src/bounded-process.js";
import { createBridgeCore } from "../src/bridge-core.js";
import { createLocalPublishTools } from "../src/local-publish-tools.js";

const execFileAsync = promisify(execFile);

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

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function gitFixture(t, options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-publish-git-"));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  t.after(() => rm(base, { recursive: true, force: true }));
  await git(workspace, "init", "--quiet");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "config", "user.name", "Developer Bridge Test");
  await writeFile(path.join(workspace, "tracked.txt"), "before\n", "utf8");
  await writeFile(path.join(workspace, "other.txt"), "before\n", "utf8");
  await git(workspace, "add", "tracked.txt", "other.txt");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  const logs = [];
  const core = await createBridgeCore(
    options.authorizedRoot ?? workspace,
    (line) => logs.push(line),
    options.coreOptions ?? {},
  );
  return { base, workspace, logs, core };
}

test("git_add and git_commit expose strict destructive schemas", async (t) => {
  const { core } = await fixture(t);
  const add = core.tools.find(({ name }) => name === "git_add");
  const commit = core.tools.find(({ name }) => name === "git_commit");
  assert.deepEqual(add.inputSchema, {
    type: "object",
    properties: { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 128 } },
    required: ["paths"],
    additionalProperties: false,
  });
  assert.deepEqual(commit.inputSchema, {
    type: "object",
    properties: { message: { type: "string", minLength: 1, maxLength: 200 } },
    required: ["message"],
    additionalProperties: false,
  });
  assert.deepEqual(add.annotations, { readOnlyHint: false, destructiveHint: true });
  assert.deepEqual(commit.annotations, { readOnlyHint: false, destructiveHint: true });
});

test("git_add stages only deduplicated explicit files and returns staged short status", async (t) => {
  const { workspace, core } = await gitFixture(t);
  await writeFile(path.join(workspace, "tracked.txt"), "staged\n", "utf8");
  await writeFile(path.join(workspace, "other.txt"), "unstaged\n", "utf8");

  const result = await core.callTool("git_add", { paths: ["tracked.txt", "tracked.txt"] });
  assert.equal(result.isError, undefined);
  assert.match(resultText(result), /^M  tracked\.txt$/m);
  assert.doesNotMatch(resultText(result), /other\.txt/);
  const status = (await git(workspace, "status", "--short")).stdout;
  assert.match(status, /^M  tracked\.txt$/m);
  assert.match(status, /^ M other\.txt$/m);
});

test("git_add requires a strict nonempty string path array of at most 128 items", async (t) => {
  const { core } = await gitFixture(t);
  const invalid = [
    {}, { paths: [] }, { paths: "tracked.txt" }, { paths: [12] },
    { paths: ["tracked.txt"], extra: true }, null, [],
    { paths: Array.from({ length: 129 }, (_, index) => `file-${index}.txt`) },
  ];
  for (const args of invalid) {
    assert.equal((await core.callTool("git_add", args)).isError, true, JSON.stringify(args));
  }
});

test("git_add rejects pathspecs, protected paths, symlinks, hard links, directories, and missing files", async (t) => {
  const { base, workspace, core } = await gitFixture(t);
  const outside = path.join(base, "outside.txt");
  await writeFile(outside, "outside\n", "utf8");
  await writeFile(path.join(workspace, ".env"), "secret\n", "utf8");
  await writeFile(path.join(workspace, ".env.production"), "secret\n", "utf8");
  await writeFile(path.join(workspace, "secret.pem"), "secret\n", "utf8");
  await mkdir(path.join(workspace, "directory"));
  await mkdir(path.join(workspace, "node_modules"));
  await writeFile(path.join(workspace, "node_modules", "package.js"), "x\n", "utf8");
  await symlink(outside, path.join(workspace, "escape.txt"), "file");
  await symlink(path.join(workspace, "tracked.txt"), path.join(workspace, "inside-link.txt"), "file");
  await link(path.join(workspace, "tracked.txt"), path.join(workspace, "hard-link.txt"));

  const invalidPaths = [
    ".", "-A", "--all", "../outside.txt", path.join(workspace, "tracked.txt"),
    "*.txt", "file?.txt", "[ab].txt", ":(glob)*", ":!tracked.txt", ":^tracked.txt", ":/tracked.txt",
    ".git/config", ".env", ".env.production", "node_modules/package.js", "secret.pem", "id_rsa", "id_ed25519", "secret.key",
    "nested/../other.txt",
    "escape.txt", "inside-link.txt", "hard-link.txt", "directory", "missing.txt",
  ];
  for (const invalidPath of invalidPaths) {
    const result = await core.callTool("git_add", { paths: [invalidPath] });
    assert.equal(result.isError, true, `expected rejection for ${invalidPath}`);
  }
});

test("git_add requires the authorized workspace to equal the repository top level", async (t) => {
  const { workspace } = await gitFixture(t);
  const nested = path.join(workspace, "nested");
  await mkdir(nested);
  await writeFile(path.join(nested, "file.txt"), "nested\n", "utf8");
  const core = await createBridgeCore(nested, () => {});
  const result = await core.callTool("git_add", { paths: ["file.txt"] });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /top level|repository root/i);
});

test("git_add and git_commit reject a branch different from the configured allowed branch", async (t) => {
  const { workspace } = await gitFixture(t);
  const currentBranch = (await git(workspace, "branch", "--show-current")).stdout.trim();
  const core = await createBridgeCore(workspace, () => {}, {
    allowedBranch: `${currentBranch}-not-allowed`,
  });

  await writeFile(path.join(workspace, "tracked.txt"), "changed\n", "utf8");

  const add = await core.callTool("git_add", { paths: ["tracked.txt"] });
  assert.equal(add.isError, true);
  assert.match(resultText(add), /allowed branch|authorized branch/i);

  await git(workspace, "add", "tracked.txt");
  const commit = await core.callTool("git_commit", { message: "must be blocked" });
  assert.equal(commit.isError, true);
  assert.match(resultText(commit), /allowed branch|authorized branch/i);
});

test("git_add permits repository clean filters as an explicit trust boundary without generic Git arguments", async (t) => {
  const { workspace, core } = await gitFixture(t);
  const canary = path.join(workspace, "clean-filter-ran");
  const filter = path.join(workspace, "clean-filter.sh");
  await writeFile(filter, `#!/bin/sh\ntouch "${canary}"\ncat\n`, "utf8");
  await chmod(filter, 0o755);
  await writeFile(path.join(workspace, ".gitattributes"), "filtered.txt filter=canary\n", "utf8");
  await writeFile(path.join(workspace, "filtered.txt"), "filtered\n", "utf8");
  await git(workspace, "config", "filter.canary.clean", filter);

  const result = await core.callTool("git_add", { paths: [".gitattributes", "filtered.txt"] });
  assert.equal(result.isError, undefined);
  await access(canary);
  assert.equal((await core.callTool("git_add", { paths: ["--renormalize"] })).isError, true);
});

test("git_commit commits staged content only and returns a full oid plus one-line summary", async (t) => {
  const { workspace, core } = await gitFixture(t);
  await writeFile(path.join(workspace, "tracked.txt"), "staged\n", "utf8");
  await writeFile(path.join(workspace, "other.txt"), "unstaged\n", "utf8");
  assert.equal((await core.callTool("git_add", { paths: ["tracked.txt"] })).isError, undefined);

  const result = await core.callTool("git_commit", { message: "controlled commit" });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(resultText(result));
  assert.match(payload.oid, /^[0-9a-f]{40,64}$/);
  assert.equal(payload.summary, "controlled commit");
  assert.equal((await git(workspace, "show", "--format=", "--name-only", "HEAD")).stdout.trim(), "tracked.txt");
  assert.match((await git(workspace, "status", "--short")).stdout, /^ M other\.txt$/m);
});

test("git_commit requires one safe line of at most 200 UTF-8 bytes and no extra controls", async (t) => {
  const { core } = await gitFixture(t);
  const invalid = [
    {}, { message: "" }, { message: "   \t" }, { message: "-message" },
    { message: "line\nnext" }, { message: "line\rnext" }, { message: "é".repeat(101) },
    { message: 12 }, { message: "ok", author: "attacker" }, { message: "ok", amend: true },
    { message: "ok", verify: true }, { message: "ok", allowEmpty: true }, null, [],
  ];
  for (const args of invalid) {
    assert.equal((await core.callTool("git_commit", args)).isError, true, JSON.stringify(args));
  }
});

test("git_commit refuses an empty staged diff", async (t) => {
  const { core } = await gitFixture(t);
  const result = await core.callTool("git_commit", { message: "nothing staged" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /nothing staged|staged diff/i);
});

test("git_commit disables hooks and signing and never logs the commit message", async (t) => {
  const { workspace, logs, core } = await gitFixture(t);
  const hookCanary = path.join(workspace, "hook-canary");
  const signingCanary = path.join(workspace, "signing-canary");
  const hooks = path.join(workspace, ".git", "hooks");
  for (const name of ["pre-commit", "commit-msg"]) {
    const hook = path.join(hooks, name);
    await writeFile(hook, `#!/bin/sh\ntouch "${hookCanary}"\nexit 1\n`, "utf8");
    await chmod(hook, 0o755);
  }
  const signer = path.join(workspace, "failing-gpg.sh");
  await writeFile(signer, `#!/bin/sh\ntouch "${signingCanary}"\nexit 1\n`, "utf8");
  await chmod(signer, 0o755);
  await git(workspace, "config", "commit.gpgSign", "true");
  await git(workspace, "config", "gpg.program", signer);
  await writeFile(path.join(workspace, "tracked.txt"), "after\n", "utf8");
  await core.callTool("git_add", { paths: ["tracked.txt"] });

  const secretMessage = "message-must-not-appear-in-audit";
  const result = await core.callTool("git_commit", { message: secretMessage });
  assert.equal(result.isError, undefined);
  await assert.rejects(access(hookCanary));
  await assert.rejects(access(signingCanary));
  assert.doesNotMatch(logs.join("\n"), new RegExp(secretMessage));
});

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
  assert.doesNotMatch(payload.stdout, /OUTSIDE/);
  await assert.rejects(access(canary));
});

test("run_python_file cannot escape when a parent directory is replaced after validation", async (t) => {
  const { workspace, outside } = await fixture(t);
  const directory = path.join(workspace, "job");
  const savedDirectory = path.join(workspace, "job-saved");
  const outsideDirectory = path.join(outside, "job");
  const canary = path.join(outside, "outside-parent-ran");
  await mkdir(directory);
  await mkdir(outsideDirectory);
  await writeFile(path.join(directory, "task.py"), "print('SAFE')\n", "utf8");
  await writeFile(path.join(outsideDirectory, "task.py"), [
    "from pathlib import Path",
    `Path(${JSON.stringify(canary)}).write_text('outside ran')`,
    "print('OUTSIDE')",
    "",
  ].join("\n"), "utf8");
  let raceTriggered = false;
  const core = await createBridgeCore(workspace, () => {}, {
    beforePythonOpen: async () => {
      raceTriggered = true;
      await rename(directory, savedDirectory);
      await symlink(outsideDirectory, directory, "dir");
    },
  });

  const result = await core.callTool("run_python_file", { path: "job/task.py" });
  assert.equal(raceTriggered, true);
  if (!result.isError) {
    const payload = JSON.parse(resultText(result));
    assert.doesNotMatch(payload.stdout, /OUTSIDE/);
  }
  await assert.rejects(access(canary));
});

test("run_python_file rejects replacement of the authorized workspace root", async (t) => {
  const { workspace, outside } = await fixture(t);
  const savedWorkspace = `${workspace}-saved`;
  const canary = path.join(outside, "replacement-root-ran");
  await writeFile(path.join(workspace, "task.py"), "print('SAFE')\n", "utf8");
  const core = await createBridgeCore(workspace, () => {}, {
    beforePythonOpen: async () => {
      await rename(workspace, savedWorkspace);
      await mkdir(workspace);
      await writeFile(path.join(workspace, "task.py"), [
        "from pathlib import Path",
        `Path(${JSON.stringify(canary)}).write_text('replacement ran')`,
        "",
      ].join("\n"), "utf8");
    },
  });

  const result = await core.callTool("run_python_file", { path: "task.py" });
  assert.equal(result.isError, true);
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

test("run_python_file matches direct isolated-script __main__ loader and import semantics", async (t) => {
  const { workspace, core } = await fixture(t);
  await writeFile(path.join(workspace, "sibling.py"), "value = 'unexpected'\n", "utf8");
  const source = [
    "import json, sys",
    "shared_value = 'visible'",
    "import __main__",
    "try:",
    "    import sibling",
    "    sibling_imported = True",
    "except ModuleNotFoundError:",
    "    sibling_imported = False",
    "print(json.dumps({",
    "    'shared': __main__.shared_value,",
    "    'loader_type': f'{type(__loader__).__module__}.{type(__loader__).__qualname__}',",
    "    'loader_name': getattr(__loader__, 'name', None),",
    "    'loader_path': getattr(__loader__, 'path', None),",
    "    'package': __package__,",
    "    'spec': __spec__,",
    "    'cached': __cached__,",
    "    'file': __file__,",
    "    'argv0': sys.argv[0],",
    "    'sibling_imported': sibling_imported,",
    "}))",
    "",
  ].join("\n");
  const script = path.join(workspace, "task.py");
  await writeFile(script, source, "utf8");
  const canonicalScript = path.join(await realpath(workspace), "task.py");
  const direct = await execFileAsync("python3", ["-I", canonicalScript], { cwd: workspace });
  const result = await core.callTool("run_python_file", { path: "task.py" });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.exitCode, 0);
  const actual = JSON.parse(payload.stdout);
  assert.deepEqual(actual, JSON.parse(direct.stdout));
  assert.equal(actual.shared, "visible");
  assert.equal(actual.sibling_imported, false);
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
    { beforePythonOpen: true },
  ]) {
    await assert.rejects(createBridgeCore(workspace, () => {}, options));
  }
});
