import process from "process";

import { operatorIdentityFromEnvironment } from "./src/audit-actor.js";
import { createBridgeWithSyncTools } from "./src/bridge-with-sync-tools.js";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

delete process.env.GH_REPO;
delete process.env.GH_HOST;

const workspace = process.env.DEVELOPER_BRIDGE_WORKSPACE;
if (typeof workspace !== "string" || workspace.length === 0) {
  console.error("Configuration error: DEVELOPER_BRIDGE_WORKSPACE is required. Set it to an existing authorized project directory before starting the server.");
  process.exit(1);
}

let operatorIdentity;
try {
  operatorIdentity = operatorIdentityFromEnvironment(process.env);
} catch (error) {
  console.error(`Configuration error: ${error instanceof Error ? error.message : "invalid operator identity"}`);
  process.exit(1);
}

let bridge;
try {
  bridge = await createBridgeWithSyncTools(workspace, undefined, { operatorIdentity });
} catch (error) {
  console.error(`Configuration error: ${error instanceof Error ? error.message : "invalid workspace"}. Set DEVELOPER_BRIDGE_WORKSPACE to an existing authorized project directory.`);
  process.exit(1);
}

const serverOptions = {
  capabilities: { tools: {} },
  ...(bridge.instructions ? { instructions: bridge.instructions } : {}),
};
const server = new Server(
  { name: "developer-bridge", version: "1.0.0" },
  serverOptions,
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bridge.tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  return bridge.callTool(name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("Developer Bridge MCP stdio server running");