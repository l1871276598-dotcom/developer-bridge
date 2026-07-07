# LAOS Native Checkpoint Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose three scope-safe native LAOS checkpoint/session tools on the real Developer Bridge endpoint and prove persistence across a fresh MCP connection.

**Architecture:** A fixed Python stdin/stdout adapter in the LAOS repository reuses `tools/serve_laos.py`, `McpCheckpointCapture`, the bridge pipeline, and `SessionStore`. A conditional Node tool group validates immutable startup configuration, invokes that adapter through a bounded fixed subprocess, and joins the existing serialized/audited Developer Bridge composition. Both MCP transports publish conditional server instructions.

**Tech Stack:** Python 3.11+ standard library, Node.js ESM, `@modelcontextprotocol/sdk`, `node:test`, Python `unittest`, SQLite/FTS5, Bash launcher.

---

## File Map

- Create LAOS `tools/developer_bridge_adapter.py`: strict JSON adapter and fixed scope enforcement.
- Create LAOS `tests/test_developer_bridge_adapter.py`: subprocess-level persistence, hashes, idempotency, scope, and malformed-input tests.
- Create Bridge `src/laos-checkpoint-tools.js`: definitions, configuration validation, fixed subprocess, result parsing, and server instructions.
- Create Bridge `test/laos-checkpoint-tools.test.js`: conditional registration, schemas, annotations, validation, injection, limits, timeout, and redaction tests.
- Modify Bridge `src/bridge-with-sync-tools.js`: append and serialize the optional three-tool group.
- Modify Bridge `mcp-http.js` and `server.js`: publish conditional instructions.
- Modify Bridge `test/mcp-integration.test.js` and `test/startup.test.js`: verify real SDK initialization and startup failures.
- Modify the external LAOS launcher only after repository tests pass: point at the new Bridge worktree and export fixed checkpoint configuration.

### Task 1: LAOS strict JSON adapter

**Files:**
- Create: `/Users/user/projects/research-agent-memory/laos-v0.8/tests/test_developer_bridge_adapter.py`
- Create: `/Users/user/projects/research-agent-memory/laos-v0.8/tools/developer_bridge_adapter.py`
- Reuse unchanged: `/Users/user/projects/research-agent-memory/laos-v0.8/tools/serve_laos.py`

- [ ] **Step 1: Write failing adapter contract tests**

Add a subprocess helper that creates an initialized data root and a non-temporary state directory under the test user's home, runs the fixed adapter with only startup environment values, and parses its single stdout JSON value:

```python
def invoke(self, request, **overrides):
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(Path.home()),
        "PYTHONUTF8": "1",
        "LAOS_DATA_ROOT": str(self.data_root),
        "LAOS_STATE_DIR": str(self.state_dir),
        "LAOS_CHECKPOINT_WORKSPACE": "personal",
        "LAOS_CHECKPOINT_PROJECT": "native-tools-test",
    }
    env.update(overrides)
    result = subprocess.run(
        [sys.executable, str(ADAPTER)],
        input=json.dumps(request, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=ROOT,
        env=env,
        timeout=10,
        check=False,
    )
    self.assertEqual(result.stderr, "")
    return result, json.loads(result.stdout)
```

Cover these exact behaviors:

```python
def test_capture_reconnect_search_and_get_preserve_exact_text_and_hashes(self): ...
def test_stable_checkpoint_id_is_idempotent(self): ...
def test_incomplete_assistant_response_is_rejected(self): ...
def test_search_and_get_cannot_escape_fixed_scope(self): ...
def test_unknown_operation_fields_paths_and_oversized_input_are_rejected(self): ...
def test_configuration_rejects_partial_invalid_overlapping_symlink_and_temporary_state(self): ...
```

The persistence test must invoke a new adapter subprocess for capture, search, and get and compare the restored user/assistant strings and SHA-256 values exactly.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
python3 -m unittest tests.test_developer_bridge_adapter -v
```

Expected: FAIL because `tools/developer_bridge_adapter.py` does not exist.

- [ ] **Step 3: Implement the minimum fixed adapter**

Use this concrete request/result envelope and no CLI arguments:

```python
MAX_REQUEST_BYTES = 512 * 1024
OPERATIONS = {"capture_checkpoint", "session_search", "session_get"}

def _request():
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise RequestError("invalid_request")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict) or set(value) != {"operation", "arguments"}:
        raise RequestError("invalid_request")
    if value["operation"] not in OPERATIONS or not isinstance(value["arguments"], dict):
        raise RequestError("invalid_request")
    return value

def _facade_and_scope():
    data_root = _real_directory("LAOS_DATA_ROOT")
    state_dir = _real_directory("LAOS_STATE_DIR")
    workspace = os.environ.get("LAOS_CHECKPOINT_WORKSPACE")
    project = _optional_environment("LAOS_CHECKPOINT_PROJECT")
    argv = [
        "--data-root", str(data_root), "--state-dir", str(state_dir),
        "--enable-checkpoint-capture", "--checkpoint-workspace", workspace,
    ]
    if project is not None:
        argv += ["--checkpoint-project", project]
    # Append fixed account/profile/confidentiality values when configured.
    return serve_laos.build_facade(serve_laos._parser().parse_args(argv)), workspace, project
```

Dispatch with strict per-operation key sets. Search always supplies the configured workspace/project; get checks the returned row before returning it:

```python
def _session_get(facade, arguments, workspace, project):
    if set(arguments) != {"session_id"}:
        raise RequestError("invalid_request")
    session = facade.session_get(_session_id(arguments["session_id"]))
    if session.get("workspace") != workspace or session.get("project") != project:
        raise RequestError("scope_violation")
    return session
```

`main()` prints exactly one compact JSON object. Successful output is `{"ok":true,"result":...}`. Failures are limited to `invalid_configuration`, `invalid_request`, `scope_violation`, `session_not_found`, or `request_failed`; stderr remains empty and failure exits non-zero. Do not include exception text.

- [ ] **Step 4: Run adapter tests and verify GREEN**

Run:

```bash
python3 -m unittest tests.test_developer_bridge_adapter tests.test_mcp_checkpoint tests.test_sessions tests.test_serve_laos -v
```

Expected: all tests pass with no unexpected stderr.

- [ ] **Step 5: Record LAOS status without committing**

Run:

```bash
git status --short --branch
git diff --check
```

Expected: only the two Task 1 files are new. Do not commit because LAOS `AGENTS.md` forbids automatic commits.

### Task 2: Conditional Developer Bridge tool group

**Files:**
- Create: `/Users/user/Developer/MCP/developer-bridge-worktrees/codex--fix-laos-native-tools-live/test/laos-checkpoint-tools.test.js`
- Create: `/Users/user/Developer/MCP/developer-bridge-worktrees/codex--fix-laos-native-tools-live/src/laos-checkpoint-tools.js`
- Modify: `/Users/user/Developer/MCP/developer-bridge-worktrees/codex--fix-laos-native-tools-live/src/bridge-with-sync-tools.js`

- [ ] **Step 1: Write failing conditional-registration and schema tests**

Create fixtures with canonical separate Bridge/code/data/state roots, a data marker, a fixed adapter file, and a canonical executable. Save the disabled tool-name set, then assert enabled registration preserves that set and adds only:

```js
const expectedAdded = new Set([
  "laos_capture_checkpoint",
  "laos_session_search",
  "laos_session_get",
]);
assert.deepEqual(new Set(enabledNames.filter((name) => !disabledNames.includes(name))), expectedAdded);
assert.equal(enabledNames.includes("laos_memory_task"), true);
```

Assert strict schemas, `additionalProperties: false`, write/read annotations, a search limit maximum of 50, and instructions whose first 512 characters contain the required explicit-capture and search-then-get sequence.

- [ ] **Step 2: Run registration tests and verify RED**

Run:

```bash
node --test test/laos-checkpoint-tools.test.js
```

Expected: FAIL because the three definitions are absent.

- [ ] **Step 3: Implement definitions and configuration validation**

Export:

```js
export const LAOS_CHECKPOINT_TOOL_DEFINITIONS = Object.freeze([capture, search, get]);
export const LAOS_CHECKPOINT_INSTRUCTIONS = "LAOS checkpoint capture is explicit, not passive. Call laos_capture_checkpoint once only when the user explicitly asks to save the current complete turn and the exact completed assistant response is available. In a new conversation, call laos_session_search first, then laos_session_get with the returned session ID. Do not use memory.create as a checkpoint substitute. Do not invent source conversation or message IDs. Do not save ordinary conversations automatically.";
export async function createLaosCheckpointTools(env, codeRoot, options = {}) { ... }
```

When `LAOS_ENABLE_CHECKPOINT_CAPTURE` is absent or `"0"`, return `null`. Reject every other value except `"1"`. When enabled, validate canonical non-symlink roots, data marker, pairwise non-overlap, state outside `os.tmpdir()`, `Mobile Documents`, and `CloudStorage`, workspace enum, optional bounded strings, confidentiality enum, a canonical executable `LAOS_PYTHON_EXECUTABLE`, and `tools/developer_bridge_adapter.py` as a canonical single-link file inside the pinned startup code root.

- [ ] **Step 4: Implement strict calls through stdin and the existing queue**

Normalize each tool's runtime arguments before execution. Encode only:

```js
JSON.stringify({ operation: operationByTool[name], arguments: normalizedArgs })
```

Spawn with `shell: false`, fixed `[adapter]` arguments, fixed cwd, detached process group on POSIX, a minimal environment containing only safe platform variables plus the validated LAOS configuration, 512 KiB request limit, 1 MiB stdout/stderr limits, and 120 second timeout. Parse `{"ok":true,"result":...}` or allowlisted error codes only. Never expose stdout/stderr on malformed responses.

In `createBridgeWithSyncTools()`, create the group once from the pinned initial code root, append its definitions after `laos_memory_task`, route calls inside the existing `serialize()` closure, and use the existing audit and `laosFailureResult()` paths. Return `instructions: laosCheckpointTools?.instructions` beside `tools` and `callTool`.

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
node --test test/laos-checkpoint-tools.test.js test/laos-data-tool.test.js test/laos-error-contract.test.js test/laos-workspace-regression.test.js
```

Expected: all pass; disabled names remain unchanged and enabled delta is exactly three.

- [ ] **Step 6: Commit the scoped Bridge integration**

Run:

```bash
git add src/laos-checkpoint-tools.js src/bridge-with-sync-tools.js test/laos-checkpoint-tools.test.js
git commit -m "Add conditional LAOS checkpoint tools"
```

### Task 3: MCP server instructions and SDK integration

**Files:**
- Modify: `/Users/user/Developer/MCP/developer-bridge-worktrees/codex--fix-laos-native-tools-live/mcp-http.js`
- Modify: `/Users/user/Developer/MCP/developer-bridge-worktrees/codex--fix-laos-native-tools-live/server.js`
- Modify: `/Users/user/Developer/MCP/developer-bridge-worktrees/codex--fix-laos-native-tools-live/test/mcp-integration.test.js`
- Modify: `/Users/user/Developer/MCP/developer-bridge-worktrees/codex--fix-laos-native-tools-live/test/startup.test.js`

- [ ] **Step 1: Write failing initialize/instructions and startup tests**

Extend the HTTP/stdio integration fixture with enabled checkpoint configuration and assert the SDK client receives `client.getInstructions()`, all previous tool names, and exactly the three new names. Add startup cases for partial roots, invalid enable flag, missing workspace, invalid scope, symlink adapter/interpreter, temporary state, and overlapping roots. Assert diagnostics do not contain any configured path or route.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test test/mcp-integration.test.js test/startup.test.js
```

Expected: FAIL because neither server constructor publishes `bridge.instructions`.

- [ ] **Step 3: Pass instructions into both MCP servers**

Use the SDK's supported `ServerOptions.instructions` field:

```js
const serverOptions = {
  capabilities: { tools: {} },
  ...(bridge.instructions ? { instructions: bridge.instructions } : {}),
};
const server = new Server(
  { name: "developer-bridge", version: "1.0.0" },
  serverOptions,
);
```

Apply the same conditional logic to HTTP and stdio. Do not add checkpoint text when the group is disabled.

- [ ] **Step 4: Run integration tests and verify GREEN**

Run:

```bash
node --test test/mcp-integration.test.js test/startup.test.js test/package-config.test.js
```

Expected: all pass and route/workspace values remain absent from output.

- [ ] **Step 5: Commit server integration**

Run:

```bash
git add mcp-http.js server.js test/mcp-integration.test.js test/startup.test.js
git commit -m "Publish LAOS checkpoint server instructions"
```

### Task 4: Cross-repository and adversarial verification

**Files:**
- Modify tests only if a newly discovered failure requires a minimal regression test before its fix.

- [ ] **Step 1: Run targeted LAOS tests**

```bash
python3 -m unittest tests.test_developer_bridge_adapter tests.test_mcp_checkpoint tests.test_sessions tests.test_protocol_host tests.test_serve_laos tests.test_bridge_pipeline -v
```

- [ ] **Step 2: Run full LAOS verification**

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m compileall -q src tools tests
git diff --check
```

- [ ] **Step 3: Run full Bridge verification**

```bash
npm test
node --check src/laos-checkpoint-tools.js
node --check src/bridge-with-sync-tools.js
node --check mcp-http.js
node --check server.js
git diff --check
```

- [ ] **Step 4: Re-run three-case security reasoning**

For every discovered failure, record and verify:

1. normal enabled capture/search/get;
2. malformed, oversized, scope-escaping, symlink, timeout, or disclosure path;
3. disabled, restart, old configuration, or worktree-switch path.

If a new Critical/Major appears, start a new search-first diagnosis and repeat until three consecutive review rounds find none.

### Task 5: Launcher and real endpoint acceptance

**Files:**
- Modify: `/Users/user/Downloads/Developer-Bridge-LAOS-双桥修正版/启动LAOS Developer Bridge-双桥本地服务.command`
- Create verification evidence only in a task-specific, non-secret local file if needed; never store route/token values.

- [ ] **Step 1: Record the exact current process before changing it**

Record PID, command, cwd, listener, branch, and HEAD for the LAOS service. Re-run the current local and HTTPS `initialize`/`tools/list` snapshots without printing the private route or endpoint.

- [ ] **Step 2: Update launcher configuration minimally**

Change only the Bridge runtime path and add fixed exports:

```bash
BRIDGE_DIR="/Users/user/Developer/MCP/developer-bridge-worktrees/codex--fix-laos-native-tools-live"
LAOS_ENABLE_CHECKPOINT_CAPTURE="1"
LAOS_CHECKPOINT_WORKSPACE="personal"
LAOS_CHECKPOINT_PROJECT="laos"
LAOS_PYTHON_EXECUTABLE="/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/bin/python3.14"
```

Export them beside `LAOS_DATA_ROOT` and `LAOS_STATE_DIR`. Validate with `bash -n` and a redacted configuration inspection. Do not change the ordinary Bridge launcher.

- [ ] **Step 3: Restart only LAOS Developer Bridge**

Terminate only the previously recorded LAOS PID/process group after confirming its cwd and port 3001. Start the updated LAOS launcher/service without touching the ordinary port-3000 Bridge or dual router. Confirm the new PID, cwd, branch, HEAD, and loopback listener.

- [ ] **Step 4: Verify real local and HTTPS endpoint tool lists**

Using `StreamableHTTPClientTransport`, perform `initialize` and `tools/list` against port 3001 and the existing HTTPS dual-router route. Save only redacted evidence: transport, server version, instructions presence, endpoint-host hash, and tool names. Assert the pre-change name set is preserved and the delta is exactly the three expected tools.

- [ ] **Step 5: Verify checkpoint, reconnect, search, and get**

Use unique synthetic text and a stable synthetic checkpoint ID. Call capture through the actual HTTPS endpoint, verify receipt lengths and SHA-256, terminate the MCP session, create a new client/connection, search the unique term, get the returned session ID, and compare both recovered messages byte-for-byte. Start a fresh Bridge process against the same state directory and repeat search/get to prove cross-process persistence.

- [ ] **Step 6: Prove ordinary Bridge isolation**

Initialize the existing port-3000 endpoint separately and assert none of the three checkpoint/session tools are present.

### Task 6: Final review and report

**Files:**
- No production changes unless review identifies a tested defect.

- [ ] **Step 1: Run spec-compliance review**

Audit every requirement in the approved design and pasted goal against file, test, runtime, and Git evidence. Classify missing evidence as incomplete rather than inferred.

- [ ] **Step 2: Run code-quality/security review**

Report Critical, Major, Minor, and Suggestion findings. Fix every Critical/Major through search-first diagnosis and TDD, then repeat the review until three consecutive rounds find no new Critical/Major.

- [ ] **Step 3: Capture final Git state**

For both repositories record root, branch, HEAD, upstream, status, diff/stat, worktrees, and local commits. Confirm no push, PR, merge, publish, migration, memory-data modification, or ordinary Bridge restart occurred.

- [ ] **Step 4: Deliver the required status**

Unless the user has manually refreshed ChatGPT and completed a brand-new-conversation acceptance test, report exactly:

```text
partially completed — server and endpoint verified; ChatGPT metadata refresh and cross-conversation UI acceptance pending
```

Include the required Settings → Apps/Connectors → LAOS Developer Bridge → Refresh → verify names → new chat/reselect app instructions and one next step only.
