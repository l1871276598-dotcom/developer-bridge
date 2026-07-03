import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  GITHUB_PR_MERGE_TOOL_DEFINITIONS,
  handleGitHubPrMergeTool,
} from "../src/github-pr-merge-tool.js";

const execFileAsync = promisify(execFile);
const git = (cwd, ...args) => execFileAsync("git", args, { cwd });

async function repository(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-pr-merge-")));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  await git(workspace, "init", "--quiet", "-b", "feat/test");
  await git(workspace, "config", "user.name", "Test User");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  await git(workspace, "remote", "add", "origin", "https://github.com/example/developer-bridge.git");
  const headOid = (await git(workspace, "rev-parse", "HEAD")).stdout.trim();
  await git(workspace, "update-ref", "refs/remotes/origin/feat/test", headOid);
  await git(workspace, "config", "branch.feat/test.remote", "origin");
  await git(workspace, "config", "branch.feat/test.merge", "refs/heads/feat/test");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspace, headOid };
}

function pullRequest(headRefOid, overrides = {}) {
  return {
    number: 42,
    isDraft: false,
    mergeStateStatus: "CLEAN",
    state: "OPEN",
    headRefName: "feat/test",
    headRefOid,
    baseRefName: "main",
    url: "https://github.com/example/developer-bridge/pull/42",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "test",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ],
    ...overrides,
  };
}

function fakeCommands(responses) {
  const calls = [];
  let viewIndex = 0;
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (args[0] === "auth") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    if (args[0] === "pr" && args[1] === "view") {
      const response = responses[Math.min(viewIndex, responses.length - 1)];
      viewIndex += 1;
      return { exitCode: 0, signal: null, stdout: `${JSON.stringify(response)}\n`, stderr: "" };
    }
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  };
  return { calls, runCommand };
}

test("exposes one strict merge-if-green tool", () => {
  assert.deepEqual(GITHUB_PR_MERGE_TOOL_DEFINITIONS, [
    {
      name: "github_pr_merge_squash_if_green",
      description: "Squash-merge the current branch pull request only after every reported CI check succeeds.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ]);
});

test("squash-merges a clean fully pushed current-branch PR only after green checks", async (t) => {
  const { workspace, headOid } = await repository(t);
  const pr = pullRequest(headOid);
  const commands = fakeCommands([pr, { ...pr, state: "MERGED" }]);

  const result = await handleGitHubPrMergeTool(
    "github_pr_merge_squash_if_green",
    {},
    workspace,
    { runCommand: commands.runCommand },
  );

  assert.deepEqual(JSON.parse(result.text), {
    merged: true,
    number: 42,
    checks: 1,
    url: pr.url,
  });
  assert.deepEqual(commands.calls.map(({ args }) => args), [
    ["auth", "status", "--hostname", "github.com"],
    ["pr", "view", "--json", "number,isDraft,mergeStateStatus,state,headRefName,headRefOid,baseRefName,url,statusCheckRollup"],
    ["pr", "merge", "42", "--squash", "--match-head-commit", headOid],
    ["pr", "view", "42", "--json", "number,state,url"],
  ]);
});

test("marks a green Draft PR ready, rechecks it, then merges", async (t) => {
  const { workspace, headOid } = await repository(t);
  const draft = pullRequest(headOid, { isDraft: true });
  const ready = pullRequest(headOid, { isDraft: false });
  const commands = fakeCommands([draft, ready, { ...ready, state: "MERGED" }]);

  const result = await handleGitHubPrMergeTool(
    "github_pr_merge_squash_if_green",
    {},
    workspace,
    { runCommand: commands.runCommand },
  );

  assert.equal(JSON.parse(result.text).merged, true);
  assert.deepEqual(commands.calls.map(({ args }) => args), [
    ["auth", "status", "--hostname", "github.com"],
    ["pr", "view", "--json", "number,isDraft,mergeStateStatus,state,headRefName,headRefOid,baseRefName,url,statusCheckRollup"],
    ["pr", "ready", "42"],
    ["pr", "view", "--json", "number,isDraft,mergeStateStatus,state,headRefName,headRefOid,baseRefName,url,statusCheckRollup"],
    ["pr", "merge", "42", "--squash", "--match-head-commit", headOid],
    ["pr", "view", "42", "--json", "number,state,url"],
  ]);
});

for (const [name, override, reason] of [
  ["no CI checks", { statusCheckRollup: [] }, "no_checks"],
  ["pending CI", { statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" }] }, "checks_not_green"],
  ["failed CI", { statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }] }, "checks_not_green"],
  ["blocked merge state", { mergeStateStatus: "BLOCKED" }, "merge_state_not_clean"],
  ["wrong head branch", { headRefName: "feat/other" }, "wrong_head_branch"],
  ["closed PR", { state: "CLOSED" }, "pr_not_open"],
  ["different remote PR head", { headRefOid: "0123456789abcdef0123456789abcdef01234567" }, "head_not_pushed"],
]) {
  test(`does not mutate GitHub for ${name}`, async (t) => {
    const { workspace, headOid } = await repository(t);
    const commands = fakeCommands([pullRequest(headOid, override)]);

    const result = await handleGitHubPrMergeTool(
      "github_pr_merge_squash_if_green",
      {},
      workspace,
      { runCommand: commands.runCommand },
    );

    const payload = JSON.parse(result.text);
    assert.equal(payload.merged, false);
    assert.equal(payload.reason, reason);
    assert.equal(commands.calls.filter(({ args }) => ["ready", "merge"].includes(args[1])).length, 0);
  });
}

test("does not contact GitHub when the local branch is dirty or not fully pushed", async (t) => {
  const dirty = await repository(t);
  await writeFile(path.join(dirty.workspace, "dirty.txt"), "dirty\n", "utf8");
  const dirtyCommands = fakeCommands([]);
  const dirtyResult = await handleGitHubPrMergeTool(
    "github_pr_merge_squash_if_green",
    {},
    dirty.workspace,
    { runCommand: dirtyCommands.runCommand },
  );
  assert.equal(JSON.parse(dirtyResult.text).reason, "workspace_not_clean");
  assert.equal(dirtyCommands.calls.length, 0);

  const unpushed = await repository(t);
  await writeFile(path.join(unpushed.workspace, "README.md"), "unpushed\n", "utf8");
  await git(unpushed.workspace, "add", "README.md");
  await git(unpushed.workspace, "commit", "--quiet", "-m", "unpushed");
  const unpushedCommands = fakeCommands([]);
  const unpushedResult = await handleGitHubPrMergeTool(
    "github_pr_merge_squash_if_green",
    {},
    unpushed.workspace,
    { runCommand: unpushedCommands.runCommand },
  );
  assert.equal(JSON.parse(unpushedResult.text).reason, "head_not_pushed");
  assert.equal(unpushedCommands.calls.length, 0);
});
