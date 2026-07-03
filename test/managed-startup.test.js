import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { handleGitBranchWorktreeTool } from "../src/git-branch-worktree-tools.js";
import { createWorkspaceContext } from "../src/workspace-context.js";

const execFileAsync = promisify(execFile);
const git = (cwd, ...args) => execFileAsync("git", args, { cwd });

test("managed worktree startup keeps branch and worktree tools usable", async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-managed-startup-")));
  const primary = path.join(base, "workspace");
  const managedRoot = path.join(base, "workspace-worktrees");
  const managed = path.join(managedRoot, "feat--managed");
  await mkdir(primary);
  await git(primary, "init", "--quiet", "-b", "feat/start");
  await git(primary, "config", "user.name", "Test User");
  await git(primary, "config", "user.email", "test@invalid.example");
  await writeFile(path.join(primary, "README.md"), "fixture\n", "utf8");
  await git(primary, "add", "README.md");
  await git(primary, "commit", "--quiet", "-m", "fixture");
  await git(primary, "worktree", "add", "--quiet", "-b", "feat/managed", managed, "HEAD");
  t.after(() => rm(base, { recursive: true, force: true }));

  const context = await createWorkspaceContext(managed);
  assert.deepEqual(context.snapshot(), {
    root: await realpath(managed),
    branch: "feat/managed",
    initialRoot: await realpath(primary),
    commonDir: await realpath(path.join(primary, ".git")),
    managedRoot,
  });

  const listedWorktrees = JSON.parse((await handleGitBranchWorktreeTool("git_worktree_list", {}, context)).text);
  assert.deepEqual(listedWorktrees.worktrees.map(({ branch }) => branch).sort(), ["feat/managed", "feat/start"]);

  const listedBranches = JSON.parse((await handleGitBranchWorktreeTool("git_branch_list", {}, context)).text);
  assert.deepEqual(listedBranches.branches.map(({ branch }) => branch), ["feat/managed", "feat/start"]);
});
