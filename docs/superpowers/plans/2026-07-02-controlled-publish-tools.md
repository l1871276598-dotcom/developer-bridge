# Controlled Publish Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add nine strictly scoped Python, Git, CI, and pull-request tools that can publish and squash-merge the current authorized workspace without exposing a generic shell or arbitrary repository access.

**Architecture:** Keep file operations and existing read-only Git behavior in `bridge-core.js`, extract the bounded subprocess primitive into a focused module, and add separate local-publish and GitHub-publish modules. Both publish modules receive only the canonical workspace root and internal executable overrides; together with the six existing tools they expose exactly fifteen strict tool definitions through narrow `invoke` interfaces.

**Tech Stack:** Node.js ESM, MCP tool schemas, `child_process.spawn`, Git CLI, GitHub CLI (`gh`), Node test runner, temporary Git/bare repositories, fake `gh` fixtures.

---

## File Map

- Create `src/bounded-process.js`: one reusable, output-bounded, timeout-aware, process-group-safe subprocess runner.
- Create `src/local-publish-tools.js`: definitions and handlers for `run_python_file`, `git_add`, and `git_commit`.
- Create `src/github-publish-tools.js`: definitions and handlers for `git_push`, `ci_status`, and all PR tools.
- Modify `src/bridge-core.js`: import the shared runner, compose thirteen existing/local/GitHub definitions, dispatch publish tools, and emit redacted audit metadata.
- Create `test/local-publish-tools.test.js`: Python, staging, commit, path, hook, timeout, and output-bound tests.
- Create `test/github-publish-tools.test.js`: fake-`gh`, bare-remote, push, CI, PR update, confirmation, and merge-gate tests.
- Modify `test/bridge-core.test.js`, `test/debug-tools.test.js`, and `test/mcp-integration.test.js`: expected tool discovery and transport coverage.
- Modify `README.md`: document the approved tools, confirmation phrases, prerequisites, and security boundary.
- Preserve without staging or editing: `src/test-supervisor.js.bak` and `src/test-supervisor.js.save`.
- Preserve the existing unstaged `src/test-supervisor.js` content unless a separately reviewed test proves a required compatibility change.

## Task 1: Extract the bounded process runner without behavior change

**Files:**
- Create: `src/bounded-process.js`
- Modify: `src/bridge-core.js`
- Test: `test/debug-tools.test.js`

- [ ] **Step 1: Add a regression test for the exported runner contract**

Append a test that runs a deterministic Node child and asserts the existing structured shape:

```js
import { runBoundedProcess } from "../src/bounded-process.js";

test("bounded runner returns exit, output, timeout, and overflow fields", async () => {
  const result = await runBoundedProcess(process.execPath, [
    "-e", "console.log('OUT'); console.error('ERR'); process.exitCode=7",
  ], { cwd: process.cwd(), timeoutMs: 2_000 });
  assert.deepEqual(
    Object.keys(result).sort(),
    ["exitCode", "outputLimitExceeded", "signal", "stderr", "stdout", "timedOut"].sort(),
  );
  assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /OUT/);
  assert.match(result.stderr, /ERR/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/debug-tools.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/bounded-process.js`.

- [ ] **Step 3: Move the existing runner into the new module**

Export the current limits and runner under the exact name `runBoundedProcess`. Move the existing `runFixedProcess` implementation from `src/bridge-core.js` without changing its control flow, then change its environment option from `envOverrides` to a complete `env` object. The exported declaration begins:

```js
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_TERMINATION_GRACE_MS = 2_000;

export function runBoundedProcess(command, args, {
  cwd,
  timeoutMs,
  stdoutLimit = MAX_COMMAND_OUTPUT_BYTES,
  stderrLimit = MAX_COMMAND_OUTPUT_BYTES,
  detached = false,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  env = process.env,
} = {}) {
  return runSpawnLifecycle(command, args, {
    cwd, timeoutMs, stdoutLimit, stderrLimit, detached, terminationGraceMs, env,
  });
}
```

Define the private `runSpawnLifecycle` by moving the complete existing spawn/chunk/timeout/process-group body into it. The module must copy `env`, delete `NODE_TEST_CONTEXT`, use `shell:false`, ignore stdin, bound each output stream independently, and retain the existing process-group grace-period behavior. Replace `runFixedProcess` calls in `bridge-core.js` with `runBoundedProcess`; pass `{ ...process.env, ...SAFE_GIT_ENV }` for Git.

- [ ] **Step 4: Run existing process and debug tests**

Run: `node --test test/debug-tools.test.js test/p2-security-audit.test.js`

Expected: all tests pass, including timeout/grandchild/PGID ownership tests.

- [ ] **Step 5: Commit only the runner extraction**

```bash
git add src/bounded-process.js src/bridge-core.js test/debug-tools.test.js
git commit -m "refactor: share bounded process runner"
```

## Task 2: Add isolated workspace Python execution

**Files:**
- Create: `src/local-publish-tools.js`
- Create: `test/local-publish-tools.test.js`
- Modify: `src/bridge-core.js`

- [ ] **Step 1: Write failing Python execution and path-boundary tests**

Create a temporary workspace and exercise the core through the MCP result shape:

```js
test("run_python_file executes one validated workspace script with isolated mode", async (t) => {
  const { workspace, core } = await fixture(t, { publishTimeoutMs: 2_000 });
  await writeFile(path.join(workspace, "task.py"),
    "import os,sys\nprint(os.getcwd())\nprint(sys.flags.isolated)\n", "utf8");
  const payload = JSON.parse(resultText(await core.callTool("run_python_file", { path: "task.py" })));
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.timedOut, false);
  assert.match(payload.stdout, /\n1\n$/);
});

for (const pathValue of ["../outside.py", "/tmp/outside.py", "task.txt", "-c", "link.py"]) {
  test(`run_python_file rejects ${pathValue}`, async (t) => {
    const { core } = await fixture(t);
    const result = await core.callTool("run_python_file", { path: pathValue });
    assert.equal(result.isError, true);
  });
}
```

Add separate tests for a symlink escape, hard link, non-regular file, non-string path, unexpected `args`, 120-second default exposed through a short test override, 1 MiB stdout/stderr limits, non-zero exit preservation, and descendant termination.

- [ ] **Step 2: Run the new file and verify RED**

Run: `node --test test/local-publish-tools.test.js`

Expected: FAIL because `run_python_file` is unknown.

- [ ] **Step 3: Define and implement `run_python_file`**

In `src/local-publish-tools.js`, export:

```js
export const LOCAL_PUBLISH_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "run_python_file",
    description: "Run one existing Python file inside the authorized workspace without interpreter arguments.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
]);

export function createLocalPublishTools({ root, existingFile, runProcess, timeoutMs, pythonCommand = "python3" }) {
  const names = new Set(["run_python_file"]);
  return { names, invoke };
}
```

Define the private `invoke(name, args)` in the same module. It must reject names outside `names`, enforce exactly one string `path`, validate `.py` after normalizing the relative path, call the bridge-provided verified existing-file resolver, and run `python3 -I <canonical-file>` with `cwd:root`, `detached:true`, and the bounded runner. Return the complete structured runner result as JSON; startup failures become `ToolError("Python could not be started")`.

Compose the definition and handler into `createBridgeCore`. Add `options.publishTimeoutMs`, `options.pythonCommand`, and `options.publishTerminationGraceMs` as internal test seams with positive-integer validation.

- [ ] **Step 4: Run Python tests and full existing core tests**

Run: `node --test test/local-publish-tools.test.js test/bridge-core.test.js test/debug-tools.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit Python execution**

```bash
git add src/local-publish-tools.js src/bridge-core.js test/local-publish-tools.test.js test/bridge-core.test.js
git commit -m "feat: add controlled Python file execution"
```

## Task 3: Add exact-path staging and hook-free commits

**Files:**
- Modify: `src/local-publish-tools.js`
- Modify: `test/local-publish-tools.test.js`

- [ ] **Step 1: Write failing `git_add` tests**

Cover exact relative paths and rejection of repository-wide/pathspec forms:

```js
test("git_add stages only explicit validated paths", async (t) => {
  const { workspace, core } = await fixture(t);
  await writeFile(path.join(workspace, "one.txt"), "one\n", "utf8");
  await writeFile(path.join(workspace, "two.txt"), "two\n", "utf8");
  const result = await core.callTool("git_add", { paths: ["one.txt"] });
  assert.equal(result.isError, undefined);
  assert.match(await gitStdout(workspace, "diff", "--cached", "--name-only"), /^one\.txt\n$/);
});

for (const value of [[], ["."], ["-A"], [":(glob)*"], ["!secret"], [".git/config"], ["node_modules/x"]]) {
  test(`git_add rejects ${JSON.stringify(value)}`, async (t) => {
    const { core } = await fixture(t);
    assert.equal((await core.callTool("git_add", { paths: value })).isError, true);
  });
}
```

Add tests for duplicates, more than 128 paths, symlink escape, hard links, missing paths, non-root authorized subdirectories, and a clean-filter canary that documents the accepted repository-code trust boundary.

- [ ] **Step 2: Write failing `git_commit` tests**

```js
test("git_commit commits staged content without hooks or signing", async (t) => {
  const { workspace, core } = await fixture(t);
  await writeFile(path.join(workspace, "change.txt"), "change\n", "utf8");
  await core.callTool("git_add", { paths: ["change.txt"] });
  await installFailingHook(workspace, "pre-commit", "pre-commit-canary");
  await git(workspace, "config", "commit.gpgSign", "true");
  const result = await core.callTool("git_commit", { message: "feat: controlled commit" });
  assert.equal(result.isError, undefined);
  assert.equal(await gitStdout(workspace, "show", "-s", "--format=%s", "HEAD"), "feat: controlled commit\n");
  await assert.rejects(access(path.join(workspace, "pre-commit-canary")));
});
```

Reject empty/whitespace/multiline/leading-dash messages, messages over 200 UTF-8 bytes, extra author/amend/verify arguments, and commits with an empty index diff.

- [ ] **Step 3: Run both test groups and verify RED**

Run: `node --test test/local-publish-tools.test.js`

Expected: new tests fail because `git_add` and `git_commit` are unknown.

- [ ] **Step 4: Implement both strict tools**

Add exact schemas:

```js
{ name: "git_add", inputSchema: { type: "object", properties: {
  paths: { type: "array", minItems: 1, maxItems: 128, items: { type: "string" } },
}, required: ["paths"], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: true } }

{ name: "git_commit", inputSchema: { type: "object", properties: {
  message: { type: "string", minLength: 1, maxLength: 200 },
}, required: ["message"], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: true } }
```

Before either operation run `git rev-parse --show-toplevel`, canonicalize it, and require equality with `root`. Use `git add -- <deduplicated paths>`. For commit, require non-empty `git diff --cached --quiet` status and run:

```text
git -c core.hooksPath=/dev/null -c commit.gpgSign=false commit --no-verify --no-gpg-sign -m <message>
```

Return staged short status for add and `{ oid, summary }` JSON for commit. Never put the message in audit metadata.

- [ ] **Step 5: Run local publish and security tests**

Run: `node --test test/local-publish-tools.test.js test/p2-security-audit.test.js`

Expected: all tests pass and hook/signing canaries remain absent.

- [ ] **Step 6: Commit staging and commit tools**

```bash
git add src/local-publish-tools.js test/local-publish-tools.test.js
git commit -m "feat: add controlled staging and commits"
```

## Task 4: Add current-repository GitHub context and guarded push

**Files:**
- Create: `src/github-publish-tools.js`
- Create: `test/github-publish-tools.test.js`
- Modify: `src/bridge-core.js`

- [ ] **Step 1: Build a fake `gh` fixture and write failing context tests**

The fake executable reads one JSON response queue file and writes every argv array to a JSON-lines call log. Inject it with `createBridgeCore(..., { ghCommand: fakeGh })`; never alter global PATH.

```js
test("GitHub operations reject a repository different from origin", async (t) => {
  const { core, gh } = await githubFixture(t, {
    repoView: { nameWithOwner: "owner/other", defaultBranchRef: { name: "main" } },
  });
  const result = await core.callTool("ci_status", {});
  assert.equal(result.isError, true);
  assert.match(resultText(result), /repository identity/i);
  assert.deepEqual(await gh.mutatingCalls(), []);
});
```

Test accepted HTTPS and SSH `origin` forms, reject embedded credentials, non-GitHub hosts, additional remotes, subdirectory roots, detached HEAD, and malformed/oversized `gh` JSON.

- [ ] **Step 2: Write failing normal/force/delete push tests**

Use a local bare remote for Git object transfer and fake only GitHub metadata/protection calls. Cover:

```js
await core.callTool("git_push", { mode: "normal" });
await core.callTool("git_push", {
  mode: "force_with_lease", confirm: `FORCE PUSH ${branch}`,
});
await core.callTool("git_push", {
  mode: "delete_current", confirm: `DELETE REMOTE BRANCH ${branch}`,
});
```

Assert normal push sets upstream; force uses an explicit `<ref>:<observed-oid>` lease and rejects a stale lease; delete removes only the current remote branch. Reject wrong/missing confirmations, normal `force`, tags, arbitrary refspecs/remotes/branches, default branch, protected branch, and any protection lookup error. Install a `pre-push` canary and prove it never runs.

- [ ] **Step 3: Run the new file and verify RED**

Run: `node --test test/github-publish-tools.test.js`

Expected: FAIL because `git_push` and the GitHub module do not exist.

- [ ] **Step 4: Implement repository context and `git_push`**

Export:

```js
export const GITHUB_PUBLISH_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "git_push",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["normal", "force_with_lease", "delete_current"] },
        confirm: { type: "string" },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
]);

export function createGitHubPublishTools({
  root, runProcess, gitCommand = "git", ghCommand = "gh", timeoutMs,
}) {
  const names = new Set(GITHUB_PUBLISH_TOOL_DEFINITIONS.map(({ name }) => name));
  return { names, invoke };
}
```

Define private `invoke(name, args)` in the same module and dispatch only names in `names`; its `git_push` branch must enforce the schema again before resolving repository state.

Resolve and cache nothing across calls: each write re-reads top level, branch, origin URL, `gh repo view --json nameWithOwner,defaultBranchRef`, remote ref OID, and branch protection. Compare normalized GitHub owner/name case-insensitively. For a local bare remote test seam, accept `options.expectedGitHubRepository` only when `NODE_ENV === "test"`; production always derives identity from a GitHub origin.

Run push with an explicit validated origin URL, `--no-verify`, no tags, and the exact current-branch refspec. Destructive modes query default/protection state immediately before mutation and fail closed.

- [ ] **Step 5: Run push tests and existing Git security tests**

Run: `node --test test/github-publish-tools.test.js test/debug-tools.test.js test/p2-security-audit.test.js`

Expected: all tests pass.

- [ ] **Step 6: Commit guarded push support**

```bash
git add src/github-publish-tools.js src/bridge-core.js test/github-publish-tools.test.js
git commit -m "feat: add guarded current-branch push"
```

## Task 5: Add CI status, draft creation, and PR updates

**Files:**
- Modify: `src/github-publish-tools.js`
- Modify: `test/github-publish-tools.test.js`

- [ ] **Step 1: Write failing `ci_status` tests**

Fake an associated current-branch PR and check runs. Assert the returned JSON includes only bounded fields `number`, `name`, `state`, `conclusion`, and `url`; reject no PR, multiple PRs, wrong head branch, malformed JSON, command failure, and output overflow. Confirm no mutating `gh` call occurs.

- [ ] **Step 2: Write failing draft-create tests**

Assert `pr_create_draft({ title, body })` issues one `gh pr create --draft --head <current> --base <default>` call. Reject an existing open PR, empty/over-256-byte title, over-65,536-byte body, detached/default branch, extra fields, and repository mismatch.

- [ ] **Step 3: Write failing update tests**

Cover title, body, labels, reviewers, comment, and `ready:true`. Require at least one update field, current-repository/current-branch ownership, open state, conservative `/^[A-Za-z0-9_.-]+$/` label/reviewer names, maximum 32 entries, deduplication, bounded text, and draft state before Ready. Verify each accepted action maps to fixed `gh pr edit`, `gh pr comment`, or `gh pr ready` argv with no shell.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `node --test test/github-publish-tools.test.js --test-name-pattern='ci_status|pr_create_draft|pr_update'`

Expected: tests fail because the three tools are unknown.

- [ ] **Step 5: Implement the three tools**

Add strict definitions and annotations:

```js
{ name: "ci_status", inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: true } }
{ name: "pr_create_draft", inputSchema: { type: "object", properties: {
  title: { type: "string", minLength: 1, maxLength: 256 },
  body: { type: "string", maxLength: 65536 },
}, required: ["title", "body"], additionalProperties: false },
  annotations: { readOnlyHint: false, openWorldHint: true } }
{ name: "pr_update", inputSchema: { type: "object", properties: {
  number: { type: "integer", minimum: 1 }, title: { type: "string", maxLength: 256 },
  body: { type: "string", maxLength: 65536 }, comment: { type: "string", maxLength: 65536 },
  add_labels: { type: "array", maxItems: 32, items: { type: "string" } },
  add_reviewers: { type: "array", maxItems: 32, items: { type: "string" } },
  ready: { type: "boolean" },
}, required: ["number"], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }
```

Use only fixed `gh` subcommands with JSON output for reads and discrete argv items for writes. Query PR identity immediately before every write. Return parsed, bounded summaries rather than raw CLI output.

- [ ] **Step 6: Run all GitHub publish tests**

Run: `node --test test/github-publish-tools.test.js`

Expected: all tests pass.

- [ ] **Step 7: Commit CI and PR editing**

```bash
git add src/github-publish-tools.js test/github-publish-tools.test.js
git commit -m "feat: add controlled CI and PR updates"
```

## Task 6: Add strongly gated squash merge and close

**Files:**
- Modify: `src/github-publish-tools.js`
- Modify: `test/github-publish-tools.test.js`

- [ ] **Step 1: Write failing merge-gate tests**

Build a table that rejects each unsafe state independently: wrong confirmation, wrong repository, wrong head branch, closed PR, draft PR, `mergeable` not `MERGEABLE`, no checks, queued/in-progress checks, and conclusions other than success. For the safe case require:

```js
const result = await core.callTool("pr_merge", {
  number: 25,
  confirm: "MERGE PR #25",
});
assert.equal(result.isError, undefined);
assert.deepEqual(await gh.lastArgv(), ["pr", "merge", "25", "--squash"]);
```

Prove `--admin`, `--auto`, merge/rebase methods, branch deletion, and arbitrary repository flags never appear.

- [ ] **Step 2: Write failing close-gate tests**

Require `CLOSE PR #25`, current repository/current branch, and open state. Assert the only mutation is `gh pr close 25` and that no branch deletion follows. Reject wrong number types, missing confirmation, draft ambiguity, closed/merged state, and extra fields.

- [ ] **Step 3: Run merge/close tests and verify RED**

Run: `node --test test/github-publish-tools.test.js --test-name-pattern='pr_merge|pr_close'`

Expected: tests fail because the tools are unknown.

- [ ] **Step 4: Implement exact confirmation and fail-closed state gates**

Define both tools with required positive integer `number` and required `confirm`. Re-query PR JSON and checks immediately before mutation. Treat missing, unknown, skipped, neutral, cancelled, timed-out, action-required, or malformed check conclusions as blocking. Require at least one check and every conclusion equal to `SUCCESS` after normalization.

Run only `gh pr merge <number> --squash` or `gh pr close <number>`. Return a bounded summary containing PR number and resulting state; do not echo confirmation text into logs.

- [ ] **Step 5: Run all GitHub tests**

Run: `node --test test/github-publish-tools.test.js`

Expected: all tests pass with zero unexpected fake-`gh` calls.

- [ ] **Step 6: Commit merge and close gates**

```bash
git add src/github-publish-tools.js test/github-publish-tools.test.js
git commit -m "feat: gate PR merge and close operations"
```

## Task 7: Complete MCP discovery, audit logging, documentation, and regression

**Files:**
- Modify: `src/bridge-core.js`
- Modify: `test/bridge-core.test.js`
- Modify: `test/debug-tools.test.js`
- Modify: `test/mcp-integration.test.js`
- Modify: `test/package-config.test.js`
- Modify: `README.md`

- [ ] **Step 1: Update failing discovery expectations to the exact fifteen-tool order**

Use this order everywhere:

```js
[
  "list_files", "read_file", "write_file", "git_status", "git_diff", "run_tests",
  "run_python_file", "git_add", "git_commit", "git_push", "ci_status",
  "pr_create_draft", "pr_update", "pr_merge", "pr_close",
]
```

Assert every schema has `additionalProperties:false`; read-only annotations apply only to list/read/status/diff/CI; destructive annotations apply to file writes, Python, Git writes, PR update, merge, and close.

- [ ] **Step 2: Run discovery tests and verify RED**

Run: `node --test test/bridge-core.test.js test/mcp-integration.test.js`

Expected: FAIL until both transports expose the exact fifteen-tool list.

- [ ] **Step 3: Compose definitions and handlers in `bridge-core.js`**

Construct the final definitions as:

```js
const allTools = Object.freeze([
  ...CORE_TOOL_DEFINITIONS,
  ...LOCAL_PUBLISH_TOOL_DEFINITIONS,
  ...GITHUB_PUBLISH_TOOL_DEFINITIONS,
]);
```

Delegate recognized names to the matching module. Each invocation returns `{ text, audit }`; log only allowlisted audit keys: `path_count`, `commit`, `mode`, `branch`, and `pr`. Sanitize all display values and never log Python output, Git/gh stderr, commit message, PR text, remote URL, workspace root, MCP route, or token.

- [ ] **Step 4: Extend transport integration without real remote writes**

In `exerciseAllTools`, discover all fifteen tools, execute existing safe tools, execute `run_python_file`, `git_add`, and `git_commit` in the temporary workspace, and call GitHub tools only against the injected fake `gh` seam in core-level integration. Transport tests verify schemas/discovery but do not push or mutate GitHub.

- [ ] **Step 5: Update README and package documentation assertions**

Document Python's non-sandboxed risk, exact-path staging, hook-free commit, push modes and confirmations, GitHub CLI authentication, draft/update/CI/merge/close behavior, current-repository scope, fail-closed protection, output/timeout limits, and the explicit absence of generic shell/arbitrary repositories/protection bypass.

- [ ] **Step 6: Run focused tests, then the full suite twice**

Run:

```bash
node --test test/local-publish-tools.test.js test/github-publish-tools.test.js
npm test
npm test
git diff --check
```

Expected: every command exits 0, both full runs report zero failures, and diff check is empty.

- [ ] **Step 7: Scan for secret leakage and unintended files**

Run:

```bash
git diff --cached --name-only
git diff -- . ':!src/test-supervisor.js' ':!src/test-supervisor.js.bak' ':!src/test-supervisor.js.save'
rg -n '(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_|-----BEGIN .*PRIVATE KEY-----)' src test README.md
git status -sb
```

Expected: no credential matches; only planned files are staged/modified; the pre-existing supervisor files remain untouched and unstaged.

- [ ] **Step 8: Commit final integration and documentation**

```bash
git add src/bridge-core.js test/bridge-core.test.js test/debug-tools.test.js \
  test/mcp-integration.test.js test/package-config.test.js README.md
git commit -m "docs: document controlled publish workflow"
```

- [ ] **Step 9: Restart and manually verify discovery without performing destructive actions**

Stop the current Bridge and ngrok windows, relaunch with `启动Developer Bridge.command`, refresh or recreate the ChatGPT connector, and verify the fifteen tool names. Call `git_status`, `ci_status`, and a harmless workspace Python fixture only after confirming the displayed authorized workspace. Do not force-push, delete, merge, or close during discovery verification.

## Execution Constraints

- Work on `feat/v0.2-safe-debug-loop`, never `main` or `master`.
- Do not stage, overwrite, delete, or restore `src/test-supervisor.js`, `src/test-supervisor.js.bak`, or `src/test-supervisor.js.save` without a separate explicit user decision.
- Do not use real GitHub mutations during automated tests.
- Do not add pooling, generic command execution, arbitrary repository parameters, or merge-protection bypasses.
- Stop and ask if a task requires credentials outside the existing authenticated `gh` keyring session.
