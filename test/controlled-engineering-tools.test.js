import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CONTROLLED_ENGINEERING_TOOL_DEFINITIONS,
  REQUIRED_TOOL_NAMES,
  handleControlledEngineeringTool,
  validateRequiredToolContract,
} from "../src/controlled-engineering-tools.js";

const execFileAsync = promisify(execFile);
const options = { env: { DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1" } };
const missingToolNames = [
  "create_directory", "path_stat", "search_text", "find_files", "move_path",
  "delete_file", "delete_empty_directory", "git_context", "git_log", "git_show",
  "git_diff_refs", "git_fetch_ref", "git_upstream_status", "install_dependencies",
  "run_package_script", "run_project_validation", "validate_github_workflow",
  "github_pr_get", "github_pr_mark_ready", "github_pr_update", "github_pr_reviews",
  "github_pr_checks", "github_actions_list_workflows", "github_actions_list_runs",
  "github_actions_get_jobs", "github_actions_get_logs", "github_actions_dispatch",
  "github_actions_rerun_failed", "github_branch_protection_get",
  "github_contents_write_workflow",
];

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-controlled-"));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await git(workspace, "init", "--quiet", "-b", "feat/test");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "config", "user.name", "Developer Bridge Test");
  await writeFile(path.join(workspace, "README.md"), "needle one\nsecond line\n", "utf8");
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "fixture", version: "1.0.0", type: "module",
    scripts: { test: "node --test sample.test.js", lint: "node -e \"process.exit(0)\"" },
  }), "utf8");
  await writeFile(path.join(workspace, "package-lock.json"), JSON.stringify({
    name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "fixture", version: "1.0.0" } },
  }), "utf8");
  await writeFile(path.join(workspace, "sample.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("passes", () => assert.equal(2 + 2, 4));',
    "",
  ].join("\n"), "utf8");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  const head = (await git(workspace, "rev-parse", "HEAD")).stdout.trim();
  await git(workspace, "remote", "add", "origin", "https://github.com/example/developer-bridge.git");
  await git(workspace, "update-ref", "refs/remotes/origin/feat/test", head);
  await git(workspace, "config", "branch.feat/test.remote", "origin");
  await git(workspace, "config", "branch.feat/test.merge", "refs/heads/feat/test");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspace, outside, head };
}

async function call(name, args, workspace, extra = {}) {
  const result = await handleControlledEngineeringTool(name, args, workspace, { ...options, ...extra });
  return result.text;
}

test("defines thirty missing tools and enforces the fifty-one-tool contract", () => {
  assert.deepEqual(CONTROLLED_ENGINEERING_TOOL_DEFINITIONS.map(({ name }) => name), missingToolNames);
  assert.equal(REQUIRED_TOOL_NAMES.length, 51);
  assert.equal(new Set(REQUIRED_TOOL_NAMES).size, 51);
  for (const definition of CONTROLLED_ENGINEERING_TOOL_DEFINITIONS) {
    assert.equal(definition.inputSchema.type, "object");
    assert.equal(definition.inputSchema.additionalProperties, false);
  }
  const env = {
    DEVELOPER_BRIDGE_REQUIRED_TOOLS: REQUIRED_TOOL_NAMES.join(","),
    DEVELOPER_BRIDGE_FAIL_IF_REQUIRED_TOOL_MISSING: "1",
  };
  assert.deepEqual(validateRequiredToolContract(REQUIRED_TOOL_NAMES, env), REQUIRED_TOOL_NAMES);
  assert.throws(() => validateRequiredToolContract(REQUIRED_TOOL_NAMES.slice(1), env), /missing required tools/i);
});

test("requires the explicit capability profile", async (t) => {
  const { workspace } = await fixture(t);
  await assert.rejects(
    handleControlledEngineeringTool("path_stat", { path: "README.md" }, workspace, { env: {} }),
    /capability profile/i,
  );
});

test("performs safe workspace file operations and rejects symlink escape", async (t) => {
  const { workspace, outside } = await fixture(t);
  assert.deepEqual(JSON.parse(await call("create_directory", {
    path: ".github/workflows", recursive: true,
  }, workspace)), { created: true, path: ".github/workflows" });
  await writeFile(path.join(workspace, ".github/workflows/ci.yml"), "name: CI\non: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n", "utf8");
  assert.equal(JSON.parse(await call("path_stat", { path: ".github/workflows/ci.yml" }, workspace)).type, "file");
  const search = JSON.parse(await call("search_text", { query: "needle", max_results: 10 }, workspace));
  assert.deepEqual(search.matches.map(({ path: file, line }) => [file, line]), [["README.md", 1]]);
  const found = JSON.parse(await call("find_files", { pattern: "**/*.yml", max_results: 10 }, workspace));
  assert.deepEqual(found.paths, [".github/workflows/ci.yml"]);
  await call("move_path", { source: "README.md", destination: "README.moved.md" }, workspace);
  assert.equal(await readFile(path.join(workspace, "README.moved.md"), "utf8"), "needle one\nsecond line\n");
  await assert.rejects(call("delete_file", { path: "README.moved.md", confirm: "wrong" }, workspace), /confirmation/i);
  await call("delete_file", { path: "README.moved.md", confirm: "DELETE FILE" }, workspace);
  await call("create_directory", { path: "empty", recursive: false }, workspace);
  await call("delete_empty_directory", { path: "empty", confirm: "DELETE EMPTY DIRECTORY" }, workspace);
  await symlink(outside, path.join(workspace, "escape"), "dir");
  await assert.rejects(call("create_directory", { path: "escape/new", recursive: true }, workspace), /symbolic link|workspace/i);
});

test("returns bounded Git context, history, diff, and upstream state", async (t) => {
  const { workspace, head } = await fixture(t);
  const context = JSON.parse(await call("git_context", {}, workspace));
  assert.deepEqual({
    branch: context.branch, head: context.head, upstream: context.upstream,
    clean: context.clean, repository: context.repository,
  }, {
    branch: "feat/test", head, upstream: "origin/feat/test",
    clean: true, repository: "example/developer-bridge",
  });
  assert.equal(JSON.parse(await call("git_log", { limit: 1 }, workspace)).commits[0].sha, head);
  assert.match(await call("git_show", { ref: "HEAD", path: "README.md" }, workspace), /README\.md/u);
  assert.equal(await call("git_diff_refs", { base: "HEAD", head: "HEAD" }, workspace), "no diff");
  const upstream = JSON.parse(await call("git_upstream_status", {}, workspace));
  assert.deepEqual({ tracked: upstream.tracked, fully_pushed: upstream.fully_pushed, ahead: upstream.ahead, behind: upstream.behind }, {
    tracked: true, fully_pushed: true, ahead: 0, behind: 0,
  });
});

test("git_fetch_ref rejects transport overrides before network access", async (t) => {
  const { workspace } = await fixture(t);
  await git(workspace, "config", "http.proxy", "http://127.0.0.1:1");
  await assert.rejects(call("git_fetch_ref", { ref: "main" }, workspace), /transport overrides/i);
});

test("runs only fixed dependency and allowlisted package commands", async (t) => {
  const { workspace } = await fixture(t);
  const commands = [];
  const runCommand = async (command, args, commandOptions) => {
    commands.push([command, args, commandOptions.cwd]);
    return { exitCode: 0, signal: null, stdout: "ok", stderr: "" };
  };
  assert.equal(JSON.parse(await call("install_dependencies", {}, workspace, { runCommand })).passed, true);
  assert.equal(JSON.parse(await call("run_package_script", { script: "lint" }, workspace, { runCommand })).passed, true);
  assert.equal(JSON.parse(await call("run_project_validation", {}, workspace, { runCommand })).passed, true);
  await assert.rejects(call("run_package_script", { script: "postinstall" }, workspace, { runCommand }), /allowlisted/i);
  assert.deepEqual(commands.map(([command, args]) => [command, args]), [
    ["npm", ["ci", "--ignore-scripts"]],
    ["npm", ["run", "--silent", "lint"]],
    ["npm", ["ci", "--ignore-scripts"]],
    ["npm", ["run", "--silent", "test"]],
    ["npm", ["run", "--silent", "lint"]],
  ]);
});

test("validates read-only workflows and rejects dangerous triggers", async (t) => {
  const { workspace } = await fixture(t);
  await mkdir(path.join(workspace, ".github/workflows"), { recursive: true });
  const safe = "name: CI\non: pull_request\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n";
  await writeFile(path.join(workspace, ".github/workflows/ci.yml"), safe, "utf8");
  assert.equal(JSON.parse(await call("validate_github_workflow", { path: ".github/workflows/ci.yml" }, workspace)).valid, true);
  await writeFile(path.join(workspace, ".github/workflows/unsafe.yml"), safe.replace("pull_request", "pull_request_target"), "utf8");
  await assert.rejects(call("validate_github_workflow", { path: ".github/workflows/unsafe.yml" }, workspace), /pull_request_target/i);
});
