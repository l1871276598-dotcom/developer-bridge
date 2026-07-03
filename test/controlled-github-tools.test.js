import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { handleControlledEngineeringTool } from "../src/controlled-engineering-tools.js";

const execFileAsync = promisify(execFile);
const permissionEnv = { DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1" };

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-github-"));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  await git(workspace, "init", "--quiet", "-b", "feat/test");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "config", "user.name", "Developer Bridge Test");
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  const head = (await git(workspace, "rev-parse", "HEAD")).stdout.trim();
  await git(workspace, "remote", "add", "origin", "https://github.com/example/developer-bridge.git");
  await git(workspace, "update-ref", "refs/remotes/origin/feat/test", head);
  await git(workspace, "config", "branch.feat/test.remote", "origin");
  await git(workspace, "config", "branch.feat/test.merge", "refs/heads/feat/test");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspace, head };
}

function fakeGithub(head) {
  const calls = [];
  let ready = false;
  const pr = () => ({
    number: 7,
    state: "OPEN",
    isDraft: !ready,
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefName: "feat/test",
    headRefOid: head,
    baseRefName: "main",
    title: "Feature",
    body: "Body",
    url: "https://github.com/example/developer-bridge/pull/7",
    statusCheckRollup: [{
      __typename: "CheckRun",
      name: "test",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    }],
  });

  const runCommand = async (command, args, commandOptions) => {
    calls.push({ command, args, input: commandOptions.input });
    if (command !== "gh") throw new Error("unexpected command");
    if (args[0] === "auth") return success();
    if (args[0] === "pr" && args[1] === "view") return success(pr());
    if (args[0] === "pr" && args[1] === "ready") {
      ready = true;
      return success();
    }
    if (args[0] === "workflow" && args[1] === "run") return success();
    if (args[0] === "run" && args[1] === "view") {
      return successText("token=ghp_abcdefghijklmnopqrstuvwxyz1234567890\n");
    }
    if (args[0] !== "api") throw new Error(`unexpected gh arguments: ${args.join(" ")}`);
    if (args.includes("graphql")) {
      return success({ data: { repository: { pullRequest: {
        reviewDecision: "APPROVED",
        reviews: { nodes: [{ author: { login: "reviewer" }, state: "APPROVED" }] },
        reviewThreads: { nodes: [{ id: "thread", isResolved: true, comments: { nodes: [] } }] },
      } } } });
    }
    const endpoint = args.find((value) => typeof value === "string" && value.startsWith("repos/"));
    if (args.includes("PATCH") && endpoint?.endsWith("/pulls/7")) {
      return success({ number: 7, title: "Updated", body: "Body", html_url: pr().url });
    }
    if (endpoint?.endsWith("/actions/workflows?per_page=100")) {
      return success({ workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active", html_url: "workflow-url" }] });
    }
    if (endpoint?.includes("/actions/runs?")) {
      return success({ workflow_runs: [{ id: 99, name: "CI", event: "pull_request", status: "completed", conclusion: "success", head_branch: "feat/test", head_sha: head, html_url: "run-url", run_attempt: 1 }] });
    }
    if (endpoint?.endsWith("/actions/runs/99/jobs?per_page=100")) {
      return success({ jobs: [{ id: 101, name: "test", status: "completed", conclusion: "success", steps: [] }] });
    }
    if (endpoint?.endsWith("/actions/runs/99")) return success({ id: 99, head_branch: "feat/test" });
    if (endpoint?.endsWith("/rerun-failed-jobs")) return success();
    if (endpoint?.endsWith("/branches/main/protection")) {
      return success({ required_status_checks: { contexts: ["test"] } });
    }
    if (endpoint?.includes("/contents/.github/workflows/ci.yml")) {
      if (args.includes("PUT")) {
        return success({ commit: { sha: "a".repeat(40) }, content: { sha: "b".repeat(40) } });
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "404 Not Found" };
    }
    throw new Error(`unexpected API endpoint: ${endpoint ?? args.join(" ")}`);
  };

  return { calls, runCommand };
}

function success(value = null) {
  return successText(value === null ? "" : JSON.stringify(value));
}

function successText(stdout) {
  return { exitCode: 0, signal: null, stdout, stderr: "" };
}

async function call(name, args, workspace, runCommand) {
  const result = await handleControlledEngineeringTool(name, args, workspace, {
    env: permissionEnv,
    runCommand,
  });
  return result.text;
}

test("uses fixed GitHub commands and expected-head gates for PR and CI operations", async (t) => {
  const { workspace, head } = await fixture(t);
  const github = fakeGithub(head);

  assert.equal(JSON.parse(await call("github_pr_get", { number: 7 }, workspace, github.runCommand)).headRefOid, head);
  assert.equal(JSON.parse(await call("github_pr_mark_ready", {
    number: 7, expected_head_sha: head,
  }, workspace, github.runCommand)).ready, true);
  assert.equal(JSON.parse(await call("github_pr_update", {
    number: 7, expected_head_sha: head, title: "Updated",
  }, workspace, github.runCommand)).title, "Updated");
  assert.equal(JSON.parse(await call("github_pr_reviews", { number: 7 }, workspace, github.runCommand)).reviewDecision, "APPROVED");
  assert.equal(JSON.parse(await call("github_pr_checks", { number: 7 }, workspace, github.runCommand)).all_green, true);
  assert.equal(JSON.parse(await call("github_actions_list_workflows", {}, workspace, github.runCommand)).workflows.length, 1);
  assert.equal(JSON.parse(await call("github_actions_list_runs", {
    branch: "feat/test", limit: 10,
  }, workspace, github.runCommand)).runs[0].id, 99);
  assert.equal(JSON.parse(await call("github_actions_get_jobs", { run_id: 99 }, workspace, github.runCommand)).jobs[0].id, 101);
  assert.doesNotMatch(await call("github_actions_get_logs", { job_id: 101 }, workspace, github.runCommand), /ghp_/u);
  assert.equal(JSON.parse(await call("github_actions_dispatch", {
    workflow: "ci.yml",
  }, workspace, github.runCommand)).dispatched, true);
  assert.equal(JSON.parse(await call("github_actions_rerun_failed", {
    run_id: 99,
  }, workspace, github.runCommand)).rerun_requested, true);
  assert.equal(JSON.parse(await call("github_branch_protection_get", {
    branch: "main",
  }, workspace, github.runCommand)).protected, true);

  await assert.rejects(call("github_pr_mark_ready", {
    number: 7, expected_head_sha: "0".repeat(40),
  }, workspace, github.runCommand), /head changed/i);

  assert.ok(github.calls.some(({ args }) => args.slice(0, 3).join(" ") === "pr ready 7"));
  assert.ok(github.calls.some(({ args }) => args.slice(0, 3).join(" ") === "workflow run ci.yml"));
  assert.ok(github.calls.some(({ args }) => args.some((value) => String(value).endsWith("/rerun-failed-jobs"))));
});

test("writes only a validated workflow to the clean fully pushed current branch", async (t) => {
  const { workspace, head } = await fixture(t);
  const github = fakeGithub(head);
  const workflow = [
    "name: CI",
    "on: pull_request",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm test",
    "",
  ].join("\n");

  const written = JSON.parse(await call("github_contents_write_workflow", {
    path: ".github/workflows/ci.yml",
    content: workflow,
    message: "ci: add workflow",
    expected_head_sha: head,
  }, workspace, github.runCommand));
  assert.equal(written.written, true);
  assert.equal(written.branch, "feat/test");
  assert.equal(written.local_requires_fetch, true);

  const request = github.calls.find(({ args }) =>
    args.includes("PUT") && args.some((value) => String(value).includes("/contents/"))
  );
  assert.ok(request);
  const payload = JSON.parse(request.input);
  assert.equal(payload.branch, "feat/test");
  assert.equal(Buffer.from(payload.content, "base64").toString("utf8"), workflow);

  await writeFile(path.join(workspace, "dirty.txt"), "dirty\n", "utf8");
  await assert.rejects(call("github_contents_write_workflow", {
    path: ".github/workflows/ci.yml",
    content: workflow,
    message: "ci: update workflow",
    expected_head_sha: head,
  }, workspace, github.runCommand), /clean/i);
});
