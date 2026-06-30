import express from "express";
import fs from "fs/promises";
import path from "path";
import process from "process";
import { randomUUID } from "crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = 3000;
const ROOT = path.resolve(
  process.env.DEVELOPER_BRIDGE_WORKSPACE || process.cwd()
);
const rawMcpPath = process.env.MCP_PATH || "mcp";

if (/^https?:\/\//i.test(rawMcpPath)) {
  throw new Error(
    "MCP_PATH must contain only a path such as mcp-abc123, not a full URL"
  );
}

const MCP_PATH = `/${rawMcpPath.replace(/^\/+/, "")}`;

const app = express();
app.use(express.json({ limit: "2mb" }));

// 每个 MCP 会话分别保存，避免不同客户端相互干扰。
const sessions = new Map();

function safePath(inputPath = ".") {
  const resolved = path.resolve(ROOT, inputPath);

  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error("Blocked: path outside the allowed workspace");
  }

  return resolved;
}

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
    tools: [
      {
        name: "list_files",
        description:
          "List files and directories inside the authorized local workspace. Use this before choosing files to read.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative directory path. Use . for the workspace root.",
            },
          },
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      {
        name: "read_file",
        description:
          "Read a UTF-8 text file inside the authorized local workspace.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path of the file to read.",
            },
          },
          required: ["path"],
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      {
        name: "write_file",
        description:
          "Create or overwrite a UTF-8 text file inside the authorized local workspace. Read the file first before modifying an existing file.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path of the file to write.",
            },
            content: {
              type: "string",
              description: "Complete new file content.",
            },
          },
          required: ["path", "content"],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      console.error("[MCP TOOL]", name, args);

      if (name === "list_files") {
        const entries = await fs.readdir(safePath(args.path || "."), {
          withFileTypes: true,
        });

        return {
          content: [
            {
              type: "text",
              text: entries
                .map((entry) =>
                  `${entry.isDirectory() ? "DIR " : "FILE"} ${entry.name}`
                )
                .join("\n"),
            },
          ],
        };
      }

      if (name === "read_file") {
        const content = await fs.readFile(safePath(args.path), "utf8");

        return {
          content: [{ type: "text", text: content }],
        };
      }

      if (name === "write_file") {
        await fs.writeFile(safePath(args.path), args.content, "utf8");

        return {
          content: [
            {
              type: "text",
              text: `Wrote ${args.path}`,
            },
          ],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
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
    console.error("[MCP ERROR]", error);

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
  console.log(`Developer Bridge MCP HTTP server running`);
  console.log(`Workspace: ${ROOT}`);
  console.log(`Local MCP endpoint: http://127.0.0.1:${PORT}${MCP_PATH}`);
});