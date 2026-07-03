# Developer Bridge

Developer Bridge connects ChatGPT to one explicitly authorized local Git project through a small, auditable MCP bridge. It supports protected file editing, fixed validation, controlled Git publishing, controlled Draft PR creation, controlled origin/main synchronization, and controlled branch/worktree changes without arbitrary Shell, Git, or GitHub CLI arguments.

## Architecture

```text
ChatGPT Web/App
→ HTTPS tunnel
→ Streamable HTTP MCP
→ authorized local workspace / selected managed worktree
```

Each tool call uses one immutable authorization snapshot. After a successful controlled switch, later calls use the selected branch or managed worktree; an in-flight call continues using the snapshot with which it started.

## Install and configure

Install dependencies:

```bash
npm install
```

Choose a single Git project as the authorized workspace and replace the placeholder values locally:

```bash
export DEVELOPER_BRIDGE_WORKSPACE="..."
export MCP_PATH="mcp-..."
```

The workspace must be the real top-level directory of a repository on an attached branch other than `main` or `master`. `DEVELOPER_BRIDGE_WORKSPACE` should be restricted to a single project. Do not commit the secret local path or other secrets. `MCP_PATH` is a single private path segment, not a complete URL, and must not be hard-coded in the repository.

Managed worktrees default to a sibling directory named `<repository>-worktrees`. A launcher may set a different absolute local directory:

```bash
export DEVELOPER_BRIDGE_WORKTREE_ROOT="..."
```

The managed root must differ from the workspace and must not traverse a symbolic link. Tool callers cannot supply worktree paths: the Bridge derives each target as `<managed-root>/<branch-with-slashes-replaced-by-->`.

The Draft PR tool requires the GitHub CLI (`gh`) to be installed and already authenticated for `github.com`. Authentication is never requested interactively by the Bridge.

## Start and connect

In terminal 1, start the Streamable HTTP MCP service:

```bash
npm start
```

In terminal 2, expose port 3000 through the HTTPS tunnel:

```bash
ngrok http 3000
```

Configure ChatGPT with this placeholder connection format:

```text
https://<ngrok-domain>/<MCP_PATH>
```

Do not hard-code an ngrok address. Stop the service and tunnel when they are no longer in use.

For a local MCP client that uses stdio instead of HTTP, run:

```bash
npm run start:stdio
```

The stdio service requires `DEVELOPER_BRIDGE_WORKSPACE` but does not use `MCP_PATH`.

## Current tools

File, inspection, and validation tools:

- `list_files`: list a directory inside the currently authorized root.
- `read_file`: read a bounded UTF-8 text file.
- `write_file`: create or overwrite an allowed UTF-8 text file.
- `git_status`: run the fixed `git status --short` check.
- `git_diff`: show the fixed unstaged diff, or the staged diff with `staged=true`.
- `run_tests`: run only the server-approved `npm test` mapping with bounded output and timeout.
- `run_validation`: run the fixed validation command set; arbitrary commands are not accepted.

Explicit Git and GitHub publishing tools:

- `git_stage`: stage only explicitly listed safe relative paths.
- `git_commit`: create a normal one-line commit from already staged changes on the authorized branch.
- `git_push_current_branch`: push only the current authorized non-protected branch to the same branch on `origin`.
- `github_pr_create_draft`: create a GitHub Draft PR using fixed `gh pr create --draft --fill` arguments only. The current branch must be clean, track `origin/<same-branch>`, and exactly match its pushed remote-tracking commit.

Controlled synchronization tools:

- `git_fetch_origin_main`: fetch only `origin/main` from an HTTPS GitHub origin; arbitrary remotes, tags, submodules, and refspecs are not accepted.
- `git_merge_origin_main`: prepare a confirmed `--no-commit --no-ff` merge of `origin/main` into the clean current feature branch. A successful merge still requires a separate `git_commit`; conflicts remain available for explicit resolution.
- `git_merge_abort`: abort the active controlled merge after explicit confirmation.

Controlled branch and worktree tools:

- `git_branch_list`: list local branches and whether they are current or checked out.
- `git_branch_create`: create a validated branch from `HEAD`, optionally switching to it.
- `git_branch_switch`: switch to an existing local branch only when the current worktree is clean and no Git operation is active.
- `git_worktree_list`: list the initial worktree and validated managed worktrees.
- `git_worktree_create`: create a worktree only at the derived managed path, using an existing or newly created branch.
- `git_worktree_switch`: change live Bridge authorization to an existing validated managed worktree by branch name.

## Safety boundary

- No delete, prune, move, rebase, tag, reset, clean, force, PR merge, PR close, or Ready-for-review operations.
- No detached `HEAD`, and no authorization or mutation of `main` or `master`.
- Branch/worktree switching requires a clean tracked and untracked state and no merge, rebase, cherry-pick, revert, or bisect in progress.
- Fetch is fixed to HTTPS GitHub `origin/main`; merge is fixed to `origin/main` into the current authorized feature branch.
- Controlled merge disables hooks and signing, rejects external merge drivers and filters, and never creates a commit automatically.
- Rebase is intentionally not exposed because it rewrites published history and can require force push.
- No caller-controlled worktree path and no arbitrary Git or `gh` arguments.
- Draft PR creation accepts no caller arguments, requires a GitHub `origin`, disables interactive prompts, and uses repository defaults for title, body, and base branch.
- Repository and user Git hooks are disabled for controlled mutations; commit signing is disabled.
- Configured external `clean`, `smudge`, or `process` filters cause staging, checkout, and merge operations to fail closed.
- No arbitrary Shell access.
- No automatic commit or automatic push: both require a separate explicit tool call, and push is limited to the current branch on `origin`.
- No file access outside the currently authorized workspace or managed worktree.
- No worktree deletion is exposed; cleanup remains a manual operator action outside the Bridge.

Keep all local paths, tunnel addresses, credentials, and other secret values out of version control.
