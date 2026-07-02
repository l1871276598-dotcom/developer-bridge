export const GITHUB_PUBLISH_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "git_push",
    description: "Push the current authorized branch to the matching origin branch.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
]);

export function createGitHubPublishTools({
  root,
  runGit,
  canonicalPath,
  allowedBranch,
  ToolError,
}) {
  const names = new Set(["git_push"]);

  async function assertRepositoryRoot() {
    const topLevel = (await runGit(["rev-parse", "--show-toplevel"])).trimEnd();
    let canonicalTopLevel;
    try {
      canonicalTopLevel = await canonicalPath(topLevel);
    } catch {
      throw new ToolError("Git repository root could not be verified");
    }
    if (canonicalTopLevel !== root) {
      throw new ToolError("Authorized workspace must equal the Git repository top level");
    }
  }

  async function invoke(name, args) {
    if (!names.has(name)) {
      throw new ToolError(`Unknown GitHub publish tool: ${name}`);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new ToolError("Arguments must be an object");
    }
    if (Object.keys(args).length !== 0) {
      throw new ToolError("git_push does not accept arguments");
    }
    if (typeof allowedBranch !== "string" || allowedBranch.length === 0) {
      throw new ToolError("An allowed Git branch must be configured");
    }

    await assertRepositoryRoot();

    const currentBranch = (await runGit(["branch", "--show-current"])).trimEnd();
    if (currentBranch.length === 0) {
      throw new ToolError("Detached HEAD cannot be pushed");
    }
    if (currentBranch !== allowedBranch) {
      throw new ToolError("Current Git branch is not the configured allowed branch");
    }

    const remotes = (await runGit(["remote"]))
      .split(/\r?\n/u)
      .filter(Boolean);
    if (remotes.length !== 1 || remotes[0] !== "origin") {
      throw new ToolError("Repository must have exactly one remote named origin");
    }

    await runGit([
      "push",
      "--no-verify",
      "--set-upstream",
      "origin",
      `refs/heads/${currentBranch}:refs/heads/${currentBranch}`,
    ]);

    return {
      text: JSON.stringify({
        remote: "origin",
        branch: currentBranch,
      }),
    };
  }

  return { names, invoke };
}
