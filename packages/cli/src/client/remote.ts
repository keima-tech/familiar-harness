import type { AgentEvent } from "@familiar/protocol";

/**
 * Client transport for `familiar serve` (M2 remote mode).
 * - dispatch: POST /rpc (JSON-RPC request/response)
 * - events:   WebSocket push, routed per sessionId
 * - approvals: server-level permission.request → local handler → respond RPC
 */
export class RemoteFamiliarClient {
  private socket?: WebSocket;
  private socketPromise?: Promise<WebSocket>;
  private sessionHandlers = new Map<string, (event: AgentEvent) => void>();
  private closed = false;

  constructor(
    readonly baseUrl: string,
    private readonly approval?: (req: { requestId: string; tool: string; summary: string; detail?: string }) => Promise<boolean>,
    private readonly onServerEvent?: (event: AgentEvent) => void,
    /** M2 bearer token (when the server sets server.auth_token_file). */
    private readonly token?: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  /** Probe a running server (POST /rpc ping). */
  static async probe(baseUrl: string, timeoutMs = 700, token?: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "ping" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { result?: string };
      return body.result === "pong";
    } catch {
      return false;
    }
  }

  /** JSON-RPC call over HTTP; registers a sessionId → events route beforehand. */
  async dispatch(
    method: string,
    params: Record<string, unknown> = {},
    opts: { sessionId?: string; onEvent?: (event: AgentEvent) => void } = {},
  ): Promise<unknown> {
    if (opts.sessionId && opts.onEvent) {
      this.sessionHandlers.set(opts.sessionId, opts.onEvent);
    }
    await this.ensureSocket();
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/rpc`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(600_000),
    });
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (body.error) throw new Error(`rpc ${method} failed: ${body.error.message}`);
    return body.result;
  }

  close(): void {
    this.closed = true;
    this.socketPromise = undefined;
    // Actually release the socket — without this the open WebSocket keeps the
    // Node event loop alive and `familiar run --server …` never exits.
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
  }

  private ensureSocket(): Promise<WebSocket> {
    if (this.socketPromise && !this.closed) return this.socketPromise;
    this.socketPromise = new Promise<WebSocket>((resolve) => {
      const base = this.baseUrl.replace(/^http/, "ws").replace(/\/+$/, "");
      const wsUrl = this.token ? `${base}/ws?token=${encodeURIComponent(this.token)}` : `${base}/ws`;
      const socket = new WebSocket(wsUrl);
      this.socket = socket;
      socket.onopen = () => resolve(socket);
      socket.onmessage = (msg: MessageEvent) => {
        let frame:
          | { type: "event"; sessionId: string; event: AgentEvent }
          | { type: string; [k: string]: unknown };
        try {
          frame = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        if ((frame as { type?: string }).type !== "event") return;
        const eventFrame = frame as { type: "event"; sessionId: string; event: AgentEvent };
        if (eventFrame.sessionId === "") {
          void this.handleServerLevelEvent(eventFrame.event);
          return;
        }
        let handler = this.sessionHandlers.get(eventFrame.sessionId);
        // Sessions the CLI doesn't know (server-created) fall back to the
        // single registered sink (run mode registers at most one).
        if (!handler) {
          const only = [...this.sessionHandlers.values()];
          handler = only.length === 1 ? only[0] : undefined;
        }
        handler?.(eventFrame.event);
      };
      socket.onclose = () => {
        if (!this.closed) this.socketPromise = undefined; // reconnect on next call
      };
      socket.onerror = () => {
        if (!this.closed) this.socketPromise = undefined;
      };
    });
    return this.socketPromise;
  }

  private async handleServerLevelEvent(event: AgentEvent): Promise<void> {
    if (event.type === "permission.request") {
      this.onServerEvent?.(event);
      let approved = false;
      if (this.approval) {
        approved = await this.approval({
          requestId: event.requestId,
          tool: event.tool,
          summary: event.summary,
          detail: event.detail,
        });
      }
      try {
        // No handler (headless) → deny. The 300s server timeout is the fallback.
        await this.dispatch("permission.respond", { requestId: event.requestId, approved });
      } catch {
        /* respond may race the timeout — deny already applied server-side */
      }
      return;
    }
    if (event.type === "permission.resolved") {
      this.onServerEvent?.(event);
      return;
    }
    // Other server-level events: hand to any registered sink (e.g. --json mode).
    this.onServerEvent?.(event);
  }
}
