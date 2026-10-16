import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentEvent, RpcContext, RpcRequest, RpcResponse } from "@familiar/protocol";
import { RPC_ERROR_INTERNAL, RPC_ERROR_METHOD_NOT_FOUND, RPC_ERROR_INVALID_PARAMS } from "@familiar/protocol";
import { AgentServer, RpcError } from "./agent-server.js";
import { log } from "@familiar/core";

/**
 * HTTP + WebSocket transport for AgentServer.
 * - POST /rpc        JSON-RPC request/response (final results only)
 * - GET  /ws         event stream; AgentEvents are pushed to every client
 *
 * M1 is single-user localhost; auth token arrives in M2.
 */
export interface HttpTransportOptions {
  port: number;
  bind: string;
}

export interface HttpTransport {
  url: string;
  close(): Promise<void>;
}

export function startHttpTransport(
  agent: AgentServer,
  opts: HttpTransportOptions,
): Promise<HttpTransport> {
  const clients = new Set<WebSocket>();

  const broadcast = (sessionId: string, event: AgentEvent | unknown): void => {
    const frame = JSON.stringify({ type: "event", sessionId, event });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  };

  const httpServer: Server = createServer(async (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || url !== "/rpc") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const ctx: RpcContext = { onEvent: broadcast };
      const body = Buffer.concat(chunks).toString("utf8");
      const reply = await handleRpc(agent, body, ctx);
      res.writeHead(reply.error ? 400 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });

  // Permission prompts must reach all clients even from POST-originated turns.
  // Server-level events (no session) use an empty sessionId.
  agent.attachBroadcast((event) => broadcast("", event));

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = (req.url ?? "").split("?")[0];
    if (url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        clients.add(ws);
        ws.on("close", () => clients.delete(ws));
        ws.on("error", () => clients.delete(ws));
        ws.send(JSON.stringify({ type: "hello", protocol: "familiar/1" }));
      });
    } else {
      socket.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.bind, () => {
      const address = httpServer.address();
      const port =
        address && typeof address === "object" ? address.port : (opts.port ?? 0);
      resolve({
        url: `http://${opts.bind}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const ws of clients) ws.close();
            wss.close();
            httpServer.close(() => done());
          }),
      });
    });
  });
}

async function handleRpc(
  agent: AgentServer,
  body: string,
  ctx: RpcContext,
): Promise<RpcResponse> {
  let req: RpcRequest;
  try {
    req = JSON.parse(body) as RpcRequest;
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: RPC_ERROR_INTERNAL, message: "invalid JSON body" } };
  }
  try {
    const result = await agent.dispatch(req.method, asParams(req.params), ctx);
    return { jsonrpc: "2.0", id: req.id, result };
  } catch (err) {
    const code =
      err instanceof RpcError
        ? err.code
        : err instanceof Error && err.message.startsWith("unknown method")
          ? RPC_ERROR_METHOD_NOT_FOUND
          : RPC_ERROR_INTERNAL;
    const message = err instanceof Error ? err.message : String(err);
    log.error(`rpc ${req.method} failed: ${message}`);
    return { jsonrpc: "2.0", id: req.id, error: { code, message } };
  }
}

function asParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  throw new RpcError(RPC_ERROR_INVALID_PARAMS, "params must be an object");
}
