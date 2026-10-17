import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { log } from "../logger.js";
import { resolveShellCommand } from "../tools/bash.js";
import type { JsonSchemaObject } from "@familiar/protocol";
import type { McpServerConfig, ResolvedConfig } from "../config.js";
import type { Tool } from "../tools/registry.js";
import type { ToolContext, ToolOutput } from "../tools/registry.js";

/**
 * M5: MCP (Model Context Protocol) stdio client — zero dependencies.
 * One child process per configured server; newline-delimited JSON-RPC 2.0
 * over stdin/stdout (the MCP stdio transport framing). Requests we send and
 * responses we read are matched by incrementing numeric ids; notifications
 * from the server are ignored.
 */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type McpServerState = "ok" | "error";

interface JsonRpcResponse {
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class McpClient {
  private process?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly tools = new Map<string, McpToolDef>();

  constructor(
    readonly name: string,
    private readonly cfg: McpServerConfig,
  ) {}

  get state(): McpServerState | "stopped" {
    if (this.process === undefined) return "stopped";
    return this.process.exitCode === null && !this.process.killed ? "ok" : "error";
  }

  lastError?: string;

  /** Spawn the server and complete the MCP initialize handshake. */
  private ensureStarted(): void {
    if (this.process) return;
    const line = [this.cfg.command, ...(this.cfg.args ?? [])].join(" ");
    if (line.trim() === "") throw new Error("mcp server has empty command");
    // Repo policy: never spawn a raw command — go through resolveShellCommand
    // (bash on Linux, PowerShell on Windows).
    const shell = resolveShellCommand(line);
    const child = spawn(shell.file, shell.args, {
      cwd: this.cfg.cwd ?? process.cwd(),
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // MCP servers must not keep a CLI process alive past its work; the exit
    // cleanup in the server layer reaps them when --yolo runs finish.
    child.unref?.();
    (child.stdin as { unref?: () => void } | null)?.unref?.();
    (child.stdout as { unref?: () => void } | null)?.unref?.();
    (child.stderr as { unref?: () => void } | null)?.unref?.();
    child.on("error", (err) => {
      this.lastError = err.message;
      log.debug(`mcp ${this.name}: spawn failed: ${err.message}`);
    });
    child.stderr?.on("data", (d: Buffer) => {
      log.debug(`mcp ${this.name} stderr: ${d.toString().slice(0, 400)}`);
    });
    child.stdout?.setEncoding("utf8");
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line2) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line2);
      } catch {
        return; // tolerate stray non-JSON output
      }
      if (msg && typeof msg === "object" && "id" in msg) {
        const resp = msg as JsonRpcResponse;
        const id = typeof resp.id === "number" ? resp.id : Number(resp.id);
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (resp.error) {
          const detail = typeof resp.error === "object" ? JSON.stringify(resp.error) : String(resp.error);
          entry.reject(new Error(`mcp ${this.name}: ${detail.slice(0, 300)}`));
        } else {
          entry.resolve(resp.result);
        }
      }
      // notifications from the server are dropped
    });
    child.on("exit", () => {
      for (const [, p] of this.pending) p.reject(new Error(`mcp ${this.name}: server exited`));
      this.pending.clear();
    });
    this.process = child;
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    this.ensureStarted();
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    this.process!.stdin!.write(`${msg}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${this.name}: ${method} timed out`));
      }, this.cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /** initialize + notifications/initialized + tools/list; cached in tools map. */
  async discover(): Promise<void> {
    this.ensureStarted();
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "familiar", version: "0.4.0" },
    });
    this.process!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDef[] } | undefined;
    for (const t of result?.tools ?? []) {
      if (typeof t?.name === "string") this.tools.set(t.name, t);
    }
  }

  async callTool(toolName: string, argsJson: string): Promise<ToolOutput> {
    let args: unknown = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      return { content: `invalid tool arguments (not JSON): ${argsJson.slice(0, 200)}`, isError: true };
    }
    const started = Date.now();
    const result = (await this.request("tools/call", { name: toolName, arguments: args })) as
      | { content?: { type?: string; text?: string }[]; isError?: boolean }
      | undefined;
    const parts = (result?.content ?? [])
      .filter((c) => c && (c.type === undefined || c.type === "text") && typeof c.text === "string")
      .map((c) => c.text);
    const content =
      parts.length > 0
        ? parts.join("\n")
        : result && Object.keys(result).length > 0
          ? JSON.stringify(result).slice(0, 4000)
          : "(mcp tool returned no content)";
    if (result?.isError === true) {
      return { content, isError: true };
    }
    log.debug(
      `mcp ${this.name}.${toolName}: ok (${Date.now() - started}ms, ${content.length} chars)`,
    );
    return { content, isError: false };
  }

  stop(): void {
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        /* already gone */
      }
      this.process = undefined;
    }
  }
}

/** All configured MCP servers + the dynamic Tools they expose. */
export class McpHub {
  private readonly clients = new Map<string, McpClient>();
  private discovery?: Promise<void>;

  constructor(private readonly cfg: ResolvedConfig) {
    for (const [name, serverCfg] of Object.entries(cfg.mcp?.servers ?? {})) {
      if (serverCfg.disabled === true) continue;
      this.clients.set(name, new McpClient(name, serverCfg));
    }
  }

  /** Connect + tool-list every configured server (errors are recorded, not fatal). */
  discover(): Promise<void> {
    this.discovery ??= (async () => {
      await Promise.allSettled(
        [...this.clients.values()].map(async (client) => {
          try {
            await client.discover();
          } catch (err) {
            client.lastError = err instanceof Error ? err.message : String(err);
            log.warn(`mcp ${client.name}: not available (${client.lastError})`);
          }
        }),
      );
    })();
    return this.discovery;
  }

  /** Tools ready for a session: mcp__<server>__<tool> (read-only flag passthrough). */
  tools(): Tool[] {
    const out: Tool[] = [];
    for (const [serverName, client] of this.clients) {
      const serverCfg = this.cfg.mcp?.servers?.[serverName];
      const readOnly = serverCfg?.read_only === true;
      for (const [toolName, def] of client.tools) {
        const fullName = sanitizeName(`mcp__${serverName}__${toolName}`);
        const description =
          (def.description ?? "MCP tool").slice(0, 500) + ` (MCP server "${serverName}")`;
        out.push({
          name: fullName,
          description,
          parameters: isSchemaObject(def.inputSchema) ? (def.inputSchema as JsonSchemaObject) : { type: "object", properties: {} },
          read_only: readOnly,
          execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> => {
            const json = JSON.stringify(args ?? {});
            if (readOnly !== true) {
              const allowed = await ctx.approval.request({
                tool: fullName,
                summary: `MCP tool call: ${serverName} / ${toolName}`,
                detail: json.slice(0, 600),
              });
              if (!allowed) return { content: "denied by user (approval)", isError: true };
            }
            return client.callTool(toolName, json);
          },
        });
      }
    }
    return out;
  }

  /** True when any MCP server is configured (helps decide cleanup hooks). */
  hasServers(): boolean {
    return this.clients.size > 0;
  }

  status(): { name: string; state: string; tools: string[]; error?: string }[] {
    return [...this.clients.entries()].map(([name, c]) => ({
      name,
      state: c.state,
      tools: [...c.tools.keys()],
      ...(c.lastError ? { error: c.lastError } : {}),
    }));
  }

  stopAll(): void {
    for (const c of this.clients.values()) c.stop();
  }
}

/**
 * OpenAI-style tool schemas demand ^[a-zA-Z0-9_-]{1,64}$ — keep the MCP
 * convention (double underscores) and harden the rest.
 */
function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[^a-z0-9_]+/, "")
    .slice(0, 64);
}

function isSchemaObject(v: unknown): v is { type: "object"; properties?: Record<string, unknown> } {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}
