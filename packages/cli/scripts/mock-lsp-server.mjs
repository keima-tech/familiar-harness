#!/usr/bin/env node
/**
 * Mock language server (stdio, Content-Length LSP framing) for smoke tests.
 * Deterministic: a `FAIL:` marker anywhere in the file publishes an error
 * diagnostic on the first marked line; otherwise diagnostics are empty.
 * Speaks the minimal subset: initialize / initialized / didOpen / didChange /
 * publishDiagnostics, and answers every request it receives.
 */

const state = { uri: null, opened: false };

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function publish(uri, text) {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.includes("FAIL:"));
  const diagnostics = [];
  if (idx >= 0) {
    const col = lines[idx].indexOf("FAIL:");
    diagnostics.push({
      uri,
      range: {
        start: { line: idx, character: col },
        end: { line: idx, character: col + lines[idx].length - col },
      },
      message: `mock: expected something else but found "${lines[idx].trim().slice(0, 40)}"`,
      severity: 1,
      code: "MOCK001",
      source: "familiar-mock-lsp",
    });
  }
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  if (idx >= 0) state.lastDiags = diagnostics;
}

function handle(msg) {
  if (msg.id !== undefined && msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        capabilities: {
          textDocumentSync: 1, // full sync
          textDocument: { diagnostic: { dynamicRegistration: false } },
        },
        serverInfo: { name: "familiar-mock-lsp", version: "1.0.0" },
      },
    });
    return;
  }
  if (msg.id !== undefined && msg.method) {
    // any other request → empty result (never stalling the client)
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "initialized") return;
  const uri = msg.params?.textDocument?.uri;
  const text = msg.params?.textDocument?.text ?? msg.params?.contentChanges?.[0]?.text;
  if ((msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") && uri) {
    if (state.uri && uri !== state.uri && state.lastDiags) {
      // switching files: clear the previous file's diagnostics
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: state.uri, diagnostics: [] } });
    }
    state.uri = uri;
    state.opened = true;
    publish(uri, text ?? "");
  }
}

// Content-Length framed reader over stdin (raw accumulation — no readline,
// since readline strips the \r that LSP framing depends on)
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    const length = match ? Number(match[1]) : 0;
    const bodyStart = headerEnd + 4;
    if (buffer.length - bodyStart < length) break; // wait for the rest of the body
    const body = buffer.slice(bodyStart, bodyStart + length);
    buffer = buffer.slice(bodyStart + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // malformed frame — ignore (smoke servers never send malformed JSON)
    }
  }
});

process.stdin.on("close", () => process.exit(0));
