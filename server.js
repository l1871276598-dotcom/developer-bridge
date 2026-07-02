import process from "process";

import { createBridgeCore } from "./src/bridge-core.js";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const workspace = process.env.DEVELOPER_BRIDGE_WORKSPACE;
if (typeof workspace !== "string" || workspace.length === 0) {
  console.error("Configuration error: DEVELOPER_BRIDGE_WORKSPACE is required. Set it to an existing authorized project directory before starting the server.");
  process.exit(1);
}

const allowedBranch = process.env.DEVELOPER_BRIDGE_ALLOWED_BRANCH;
if (typeof allowedBranch !== "string" || allowedBranch.length === 0) {
  console.error("Configuration error: DEVELOPER_BRIDGE_ALLOWED_BRANCH is required.");
  process.exit(1);
}

let bridge;
try {
  bridge = await createBridgeCore(workspace, undefined, { allowedBranch });
} catch (error) {
  console.error(`Configuration error: ${error instanceof Error ? error.message : "invalid workspace"}. Set DEVELOPER_BRIDGE_WORKSPACE to an existing authorized project directory.`);
  process.exit(1);
}

const server = new Server(
  { name: "developer-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bridge.tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  return bridge.callTool(name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("Developer Bridge MCP stdio server running");
