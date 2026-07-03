import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  GIT_BRANCH_WORKTREE_TOOL_DEFINITIONS,
  handleGitBranchWorktreeTool,
} from "../src/git-branch-worktree-tools.js";
import { createBridgeCore } from "../src/bridge-core.js";
import { createWorkspaceContext } from "../src/workspace-context.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function repository(t, branch = "feat/start") {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-context-")));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  await git(workspace, "init", "-b", branch);
  await git(workspace, "config", "user.name", "Test User");
  await git(workspace, "config", "user.email", "test@invalid.example");
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-m", "fixture");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, workspace };
}

test("workspace context authorizes one repository root and serializes operations", async (t) => {
  const { workspace } = await repository(t);
  const root = await realpath(workspace);
  const commonDir = await realpath(path.join(root, ".git"));
  const context = await createWorkspaceContext(workspace);

  assert.deepEqual(context.snapshot(), {
    root,
    branch: "feat/start",
    initialRoot: root,
    commonDir,
    managedRoot: path.join(path.dirname(root), `${path.basename(root)}-worktrees`),
  });
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.snapshot()));

  const events = [];
  const first = context.runExclusive(async () => {
    events.push("a1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push("a2");
  });
  const second = context.runExclusive(async () => {
    events.push("b1");
    await new Promise((resolve) => setImmediate(resolve));
    events.push("b2");
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a1", "a2", "b1", "b2"]);

  const previous = context.snapshot();
  context.replace({ branch: "feat/next" });
  assert.notEqual(context.snapshot(), previous);
  assert.equal(context.snapshot().branch, "feat/next");
  assert.equal(context.snapshot().root, root);
  assert.ok(Object.isFrozen(context.snapshot()));
});

test("workspace context rejects unsafe repository identities", async (t) => {
  const nonRepository = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-non-repo-")));
  t.after(() => rm(nonRepository, { recursive: true, force: true }));
  await assert.rejects(createWorkspaceContext(nonRepository), /attached Git repository branch/i);

  const nestedFixture = await repository(t);
  const nested = path.join(nestedFixture.workspace, "nested");
  await mkdir(nested);
  await assert.rejects(createWorkspaceContext(nested), /repository root/i);
  await assert.rejects(
    createWorkspaceContext(nestedFixture.workspace, { managedRoot: `bad\0root` }),
    /absolute local path/i,
  );

  const realManagedParent = path.join(nestedFixture.base, "managed-parent");
  const managedAlias = path.join(nestedFixture.base, "managed-alias");
  await mkdir(realManagedParent);
  await symlink(realManagedParent, managedAlias, "dir");
  await assert.rejects(
    createWorkspaceContext(nestedFixture.workspace, { managedRoot: path.join(managedAlias, "worktrees") }),
    /symbolic link/i,
  );

  const detachedFixture = await repository(t);
  await git(detachedFixture.workspace, "switch", "--detach", "HEAD");
  await assert.rejects(createWorkspaceContext(detachedFixture.workspace), /attached Git repository branch/i);

  for (const protectedBranch of ["main", "master"]) {
    const fixture = await repository(t, protectedBranch);
    await assert.rejects(createWorkspaceContext(fixture.workspace), /protected branch/i);
  }
});

function responseText(result) {
  return result.text;
}

test("branch and worktree tools expose strict schemas", () => {
  assert.deepEqual(GIT_BRANCH_WORKTREE_TOOL_DEFINITIONS.map(({ name }) => name), [
    "git_branch_list",
    "git_branch_create",
    "git_branch_switch",
    "git_worktree_list",
    "git_worktree_create",
    "git_worktree_switch",
  ]);
  for (const tool of GIT_BRANCH_WORKTREE_TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test("controlled branch tools list, create, and switch attached branches", async (t) => {
  const { workspace } = await repository(t);
  const context = await createWorkspaceContext(workspace);

  const listed = JSON.parse(responseText(await handleGitBranchWorktreeTool("git_branch_list", {}, context)));
  assert.deepEqual(listed.branches.map(({ branch }) => branch), ["feat/start"]);

  await handleGitBranchWorktreeTool("git_branch_create", { branch: "feat/new", switch: false }, context);
  assert.equal(context.snapshot().branch, "feat/start");
  await git(workspace, "show-ref", "--verify", "refs/heads/feat/new");

  await handleGitBranchWorktreeTool("git_branch_switch", { branch: "feat/new" }, context);
  assert.equal(context.snapshot().branch, "feat/new");
  assert.equal((await git(workspace, "branch", "--show-current")).stdout.trim(), "feat/new");

  await handleGitBranchWorktreeTool("git_branch_create", { branch: "feat/next", switch: true }, context);
  assert.equal(context.snapshot().branch, "feat/next");
});

test("controlled branch tools reject malformed, protected, dirty, and unexpected requests", async (t) => {
  const { workspace } = await repository(t);
  const context = await createWorkspaceContext(workspace);

  for (const args of [
    {},
    { branch: "main", switch: false },
    { branch: "-bad", switch: false },
    { branch: "bad name", switch: false },
    { branch: "feat/new", switch: false, extra: true },
  ]) {
    await assert.rejects(handleGitBranchWorktreeTool("git_branch_create", args, context));
  }

  await writeFile(path.join(workspace, "dirty.txt"), "dirty\n", "utf8");
  await assert.rejects(
    handleGitBranchWorktreeTool("git_branch_create", { branch: "feat/dirty", switch: false }, context),
    /clean/i,
  );
});

test("branch switching fails closed during an active Git operation", async (t) => {
  const { workspace } = await repository(t);
  const context = await createWorkspaceContext(workspace);
  await git(workspace, "branch", "feat/next");
  const head = (await git(workspace, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(workspace, ".git", "MERGE_HEAD"), `${head}\n`, "utf8");

  await assert.rejects(
    handleGitBranchWorktreeTool("git_branch_switch", { branch: "feat/next" }, context),
    /operation state/i,
  );
  assert.equal(context.snapshot().branch, "feat/start");
  assert.equal((await git(workspace, "branch", "--show-current")).stdout.trim(), "feat/start");
});

test("registered worktrees outside the managed root are rejected", async (t) => {
  const { base, workspace } = await repository(t);
  const context = await createWorkspaceContext(workspace);
  const external = path.join(base, "external-worktree");
  await git(workspace, "branch", "feat/external");
  await git(workspace, "worktree", "add", "--quiet", external, "feat/external");

  await assert.rejects(
    handleGitBranchWorktreeTool("git_worktree_list", {}, context),
    /unmanaged/i,
  );
});

test("managed worktree tools create, list, and switch only derived worktrees", async (t) => {
  const { workspace } = await repository(t);
  const context = await createWorkspaceContext(workspace);
  await git(workspace, "branch", "feat/existing");

  const existing = JSON.parse(responseText(await handleGitBranchWorktreeTool(
    "git_worktree_create",
    { branch: "feat/existing", create_branch: false },
    context,
  )));
  const expectedExisting = path.join(path.dirname(workspace), "workspace-worktrees", "feat--existing");
  assert.equal(existing.root, await realpath(expectedExisting));

  const created = JSON.parse(responseText(await handleGitBranchWorktreeTool(
    "git_worktree_create",
    { branch: "feat/created", create_branch: true },
    context,
  )));
  const expectedCreated = path.join(path.dirname(workspace), "workspace-worktrees", "feat--created");
  assert.equal(created.root, await realpath(expectedCreated));

  const listed = JSON.parse(responseText(await handleGitBranchWorktreeTool("git_worktree_list", {}, context)));
  assert.ok(listed.worktrees.some(({ branch }) => branch === "feat/existing"));
  assert.ok(listed.worktrees.some(({ branch }) => branch === "feat/created"));

  await handleGitBranchWorktreeTool("git_worktree_switch", { branch: "feat/created" }, context);
  assert.equal(context.snapshot().root, await realpath(expectedCreated));
  assert.equal(context.snapshot().branch, "feat/created");
});

test("worktree switching rejects a dirty target without changing authorization", async (t) => {
  const { workspace } = await repository(t);
  const context = await createWorkspaceContext(workspace);
  const created = JSON.parse(responseText(await handleGitBranchWorktreeTool(
    "git_worktree_create",
    { branch: "feat/dirty-target", create_branch: true },
    context,
  )));
  await writeFile(path.join(created.root, "untracked.txt"), "dirty\n", "utf8");

  await assert.rejects(
    handleGitBranchWorktreeTool("git_worktree_switch", { branch: "feat/dirty-target" }, context),
    /clean/i,
  );
  assert.equal(context.snapshot().root, await realpath(workspace));
  assert.equal(context.snapshot().branch, "feat/start");
});

test("managed worktree creation safely builds a nested configured root", async (t) => {
  const { base, workspace } = await repository(t);
  const managedRoot = path.join(base, "nested", "managed", "worktrees");
  const context = await createWorkspaceContext(workspace, { managedRoot });

  const created = JSON.parse(responseText(await handleGitBranchWorktreeTool(
    "git_worktree_create",
    { branch: "feat/nested", create_branch: true },
    context,
  )));
  assert.equal(created.root, path.join(managedRoot, "feat--nested"));
  assert.equal(await realpath(created.root), created.root);
});

test("bridge operations follow the live managed-worktree context", async (t) => {
  const { workspace } = await repository(t);
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "node --test target.test.js" },
  }), "utf8");
  await writeFile(path.join(workspace, "target.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("passes", () => assert.equal(2 + 2, 4));',
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(workspace, "marker.txt"), "initial\n", "utf8");
  await git(workspace, "add", "package.json", "target.test.js", "marker.txt");
  await git(workspace, "commit", "-m", "core fixture");
  let initialHead = (await git(workspace, "rev-parse", "HEAD")).stdout.trim();
  const logs = [];
  const managedRootPath = path.join(path.dirname(workspace), "workspace-worktrees");
  const core = await createBridgeCore(workspace, (line) => logs.push(line), {
    managedRoot: managedRootPath,
  });

  const created = await core.callTool("git_worktree_create", {
    branch: "feat/managed",
    create_branch: true,
  });
  assert.equal(created.isError, undefined);
  const managedRoot = JSON.parse(created.content[0].text).root;

  await writeFile(path.join(workspace, "marker.txt"), "queued-initial\n", "utf8");
  await git(workspace, "add", "marker.txt");
  await git(workspace, "commit", "-m", "advance initial branch");
  initialHead = (await git(workspace, "rev-parse", "HEAD")).stdout.trim();

  const queuedRead = core.callTool("read_file", { path: "marker.txt" });
  const queuedSwitch = core.callTool("git_worktree_switch", { branch: "feat/managed" });
  assert.equal((await queuedRead).content[0].text, "queued-initial\n");
  assert.equal((await queuedSwitch).isError, undefined);
  assert.equal(await readFile(path.join(workspace, "marker.txt"), "utf8"), "queued-initial\n");
  assert.equal(await readFile(path.join(managedRoot, "marker.txt"), "utf8"), "initial\n");

  assert.equal((await core.callTool("write_file", { path: "marker.txt", content: "managed\n" })).isError, undefined);
  assert.equal((await core.callTool("read_file", { path: "marker.txt" })).content[0].text, "managed\n");
  assert.match((await core.callTool("git_status", {})).content[0].text, / M marker\.txt/);
  assert.match((await core.callTool("git_diff", {})).content[0].text, /\+managed/);
  const tests = JSON.parse((await core.callTool("run_tests", { test: "default" })).content[0].text);
  assert.equal(tests.exitCode, 0);

  assert.equal((await core.callTool("git_stage", { paths: ["marker.txt"] })).isError, undefined);
  assert.equal((await core.callTool("git_commit", { message: "test: update managed marker" })).isError, undefined);
  assert.equal((await git(workspace, "rev-parse", "HEAD")).stdout.trim(), initialHead);
  assert.notEqual((await git(managedRoot, "rev-parse", "HEAD")).stdout.trim(), initialHead);
  assert.match(logs.join("\n"), /branch=feat\/managed/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(workspace));
  assert.doesNotMatch(logs.join("\n"), new RegExp(managedRoot));
});
