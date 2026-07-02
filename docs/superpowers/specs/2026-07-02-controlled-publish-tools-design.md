# Controlled Publish Tools Design

Date: 2026-07-02

## Goal

Extend Developer Bridge with narrowly scoped Python, Git, GitHub Actions, and pull-request tools for the currently authorized workspace. The tools support a complete test-to-merge workflow without exposing a generic shell, arbitrary Git arguments, or arbitrary GitHub repositories.

## Scope

The bridge adds nine tools:

1. `run_python_file`
2. `git_add`
3. `git_commit`
4. `git_push`
5. `ci_status`
6. `pr_create_draft`
7. `pr_update`
8. `pr_merge`
9. `pr_close`

Existing file, status, diff, and preset-test tools retain their current behavior.

All Git and GitHub write operations are restricted to the repository rooted exactly at the authorized workspace. GitHub tools derive the repository from that workspace and never accept an arbitrary `owner/repo` value.

## Tool Contracts

### `run_python_file`

Accepts one required relative `path`. The target must be an existing regular `.py` file inside the authorized workspace. Absolute paths, traversal, symlinks, non-Python files, interpreter flags, module names, `-c`, stdin programs, and user-supplied arguments are rejected.

The bridge runs `python3 -I <validated-path>` with the workspace as the current directory, a 120-second timeout, process-group termination, and independent 1 MiB stdout and stderr limits. Isolated mode limits Python environment injection but does not sandbox the script: an authorized script may still read local files, access the network, or create subprocesses.

### `git_add`

Accepts a required non-empty array of explicit relative file paths. Each path must remain inside the authorized workspace and must not target protected paths such as `.git`, `.env`, private keys, or `node_modules`. Duplicate paths are removed. Repository-wide forms such as `.`, `-A`, wildcards, pathspec magic, exclusions, and interactive patch mode are rejected.

The tool stages only the validated paths and returns the staged short status. Git attributes and clean filters remain a repository trust concern; this is acceptable within the selected authorization profile because `run_python_file` already permits execution of workspace-owned code.

### `git_commit`

Accepts a required single-line `message` with a bounded UTF-8 length. The message must not be empty or begin with `-`. The tool requires a non-empty staged diff and runs a normal commit of staged content only.

Hooks, signing, amend, empty commits, custom authors, path-limited commits, cleanup customization, and additional Git arguments are disabled. The result returns the new commit OID and a one-line summary without echoing the complete commit message into audit logs.

### `git_push`

Accepts `mode` with one of `normal`, `force_with_lease`, or `delete_current`, plus `confirm` only where required.

- `normal` pushes the current local branch to the same branch on `origin` and sets upstream when missing.
- `force_with_lease` requires `confirm` to equal `FORCE PUSH <branch>`. It uses an explicit lease containing the remote OID observed immediately before the push.
- `delete_current` requires `confirm` to equal `DELETE REMOTE BRANCH <branch>` and deletes only the remote counterpart of the current local branch.

The remote must resolve to the current GitHub repository without embedded credentials. Hooks, tags, arbitrary refspecs, arbitrary remotes, and ordinary `--force` are prohibited. Force or deletion is always denied for the repository default branch or a branch reported as protected by GitHub. If repository identity or protection status cannot be established, the destructive operation fails closed.

### `ci_status`

Takes no arguments. It resolves the pull request associated with the current branch and returns bounded structured status for GitHub Actions/check runs, including name, state, conclusion, and URL where available. It is read-only and fails clearly if no current-branch PR exists.

### `pr_create_draft`

Accepts required bounded `title` and `body`. It creates a draft pull request from the current branch to the repository default branch. It refuses to create a duplicate when the branch already has an open pull request.

### `pr_update`

Accepts a required PR `number` and one or more bounded update fields: `title`, `body`, `add_labels`, `add_reviewers`, `comment`, or `ready`. The PR must belong to the current repository and its head branch must equal the current local branch. Labels and reviewers are arrays of conservative GitHub names; arbitrary CLI arguments are not accepted.

Setting `ready=true` is allowed only after the bridge confirms that the PR is currently a draft. Other state transitions, merge, close, and branch deletion are not part of this tool.

### `pr_merge`

Accepts required PR `number` and `confirm`. The exact confirmation is `MERGE PR #<number>`.

The PR must belong to the current repository and current branch, be open, be non-draft, report no merge conflict, and have at least one check run. Every check must be completed successfully; pending, skipped, cancelled, neutral, timed-out, action-required, or failed checks block the operation. The bridge performs squash merge only, without bypassing branch protection and without deleting the branch.

### `pr_close`

Accepts required PR `number` and `confirm`. The exact confirmation is `CLOSE PR #<number>`. The PR must belong to the current repository and current branch and must be open. Closing never deletes local or remote branches.

## Execution Architecture

Tool definitions keep strict object schemas with `additionalProperties: false` and accurate MCP annotations. Each tool handler validates plain argument objects before performing any I/O.

A shared bounded-process runner executes Python, Git, and `gh` with `shell: false`, fixed working directory, timeouts, output limits, and process-group cleanup. Git write operations use a hardened environment, disable hooks where supported, and add command-specific configuration to disable signing and unintended recursion. GitHub operations use the installed authenticated `gh` CLI without reading or returning its token.

Before any Git or GitHub write operation, the bridge resolves the Git top-level directory and requires its canonical path to equal the canonical authorized workspace. GitHub repository identity, default branch, PR head branch, merge state, checks, and branch protection are queried from the current working repository. User input never selects another repository.

## Confirmations and Failure Behavior

High-risk operations require exact, state-bound confirmation phrases. A missing or incorrect phrase returns the phrase required for the currently resolved branch or PR without performing the operation. Confirmation is revalidated after repository and branch resolution.

Validation, timeout, output overflow, authentication failure, missing PR, ambiguous repository state, and GitHub API failure return bounded errors. Destructive operations fail closed whenever default-branch, protection, CI, conflict, or ownership status cannot be proven safe. No fallback widens permissions.

## Audit Logging

Logs record timestamp, tool name, result, duration, and limited metadata such as path count, commit OID prefix, push mode, branch display value, or PR number. Logs do not contain file content, Python output, commit message text, PR body/comment text, tokens, complete remote URLs, private MCP routes, or authentication headers.

## Testing

Implementation follows test-driven development. Automated tests use temporary workspaces, temporary Git repositories, local bare remotes, canary hooks and filters, deterministic subprocess fixtures, and a fake `gh` executable. The suite covers:

- strict schemas and rejected extra arguments;
- path traversal, symlink, protected-path, pathspec, and interpreter-option rejection;
- Python timeout, output bounds, failure exit codes, and descendant termination;
- exact-path staging and non-empty staged commit requirements;
- disabled commit and push hooks and disabled commit signing;
- normal push, explicit force lease, stale lease, protected/default branch denial, and confirmed deletion;
- current-repository and current-branch scoping for every GitHub tool;
- draft creation and update operations;
- CI success, failure, pending, absent, and malformed responses;
- merge and close confirmation gates and all merge preconditions;
- HTTP and stdio discovery and invocation of the complete approved tool set;
- audit-log redaction and output-size enforcement.

Tests never contact GitHub, push to a real repository, create a real pull request, or reveal credentials. After local regression passes, the running Bridge must be restarted and the ChatGPT connection refreshed or recreated so the new schemas are discovered.

## Non-Goals

The bridge does not expose a generic shell, arbitrary `python3` arguments, arbitrary Git subcommands, arbitrary `gh` arguments, repository selection, merge-rule bypass, ordinary force push, default-branch rewriting, tag management, remote creation, branch deletion during merge, PR reopening, issue management, release management, or secret access.
