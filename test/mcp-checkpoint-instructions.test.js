import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { REQUIRED_TOOL_NAMES } from "../src/controlled-engineering-tools.js";
import { LAOS_CHECKPOINT_INSTRUCTIONS } from "../src/laos-checkpoint-tools.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);
const addedNames = [
  "laos_capture_checkpoint",
  "laos_session_search",
  "laos_session_get",
];

function client() {
  return new Client(
    { name: "checkpoint-instructions-test", version: "1.0.0" },
    { capabilities: {} },
  );
}

async function fixture(t) {
  const base = await realpath(
    await mkdtemp(path.join(os.homedir(), ".developer-bridge-mcp-checkpoint-")),
  );
  const workspace = path.join(base, "workspace");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([
    mkdir(path.join(workspace, "src"), { recursive: true }),
    mkdir(path.join(workspace, "tools"), { recursive: true }),
    mkdir(dataRoot),
    mkdir(stateDir),
  ]);
  await writeFile(path.join(workspace, "src", "laos.py"), "print('fixture')\n", "utf8");
  await writeFile(
    path.join(workspace, "tools", "developer_bridge_adapter.py"),
    "# fixture\n",
    "utf8",
  );
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");
  await writeFile(
    path.join(dataRoot, ".research-agent-root"),
    JSON.stringify({ type: "research-agent-data-root", format_version: 1 }),
    "utf8",
  );
  await execFileAsync("git", ["init", "--quiet", "-b", "feat/checkpoint"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Checkpoint Test"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: workspace });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, workspace, dataRoot, stateDir };
}

function environment(item, overrides = {}) {
  return {
    ...process.env,
    DEVELOPER_BRIDGE_OPERATOR_ID: "checkpoint.integration",
    DEVELOPER_BRIDGE_WORKSPACE: item.workspace,
    DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1",
    LAOS_DATA_ROOT: item.dataRoot,
    LAOS_STATE_DIR: item.stateDir,
    LAOS_ENABLE_CHECKPOINT_CAPTURE: "1",
    LAOS_CHECKPOINT_WORKSPACE: "personal",
    LAOS_CHECKPOINT_PROJECT: "checkpoint-integration",
    LAOS_PYTHON_EXECUTABLE: process.execPath,
    ...overrides,
  };
}

function assertCheckpointMetadata(mcpClient, tools) {
  assert.equal(mcpClient.getInstructions(), LAOS_CHECKPOINT_INSTRUCTIONS);
  const names = tools.tools.map(({ name }) => name);
  for (const name of REQUIRED_TOOL_NAMES) assert.equal(names.includes(name), true, name);
  assert.equal(names.includes("laos_memory_task"), true);
  for (const name of addedNames) assert.equal(names.includes(name), true, name);
  assert.deepEqual(
    names.filter((name) => addedNames.includes(name)),
    addedNames,
  );
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("HTTP server did not become healthy");
}

test("stdio initialize publishes checkpoint instructions and tools", async (t) => {
  const item = await fixture(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.js"],
    cwd: projectRoot,
    env: environment(item),
    stderr: "pipe",
  });
  const mcpClient = client();
  t.after(() => mcpClient.close());
  await mcpClient.connect(transport);
  assertCheckpointMetadata(mcpClient, await mcpClient.listTools());
});

test("HTTP initialize publishes checkpoint instructions and tools", async (t) => {
  const item = await fixture(t);
  const port = await freePort();
  const route = "mcp-checkpoint-integration";
  const child = spawn(process.execPath, ["mcp-http.js"], {
    cwd: projectRoot,
    env: environment(item, {
      DEVELOPER_BRIDGE_PORT: String(port),
      MCP_PATH: route,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let transport;
  let mcpClient;
  t.after(async () => {
    if (transport?.sessionId) await transport.terminateSession().catch(() => {});
    if (mcpClient) await mcpClient.close().catch(() => {});
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
  });
  await waitForHealth(port);
  transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/${route}`),
  );
  mcpClient = client();
  await mcpClient.connect(transport);
  assertCheckpointMetadata(mcpClient, await mcpClient.listTools());
  assert.doesNotMatch(output, new RegExp(item.base));
  assert.doesNotMatch(output, new RegExp(route));
});

test("HTTP startup rejects invalid checkpoint enablement without leaking configuration", async (t) => {
  const item = await fixture(t);
  const route = "mcp-checkpoint-secret";
  const child = spawn(process.execPath, ["mcp-http.js"], {
    cwd: projectRoot,
    env: environment(item, {
      LAOS_ENABLE_CHECKPOINT_CAPTURE: "true",
      DEVELOPER_BRIDGE_PORT: "0",
      MCP_PATH: route,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.notEqual(code, 0);
  assert.match(output, /configuration/i);
  assert.doesNotMatch(output, new RegExp(item.base));
  assert.doesNotMatch(output, new RegExp(route));
});
