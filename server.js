import fs from "fs/promises";
import path from "path";
import process from "process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const ROOT = path.resolve(process.env.DEVELOPER_BRIDGE_WORKSPACE || process.cwd());

function safePath(inputPath = ".") {
  const resolved = path.resolve(ROOT, inputPath);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error("Blocked: path outside workspace");
  }
  return resolved;
}

const server = new Server(
  { name: "developer-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_files",
      description: "List files in the allowed workspace",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path" }
        }
      }
    },
    {
      name: "read_file",
      description: "Read a file in the allowed workspace",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" }
        },
        required: ["path"]
      }
    },
    {
      name: "write_file",
      description: "Write a file in the allowed workspace",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          content: { type: "string", description: "File content" }
        },
        required: ["path", "content"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  console.error("TOOL CALLED:", name, args);

  if (name === "list_files") {
    const dir = safePath(args.path || ".");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return {
      content: [{
        type: "text",
        text: entries.map(e => `${e.isDirectory() ? "DIR " : "FILE"} ${e.name}`).join("\n")
      }]
    };
  }

  if (name === "read_file") {
    const text = await fs.readFile(safePath(args.path), "utf8");
    return { content: [{ type: "text", text }] };
  }

  if (name === "write_file") {
    await fs.writeFile(safePath(args.path), args.content, "utf8");
    return { content: [{ type: "text", text: `Wrote ${args.path}` }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("Developer Bridge MCP Server running...");