import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.js"],
});

const client = new Client(
  { name: "developer-bridge-test-client", version: "1.0.0" },
  { capabilities: {} }
);

await client.connect(transport);

console.log("1. Listing tools...");
const tools = await client.listTools();
console.log(JSON.stringify(tools, null, 2));

console.log("\n2. Reading package.json...");
const readResult = await client.callTool({
  name: "read_file",
  arguments: { path: "package.json" },
});
console.log(JSON.stringify(readResult, null, 2));

console.log("\n3. Writing test_mcp.txt...");
const writeResult = await client.callTool({
  name: "write_file",
  arguments: {
    path: "test_mcp.txt",
    content: "hello MCP"
  },
});
console.log(JSON.stringify(writeResult, null, 2));

console.log("\n4. Listing files...");
const listResult = await client.callTool({
  name: "list_files",
  arguments: { path: "." },
});
console.log(JSON.stringify(listResult, null, 2));

await client.close();