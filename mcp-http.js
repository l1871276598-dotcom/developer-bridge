import express from "express";
import process from "process";
import { randomUUID } from "crypto";

import { createBridgeCore } from "./src/bridge-core.js";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

const configuredPort = process.env.DEVELOPER_BRIDGE_PORT;
const PORT = configuredPort === undefined ? 3000 : Number(configuredPort);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error("Configuration error: DEVELOPER_BRIDGE_PORT must be an integer from 0 through 65535.");
  process.exit(1);
}

function requiredEnvironment(name, guidance) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    console.error(`Configuration error: ${name} is required. ${guidance}`);
    process.exit(1);
  }
  return value;
}

const workspace = requiredEnvironment(
  "DEVELOPER_BRIDGE_WORKSPACE",
  "Set it to an existing authorized project directory before starting the server.",
);
const rawMcpPath = requiredEnvironment(
  "MCP_PATH",
  'Set it to a single private route segment such as "mcp-abc123".',
);
const allowedBranch = requiredEnvironment(
  "DEVELOPER_BRIDGE_ALLOWED_BRANCH",
  "Set it to the single Git branch that this Bridge may modify, commit, and push.",
);

if (!/^[A-Za-z0-9._~-]+$/.test(rawMcpPath) || rawMcpPath === "." || rawMcpPath === "..") {
  console.error(
    'Configuration error: MCP_PATH must be a single route segment such as "mcp-abc123", not a URL or nested path.',
  );
  process.exit(1);
}

const MCP_PATH = `/${rawMcpPath}`;

let bridge;
try {
  bridge = await createBridgeCore(workspace, undefined, { allowedBranch });
} catch (error) {
  console.error(`Configuration error: ${error instanceof Error ? error.message : "invalid workspace"}. Set DEVELOPER_BRIDGE_WORKSPACE to an existing authorized project directory.`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// 每个 MCP 会话分别保存，避免不同客户端相互干扰。
const sessions = new Map();

function createMcpServer() {
  const server = new Server(
    {
      name: "developer-bridge",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: bridge.tools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    return bridge.callTool(name, args);
  });

  return server;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "developer-bridge-mcp",
  });
});

app.post(MCP_PATH, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      if (sessionId || !isInitializeRequest(req.body)) {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Invalid or missing MCP session",
          },
          id: null,
        });
      }

      const server = createMcpServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { server, transport });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      await server.connect(transport);
      session = { server, transport };
    }

    await session.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(`${new Date().toISOString()} transport=http result=failure`);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal MCP server error",
        },
        id: null,
      });
    }
  }
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  const session = sessionId ? sessions.get(sessionId) : undefined;

  if (!session) {
    return res.status(404).send("MCP session not found");
  }

  await session.transport.handleRequest(req, res);
}

app.get(MCP_PATH, handleSessionRequest);
app.delete(MCP_PATH, handleSessionRequest);

app.listen(PORT, "127.0.0.1", () => {
  console.log("Developer Bridge MCP HTTP server running");
});
