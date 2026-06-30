import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

function client() {
  return new Client({ name: "p0-integration-test", version: "1.0.0" }, { capabilities: {} });
}

async function exerciseOriginalTools(mcpClient) {
  const tools = await mcpClient.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name), ["list_files", "read_file", "write_file"]);
  const write = await mcpClient.callTool({
    name: "write_file",
    arguments: { path: "integration.txt", content: "integration body" },
  });
  assert.equal(write.isError, undefined);
  const read = await mcpClient.callTool({ name: "read_file", arguments: { path: "integration.txt" } });
  assert.equal(read.content[0].text, "integration body");
  const list = await mcpClient.callTool({ name: "list_files", arguments: { path: "." } });
  assert.match(list.content[0].text, /FILE integration\.txt/);
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

test("stdio transport scans and runs the three original tools", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-stdio-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.js"],
    cwd: projectRoot,
    env: { ...process.env, DEVELOPER_BRIDGE_WORKSPACE: workspace },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  const mcpClient = client();
  t.after(() => mcpClient.close());
  await mcpClient.connect(transport);
  await exerciseOriginalTools(mcpClient);
  assert.doesNotMatch(stderr, /integration body/);
  assert.doesNotMatch(stderr, new RegExp(workspace));
});

test("HTTP transport scans and runs the three original tools without leaking route", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-http-"));
  const port = await freePort();
  const route = "mcp-integration-secret";
  const child = spawn(process.execPath, ["mcp-http.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEVELOPER_BRIDGE_WORKSPACE: workspace,
      DEVELOPER_BRIDGE_PORT: String(port),
      MCP_PATH: route,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let transport;
  let mcpClient;
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (transport?.sessionId) await transport.terminateSession().catch(() => {});
    if (mcpClient) await mcpClient.close().catch(() => {});
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
    await rm(workspace, { recursive: true, force: true });
  });
  await waitForHealth(port);
  transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/${route}`));
  mcpClient = client();
  await mcpClient.connect(transport);
  await exerciseOriginalTools(mcpClient);
  assert.doesNotMatch(output, /integration body/);
  assert.doesNotMatch(output, new RegExp(workspace));
  assert.doesNotMatch(output, new RegExp(route));
});
