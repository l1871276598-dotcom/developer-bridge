import fs from "node:fs";
import path from "node:path";

import { runFixedGit } from "./fixed-git-runner.js";

export const GIT_FETCH_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "git_fetch_origin_main",
    description: "Fetch only origin/main from a GitHub HTTPS origin without tags or submodules.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]);

const git = (root, args, options = {}) => runFixedGit("git", args, { cwd: root, ...options });

function assertNoArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0) {
    throw new Error("git_fetch_origin_main does not accept arguments.");
  }
}

async function marker(root, name) {
  const result = await git(root, ["rev-parse", "--quiet", "--verify", name], {
    allowedExitCodes: [0, 1],
  });
  return result.exitCode === 0;
}

async function assertSafeContext(root) {
  const canonical = fs.realpathSync(root);
  const top = fs.realpathSync((await git(canonical, ["rev-parse", "--show-toplevel"])).stdout.trim());
  if (top !== canonical) throw new Error("Repository identity no longer matches the authorized root.");

  const branch = (await git(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!branch || branch === "main" || branch === "master") {
    throw new Error("Protected or detached branches are not allowed.");
  }

  for (const operation of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (await marker(canonical, operation)) throw new Error("Another Git operation is already in progress.");
  }
  for (const operation of ["rebase-apply", "rebase-merge"]) {
    const markerPath = (await git(canonical, ["rev-parse", "--git-path", operation])).stdout.trim();
    if (fs.existsSync(path.resolve(canonical, markerPath))) {
      throw new Error("Another Git operation is already in progress.");
    }
  }

  const status = await git(canonical, ["status", "--porcelain=v1", "-z"]);
  if (status.stdout.length !== 0) throw new Error("The workspace must be clean.");

  const remote = (await git(canonical, ["remote", "get-url", "origin"])).stdout.trim();
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(remote)) {
    throw new Error("A GitHub HTTPS origin is required.");
  }
  return { root: canonical, branch };
}

export async function handleGitFetchTool(name, args = {}, root) {
  if (name !== "git_fetch_origin_main") throw new Error(`Unsupported Git fetch tool: ${name}`);
  assertNoArguments(args);
  const current = await assertSafeContext(root);
  await git(current.root, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  const oid = (await git(current.root, ["rev-parse", "refs/remotes/origin/main"])).stdout.trim();
  return { text: JSON.stringify({ fetched: true, branch: current.branch, ref: "origin/main", oid }) };
}
