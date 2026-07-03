import { spawn } from "node:child_process";
import path from "node:path";

import { runFixedGit } from "./fixed-git-runner.js";

const TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 200_000;
const TOOL_NAME = "github_pr_merge_squash_if_green";
const PR_FIELDS = "number,isDraft,mergeStateStatus,state,headRefName,headRefOid,baseRefName,url,statusCheckRollup";

export const GITHUB_PR_MERGE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: TOOL_NAME,
    description: "Squash-merge the current branch pull request only after every reported CI check succeeds.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
]);

export function isGitHubPrMergeTool(name) {
  return name === TOOL_NAME;
}

function assertPlainArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  if (Object.keys(args).length !== 0) throw new Error("Unexpected arguments");
}

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        finish(new Error("Command output exceeded the fixed limit"));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", () => finish(new Error("Command could not be started")));
    child.once("close", (exitCode, signal) => {
      if (timedOut) return finish(new Error("Command timed out"));
      if (exitCode !== 0) return finish(new Error("Fixed command failed"));
      return finish(null, {
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    timer.unref();
  });
}

async function git(root, args) {
  return runFixedGit("git", args, { cwd: root });
}

function ghEnvironment() {
  const env = {
    ...process.env,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete env.GH_REPO;
  delete env.GH_HOST;
  return env;
}

function isGitHubOrigin(remote) {
  return (
    /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(remote) ||
    /^git@github\.com:[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(remote) ||
    /^ssh:\/\/git@github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(remote)
  );
}

async function repositoryContext(root) {
  const topLevel = (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (path.resolve(topLevel) !== path.resolve(root)) throw new Error("Workspace must be the repository root");
  const branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!branch || branch === "main" || branch === "master") {
    throw new Error("A non-protected attached branch is required");
  }
  const remote = (await git(root, ["remote", "get-url", "origin"])).stdout.trim();
  if (!isGitHubOrigin(remote)) throw new Error("A GitHub origin remote is required");

  const status = (await git(root, ["status", "--porcelain=v1", "-z"])).stdout;
  if (status.length !== 0) return { branch, reason: "workspace_not_clean" };

  const upstream = (await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout.trim();
  if (upstream !== `origin/${branch}`) return { branch, reason: "head_not_pushed" };

  const localHead = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const remoteHead = (await git(root, ["rev-parse", `refs/remotes/origin/${branch}`])).stdout.trim();
  if (localHead !== remoteHead) return { branch, localHead, reason: "head_not_pushed" };
  return { branch, localHead };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitHub returned malformed JSON");
  }
}

async function viewCurrentPr(root, runCommand) {
  const result = await runCommand("gh", ["pr", "view", "--json", PR_FIELDS], {
    cwd: root,
    timeoutMs: TIMEOUT_MS,
    envOverrides: ghEnvironment(),
    env: ghEnvironment(),
  });
  return parseJson(result.stdout);
}

function checkSucceeded(item) {
  if (!item || typeof item !== "object") return false;
  if ("conclusion" in item || "status" in item) {
    return item.status === "COMPLETED" && item.conclusion === "SUCCESS";
  }
  return item.state === "SUCCESS";
}

function gate(pr, branch, localHead, { allowDraftBlocked = false } = {}) {
  if (!pr || typeof pr !== "object") return "invalid_pr";
  if (pr.state !== "OPEN") return "pr_not_open";
  if (pr.headRefName !== branch) return "wrong_head_branch";
  if (pr.baseRefName !== "main" && pr.baseRefName !== "master") return "wrong_base_branch";
  if (!Number.isInteger(pr.number) || pr.number < 1) return "invalid_pr";
  if (!/^[0-9a-f]{40}$/u.test(pr.headRefOid ?? "")) return "invalid_head_oid";
  if (pr.headRefOid !== localHead) return "head_not_pushed";
  if (!Array.isArray(pr.statusCheckRollup) || pr.statusCheckRollup.length === 0) return "no_checks";
  if (!pr.statusCheckRollup.every(checkSucceeded)) return "checks_not_green";
  if (pr.mergeStateStatus !== "CLEAN") {
    if (!(allowDraftBlocked && pr.isDraft === true && pr.mergeStateStatus === "BLOCKED")) {
      return "merge_state_not_clean";
    }
  }
  return null;
}

function blocked(pr, reason) {
  return {
    text: JSON.stringify({
      merged: false,
      reason,
      number: Number.isInteger(pr?.number) ? pr.number : null,
      checks: Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup.length : 0,
      url: typeof pr?.url === "string" ? pr.url : null,
    }),
  };
}

export async function handleGitHubPrMergeTool(name, args = {}, root, options = {}) {
  if (!isGitHubPrMergeTool(name)) throw new Error(`Unsupported GitHub PR merge tool: ${name}`);
  assertPlainArguments(args);
  if (typeof root !== "string" || root.length === 0) throw new Error("Authorized workspace is required");

  const runCommand = options.runCommand || run;
  const context = await repositoryContext(root);
  if (context.reason) return blocked(null, context.reason);
  const ghOptions = {
    cwd: root,
    timeoutMs: TIMEOUT_MS,
    envOverrides: ghEnvironment(),
    env: ghEnvironment(),
  };

  await runCommand("gh", ["auth", "status", "--hostname", "github.com"], ghOptions);
  let pr = await viewCurrentPr(root, runCommand);
  let reason = gate(pr, context.branch, context.localHead, { allowDraftBlocked: true });
  if (reason) return blocked(pr, reason);

  if (pr.isDraft === true) {
    await runCommand("gh", ["pr", "ready", String(pr.number)], ghOptions);
    pr = await viewCurrentPr(root, runCommand);
    reason = gate(pr, context.branch, context.localHead);
    if (reason) return blocked(pr, reason);
  }

  await runCommand(
    "gh",
    ["pr", "merge", String(pr.number), "--squash", "--match-head-commit", pr.headRefOid],
    ghOptions,
  );
  const confirmed = parseJson((await runCommand(
    "gh",
    ["pr", "view", String(pr.number), "--json", "number,state,url"],
    ghOptions,
  )).stdout);
  if (confirmed.state !== "MERGED" || confirmed.number !== pr.number) {
    throw new Error("GitHub did not confirm the merged state");
  }

  return {
    text: JSON.stringify({
      merged: true,
      number: pr.number,
      checks: pr.statusCheckRollup.length,
      url: pr.url,
    }),
  };
}
