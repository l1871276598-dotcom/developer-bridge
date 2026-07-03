import fs from "node:fs";
import os from "node:os";

import { runFixedGit } from "./git-sync-tools.js";

export const GIT_MERGE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "git_merge_origin_main",
    description: "Prepare a no-commit merge of origin/main into the clean authorized feature branch after exact confirmation.",
    inputSchema: {
      type: "object",
      properties: { confirm: { type: "string", minLength: 1, maxLength: 300 } },
      required: ["confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "git_merge_abort",
    description: "Abort the active merge after exact confirmation and restore the pre-merge state.",
    inputSchema: {
      type: "object",
      properties: { confirm: { type: "string", const: "ABORT MERGE" } },
      required: ["confirm"],
      additionalProperties: false,
    },
  },
]);

const NAMES = new Set(GIT_MERGE_TOOL_DEFINITIONS.map(({ name }) => name));
export const isGitMergeTool = (name) => NAMES.has(name);

const git = (root, args, options = {}) => runFixedGit("git", args, { cwd: root, ...options });

function assertArgs(args, allowed) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object.");
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`Unexpected argument: ${key}`);
  }
}

async function marker(root, name) {
  const result = await git(root, ["rev-parse", "--quiet", "--verify", name], {
    allowedExitCodes: [0, 1],
  });
  return result.exitCode === 0;
}

async function activeContext(root, { allowMerge = false, requireClean = false } = {}) {
  const canonical = fs.realpathSync(root);
  const top = fs.realpathSync((await git(canonical, ["rev-parse", "--show-toplevel"])).stdout.trim());
  if (top !== canonical) throw new Error("Repository identity no longer matches the authorized root.");

  const branch = (await git(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!branch || branch === "main" || branch === "master") {
    throw new Error("Protected or detached branches are not allowed.");
  }

  const mergeInProgress = await marker(canonical, "MERGE_HEAD");
  if (!allowMerge && mergeInProgress) throw new Error("A merge is already in progress.");
  for (const operation of ["REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (await marker(canonical, operation)) throw new Error("Another Git operation is already in progress.");
  }
  if (requireClean) {
    const status = await git(canonical, ["status", "--porcelain=v1", "-z"]);
    if (status.stdout.length !== 0) throw new Error("The workspace must be clean.");
  }
  return { root: canonical, branch, mergeInProgress };
}

async function assertGitHubOrigin(root) {
  const remote = (await git(root, ["remote", "get-url", "origin"])).stdout.trim();
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(remote)) {
    throw new Error("A GitHub HTTPS origin is required.");
  }
}

async function assertNoExternalGitPrograms(root) {
  const configured = await git(
    root,
    [
      "config",
      "--name-only",
      "--get-regexp",
      "^(merge\\..*\\.driver|filter\\..*\\.(clean|smudge|process))$",
    ],
    { allowedExitCodes: [0, 1] },
  );
  if (configured.exitCode === 0 && configured.stdout.trim()) {
    throw new Error("External Git merge drivers and filters are not allowed.");
  }
}

async function prepareMerge(args, root) {
  assertArgs(args, ["confirm"]);
  const current = await activeContext(root, { requireClean: true });
  const expected = `MERGE origin/main INTO ${current.branch}`;
  if (args.confirm !== expected) throw new Error(`Confirmation must exactly match ${expected}.`);
  await assertGitHubOrigin(current.root);
  await assertNoExternalGitPrograms(current.root);
  await git(current.root, ["rev-parse", "--verify", "refs/remotes/origin/main"]);

  const result = await git(current.root, [
    "-c", `core.hooksPath=${os.devNull}`,
    "-c", "commit.gpgSign=false",
    "merge",
    "--no-commit",
    "--no-edit",
    "--no-verify",
    "--no-ff",
    "refs/remotes/origin/main",
  ], { allowedExitCodes: [0, 1] });

  if (!(await marker(current.root, "MERGE_HEAD"))) {
    if (result.exitCode !== 0) throw new Error("Fixed Git merge failed.");
    const oid = (await git(current.root, ["rev-parse", "HEAD"])).stdout.trim();
    return {
      text: JSON.stringify({
        merged: false,
        conflicted: false,
        readyToCommit: false,
        upToDate: true,
        branch: current.branch,
        oid,
      }),
    };
  }

  const conflicts = (await git(current.root, ["diff", "--name-only", "--diff-filter=U"])).stdout
    .split(/\r?\n/u)
    .filter(Boolean);
  return {
    text: JSON.stringify({
      merged: false,
      conflicted: conflicts.length > 0,
      readyToCommit: conflicts.length === 0,
      upToDate: false,
      branch: current.branch,
      conflicts,
    }),
  };
}

async function abortMerge(args, root) {
  assertArgs(args, ["confirm"]);
  if (args.confirm !== "ABORT MERGE") throw new Error("Confirmation must exactly match ABORT MERGE.");
  const current = await activeContext(root, { allowMerge: true });
  if (!current.mergeInProgress) throw new Error("No merge is in progress.");
  await assertNoExternalGitPrograms(current.root);
  await git(current.root, ["merge", "--abort"]);
  return { text: JSON.stringify({ aborted: true, branch: current.branch }) };
}

export async function handleGitMergeTool(name, args = {}, root) {
  if (name === "git_merge_origin_main") return prepareMerge(args, root);
  if (name === "git_merge_abort") return abortMerge(args, root);
  throw new Error(`Unsupported Git merge tool: ${name}`);
}
