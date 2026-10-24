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
  /** server build version, surfaced by /healthz for the GUI about card */
  version?: string;
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
  "/favicon.ico": { file: "favicon.ico", type: "image/x-icon" },
  "/icon-32.png": { file: "icon-32.png", type: "image/png" },
  "/icon-192.png": { file: "icon-192.png", type: "image/png" },
  "/icon-512.png": { file: "icon-512.png", type: "image/png" },
  "/brand.png": { file: "brand.png", type: "image/png" },
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
    const COOKIE_NAME = "familiar_token";

  /** Read the familiar_token cookie (set once after a successful ?token= load). */
  const cookieToken = (req: { headers: Record<string, unknown> }): string | null => {
    const raw = req.headers["cookie"];
    if (typeof raw !== "string") return null;
    for (const part of raw.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === COOKIE_NAME) {
        try {
          return decodeURIComponent(part.slice(eq + 1).trim());
        } catch {
          return null;
        }
      }
    }
    return null;
  };

  type AuthKind = "none" | "cookie" | "explicit";
  /** none = unauthorized; cookie = valid familiar_token cookie; explicit = valid
   * Bearer header or ?token= query (a fresh sign-in → worth a Set-Cookie). */
  const authKind = (req: { headers: Record<string, unknown>; url?: string }): AuthKind => {
    if (!authRequired) return "cookie";
    const header = req.headers["authorization"];
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      if (safeEqual(header.slice("Bearer ".length).trim(), opts.authToken ?? "")) return "explicit";
    }
    const queryToken = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
    if (queryToken !== null && safeEqual(queryToken, opts.authToken ?? "")) return "explicit";
    const cookie = cookieToken(req);
    if (cookie !== null && safeEqual(cookie, opts.authToken ?? "")) return "cookie";
    return "none";
  };

  const authorized = (req: { headers: Record<string, unknown>; url?: string }): boolean =>
    authKind(req) !== "none";
  /** Token entry page: paste the token once; the server responds to the
   * resulting /?token=… with a cookie so CSS/JS/WS carry it afterwards. */
  const sendTokenPage = (
    req: { headers: Record<string, unknown>; url?: string },
    res: import("node:http").ServerResponse,
    badAttempt: boolean,
  ): void => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(
      `<!doctype html><html lang="ja"><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>Familiar Harness — token</title><style>` +
        `body{font-family:system-ui,sans-serif;background:#0f1117;color:#e6e6ea;display:grid;place-items:center;height:100vh;margin:0}` +
        `.card{background:#161923;border:1px solid #2a2e3a;border-radius:14px;padding:32px 36px;width:min(420px,90vw)}` +
        `h2{margin:0 0 4px;font-size:16px;display:flex;align-items:center;gap:8px}` +
        `.hint{color:#8b8b96;font-size:12.5px;line-height:1.7;margin:0 0 16px}` +
        `code{background:#0f1117;padding:1px 6px;border-radius:5px}` +
        `input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2a2e3a;background:#0f1117;color:#e6e6ea;font-size:14px}` +
        `input:focus{outline:none;border-color:#4a9eff}` +
        `button{margin-top:12px;width:100%;padding:10px;border-radius:8px;border:none;background:#2f6feb;color:#fff;font-size:14px;cursor:pointer}` +
        `button:hover{background:#4a9eff}` +
        `.err{color:#ff6b6b;font-size:12px;margin-top:10px;display:none}` +
        `</style><div class="card">` +
        `<h2>◍ Familiar Harness</h2>` +
        `<p class="hint">このサーバーへの接続にはアクセストークンが必要です。<br>` +
        `サーバー上で <code>cat ~/.familiar/server.token</code> を実行して確認できます。<br>` +
        `A bearer token is required — check <code>~/.familiar/server.token</code> on the server.</p>` +
        `<input id="t" type="password" placeholder="access token" autocomplete="off" autofocus>` +
        `<button onclick="go()">接続 / connect</button>` +
        `<div class="err" id="e">トークンが違います / invalid token</div></div>` +
        `<script>` +
        `function go(){var v=document.getElementById("t").value.trim();if(v)location.href="/?token="+encodeURIComponent(v);}` +
        `document.getElementById("t").addEventListener("keydown",function(e){if(e.key==="Enter")go();});` +
        (badAttempt ? `document.getElementById("e").style.display="block";` : "") +
        `</script>`,
    );
  };

    const sendUnauthorized = (
    req: { method?: string; headers: Record<string, unknown>; url?: string },
    res: import("node:http").ServerResponse,
    url: string,
  ): void => {
    if (url === "/" || url === "/index.html") {
      // friendly token entry page: paste the token once, get a cookie back
      const hadAttempt = new URL(req.url ?? "/", "http://localhost").searchParams.has("token");
      sendTokenPage(req, res, hadAttempt);
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
      if (url === "/oauth/callback") {
        // Google consent redirect: the state ties the callback to a legit
        // initiation, so this endpoint can stay unauthenticated
        const q = new URL(req.url ?? "/", "http://localhost").searchParams;
        const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
        let ok = false;
        let msg = "";
        try {
          const r = (await agent.dispatch("google.exchange", {
            code: q.get("code") ?? "",
            state: q.get("state") ?? "",
            redirect_uri: `${origin}/oauth/callback`,
          })) as { ok?: boolean };
          ok = r.ok === true;
        } catch (err) {
          msg = err instanceof Error ? err.message : String(err);
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(
          `<!doctype html><html lang="ja"><meta charset="utf-8"><body style="font-family:system-ui;background:#0f1117;color:#e6e6ea;display:grid;place-items:center;height:100vh">` +
            `<div style="text-align:center"><h2>${ok ? "✓ Google 連携が完了しました" : "✗ 連携に失敗しました"}</h2>` +
            (ok ? `<p style="color:#8b8b96">このタブを閉じて Familiar Harness に戻ってください。</p>` : `<p style="color:#ff6b6b">${msg.replace(/</g, "<")}</p>`) +
            `</div></body>`,
        );
        return;
      }
      if (url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            protocol: "familiar/1",
            auth: authRequired ? "required" : "off",
            ...(authRequired && opts.authTokenFile ? { tokenFile: opts.authTokenFile } : {}),
            ...(opts.version ? { version: opts.version } : {}),
          }),
        );
        return;
      }
      const kind = authKind(req);
      if (kind === "none") {
        sendUnauthorized(req, res, url);
        return;
      }
      // a fresh ?token=/Bearer sign-in hands out a cookie so the browser also
      // carries it on sub-resource requests (CSS/JS) and the /ws handshake
      const setCookie =
        kind === "explicit"
          ? {
              "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(opts.authToken ?? "")}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
            }
          : {};
      const asset = STATIC_FILES[url];
      if (asset) {
        const file = path.join(publicDir(), asset.file);
        if (fs.existsSync(file)) {
          // revalidate on every load: the UI ships as plain files, so a stale
          // cache after an update would mix old CSS with new markup
          const stat = fs.statSync(file);
          const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
          if (req.headers["if-none-match"] === etag) {
            res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache", ...setCookie });
            res.end();
            return;
          }
          res.writeHead(200, {
            "Content-Type": asset.type,
            "Cache-Control": "no-cache",
            ETag: etag,
            "Last-Modified": stat.mtime.toUTCString(),
            ...setCookie,
          });
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
