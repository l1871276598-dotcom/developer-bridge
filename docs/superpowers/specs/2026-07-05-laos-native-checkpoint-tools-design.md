# LAOS Native Checkpoint Tools Design

## Objective

Expose `laos_capture_checkpoint`, `laos_session_search`, and `laos_session_get` through the existing Developer Bridge endpoint used by ChatGPT while preserving every current Developer Bridge tool, `laos_memory_task`, Git authorization, audit serialization, and LAOS persistence semantics.

Completion requires evidence from the real running HTTPS endpoint: `initialize`, `tools/list`, checkpoint capture, client reconnect, session search, and exact session recovery from the same stable state directory. A successful source-level or mocked test is not sufficient.

## Existing Runtime and Failure Boundary

The LAOS application is not connected to LAOS's Python FastMCP host. The running chain is:

1. ChatGPT connects through an HTTPS ngrok endpoint.
2. A loopback dual-router forwards the private LAOS route to port 3001.
3. Developer Bridge's Node `mcp-http.js` creates the MCP server.
4. `createBridgeWithSyncTools()` composes the controlled engineering tools and the optional `laos_memory_task`.
5. No Node composition code registers the three checkpoint/session tools, and the launcher sets no checkpoint-enable or checkpoint-scope variables.

Therefore the existence of the functions in `src/protocol_host.py` cannot expose them on the actual endpoint. The change must extend the Node composition path and invoke LAOS through a fixed adapter.

## Architecture

### LAOS adapter

Add one fixed Python entry point under the authorized LAOS repository. It will:

- derive the repository root and `src/` import path from its own real file location;
- read `LAOS_DATA_ROOT`, `LAOS_STATE_DIR`, checkpoint workspace, and optional scope metadata only from its inherited startup environment;
- read exactly one bounded JSON request from stdin;
- allow only `capture_checkpoint`, `session_search`, and `session_get` operations;
- build the existing facade/pipeline through LAOS's existing `tools/serve_laos.py` construction functions;
- call `McpCheckpointCapture` and `SessionStore` through that facade without duplicating checkpoint, hashing, idempotency, projection, or SQLite semantics;
- enforce the configured workspace/project on search and on the session returned by get;
- emit exactly one bounded JSON object on stdout and no operational data on stderr.

The adapter will reject unknown keys, paths, database names, commands, executable names, environment overrides, invalid workspace/project filters, unbounded limits, incomplete assistant responses, oversized input, and sessions outside the configured scope.

### Developer Bridge integration

Add one focused JavaScript module that owns only the MCP-facing definitions, startup validation, fixed subprocess call, bounded I/O, timeout, output parsing, and redaction. It will not implement LAOS business behavior.

`createBridgeWithSyncTools()` will create this optional tool group at startup and append its three definitions beside the existing `laos_memory_task`. Calls will use the existing bridge serialization queue and audit logger. Failures will return stable generic LAOS error codes without paths, request text, stderr, tokens, or endpoint details.

The Python executable and adapter path are resolved and validated once at startup. The MCP caller can provide only tool contract fields; it cannot select a path, command, environment variable, interpreter, data root, state directory, workspace, or project.

### Conditional configuration

The tools are disabled unless `LAOS_ENABLE_CHECKPOINT_CAPTURE=1`.

When disabled, checkpoint-only variables are ignored for tool registration and the ordinary bridge tool set is unchanged. When enabled, startup requires:

- `LAOS_DATA_ROOT` and `LAOS_STATE_DIR` as existing canonical, non-symlink directories;
- `LAOS_CHECKPOINT_WORKSPACE` equal to `personal` or `work`;
- optional non-empty `LAOS_CHECKPOINT_PROJECT`, account, profile, and confidentiality values;
- `LAOS_PYTHON_EXECUTABLE` as an absolute canonical regular executable;
- the fixed adapter as an existing canonical single-link regular file inside the authorized LAOS code root;
- pairwise separation of Developer Bridge runtime, LAOS code, data, and state roots.

The stable state directory must not be temporary or inside a synchronized cloud-data root. Partial configuration, invalid scope, overlaps, and symlink traversal fail startup rather than degrading to fewer tools.

The LAOS launcher will explicitly set the enable flag, fixed canonical interpreter, workspace/project, and stable existing roots. The ordinary Developer Bridge launcher will not set checkpoint variables.

## Tool Contracts

### `laos_capture_checkpoint`

The input schema follows `src/protocol_host.py` and `McpCheckpointCapture.capture()`: required `session_alias`, `user_message`, and `assistant_response`; optional checkpoint ID, summary, completion flag, real source IDs, branch, version, captured time, and force-review flag.

It is an additive write tool: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` because a stable checkpoint ID makes retries safe. The implementation rejects incomplete responses. Its receipt preserves the existing exact character lengths, SHA-256 hashes, idempotency evidence, and explicit limitations: no passive conversation access and no independent observation of final assistant text.

### `laos_session_search`

The tool accepts a non-empty query, optional workspace/project filters constrained to the configured scope, and integer limit from 1 through 50. It accepts no path. It is read-only, non-destructive, and idempotent.

### `laos_session_get`

The tool accepts only one bounded session ID. It reads from the fixed `SessionStore`, verifies the returned session remains in the configured workspace/project, and returns all saved messages plus the necessary session metadata. It is read-only, non-destructive, and idempotent.

## Server Instructions

When the checkpoint tool group is enabled, both HTTP and stdio Developer Bridge servers will publish concise MCP server instructions. The first 512 characters will state that checkpoint capture is explicit rather than passive; it is called once only when the user asks to save the complete current turn; recovery starts with `laos_session_search` and then `laos_session_get`; `memory.create` is not a checkpoint substitute; and source conversation/message IDs must not be invented. When the group is disabled, checkpoint instructions are absent so an ordinary bridge never advertises an unavailable workflow.

The instructions do not require automatic saving and do not alter ordinary Developer Bridge behavior.

## Error and Security Model

Requests travel to the fixed Python process over stdin so message text is absent from process arguments. The subprocess uses `shell: false`, a fixed working directory, a minimal allowlisted environment, a fixed timeout, and independent request/stdout/stderr byte limits. A timeout terminates the process group. Malformed, oversized, or non-JSON stdout is rejected.

The adapter returns stable symbolic errors. Developer Bridge exposes only allowlisted codes and a generic message. Absolute paths, secrets, tunnel addresses, checkpoint content, and raw stderr never reach MCP responses or audit logs.

The existing single-operation queue remains the concurrency boundary. No additional service, dependency, daemon, database, or JavaScript checkpoint implementation is introduced.

## Verification Design

TDD begins with failing tests for disabled/enabled tool registration, exact tool-set deltas, startup validation, annotations, server instructions, and subprocess safety. LAOS tests cover the adapter's exact receipt hashes, idempotent retry, incomplete-response rejection, scoped search/get, exact text restoration, reconnect persistence, unknown fields, path/command/environment injection, input/output bounds, timeout behavior, symlinks, root overlap, and error redaction.

After targeted tests, both repositories run their full available suites, compile/build/lint/typecheck checks, and `git diff --check`. A separate review classifies Critical, Major, Minor, and Suggestion findings.

Runtime acceptance records the precise existing LAOS PID, command, and cwd; changes only the LAOS launcher to the fixed task worktree/configuration; restarts only the LAOS bridge; initializes the actual local and HTTPS routes; verifies the old tool-name set is preserved and only the expected three names are added; then captures unique test text, disconnects, reconnects, searches, gets, and compares the recovered text and receipt hashes byte-for-byte. The ordinary bridge endpoint is checked separately to prove it did not acquire checkpoint tools.

ChatGPT UI refresh and a brand-new conversation remain manual acceptance steps. Until those pass, final status is `partially completed — server and endpoint verified; ChatGPT metadata refresh and cross-conversation UI acceptance pending`.
