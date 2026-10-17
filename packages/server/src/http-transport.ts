import { createServer, type Server } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentEvent, RpcContext, RpcRequest, RpcResponse } from "@familiar/protocol";
import { RPC_ERROR_INTERNAL, RPC_ERROR_METHOD_NOT_FOUND, RPC_ERROR_INVALID_PARAMS } from "@familiar/protocol";
import { AgentServer, RpcError } from "./agent-server.js";
import { log } from "@familiar/core";

/**
 * HTTP + WebSocket transport for AgentServer.
 * - POST /rpc        JSON-RPC request/response (final results only)
 * - GET  /ws         event stream; AgentEvents are pushed to every client
 * - GET  /           M4: single-page web UI (packages/server/public)
 * - GET  /healthz    liveness probe
 */
export interface HttpTransportOptions {
  port: number;
  bind: string;
  /**
   * M2: when set, every endpoint except /healthz requires this bearer token
   * (Authorization: Bearer <token> header or ?token= query, e.g. for /ws).
   */
  authToken?: string;
  /** Path the token was read from — reported by /healthz so local clients
   * (the desktop shell) can pick it up. Never the value itself. */
  authTokenFile?: string;
}

export interface HttpTransport {
  url: string;
  close(): Promise<void>;
  /** M5: push any event for an arbitrary session (cron jobs, diagnostics). */
  broadcast: (sessionId: string, event: unknown) => void;
}

// Whitelisted static assets only (no directory traversal surface).
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

function publicDir(): string {
  // dist/http-transport.js -> ../public
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
}

/** Length-independent comparison for bearer tokens (avoids timing leaks). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function startHttpTransport(
  agent: AgentServer,
  opts: HttpTransportOptions,
): Promise<HttpTransport> {
  const clients = new Set<WebSocket>();

  const authRequired = typeof opts.authToken === "string" && opts.authToken !== "";

  /** Constant-time comparison against the configured bearer token. */
  const authorized = (req: { headers: Record<string, unknown>; url?: string }): boolean => {
    if (!authRequired) return true;
    const header = req.headers["authorization"];
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      if (safeEqual(header.slice("Bearer ".length).trim(), opts.authToken ?? "")) return true;
    }
    const queryToken = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
    if (queryToken !== null && safeEqual(queryToken, opts.authToken ?? "")) return true;
    return false;
  };

  const sendUnauthorized = (
    req: { method?: string; headers: Record<string, unknown> },
    res: import("node:http").ServerResponse,
    url: string,
  ): void => {
    if (url === "/" || url === "/index.html") {
      // human-friendly page for someone who opened the URL without a token
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><title>familiar — authentication required</title>" +
          "<meta charset=\"utf-8\"><body style=\"font-family:system-ui;padding:40px\">" +
          "<h2>familiar server is running — token required</h2>" +
          "<p>This server requires a bearer token. Open it as:<br>" +
          "<code>http://" + (req.headers["host"] ?? "127.0.0.1") + "/?token=&lt;your-token&gt;</code></p>" +
          "<p>Generate one with <code>familiar token --write</code> and set <code>server.auth_token_file</code> in config.yaml.</p></body>",
      );
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  };

  const broadcast = (sessionId: string, event: AgentEvent | unknown): void => {
    const frame = JSON.stringify({ type: "event", sessionId, event });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  };

  const httpServer: Server = createServer(async (req, res) => {
    const url = ((req.url ?? "").split("?")[0]) ?? "";
    if (req.method === "GET" || req.method === "HEAD") {
      if (url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            protocol: "familiar/1",
            auth: authRequired ? "required" : "off",
            ...(authRequired && opts.authTokenFile ? { tokenFile: opts.authTokenFile } : {}),
          }),
        );
        return;
      }
      if (!authorized(req)) {
        sendUnauthorized(req, res, url);
        return;
      }
      const asset = STATIC_FILES[url];
      if (asset) {
        const file = path.join(publicDir(), asset.file);
        if (fs.existsSync(file)) {
          res.writeHead(200, { "Content-Type": asset.type });
          res.end(req.method === "HEAD" ? undefined : fs.readFileSync(file));
          return;
        }
      }
      if (url === "/") {
        // UI not shipped → fall back to a plain hint page.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><title>familiar</title><p>familiar server is running. " +
            "UI assets not found (packages/server/public). RPC: POST /rpc, WS: /ws, probe: /healthz.</p>",
        );
        return;
      }
    }
    if (req.method !== "POST" || url !== "/rpc") {
      if (!authorized(req)) {
        sendUnauthorized(req, res, url);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
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
  // Server-level events (no session) use an empty sessionId; cron turns push
  // through their own session id via the (sessionId, event) signature.
  agent.attachBroadcast((sessionId, event) => broadcast(sessionId, event));

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = (req.url ?? "").split("?")[0];
    if (url === "/ws" && authorized(req)) {
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
        broadcast: (sessionId: string, event: unknown): void => broadcast(sessionId, event),
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
