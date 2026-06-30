import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const app = express();
app.use(express.json());

async function callTool(name, args) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["server.js"],
  });

  const client = new Client(
    { name: "http-bridge-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  try {
    return await client.callTool({
      name,
      arguments: args || {},
    });
  } finally {
    await client.close();
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "developer-bridge-http" });
});

app.post("/list", async (req, res) => {
  try {
    const result = await callTool("list_files", req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/read", async (req, res) => {
  try {
    const result = await callTool("read_file", req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/write", async (req, res) => {
  try {
    const result = await callTool("write_file", req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => {
  console.log("HTTP Bridge running on http://localhost:3000");
});