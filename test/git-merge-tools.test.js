import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { handleGitMergeTool } from "../src/git-merge-tools.js";

const execFileAsync = promisify(execFile);
const git = (cwd, ...args) => execFileAsync("git", args, { cwd });

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "--quiet", "-b", "main");
  await git(root, "config", "user.name", "Test User");
  await git(root, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "base.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "base");
  await git(root, "switch", "--quiet", "-c", "feat/test");
  await writeFile(path.join(root, "feature.txt"), "feature\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "feature");
  const featureHead = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  await git(root, "switch", "--quiet", "main");
  await writeFile(path.join(root, "main.txt"), "main\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "main update");
  await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(root, "remote", "add", "origin", "https://github.com/example/repository.git");
  await git(root, "switch", "--quiet", "feat/test");
  return { root, featureHead };
}

test("merge prepares an explicit commit and abort restores the feature head", async (t) => {
  const { root, featureHead } = await repository(t);
  await assert.rejects(
    handleGitMergeTool("git_merge_origin_main", { confirm: "MERGE" }, root),
    /Confirmation/i,
  );

  const prepared = JSON.parse((await handleGitMergeTool(
    "git_merge_origin_main",
    { confirm: "MERGE origin/main INTO feat/test" },
    root,
  )).text);
  assert.equal(prepared.readyToCommit, true);
  assert.equal(prepared.conflicted, false);
  assert.equal((await git(root, "rev-parse", "HEAD")).stdout.trim(), featureHead);
  assert.equal((await git(root, "rev-parse", "--verify", "MERGE_HEAD")).stdout.trim().length, 40);

  await handleGitMergeTool("git_merge_abort", { confirm: "ABORT MERGE" }, root);
  assert.equal((await git(root, "rev-parse", "HEAD")).stdout.trim(), featureHead);
  assert.equal((await git(root, "status", "--porcelain")).stdout, "");
});

test("merge rejects external filters before changing repository state", async (t) => {
  const { root, featureHead } = await repository(t);
  await git(root, "config", "filter.external.clean", "cat");

  await assert.rejects(
    handleGitMergeTool(
      "git_merge_origin_main",
      { confirm: "MERGE origin/main INTO feat/test" },
      root,
    ),
    /drivers and filters/i,
  );
  assert.equal((await git(root, "rev-parse", "HEAD")).stdout.trim(), featureHead);
  const mergeHead = await git(root, "rev-parse", "--quiet", "--verify", "MERGE_HEAD").catch((error) => error);
  assert.notEqual(mergeHead.code, 0);
  assert.equal((await git(root, "status", "--porcelain")).stdout, "");
});
