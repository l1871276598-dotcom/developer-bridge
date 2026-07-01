import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeCore } from "../src/bridge-core.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function repository(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-p2-audit-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await git(workspace, "init", "--quiet");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "config", "user.name", "Developer Bridge Audit");
  await writeFile(path.join(workspace, "tracked.txt"), "before\n", "utf8");
  await git(workspace, "add", "tracked.txt");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  return workspace;
}

function resultText(result) {
  return result.content[0].text;
}

test("git_status ignores malicious global and system fsmonitor configuration", async (t) => {
  const workspace = await repository(t);
  const canary = path.join(workspace, "fsmonitor-environment-canary");
  const hook = path.join(workspace, "fsmonitor-environment-hook.sh");
  const globalConfig = path.join(workspace, "malicious-global.gitconfig");
  const systemConfig = path.join(workspace, "malicious-system.gitconfig");

  await writeFile(hook, `#!/bin/sh\ntouch "${canary}"\nprintf '\\n'\n`, "utf8");
  await chmod(hook, 0o755);
  await git(workspace, "config", "--file", globalConfig, "core.fsmonitor", hook);
  await git(workspace, "config", "--file", systemConfig, "core.fsmonitor", hook);

  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  t.after(() => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = previousSystem;
  });

  const core = await createBridgeCore(workspace, () => {});
  const result = await core.callTool("git_status", {});
  assert.equal(result.isError, undefined);
  await assert.rejects(access(canary));
});

test("git_diff blocks repository textconv for both unstaged and staged diffs", async (t) => {
  const workspace = await repository(t);
  const canary = path.join(workspace, "textconv-staged-canary");
  const converter = path.join(workspace, "textconv-staged.mjs");

  await writeFile(converter, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(canary)}, "executed");`,
    "process.stdout.write(readFileSync(process.argv[2]));",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(workspace, ".gitattributes"), "tracked.txt diff=canary\n", "utf8");
  await git(workspace, "config", "diff.canary.textconv", `${process.execPath} ${converter}`);
  await git(workspace, "add", ".gitattributes", "textconv-staged.mjs");
  await git(workspace, "commit", "--quiet", "-m", "textconv fixture");

  const core = await createBridgeCore(workspace, () => {});
  await writeFile(path.join(workspace, "tracked.txt"), "after\n", "utf8");

  const unstaged = await core.callTool("git_diff", {});
  assert.equal(unstaged.isError, undefined);
  assert.match(resultText(unstaged), /-before/);
  assert.match(resultText(unstaged), /\+after/);
  await assert.rejects(access(canary));

  await git(workspace, "add", "tracked.txt");
  const staged = await core.callTool("git_diff", { staged: true });
  assert.equal(staged.isError, undefined);
  assert.match(resultText(staged), /-before/);
  assert.match(resultText(staged), /\+after/);
  await assert.rejects(access(canary));
});
