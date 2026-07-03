import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  GIT_WRITE_TOOL_DEFINITIONS,
  handleGitWriteTool,
} from "../src/git-write-tools.js";
import { createWorkspaceContext } from "../src/workspace-context.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function repository(t, remote = "https://github.com/example/developer-bridge.git") {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-pr-")));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  await git(workspace, "init", "--quiet", "-b", "feat/test");
  await git(workspace, "config", "user.name", "Test User");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  await git(workspace, "remote", "add", "origin", remote);
  await git(workspace, "update-ref", "refs/remotes/origin/feat/test", "HEAD");
  await git(workspace, "config", "branch.feat/test.remote", "origin");
  await git(workspace, "config", "branch.feat/test.merge", "refs/heads/feat/test");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspace, context: await createWorkspaceContext(workspace) };
}

test("exposes one strict Draft PR creation tool", () => {
  const tool = GIT_WRITE_TOOL_DEFINITIONS.find(({ name }) => name === "github_pr_create_draft");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema, {
    type: "object",
    additionalProperties: false,
    properties: {},
  });
});

test("creates a Draft PR only from the clean pushed current branch", async (t) => {
  const { workspace, context } = await repository(t);
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, envOverrides: options.envOverrides });
    if (args[0] === "auth") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    return {
      exitCode: 0,
      signal: null,
      stdout: "https://github.com/example/developer-bridge/pull/42\n",
      stderr: "",
    };
  };

  const result = await handleGitWriteTool(
    "github_pr_create_draft",
    {},
    context.snapshot(),
    { runCommand },
  );
  assert.deepEqual(JSON.parse(result.text), {
    draft: true,
    branch: "feat/test",
    url: "https://github.com/example/developer-bridge/pull/42",
  });
  assert.deepEqual(calls.map(({ command, args, cwd }) => ({ command, args, cwd })), [
    {
      command: "gh",
      args: ["auth", "status", "--hostname", "github.com"],
      cwd: workspace,
    },
    {
      command: "gh",
      args: ["pr", "create", "--draft", "--fill"],
      cwd: workspace,
    },
  ]);
  for (const call of calls) {
    assert.equal(call.envOverrides.GH_PROMPT_DISABLED, "1");
    assert.equal(call.envOverrides.GIT_TERMINAL_PROMPT, "0");
  }
});

test("rejects unexpected arguments, dirty state, unpushed commits, and non-GitHub origins", async (t) => {
  const fixture = await repository(t);
  const neverRun = async () => assert.fail("gh must not run");

  await assert.rejects(
    handleGitWriteTool("github_pr_create_draft", { base: "main" }, fixture.context.snapshot(), { runCommand: neverRun }),
    /Unexpected argument/i,
  );

  await writeFile(path.join(fixture.workspace, "dirty.txt"), "dirty\n", "utf8");
  await assert.rejects(
    handleGitWriteTool("github_pr_create_draft", {}, fixture.context.snapshot(), { runCommand: neverRun }),
    /clean/i,
  );
  await rm(path.join(fixture.workspace, "dirty.txt"));

  await writeFile(path.join(fixture.workspace, "README.md"), "unpushed\n", "utf8");
  await git(fixture.workspace, "add", "README.md");
  await git(fixture.workspace, "commit", "--quiet", "-m", "unpushed");
  await assert.rejects(
    handleGitWriteTool("github_pr_create_draft", {}, fixture.context.snapshot(), { runCommand: neverRun }),
    /pushed/i,
  );

  const nonGitHub = await repository(t, "https://example.invalid/example/repo.git");
  await assert.rejects(
    handleGitWriteTool("github_pr_create_draft", {}, nonGitHub.context.snapshot(), { runCommand: neverRun }),
    /GitHub origin/i,
  );
});

test("first push establishes the same-branch origin upstream required by Draft PR creation", async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-push-")));
  const workspace = path.join(base, "workspace");
  const remote = path.join(base, "remote.git");
  await mkdir(workspace);
  await mkdir(remote);
  t.after(() => rm(base, { recursive: true, force: true }));

  await git(remote, "init", "--quiet", "--bare");
  await git(workspace, "init", "--quiet", "-b", "feat/new");
  await git(workspace, "config", "user.name", "Test User");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  await git(workspace, "remote", "add", "origin", remote);

  const context = await createWorkspaceContext(workspace);
  await handleGitWriteTool("git_push_current_branch", {}, context.snapshot());

  const upstream = await git(
    workspace,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  );
  assert.equal(upstream.stdout.trim(), "origin/feat/new");
});
