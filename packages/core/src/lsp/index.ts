/**
 * M6: minimal LSP (Language Server Protocol) client over stdio.
 *
 * Zero-dependency implementation of the subset Familiar needs:
 *   initialize → initialized → textDocument/didOpen|didChange →
 *   wait for textDocument/publishDiagnostics notifications.
 *
 * One persistent child process per configured language (lazily started).
 * Children are unref'd so a plain `familiar run` process exits cleanly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "../logger.js";
import { sshStdioSpec, type StdioSpec } from "../exec/ssh.js";
import type { ExecBackend } from "../exec/types.js";
import type { SessionRemote } from "@familiar/protocol";
import type { LspServerConfig, ResolvedConfig } from "../config.js";

/**
 * Where a language server runs and how its files are addressed. Local servers
 * take platform paths and read files from this machine; SSH servers get a
 * spawn spec (the ssh client's stdio is the server's stdio), posix file URIs,
 * and file contents fetched through the session backend.
 */
export interface LspTransport {
  spawnSpec?: StdioSpec;
  uriFor(file: string): string;
  readText(file: string): Promise<string>;
}

function localTransport(): LspTransport {
  return {
    uriFor: (file) => pathToFileURL(file).toString(),
    readText: async (file) => fs.readFileSync(file, "utf8"),
  };
}

/** file:// URI with posix semantics (remote hosts may differ from the client). */
function posixFileUri(file: string): string {
  const normalized = file.startsWith("/") ? file : `/${file}`;
  return `file://${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

function sshTransport(target: SessionRemote, server: LspServerConfig, backend: ExecBackend): LspTransport {
  const rc = server.remote ?? {};
  const cwd = rc.cwd;
  return {
    spawnSpec: sshStdioSpec(target, rc.command ?? server.command, rc.args ?? server.args ?? [], {
      ...(cwd ? { cwd } : {}),
    }),
    uriFor: posixFileUri,
    readText: async (file) => (await backend.readFile(file)).toString("utf8"),
  };
}

export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface LspDiagnostic {
  uri: string;
  range: LspRange;
  message: string;
  severity?: number;
  code?: string | number;
  source?: string;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  timer: NodeJS.Timeout;
  resolve: (diagnostics: LspDiagnostic[] | null) => void;
}

const SEVERITY_NAMES: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

export function severityName(severity: number | undefined): string {
  if (severity !== undefined && SEVERITY_NAMES[severity]) return SEVERITY_NAMES[severity] as string;
  return String(severity ?? "?");
}

function normalizeExt(e: string): string {
  return e.trim().replace(/^\./, "").toLowerCase();
}

/** LSP languageId from a file extension (best effort; servers tolerate unknown ids). */
export function languageIdFor(ext: string): string {
  switch (normalizeExt(ext)) {
    case "ts":
      return "typescript";
    case "tsx":
      return "typescriptreact";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "rb":
      return "ruby";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "hpp":
      return "cpp";
    case "java":
      return "java";
    case "cs":
      return "csharp";
    case "json":
      return "json";
    case "md":
      return "markdown";
    default:
      return normalizeExt(ext) || "plaintext";
  }
}

/** One stdio language server connection (per language). */
export class LspClient {
  readonly language: string;
  readonly serverConfig: LspServerConfig;
  readonly extensions: string[];

  private child: ChildProcess | null = null;
  private clientState: "idle" | "starting" | "running" | "failed" | "stopped" = "idle";
  private lastError: string | undefined;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private waiters = new Map<string, Waiter[]>();
  private opened = new Set<string>();
  private startup: Promise<void> | null = null;

  constructor(
    language: string,
    serverConfig: LspServerConfig,
    private readonly rootUri: string,
    private readonly transport: LspTransport = localTransport(),
  ) {
    this.language = language;
    this.serverConfig = serverConfig;
    this.extensions = (serverConfig.extensions ?? []).map(normalizeExt);
  }

  get state(): string {
    return this.clientState;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  /** Start + handshake (idempotent; concurrent callers share one startup). */
  start(): Promise<void> {
    if (this.clientState === "running") return Promise.resolve();
    if (this.startup) return this.startup;
    this.clientState = "starting";
    let settled = false;
    this.startup = new Promise<void>((resolve, reject) => {
      try {
        this.child = this.transport.spawnSpec
          ? spawn(this.transport.spawnSpec.file, this.transport.spawnSpec.args, {
              stdio: ["pipe", "pipe", "pipe"],
            })
          : spawn(this.serverConfig.command, this.serverConfig.args ?? [], {
              stdio: ["pipe", "pipe", "pipe"],
            });
      } catch (err) {
        this.clientState = "failed";
        this.lastError = err instanceof Error ? err.message : String(err);
        this.startup = null;
        reject(new Error(`lsp: failed to spawn ${this.serverConfig.command}: ${this.lastError}`));
        return;
      }
      this.child.on("error", (err) => {
        this.clientState = "failed";
        this.lastError = err.message;
        for (const [, req] of [...this.pending]) {
          clearTimeout(req.timer);
          req.reject(err);
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          this.startup = null;
          reject(err);
        }
      });
      this.child.stdout?.on("data", (chunk: Buffer) => this.feed(chunk));
      this.child.stderr?.on("data", (chunk: Buffer) => {
        log.debug(`lsp(${this.language}) stderr: ${chunk.toString().trim()}`);
      });
      this.child.on("exit", (code, signal) => {
        this.child = null;
        if (this.clientState !== "stopped") {
          this.clientState = "failed";
          if (!this.lastError) {
            this.lastError = `server exited (code ${code ?? "?"} signal ${signal ?? "?"})`;
          }
        }
        for (const [, req] of [...this.pending]) {
          clearTimeout(req.timer);
          req.reject(new Error("lsp server exited before responding"));
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          this.startup = null;
          reject(new Error(`lsp server exited during startup (code ${code ?? "?"})`));
        }
      });
      // Keep the CLI / serve process free to exit independently.
      this.child.unref?.();
      (this.child.stdin as { unref?: () => void } | null)?.unref?.();
      (this.child.stdout as { unref?: () => void } | null)?.unref?.();
      (this.child.stderr as { unref?: () => void } | null)?.unref?.();

      const timeoutMs = Math.max(this.serverConfig.timeout_ms ?? 5000, 10_000);
      this.request("initialize", {
        processId: null,
        rootUri: this.rootUri,
        capabilities: { textDocument: { diagnostic: {} } },
      }, timeoutMs)
        .then(() => {
          this.notify("initialized", {});
          this.clientState = "running";
          if (!settled) {
            settled = true;
            resolve();
          }
        })
        .catch((err: Error) => {
          this.clientState = "failed";
          this.lastError = err.message;
          if (!settled) {
            settled = true;
            this.startup = null;
            reject(err);
          }
        });
    });
    return this.startup;
  }

  /** Diagnose one file: didOpen (or didChange refresh) → publishDiagnostics. */
  async diagnose(file: string): Promise<{ diagnostics: LspDiagnostic[] | null; timedOut: boolean }> {
    await this.start();
    const uri = this.transport.uriFor(file);
    let text = "";
    try {
      text = await this.transport.readText(file);
    } catch (err) {
      throw new Error(`lsp: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const languageId = languageIdFor(path.extname(file));
    if (!this.opened.has(uri)) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      this.opened.add(uri);
    } else {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text }],
      });
    }
    const arrived = await this.waitFor(uri, this.serverConfig.timeout_ms ?? 5000);
    if (arrived === null) {
      return { diagnostics: this.diagnostics.get(uri) ?? [], timedOut: true };
    }
    return { diagnostics: arrived, timedOut: false };
  }

  stop(): void {
    this.clientState = "stopped";
    for (const [, req] of [...this.pending]) {
      clearTimeout(req.timer);
      req.reject(new Error("lsp client stopped"));
    }
    this.pending.clear();
    for (const [, list] of [...this.waiters]) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
    }
    this.waiters.clear();
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
      this.child = null;
    }
  }

  private waitFor(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    // Clear the cached publication so a fresh notification is required.
    this.diagnostics.delete(uri);
    return new Promise((resolve) => {
      let settled = false;
      // NOTE: intentionally NOT unref'd — a ref'd timer is what keeps the
      // event loop alive while waiting for the server's publication.
      const timer = setTimeout(() => {
        const list = this.waiters.get(uri) ?? [];
        const idx = list.indexOf(waiter);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) this.waiters.delete(uri);
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, timeoutMs);
      const waiter: Waiter = {
        timer,
        resolve: (d) => {
          if (!settled) {
            settled = true;
            resolve(d);
          }
        },
      };
      const list = this.waiters.get(uri) ?? [];
      list.push(waiter);
      this.waiters.set(uri, list);
    });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin?.writable) {
      return Promise.reject(new Error("lsp: server not running"));
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`lsp: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendFrame(Buffer.from(frame, "utf8"));
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child?.stdin?.writable) return;
    this.sendFrame(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }), "utf8"));
  }

  private sendFrame(body: Buffer): void {
    try {
      this.child?.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`);
      this.child?.stdin?.write(body);
    } catch (err) {
      log.warn(`lsp(${this.language}) write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        log.warn(`lsp(${this.language}) malformed header: ${header.slice(0, 80)}`);
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const total = headerEnd + 4 + length;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(headerEnd + 4, total).toString("utf8");
      this.buffer = this.buffer.subarray(total);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let msg: {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      error?: { message?: string };
      result?: unknown;
    };
    try {
      msg = JSON.parse(body);
    } catch {
      log.warn(`lsp(${this.language}) invalid JSON frame`);
      return;
    }
    const id = typeof msg.id === "number" ? msg.id : undefined;
    if (msg.method === "textDocument/publishDiagnostics") {
      const uri = String(msg.params?.["uri"] ?? "");
      const diags = Array.isArray(msg.params?.["diagnostics"]) ? msg.params?.["diagnostics"] : [];
      this.diagnostics.set(uri, diags as LspDiagnostic[]);
      const waiters = this.waiters.get(uri);
      if (waiters) {
        this.waiters.delete(uri);
        for (const w of waiters) {
          clearTimeout(w.timer);
          w.resolve(diags as LspDiagnostic[]);
        }
      }
      return;
    }
    if (id !== undefined && msg.method) {
      // Unsupported server→client request: reply null so the server never stalls.
      this.sendFrame(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: null }), "utf8"));
      return;
    }
    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new Error(`lsp: request failed: ${msg.error.message ?? "unknown error"}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }
}

/** Hub: routes files to per-language clients, owns lifecycle. */
export class LspHub {
  private clients = new Map<string, LspClient>();

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly transportFor: (server: LspServerConfig) => LspTransport = () => localTransport(),
  ) {}

  private rootUri: string | undefined; // frozen at first start (v1)

  private serverFor(ext: string): { name: string; config: LspServerConfig } | null {
    const want = normalizeExt(ext);
    for (const [name, config] of Object.entries(this.cfg.lsp?.servers ?? {})) {
      if (config.disabled) continue;
      if ((config.extensions ?? []).map(normalizeExt).includes(want)) {
        return { name, config };
      }
    }
    return null;
  }

  /** Which server would handle this extension (also used by the tool's error). */
  hasExtension(ext: string): boolean {
    return this.serverFor(ext) !== null;
  }

  async diagnose(file: string): Promise<{
    language: string;
    server: string;
    diagnostics: LspDiagnostic[] | null;
    timedOut: boolean;
  }> {
    const ext = path.extname(file);
    const route = this.serverFor(ext);
    if (!route) {
      throw new Error(
        `lsp: no language server configured for extension "${ext || "(none)"}" (see lsp.servers in config)`,
      );
    }
    let client = this.clients.get(route.name);
    if (!client) {
      client = new LspClient(
        route.name,
        route.config,
        this.rootUri ?? (this.rootUri = "file:///"),
        this.transportFor(route.config),
      );
    }
    const res = await client.diagnose(file);
    return { language: route.name, server: route.config.command, ...res };
  }

  status(): { name: string; state: string; extensions: string[]; error?: string }[] {
    return [...this.clients.entries()].map(([name, c]) => ({
      name,
      state: c.state,
      extensions: (c.serverConfig.extensions ?? []).slice(),
      ...(c.error ? { error: c.error } : {}),
    }));
  }

  stopAll(): void {
    for (const [, client] of [...this.clients]) client.stop();
    this.clients.clear();
  }
}

// ---------------------------------------------------------------------------
// Shared hub instance (one per process; rebuilt when the lsp config changes)
// ---------------------------------------------------------------------------

let hub: LspHub | null = null;
let hubKey = "";

/** Get (or rebuild) the process-wide LSP hub; null when nothing is configured. */
export function getLspHub(config: ResolvedConfig): LspHub | null {
  const servers = config.lsp?.servers ?? {};
  if (Object.keys(servers).length === 0) return null;
  const key = JSON.stringify(servers);
  if (hub && hubKey === key) return hub;
  hub?.stopAll();
  hub = new LspHub(config);
  hubKey = key;
  return hub;
}

/** Called from server.dispose() and the process exit cleanup. */
export function disposeLspHub(): void {
  hub?.stopAll();
  hub = null;
  hubKey = "";
}

// ---------------------------------------------------------------------------
// SSH hubs: language servers spawned on a remote host, one hub per target
// ---------------------------------------------------------------------------

interface SshHubEntry {
  configKey: string;
  hub: LspHub;
}

const sshHubs = new Map<string, SshHubEntry>();

/** Hub whose language servers run on an SSH host (proxy sessions). */
export function getSshLspHub(
  config: ResolvedConfig,
  target: SessionRemote,
  backend: ExecBackend,
): LspHub | null {
  const servers = config.lsp?.servers ?? {};
  if (Object.keys(servers).length === 0) return null;
  const targetKey = `${target.user ?? ""}@${target.host}:${target.port ?? 22}:${target.identityFile ?? ""}`;
  const configKey = JSON.stringify(servers);
  const entry = sshHubs.get(targetKey);
  if (entry && entry.configKey === configKey) return entry.hub;
  entry?.hub.stopAll();
  const created = new LspHub(config, (server) => sshTransport(target, server, backend));
  sshHubs.set(targetKey, { configKey, hub: created });
  return created;
}

/** Called from server.dispose() and the process exit cleanup. */
export function disposeSshLspHubs(): void {
  for (const entry of sshHubs.values()) entry.hub.stopAll();
  sshHubs.clear();
}
