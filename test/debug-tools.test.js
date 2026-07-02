import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeCore } from "../src/bridge-core.js";
import { runBoundedProcess } from "../src/bounded-process.js";

const execFileAsync = promisify(execFile);

test("runBoundedProcess returns structured output for a failing command", async () => {
  const result = await runBoundedProcess(process.execPath, [
    "-e",
    "console.log('OUT'); console.error('ERR'); process.exitCode=7",
  ], { timeoutMs: 2_000 });

  assert.deepEqual(Object.keys(result).sort(), [
    "exitCode",
    "outputLimitExceeded",
    "signal",
    "stderr",
    "stdout",
    "timedOut",
  ]);
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "OUT\n");
  assert.equal(result.stderr, "ERR\n");
  assert.equal(result.timedOut, false);
  assert.equal(result.outputLimitExceeded, false);
});

function resultText(result) {
  return result.content[0].text;
}

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t, { initializeGit = true, packageTest = "node --test target.test.js", coreOptions } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-debug-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: packageTest },
  }), "utf8");
  if (initializeGit) {
    await git(workspace, "init", "--quiet");
    await git(workspace, "config", "user.email", "test@example.invalid");
    await git(workspace, "config", "user.name", "Developer Bridge Test");
    await git(workspace, "add", "package.json");
    await git(workspace, "commit", "--quiet", "-m", "fixture");
  }
  const core = await createBridgeCore(workspace, () => {}, coreOptions);
  return { workspace, core };
}

test("exposes exactly ten tools with strict schemas and expected annotations", async (t) => {
  const { core } = await fixture(t);
  assert.deepEqual(core.tools.map(({ name }) => name), [
    "list_files", "read_file", "write_file", "git_status", "git_diff", "run_tests", "run_python_file", "git_add", "git_commit", "git_push",
  ]);
  for (const tool of core.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(core.tools.find(({ name }) => name === "git_status").annotations.readOnlyHint, true);
  assert.equal(core.tools.find(({ name }) => name === "git_diff").annotations.readOnlyHint, true);
  assert.notEqual(core.tools.find(({ name }) => name === "run_tests").annotations?.readOnlyHint, true);
  assert.deepEqual(core.tools.find(({ name }) => name === "run_python_file").annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
});

test("git_status reports clean and modified repositories without accepting arguments", async (t) => {
  const { workspace, core } = await fixture(t);
  assert.match(resultText(await core.callTool("git_status", {})), /clean/i);
  await writeFile(path.join(workspace, "changed.txt"), "changed\n", "utf8");
  assert.match(resultText(await core.callTool("git_status", {})), /\?\? changed\.txt/);
  for (const args of [{ args: ["--ignored"] }, { path: "." }, { surprise: true }]) {
    assert.equal((await core.callTool("git_status", args)).isError, true);
  }
});

test("git_status never executes a repository-configured fsmonitor command", async (t) => {
  const { workspace, core } = await fixture(t);
  const canary = path.join(workspace, "fsmonitor-canary");
  const hook = path.join(workspace, "fsmonitor-hook.sh");
  await writeFile(hook, `#!/bin/sh\ntouch "${canary}"\nprintf '\\n'\n`, "utf8");
  await chmod(hook, 0o755);
  await git(workspace, "config", "core.fsmonitor", hook);

  await core.callTool("git_status", {});
  await assert.rejects(access(canary));
});

test("git_status and git_diff return clear errors outside a Git repository", async (t) => {
  const { core } = await fixture(t, { initializeGit: false });
  for (const name of ["git_status", "git_diff"]) {
    const result = await core.callTool(name, {});
    assert.equal(result.isError, true);
    assert.match(resultText(result), /not a Git repository/i);
  }
});

test("git_status rejects output over its fixed limit", async (t) => {
  const { workspace, core } = await fixture(t);
  for (let batch = 0; batch < 50; batch += 1) {
    await Promise.all(Array.from({ length: 100 }, async (_, offset) => {
      const index = batch * 100 + offset;
      const name = `${String(index).padStart(5, "0")}-${"x".repeat(215)}.txt`;
      await writeFile(path.join(workspace, name), "", "utf8");
    }));
  }
  const result = await core.callTool("git_status", {});
  assert.equal(result.isError, true);
  assert.match(resultText(result), /output size limit/i);
  assert.ok(Buffer.byteLength(resultText(result), "utf8") < 1024);
});

test("git_diff distinguishes working-tree and staged changes and rejects arbitrary parameters", async (t) => {
  const { workspace, core } = await fixture(t);
  await writeFile(path.join(workspace, "tracked.txt"), "before\n", "utf8");
  await git(workspace, "add", "tracked.txt");
  await git(workspace, "commit", "--quiet", "-m", "tracked");
  await writeFile(path.join(workspace, "tracked.txt"), "after\n", "utf8");

  const unstaged = resultText(await core.callTool("git_diff", {}));
  assert.match(unstaged, /-before/);
  assert.match(unstaged, /\+after/);
  assert.match(resultText(await core.callTool("git_diff", { staged: true })), /no diff/i);

  await git(workspace, "add", "tracked.txt");
  assert.match(resultText(await core.callTool("git_diff", {})), /no diff/i);
  assert.match(resultText(await core.callTool("git_diff", { staged: true })), /\+after/);

  for (const args of [
    { staged: "true" }, { staged: 1 }, { staged: false, args: ["--stat"] },
    { command: "reset --hard" }, { path: "package.json" },
  ]) {
    assert.equal((await core.callTool("git_diff", args)).isError, true);
  }
});

test("git_diff never executes a repository-configured textconv command", async (t) => {
  const { workspace, core } = await fixture(t);
  const canary = path.join(workspace, "textconv-canary");
  const converter = path.join(workspace, "textconv.mjs");
  await writeFile(converter, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(canary)}, "executed");`,
    "process.stdout.write(readFileSync(process.argv[2]));",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(workspace, ".gitattributes"), "tracked.txt diff=canary\n", "utf8");
  await writeFile(path.join(workspace, "tracked.txt"), "before\n", "utf8");
  await git(workspace, "config", "diff.canary.textconv", `${process.execPath} ${converter}`);
  await git(workspace, "add", ".gitattributes", "tracked.txt", "textconv.mjs");
  await git(workspace, "commit", "--quiet", "-m", "textconv fixture");
  await writeFile(path.join(workspace, "tracked.txt"), "after\n", "utf8");

  await core.callTool("git_diff", {});
  await assert.rejects(access(canary));
});

test("git_diff rejects output over its fixed limit with narrowing guidance", async (t) => {
  const { workspace, core } = await fixture(t);
  await writeFile(path.join(workspace, "large.txt"), "", "utf8");
  await git(workspace, "add", "large.txt");
  await git(workspace, "commit", "--quiet", "-m", "large fixture");
  await writeFile(path.join(workspace, "large.txt"), `${"x".repeat(1024 * 1024 + 1)}\n`, "utf8");
  const result = await core.callTool("git_diff", {});
  assert.equal(result.isError, true);
  assert.match(resultText(result), /output size limit/i);
  assert.match(resultText(result), /narrow/i);
  assert.ok(Buffer.byteLength(resultText(result), "utf8") < 1024);
});

test("run_tests runs only the fixed default npm test mapping and returns structured results", async (t) => {
  const { workspace, core } = await fixture(t, { coreOptions: { testTimeoutMs: 2_000 } });
  await writeFile(path.join(workspace, "target.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("passes", () => assert.equal(2 + 2, 4));',
    "",
  ].join("\n"), "utf8");
  const result = await core.callTool("run_tests", { test: "default" });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.timedOut, false);
  assert.equal(payload.outputLimitExceeded, false);
  assert.match(`${payload.stdout}\n${payload.stderr}`, /pass 1/);
  assert.equal(typeof payload.stderr, "string");

  for (const args of [
    {}, { test: "npm install" }, { test: "default", args: ["--watch"] },
    { test: "default; rm -rf ." }, { command: "curl example.com" },
  ]) {
    assert.equal((await core.callTool("run_tests", args)).isError, true);
  }
});

test("run_tests fixes cwd and preserves a failing exit code, stdout, and stderr", async (t) => {
  const { workspace, core } = await fixture(t, {
    packageTest: "node failing.mjs",
    coreOptions: { testTimeoutMs: 2_000 },
  });
  await writeFile(path.join(workspace, "failing.mjs"), [
    'console.log(`cwd=${process.cwd()}`);',
    'console.error("EXPECTED_STDERR");',
    "process.exitCode = 7;",
    "",
  ].join("\n"), "utf8");
  const result = await core.callTool("run_tests", { test: "default" });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.exitCode, 7);
  const canonicalWorkspace = await realpath(workspace);
  assert.match(payload.stdout, new RegExp(`cwd=${canonicalWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(payload.stderr, /EXPECTED_STDERR/);
});

for (const stream of ["stdout", "stderr"]) {
  test(`run_tests bounds ${stream} at 1 MiB`, async (t) => {
    const { workspace, core } = await fixture(t, {
      packageTest: "node noisy.mjs",
      coreOptions: { testTimeoutMs: 5_000, terminationGraceMs: 100 },
    });
    const target = stream === "stdout" ? "stdout" : "stderr";
    await writeFile(path.join(workspace, "noisy.mjs"), [
      `const chunk = Buffer.alloc(64 * 1024, ${stream === "stdout" ? "65" : "255"});`,
      `for (let i = 0; i < 20; i += 1) process.${target}.write(chunk);`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"), "utf8");
    const payload = JSON.parse(resultText(await core.callTool("run_tests", { test: "default" })));
    assert.equal(payload.outputLimitExceeded, true);
    assert.ok(Buffer.byteLength(payload[stream], "utf8") <= 1024 * 1024);
  });
}

test("run_tests times out and terminates the npm process group including its grandchild", async (t) => {
  const { workspace, core } = await fixture(t, {
    packageTest: "node parent.mjs",
    coreOptions: { testTimeoutMs: 500, terminationGraceMs: 100 },
  });
  await writeFile(path.join(workspace, "child.mjs"), [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("child.pid", String(process.pid));',
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(workspace, "parent.mjs"), [
    'import { spawn } from "node:child_process";',
    'spawn(process.execPath, ["child.mjs"], { stdio: "ignore" });',
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"), "utf8");

  const started = Date.now();
  const payload = JSON.parse(resultText(await core.callTool("run_tests", { test: "default" })));
  assert.equal(payload.timedOut, true);
  assert.ok(Date.now() - started < 3_000);
  const childPid = Number(await readFile(path.join(workspace, "child.pid"), "utf8"));
  const deadline = Date.now() + 2_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if (error?.code === "ESRCH") alive = false;
      else throw error;
    }
  }
  assert.equal(alive, false, `grandchild ${childPid} survived timeout`);
});

test("run_tests retains ownership of its process group throughout the termination grace period", async (t) => {
  const { workspace, core } = await fixture(t, {
    packageTest: "node owner.mjs",
    coreOptions: { testTimeoutMs: 300, terminationGraceMs: 700 },
  });
  await writeFile(path.join(workspace, "owner.mjs"), [
    'import { execFileSync } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim();',
    'writeFileSync("group.id", pgid);',
    'process.on("SIGTERM", () => process.exit(0));',
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"), "utf8");

  const running = core.callTool("run_tests", { test: "default" });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path.join(workspace, "group.id"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const pgid = Number(await readFile(path.join(workspace, "group.id"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.doesNotThrow(() => process.kill(-pgid, 0));
  const payload = JSON.parse(resultText(await running));
  assert.equal(payload.timedOut, true);
});

test("completes the read-write-status-diff-fail-fix-pass loop without Git mutations", async (t) => {
  const { workspace, core } = await fixture(t, { coreOptions: { testTimeoutMs: 5_000 } });
  await writeFile(path.join(workspace, "value.js"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(workspace, "target.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { value } from "./value.js";',
    'test("value is two", () => assert.equal(value, 2));',
    "",
  ].join("\n"), "utf8");
  await git(workspace, "add", "value.js", "target.test.js");
  await git(workspace, "commit", "--quiet", "-m", "loop fixture");
  const beforeHead = (await git(workspace, "rev-parse", "HEAD")).stdout.trim();

  assert.equal(resultText(await core.callTool("read_file", { path: "value.js" })), "export const value = 1;\n");
  assert.equal((await core.callTool("write_file", { path: "value.js", content: "export const value = 3;\n" })).isError, undefined);
  assert.match(resultText(await core.callTool("git_status", {})), / M value\.js/);
  assert.match(resultText(await core.callTool("git_diff", {})), /\+export const value = 3/);

  const failed = JSON.parse(resultText(await core.callTool("run_tests", { test: "default" })));
  assert.notEqual(failed.exitCode, 0);
  assert.match(`${failed.stdout}\n${failed.stderr}`, /3 !== 2/);

  await core.callTool("write_file", { path: "value.js", content: "export const value = 2;\n" });
  const passed = JSON.parse(resultText(await core.callTool("run_tests", { test: "default" })));
  assert.equal(passed.exitCode, 0);
  assert.equal((await git(workspace, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.match(resultText(await core.callTool("git_status", {})), / M value\.js/);
  await assert.rejects(readFile(path.join(workspace, ".git", "refs", "remotes", "origin", "main")));
});
