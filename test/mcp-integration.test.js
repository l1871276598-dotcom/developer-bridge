import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

const APPROVED_TOOLS = [
  "list_files",
  "read_file",
  "write_file",
  "git_stage",
  "git_commit",
  "git_push_current_branch",
  "github_pr_create_draft",
  "run_validation",
  "git_branch_list",
  "git_branch_create",
  "git_branch_switch",
  "git_worktree_list",
  "git_worktree_create",
  "git_worktree_switch",
  "git_status",
  "git_diff",
  "run_tests",
  "git_fetch_origin_main",
  "git_merge_origin_main",
  "git_merge_abort",
];

function client() {
  return new Client({ name: "p0-integration-test", version: "1.0.0" }, { capabilities: {} });
}

async function prepareWorkspace(workspace) {
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "node --test target.test.js" },
  }), "utf8");
  await writeFile(path.join(workspace, "target.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("passes", () => assert.equal(2 + 2, 4));',
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(workspace, "tracked.txt"), "before\n", "utf8");
  const git = (...args) => execFileAsync("git", args, { cwd: workspace });
  await git("init", "--quiet", "-b", "feat/test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Developer Bridge Test");
  await git("add", "package.json", "target.test.js", "tracked.txt");
  await git("commit", "--quiet", "-m", "fixture");
}

async function exerciseAllTools(mcpClient) {
  const tools = await mcpClient.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name), APPROVED_TOOLS);
  const branches = await mcpClient.callTool({ name: "git_branch_list", arguments: {} });
  assert.deepEqual(JSON.parse(branches.content[0].text).branches.map(({ branch }) => branch), ["feat/test"]);
  const worktrees = await mcpClient.callTool({ name: "git_worktree_list", arguments: {} });
  assert.deepEqual(JSON.parse(worktrees.content[0].text).worktrees.map(({ branch }) => branch), ["feat/test"]);

  const write = await mcpClient.callTool({
    name: "write_file",
    arguments: { path: "integration.txt", content: "integration body" },
  });
  assert.equal(write.isError, undefined);
  const read = await mcpClient.callTool({ name: "read_file", arguments: { path: "integration.txt" } });
  assert.equal(read.content[0].text, "integration body");
  const list = await mcpClient.callTool({ name: "list_files", arguments: { path: "." } });
  assert.match(list.content[0].text, /FILE integration\.txt/);
  const trackedWrite = await mcpClient.callTool({
    name: "write_file",
    arguments: { path: "tracked.txt", content: "after\n" },
  });
  assert.equal(trackedWrite.isError, undefined);
  const status = await mcpClient.callTool({ name: "git_status", arguments: {} });
  assert.match(status.content[0].text, / M tracked\.txt/);
  const diff = await mcpClient.callTool({ name: "git_diff", arguments: { staged: false } });
  assert.match(diff.content[0].text, /\+after/);
  const tests = await mcpClient.callTool({ name: "run_tests", arguments: { test: "default" } });
  assert.equal(JSON.parse(tests.content[0].text).exitCode, 0);
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

test("stdio transport scans and runs all twenty approved tools", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-stdio-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await prepareWorkspace(workspace);
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
  await exerciseAllTools(mcpClient);
  assert.doesNotMatch(stderr, /integration body/);
  assert.doesNotMatch(stderr, new RegExp(workspace));
});

test("HTTP transport scans and runs all twenty approved tools without leaking route", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-http-"));
  await prepareWorkspace(workspace);
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
  await exerciseAllTools(mcpClient);
  assert.doesNotMatch(output, /integration body/);
  assert.doesNotMatch(output, new RegExp(workspace));
  assert.doesNotMatch(output, new RegExp(route));
});
