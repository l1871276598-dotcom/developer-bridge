import fs from "node:fs";
import path from "node:path";

import { createOperatorAuditLogger } from "./audit-actor.js";
import { createBridgeCore } from "./bridge-core.js";
import { guardControlledEngineeringTool as preflightControlledTool } from "./controlled-engineering-guards.js";
import {
  CONTROLLED_ENGINEERING_TOOL_DEFINITIONS,
  REQUIRED_TOOL_NAMES,
  handleControlledEngineeringTool,
  isControlledEngineeringTool,
  validateRequiredToolContract,
} from "./controlled-engineering-tools.js";
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
import { createLaosMemoryTool } from "./laos-memory-tool.js";
import { createWorkspaceContext } from "./workspace-context.js";

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

function orderedToolSet(definitions, env) {
  const byName = new Map();
  for (const definition of definitions) {
    if (!definition || typeof definition.name !== "string") throw new Error("Invalid tool definition.");
    if (byName.has(definition.name)) throw new Error(`Duplicate tool definition: ${definition.name}`);
    byName.set(definition.name, definition);
  }
  const ordered = REQUIRED_TOOL_NAMES.map((name) => {
    const definition = byName.get(name);
    if (!definition) throw new Error(`Missing required tool definition: ${name}`);
    return definition;
  });
  if (byName.size !== ordered.length) {
    const unexpected = [...byName.keys()].filter((name) => !REQUIRED_TOOL_NAMES.includes(name));
    throw new Error(`Unexpected tool definitions: ${unexpected.join(", ")}`);
  }
  validateRequiredToolContract(ordered.map(({ name }) => name), env);
  return Object.freeze(ordered);
}

export async function createBridgeWithSyncTools(workspace, logger, options = {}) {
  const baseLogger = logger ?? ((line) => console.error(line));
  const auditLogger = createOperatorAuditLogger(baseLogger, options.operatorIdentity);
  const env = options.env ?? process.env;
  const workspaceContext = await createWorkspaceContext(workspace, {
    managedRoot: env.DEVELOPER_BRIDGE_WORKTREE_ROOT,
  });
  const core = await createBridgeCore(workspace, auditLogger, { workspaceContext });
  const identity = await repositoryIdentity(workspace);
  const fetchTool = GIT_SYNC_TOOL_DEFINITIONS.find(({ name }) => name === "git_fetch_origin_main");
  const baseTools = orderedToolSet([
    ...core.tools,
    fetchTool,
    ...GIT_MERGE_TOOL_DEFINITIONS,
    ...GITHUB_PR_MERGE_TOOL_DEFINITIONS,
    ...CONTROLLED_ENGINEERING_TOOL_DEFINITIONS,
  ], env);
  let activeRoot = identity.root;
  const laosMemoryTool = await createLaosMemoryTool(env, () => activeRoot, {
    runCommand: options.laosRunCommand,
  });
  const tools = Object.freeze(laosMemoryTool
    ? [...baseTools, laosMemoryTool.definition]
    : baseTools);
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

  async function refreshRootAfterWorktreeSwitch(result, branch) {
    const parsed = JSON.parse(resultText(result));
    if (parsed.branch !== branch || typeof parsed.root !== "string") {
      throw new Error("The worktree switch result did not contain the requested target.");
    }
    const next = await repositoryIdentity(parsed.root);
    if (next.commonDir !== identity.commonDir) {
      throw new Error("The switched worktree belongs to another repository.");
    }
    activeRoot = next.root;
  }

  return {
    tools,
    callTool(name, args = {}) {
      return serialize(async () => {
        if (laosMemoryTool && name === laosMemoryTool.definition.name) {
          const started = Date.now();
          try {
            await assertActiveIdentity();
            const result = await laosMemoryTool.call(args);
            auditLogger(`${new Date().toISOString()} tool=${name} result=success duration_ms=${Date.now() - started}`);
            return textResult(result.text);
          } catch (error) {
            auditLogger(`${new Date().toISOString()} tool=${name} result=failure duration_ms=${Date.now() - started}`);
            const message = error instanceof Error ? error.message : "Tool operation failed";
            return { content: [{ type: "text", text: message }], isError: true };
          }
        }

        if (
          name === "git_fetch_origin_main" ||
          isGitMergeTool(name) ||
          isGitHubPrMergeTool(name) ||
          isControlledEngineeringTool(name)
        ) {
          const started = Date.now();
          try {
            await assertActiveIdentity();
            if (isControlledEngineeringTool(name)) {
              await preflightControlledTool(name, args, activeRoot);
            }
            const result = name === "git_fetch_origin_main"
              ? await handleGitSyncTool(name, args, activeRoot)
              : isGitMergeTool(name)
                ? await handleGitMergeTool(name, args, activeRoot)
                : isGitHubPrMergeTool(name)
                  ? await handleGitHubPrMergeTool(name, args, activeRoot)
                  : await handleControlledEngineeringTool(name, args, activeRoot, {
                    env,
                    runCommand: options.controlledRunCommand,
                  });
            auditLogger(`${new Date().toISOString()} tool=${name} result=success duration_ms=${Date.now() - started}`);
            return textResult(result.text);
          } catch {
            auditLogger(`${new Date().toISOString()} tool=${name} result=failure duration_ms=${Date.now() - started}`);
            return failureResult();
          }
        }

        const result = await core.callTool(name, args);
        if (name === "git_worktree_switch" && !result.isError) {
          try {
            await refreshRootAfterWorktreeSwitch(result, args.branch);
          } catch {
            return failureResult();
          }
        }
        return result;
      });
    },
  };
}
