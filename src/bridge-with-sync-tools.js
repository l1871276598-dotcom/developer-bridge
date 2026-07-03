import fs from "node:fs";
import path from "node:path";

import { createOperatorAuditLogger } from "./audit-actor.js";
import { createBridgeCore } from "./bridge-core.js";
import {
  GITHUB_PR_MERGE_TOOL_DEFINITIONS,
  handleGitHubPrMergeTool,
  isGitHubPrMergeTool,
} from "./github-pr-merge-tool.js";
import {
  GIT_MERGE_TOOL_DEFINITIONS,
  handleGitMergeTool,
  isGitMergeTool,
} from "./git-merge-tools.js";
import {
  GIT_SYNC_TOOL_DEFINITIONS,
  handleGitSyncTool,
  runFixedGit,
} from "./git-sync-tools.js";

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function failureResult() {
  return { content: [{ type: "text", text: "Tool operation failed" }], isError: true };
}

function resultText(result) {
  return result?.content?.[0]?.text;
}

async function repositoryIdentity(root) {
  const canonicalRoot = fs.realpathSync(root);
  const commonPath = (await runFixedGit(
    "git",
    ["rev-parse", "--git-common-dir"],
    { cwd: canonicalRoot },
  )).stdout.trim();
  return {
    root: canonicalRoot,
    commonDir: fs.realpathSync(path.resolve(canonicalRoot, commonPath)),
  };
}

export async function createBridgeWithSyncTools(workspace, logger, options = {}) {
  const baseLogger = logger ?? ((line) => console.error(line));
  const auditLogger = createOperatorAuditLogger(baseLogger, options.operatorIdentity);
  const core = await createBridgeCore(workspace, auditLogger);
  const identity = await repositoryIdentity(workspace);
  const fetchTool = GIT_SYNC_TOOL_DEFINITIONS.find(({ name }) => name === "git_fetch_origin_main");
  let activeRoot = identity.root;
  let queue = Promise.resolve();

  function serialize(operation) {
    const pending = queue.then(operation, operation);
    queue = pending.catch(() => {});
    return pending;
  }

  async function assertActiveIdentity() {
    const current = await repositoryIdentity(activeRoot);
    if (current.root !== activeRoot || current.commonDir !== identity.commonDir) {
      throw new Error("The active worktree no longer matches the authorized repository.");
    }
  }

  async function refreshRootAfterWorktreeSwitch(branch) {
    const listed = await core.callTool("git_worktree_list", {});
    if (listed.isError) throw new Error("Unable to refresh the authorized worktree.");
    const parsed = JSON.parse(resultText(listed));
    const match = parsed.worktrees?.find((item) => item.branch === branch);
    if (!match || typeof match.root !== "string") {
      throw new Error("The switched worktree is not present in the authorized list.");
    }
    const next = await repositoryIdentity(match.root);
    if (next.commonDir !== identity.commonDir) {
      throw new Error("The switched worktree belongs to another repository.");
    }
    activeRoot = next.root;
  }

  return {
    tools: Object.freeze([
      ...core.tools,
      fetchTool,
      ...GIT_MERGE_TOOL_DEFINITIONS,
      ...GITHUB_PR_MERGE_TOOL_DEFINITIONS,
    ]),
    callTool(name, args = {}) {
      return serialize(async () => {
        if (name === "git_fetch_origin_main" || isGitMergeTool(name) || isGitHubPrMergeTool(name)) {
          const started = Date.now();
          try {
            await assertActiveIdentity();
            const result = name === "git_fetch_origin_main"
              ? await handleGitSyncTool(name, args, activeRoot)
              : isGitMergeTool(name)
                ? await handleGitMergeTool(name, args, activeRoot)
                : await handleGitHubPrMergeTool(name, args, activeRoot);
            auditLogger(`${new Date().toISOString()} tool=${name} result=success duration_ms=${Date.now() - started}`);
            return textResult(result.text);
          } catch {
            auditLogger(`${new Date().toISOString()} tool=${name} result=failure duration_ms=${Date.now() - started}`);
            return failureResult();
          }
        }

        const result = await core.callTool(name, args);
        if (name === "git_worktree_switch" && !result.isError) {
          activeRoot = null;
          try {
            await refreshRootAfterWorktreeSwitch(args.branch);
          } catch {
            return failureResult();
          }
        }
        return result;
      });
    },
  };
}
