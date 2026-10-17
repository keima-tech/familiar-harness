// Minimal MCP stdio server (newline-delimited JSON-RPC) for tests.
import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === "initialize") {
    send({
      id: m.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "0.0.1" },
      },
    });
  } else if (m.method === "tools/list") {
    send({
      id: m.id,
      result: {
        tools: [
          {
            name: "echo_text",
            description: "Echo the input text (mock MCP server)",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: "text to echo" } },
              required: ["text"],
            },
          },
        ],
      },
    });
  } else if (m.method === "tools/call") {
    send({
      id: m.id,
      result: {
        content: [{ type: "text", text: `mcp-echo: ${String(m.params?.arguments?.text ?? "").toUpperCase()}` }],
      },
    });
  }
});
