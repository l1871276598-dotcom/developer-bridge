# Controlled Branch and Worktree Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six narrowly scoped Git branch/worktree MCP tools with live authorized-context switching, then create a separate executable macOS launcher that advertises and configures those permissions.

**Architecture:** A new workspace context owns the initial repository identity, current worktree, current branch, managed worktree root, and a FIFO operation lock. A separate tool module validates fixed schemas and invokes Git with argument arrays; `bridge-core.js` snapshots the context for every operation, while existing Git write tools receive that snapshot instead of reading mutable environment variables.

**Tech Stack:** Node.js ESM, `node:test`, Git CLI via `spawn`, MCP SDK, Bash 3.2-compatible macOS launcher.

---

## File map

- Create `src/workspace-context.js` for authorization state and serialization.
- Create `src/git-branch-worktree-tools.js` for the six tool schemas and handlers.
- Create `test/git-branch-worktree-tools.test.js` for temporary-repository behavior and security tests.
- Modify `src/bridge-core.js` to route every tool through a context snapshot.
- Modify `src/git-write-tools.js` to use an injected snapshot.
- Modify core, debug, startup, and MCP integration tests for the 16-tool surface.
- Modify `README.md` with the new guarantees and exclusions.
- Create `/Users/user/Desktop/启动Developer Bridge-分支与Worktree权限.command` without changing the source launcher.
- Create `test/test_branch_worktree_launcher.sh` for the external launcher contract.

### Task 1: Serialized workspace context

**Files:**
- Create: `src/workspace-context.js`
- Create: `test/git-branch-worktree-tools.test.js`

- [ ] **Step 1: Write failing context tests**

Create a temporary repository on `feat/start`, initialize the context, and assert:

```js
assert.deepEqual(context.snapshot(), {
  root: realWorkspace,
  branch: "feat/start",
  initialRoot: realWorkspace,
  commonDir: realCommonDir,
  managedRoot: path.join(path.dirname(realWorkspace), `${path.basename(realWorkspace)}-worktrees`),
});
```

Queue two asynchronous `runExclusive` calls and assert the event order is `a1,a2,b1,b2`. Reject a non-repository, a subdirectory instead of the Git top level, detached HEAD, `main`, and `master`.

- [ ] **Step 2: Verify the test fails**

Run: `node --test test/git-branch-worktree-tools.test.js --test-name-pattern='workspace context'`

Expected: FAIL because `src/workspace-context.js` is absent.

- [ ] **Step 3: Implement the context API**

Export `createWorkspaceContext(workspace, options)`. Resolve the workspace and `git rev-parse --show-toplevel` to the same real path, resolve `git rev-parse --git-common-dir`, read a non-protected current branch, and derive `<parent>/<repo>-worktrees`. Return:

```js
Object.freeze({
  snapshot: () => state,
  replace(next) { state = Object.freeze({ ...state, ...next }); },
  runExclusive(operation) {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  },
});
```

All Git calls use `spawn` with `shell: false`, a 30-second timeout, and 200 KiB output limits.

- [ ] **Step 4: Verify and commit**

```bash
node --test test/git-branch-worktree-tools.test.js --test-name-pattern='workspace context'
git add src/workspace-context.js test/git-branch-worktree-tools.test.js
git commit -m "feat: add serialized workspace authorization context"
```

Expected: tests PASS and the commit succeeds.

### Task 2: Controlled branch tools

**Files:**
- Create: `src/git-branch-worktree-tools.js`
- Modify: `test/git-branch-worktree-tools.test.js`

- [ ] **Step 1: Write failing list/create/switch tests**

Assert strict schemas and these outcomes:

```js
assert.match(text(await invoke("git_branch_list", {})), /feat\/start/);
await invoke("git_branch_create", { branch: "feat/new", switch: false });
assert.equal(context.snapshot().branch, "feat/start");
await invoke("git_branch_switch", { branch: "feat/new" });
assert.equal(context.snapshot().branch, "feat/new");
```

Reject extra fields, missing/non-string/overlong/control-character/leading-dash names, invalid ref formats, `main`, `master`, duplicate creates, missing switch targets, branches occupied by another worktree, dirty tracked/untracked state, and merge/rebase/cherry-pick/revert/bisect state.

- [ ] **Step 2: Verify failure**

Run: `node --test test/git-branch-worktree-tools.test.js --test-name-pattern='branch'`

Expected: FAIL because branch tools are absent.

- [ ] **Step 3: Implement three strict tools**

Define `git_branch_list {}`, `git_branch_create { branch, switch }`, and `git_branch_switch { branch }`, all with `additionalProperties: false`. Revalidate inside handlers. Validate names through fixed `git check-ref-format --branch`. List local refs with `git for-each-ref`; create only from `HEAD` with `git branch -- <name> HEAD`; switch only through `git switch <existing-name>` after clean-state and operation-state checks. Re-read the actual branch before `context.replace({ branch })`. Return bounded JSON and audit only `{ branch }`.

- [ ] **Step 4: Verify and commit**

```bash
node --test test/git-branch-worktree-tools.test.js --test-name-pattern='branch'
git add src/git-branch-worktree-tools.js test/git-branch-worktree-tools.test.js
git commit -m "feat: add controlled branch tools"
```

Expected: tests PASS.

### Task 3: Managed worktree tools

**Files:**
- Modify: `src/git-branch-worktree-tools.js`
- Modify: `test/git-branch-worktree-tools.test.js`

- [ ] **Step 1: Write failing list/create/switch tests**

Test both creation modes and switching:

```js
await invoke("git_worktree_create", { branch: "feat/existing", create_branch: false });
await invoke("git_worktree_create", { branch: "feat/created", create_branch: true });
await invoke("git_worktree_switch", { branch: "feat/created" });
assert.equal(context.snapshot().root, expectedCreatedPath);
assert.equal(context.snapshot().branch, "feat/created");
```

Assert `/` becomes `--` in the derived directory. Reject path properties, external registered worktrees, symlinked roots or targets, another common directory, detached/protected worktrees, duplicates, ambiguous mappings, existing targets, and malformed porcelain. A failed switch must leave the same snapshot object.

- [ ] **Step 2: Verify failure**

Run: `node --test test/git-branch-worktree-tools.test.js --test-name-pattern='worktree'`

Expected: FAIL because worktree tools are absent.

- [ ] **Step 3: Implement three worktree tools**

Define `git_worktree_list {}`, `git_worktree_create { branch, create_branch }`, and `git_worktree_switch { branch }`. Parse `git worktree list --porcelain -z` into complete unique records. Derive only:

```js
const destination = path.join(snapshot.managedRoot, branch.replaceAll("/", "--"));
```

Require the canonical destination to remain directly below the canonical managed root. For existing branches run `git worktree add -- <destination> <branch>`; for new branches run `git worktree add -b <branch> -- <destination> HEAD`. Switch by branch name resolved from a fresh worktree list; require the initial root or a strictly contained managed path, equal common directory, clean state, and safe attached branch before atomically replacing `{ root, branch }`.

- [ ] **Step 4: Verify and commit**

```bash
node --test test/git-branch-worktree-tools.test.js
git add src/git-branch-worktree-tools.js test/git-branch-worktree-tools.test.js
git commit -m "feat: add managed worktree tools"
```

Expected: tests PASS without network access.

### Task 4: Wire context through every Bridge operation

**Files:**
- Modify: `src/bridge-core.js`
- Modify: `src/git-write-tools.js`
- Modify: `test/bridge-core.test.js`
- Modify: `test/debug-tools.test.js`

- [ ] **Step 1: Write failing integration tests**

Expect 16 tools, inserting the six new names after `run_validation`. Switch to a managed worktree containing a distinct marker, then prove `read_file`, `write_file`, `git_status`, `git_diff`, `run_tests`, `git_stage`, and `git_commit` affect only that root. Add a queued read/switch test proving one invocation uses one immutable snapshot.

- [ ] **Step 2: Verify failure**

Run: `node --test test/bridge-core.test.js test/debug-tools.test.js`

Expected: FAIL because the current core captures the initial root and reports 10 tools.

- [ ] **Step 3: Refactor core dispatch**

Initialize:

```js
const workspaceContext = options.workspaceContext || await createWorkspaceContext(workspace, {
  managedRoot: process.env.DEVELOPER_BRIDGE_WORKTREE_ROOT || undefined,
});
```

Wrap each call in `workspaceContext.runExclusive`, take one snapshot, and pass it to root-dependent file, Git, test, and validation helpers. Dispatch the six new names to `handleGitBranchWorktreeTool(name, args, workspaceContext)`. Preserve existing symlink, hard-link, size, timeout, bounded-output, and audit protections.

- [ ] **Step 4: Refactor existing Git writes**

Use this signature:

```js
export async function handleGitWriteTool(name, args = {}, snapshot) {
  if (!snapshot?.root || !snapshot?.branch) throw new Error("Missing authorized workspace snapshot.");
  return dispatchFixedWrite(name, args, snapshot);
}
```

Remove runtime workspace/branch environment reads from `git-write-tools.js`. Immediately before mutation, compare actual real top level, common directory, and branch with the supplied snapshot.

- [ ] **Step 5: Verify and commit**

```bash
node --test test/bridge-core.test.js test/debug-tools.test.js test/git-branch-worktree-tools.test.js
npm test
git add src/bridge-core.js src/git-write-tools.js test/bridge-core.test.js test/debug-tools.test.js
git commit -m "feat: switch bridge tools with authorized worktree context"
```

Expected: the focused and full suites PASS.

### Task 5: Transport discovery, startup policy, and documentation

**Files:**
- Modify: `test/mcp-integration.test.js`
- Modify: `test/startup.test.js`
- Modify: `README.md`

- [ ] **Step 1: Write failing transport and startup tests**

Expect the same exact 16 names over stdio and HTTP, then safely call both list tools. Test rejection of relative, NUL-containing, URL-like, and workspace-equal `DEVELOPER_BRIDGE_WORKTREE_ROOT` values without logging the value.

- [ ] **Step 2: Verify failure**

Run: `node --test test/mcp-integration.test.js test/startup.test.js`

Expected: FAIL until discovery and startup validation are updated.

- [ ] **Step 3: Implement startup validation and docs**

Accept an omitted policy root or an absolute normalized path whose existing ancestor resolves canonically without escaping through a symlink. Document all 16 tools, managed layout, clean-state switching, protected branches, live context, and absence of deletion, force, detach, arbitrary paths, and arbitrary arguments.

- [ ] **Step 4: Verify and commit**

```bash
node --test test/mcp-integration.test.js test/startup.test.js
npm test
git add test/mcp-integration.test.js test/startup.test.js README.md
git commit -m "docs: expose controlled branch and worktree workflow"
```

Expected: all tests PASS.

### Task 6: Generate the separate launcher

**Files:**
- Create: `/Users/user/Desktop/启动Developer Bridge-分支与Worktree权限.command`
- Create: `test/test_branch_worktree_launcher.sh`

- [ ] **Step 1: Write a failing launcher contract test**

Capture the original SHA-256, then assert the new launcher exists, is executable, passes `bash -n`, differs from the original, exports `DEVELOPER_BRIDGE_WORKTREE_ROOT`, and contains these exact summaries:

```text
创建/切换 Git 分支
创建/列出/切换受控 worktree
不包含删除、强制切换或任意 Git 参数
```

Recheck the original hash after the test.

- [ ] **Step 2: Verify failure**

Run: `bash test/test_branch_worktree_launcher.sh`

Expected: FAIL because the new launcher is absent.

- [ ] **Step 3: Create the launcher without overwriting the source**

Reproduce the approved source through `apply_patch`. After selecting `workspace`, set:

```bash
repo_name="${workspace##*/}"
repo_parent="${workspace%/*}"
worktree_root="$repo_parent/$repo_name-worktrees"
export DEVELOPER_BRIDGE_WORKTREE_ROOT="$worktree_root"
```

Keep detached and `main/master` rejection. Add the three exact permission summaries. Do not add delete, force, prune, move, arbitrary shell, arbitrary path, or arbitrary Git argument controls.

- [ ] **Step 4: Verify and commit the repository-side test**

```bash
chmod 755 '/Users/user/Desktop/启动Developer Bridge-分支与Worktree权限.command'
bash -n '/Users/user/Desktop/启动Developer Bridge-分支与Worktree权限.command'
bash test/test_branch_worktree_launcher.sh
git add test/test_branch_worktree_launcher.sh
git commit -m "test: verify branch and worktree launcher contract"
```

Expected: all checks PASS; the desktop launcher remains outside Git.

### Task 7: Final verification

**Files:**
- Verify all modified files and both desktop launchers.

- [ ] **Step 1: Run complete static and automated checks**

```bash
node --check src/workspace-context.js
node --check src/git-branch-worktree-tools.js
node --check src/bridge-core.js
node --check src/git-write-tools.js
bash -n '/Users/user/Desktop/启动Developer Bridge-分支与Worktree权限.command'
npm test
bash test/test_branch_worktree_launcher.sh
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Verify the permission surface in a temporary repository**

Start stdio, assert the exact 16 names, create `feat/verify`, create its managed worktree, switch context, read a marker, and list worktrees. Do not call push, delete, merge, or a real remote.

- [ ] **Step 3: Verify final filesystem state**

```bash
git status --short --branch
stat -f '%Sp %N' '/Users/user/Desktop/启动Developer Bridge-增强权限.command' '/Users/user/Desktop/启动Developer Bridge-分支与Worktree权限.command'
shasum -a 256 '/Users/user/Desktop/启动Developer Bridge-增强权限.command'
```

Expected: only intentional commits are ahead of origin, both launchers exist, the new launcher is executable, and the original hash is unchanged.

