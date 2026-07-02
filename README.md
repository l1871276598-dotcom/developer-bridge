# Developer Bridge

Developer Bridge connects ChatGPT to one explicitly authorized local project through a small, auditable MCP file bridge. It is intended for reading and editing code inside that workspace only.

## Architecture

```text
ChatGPT Web/App
→ HTTPS tunnel
→ Streamable HTTP MCP
→ authorized local workspace
```

## Install and configure

Install dependencies:

```bash
npm install
```

Choose a single project as the authorized workspace and replace the placeholder values locally:

```bash
export DEVELOPER_BRIDGE_WORKSPACE="..."
export MCP_PATH="mcp-..."
```

`DEVELOPER_BRIDGE_WORKSPACE` should be restricted to a single project. Do not commit the secret local path or other secrets. `MCP_PATH` is a single path segment, not a complete URL, and must not be hard-coded in the repository.

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

- `list_files`: list a directory inside the workspace.
- `read_file`: read a UTF-8 text file inside the workspace.
- `write_file`: write a protected UTF-8 text file inside the workspace.
- `git_status`: run the fixed read-only `git status --short` check.
- `git_diff`: show the fixed unstaged diff, or the staged diff with `staged=true`.
- `run_tests`: run only the server-approved `npm test` mapping with bounded output and timeout.

## Safety boundary

- No delete operations.
- No arbitrary Shell access.
- No automatic commit.
- No automatic push.
- No access outside the authorized workspace.

Keep all local paths, tunnel addresses, credentials, and other secret values out of version control.
