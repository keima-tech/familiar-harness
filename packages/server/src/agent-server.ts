import crypto from "node:crypto";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  ModelInfo,
  RpcContext,
  SessionRecord,
  TodoItem,
  ToolCall,
  Usage,
} from "@familiar/protocol";
import {
  RPC_ERROR_METHOD_NOT_FOUND,
  RPC_ERROR_INVALID_PARAMS,
} from "@familiar/protocol";
import {
  AgentRunner,
  loadConfig,
  configFilePath,
  writeConnectorsToDisk,
  writeProviderToDisk,
  describeAuthSource,
  normalizeEffort,
  familiarPaths,
  sanitizeConfigForApi,
  ProviderRegistry,
  SqliteSessionStore,
  MemoryStore,
  PendingMemoryStore,
  SkillStore,
  PendingSkillStore,
  Settings,
  CuratorRunner,
  postTurnReview,
  approveStagedMemory,
  rejectStagedMemory,
  approveStagedSkill,
  rejectStagedSkill,
  startCuratorScheduler,
  McpHub,
  HookRunner,
  CronScheduler,
  DenyApprovalAdapter,
  disposeLspHub,
  type ApprovalAdapter,
  type CronJob,
  type CuratorScheduler,
  type ResolvedConfig,
  type ProviderConfig,
  type ProviderPatch,
  type SessionStore,
  type SelfImproveContext,
  type ToolRegistry,
} from "@familiar/core";
import { log } from "@familiar/core";
import { SessionTodoStore } from "./todo-store.js";
import { RpcApprovalAdapter } from "./rpc-approvals.js";

/**
 * M5: every AgentServer with configured MCP servers registers here so child
 * processes are reaped on process exit (familiar run must not wedge on them).
 */
let mcpExitCleanupInstalled = false;
const liveMcpHubs = new Set<McpHub>();
function installMcpExitCleanup(hub: McpHub): void {
  liveMcpHubs.add(hub);
  if (mcpExitCleanupInstalled) return;
  mcpExitCleanupInstalled = true;
  process.on("exit", () => {
    for (const h of liveMcpHubs) h.stopAll();
  });
}

/**
 * Transport-independent agent service. HTTP/WS wrappers and the CLI's
 * in-process bridge both drive this via dispatch().
 */
export class AgentServer {
  readonly cfg: ResolvedConfig;
  readonly store: SessionStore;
  readonly providers: ProviderRegistry;
  readonly todos: SessionTodoStore;
  readonly selfImprove: SelfImproveContext;
  private readonly runner: AgentRunner;
  private rpcApproval?: RpcApprovalAdapter;
  private broadcastHook?: (sessionId: string, event: unknown) => void;

  constructor(    opts: {
      config?: ResolvedConfig;
      version?: string;
      store?: SessionStore;
      tools?: ToolRegistry;
      approval?: ApprovalAdapter;
      /** M2: install the RPC approval bridge (serve mode) */
      rpcApprovals?: boolean;
      rpcApprovalTimeoutMs?: number;
      /** M3: override the self-improvement context (tests) */
      selfImprove?: SelfImproveContext;
      /** M3: run background self-review after turns (default true) */
      disableReview?: boolean;
      /** M5: skip MCP dynamic tools (tests) */
      disableMcp?: boolean;
      /** M5: skip lifecycle hooks (tests) */
      disableHooks?: boolean;
    } = {},
  ) {
    this.serverVersion = opts.version ?? "0.0.0";

    this.cfg = opts.config ?? loadConfig();
    this.store = opts.store ?? new SqliteSessionStore(familiarPaths.stateDb());
    this.providers = new ProviderRegistry(this.cfg);
    this.todos = new SessionTodoStore();
    this.selfImprove =
      opts.selfImprove ??
      (() => {
        const home = this.cfg.homeDir || familiarPaths.home();
        return {
          memories: new MemoryStore(home),
          pendingMemories: new PendingMemoryStore(home),
          skills: new SkillStore(home),
          pendingSkills: new PendingSkillStore(home),
          settings: new Settings(home),
        };
      })();
    if (opts.rpcApprovals) {
      this.rpcApproval = new RpcApprovalAdapter(
        (event) => this.broadcastHook?.("", event),
        opts.rpcApprovalTimeoutMs,
      );
    }
    const approval = opts.approval ?? this.rpcApproval;
    this.approval = approval;
    // M5: hooks must exist before the runner is built; MCP discovery runs in
    // the background and registers dynamic tools when ready. Empty config ⇒
    // nothing is spawned, so default construction stays inert.
    this.hooks = opts.disableHooks === true ? undefined : new HookRunner(this.cfg);
    if (opts.disableMcp !== true) {
      this.mcp = new McpHub(this.cfg);
      void this.mcpReady();
      if (this.mcp.hasServers()) {
        installMcpExitCleanup(this.mcp);
      }
    }
    this.curator = new CuratorRunner(this.cfg, this.providers, this.selfImprove);
    this.runner = new AgentRunner(this.cfg, this.providers, this.store, {
      tools: opts.tools,
      approval,
      todos: this.todos,
      selfImprove: this.selfImprove,
      hooks: this.hooks,
      taskRunner: (args) =>
        this.runSubagentTask({
          sessionId: args.sessionId,
          description: args.description,
          prompt: args.prompt,
          yolo: args.yolo,
        }),
    });
    this.disableReview = opts.disableReview === true;
  }

  private approval?: ApprovalAdapter;
  private disableReview: boolean;
  /** M4: skill gardening (curator) */
  readonly curator: CuratorRunner;
  private curatorScheduler?: CuratorScheduler;
  /** M4: ms timestamp of the last turn activity (idle feed for the curator) */
  private lastTurnAt = Date.now();
  /** runs per session while a turn is streamed (session.abort kills it) */
  private readonly activeTurns = new Map<string, AbortController>();
  /** M5: MCP dynamic tools */
  readonly mcp?: McpHub;
  private mcpDiscover?: Promise<void>;
  /** M5: lifecycle hooks */
  readonly hooks?: HookRunner;
  /** M5: scheduled prompts (public for CLI/serve display) */
  cronScheduler?: CronScheduler;

  /** MCP discovery (memoized); resolves after dynamic tools are registered. */
  mcpReady(): Promise<void> {
    if (!this.mcp) return Promise.resolve();
    this.mcpDiscover ??= this.mcp
      .discover()
      .then(() => {
        this.runner.registerExtraTools(this.mcp!.tools());
      })
      .catch(() => {
        /* every server failure is recorded inside the hub */
      });
    return this.mcpDiscover;
  }

  /** Serve mode: start scheduled prompts (config cron.jobs). */
  startCronScheduler(): CronScheduler | undefined {
    if (this.cronScheduler) return this.cronScheduler;
    const jobs = (this.cfg.cron?.jobs ?? []).filter(
      (j) => j.enabled !== false && typeof j.prompt === "string" && j.prompt.trim() !== "" && Number.isFinite(j.every_minutes),
    );
    if (jobs.length === 0) return undefined;
    this.cronScheduler = new CronScheduler(jobs, (job) => this.runCronJob(job));
    this.cronScheduler.start();
    return this.cronScheduler;
  }

  /** Kill MCP servers / cron timers (serve shutdown, tests). */
  dispose(): void {
    this.mcp?.stopAll();
    this.cronScheduler?.stop();
    disposeLspHub();
  }

  private async runCronJob(job: CronJob): Promise<void> {
    const name = job.name ?? job.prompt.slice(0, 24);
    const started = Date.now();
    const session = await this.createSession({ title: `cron: ${name}` });
    const emit = (event: unknown): void => {
      try {
        this.broadcastHook?.(session.id, event);
      } catch {
        /* event sink failures must not kill the job */
      }
    };
    // Unattended execution: unapproved risky tools are denied immediately
    // instead of stalling on the 300s RPC approval timeout.
    const cronRunner = new AgentRunner(this.cfg, this.providers, this.store, {
      approval: new DenyApprovalAdapter(),
      todos: this.todos,
      selfImprove: this.selfImprove,
      taskRunner: (args) =>
        this.runSubagentTask({
          sessionId: args.sessionId,
          description: args.description,
          prompt: args.prompt,
          yolo: args.yolo,
        }),
      hooks: this.hooks,
    });
    if (this.mcp) {
      await this.mcpReady();
      cronRunner.registerExtraTools(this.mcp.tools());
    }
    log.info(`cron: running "${name}" on session ${session.id.slice(0, 8)}`);
    try {
      await cronRunner.runTurn({
        sessionId: session.id,
        userText: job.prompt,
        maxSteps: 25,
        yolo: false,
        onEvent: emit,
      });
      emit({ type: "cron.run", name, status: "ok", durationMs: Date.now() - started });
    } catch (err) {
      emit({ type: "cron.run", name, status: "error", durationMs: Date.now() - started });
      throw err; // the scheduler records the failure; other jobs keep running
    }
  }

  /** Serve mode: start the maintenance scheduler (curator). */
  startCuratorScheduler(tickMinutes = 15): CuratorScheduler | undefined {
    if (this.curatorScheduler) return this.curatorScheduler;
    this.curatorScheduler = startCuratorScheduler(this.cfg, this.curator, {
      intervalMs: tickMinutes,
      idleSince: (): number => Date.now() - this.lastTurnAt,
    });
    return this.curatorScheduler;
  }

  /** Hook installed by the HTTP transport; cron turns use their session id. */
  attachBroadcast(broadcast: (sessionId: string, event: unknown) => void): void {
    this.broadcastHook = broadcast;
  }

  private async runSubagentTask(args: {
    sessionId: string;
    description: string;
    prompt: string;
    yolo: boolean;
  }): Promise<string> {
    const parent = this.store.getSession(args.sessionId);
    if (!parent) throw new Error(`parent session not found: ${args.sessionId}`);
    const child = this.store.createSession({
      title: `↳ task: ${args.description.slice(0, 40)}`,
      provider: parent.provider,
      model: parent.model,
      cwd: parent.cwd,
    });
    log.debug(`subagent task: session ${child.id} (parent ${parent.id.slice(0, 8)})`);
    // Single-level recursion by design (M2): the subagent runner has no taskRunner.
    const subRunner = new AgentRunner(this.cfg, this.providers, this.store, {
      approval: this.approval,
    });
    await subRunner.runTurn({
      sessionId: child.id,
      userText: args.prompt,
      provider: parent.provider,
      model: parent.model,
      yolo: args.yolo,
      maxSteps: 15,
      onEvent: () => {
        /* subagent events are swallowed in M2 */
      },
    });
    const msgs = this.store.getMessages(child.id);
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    return lastAssistant?.content ?? "(subagent produced no final text)";
  }

  async dispatch(
    method: string,
    params: Record<string, unknown> = {},
    ctx: RpcContext = {},
  ): Promise<unknown> {
    switch (method) {
      case "ping":
        return "pong";
      case "config.get":
        return sanitizeConfigForApi(this.cfg);
      case "config.provider.set":
        return this.configProviderSet(params);
      case "models.list":
        return this.modelsList(params);
      case "models.probe":
        return this.modelsProbe(params);
      case "connectors.get":
        return this.connectorsGet();
      case "connectors.set":
        return this.connectorsSet(params);
      case "connectors.delete":
        return this.connectorsDelete(params);
      case "connectors.test":
        return this.connectorsTest(params);
      case "skills.save":
        return this.skillsSave(params);
      case "skills.delete":
        return this.skillsDelete(params);
      case 'update.check':
        return this.updateCheck();
      case "google.authUrl":
        return this.googleAuthUrl(params);
      case "google.exchange":
        return this.googleExchange(params);
      case "google.test":
        return this.googleTest();
      case "google.gmailList":
        return this.googleGmailList(params);
      case "google.calendarList":
        return this.googleCalendarList(params);
      case "fs.list":
        return this.fsList(params);
      case "fs.read":
        return this.fsRead(params);
      case "fs.preview":
        return this.fsPreview(params);
      case "fs.dirs":
        return this.fsDirs(params);
      case "fs.suggest":
        return this.fsSuggest(params);
      case "todo.list":
        return this.todoList(params);
      case "session.create":
        return this.createSession(params);
      case "session.list":
        return this.store.listSessions();
      case "session.get": {
        const session = this.requireSession(str(params, "id"));
        return { session, messages: this.store.getMessages(session.id) };
      }
      case "session.delete": {
        const delId = str(params, "id");
        if (!delId) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
        const deleted = this.store.deleteSession(delId);
        if (!deleted) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session not found");
        this.todos.drop(delId);
        return { deleted: true };
      }
      case "session.update":
        return this.updateSession(params);
      case "session.send":
        return this.send(params, ctx);
      case "session.abort":
        return this.abortTurn(params);
      case "permission.respond": {
        const requestId = str(params, "requestId");
        if (!requestId) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "requestId is required");
        const approved = params["approved"] === true;
        if (!this.rpcApproval) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "rpc approvals not installed");
        const resolved = this.rpcApproval.respond(requestId, approved);
        if (!resolved) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "request not pending");
        this.broadcastHook?.("", { type: "permission.resolved", requestId, approved });
        return { resolved: true };
      }
      case "memory.list":
        return this.memoryList();
      case "memory.pending":
        return this.memoryPending();
      case "memory.approve":
        return this.memoryApprove(params);
      case "memory.reject":
        return this.memoryReject(params);
      case "memory.approval":
        return this.memoryApproval(params);
      case "skills.list":
        return this.skillsList();
      case "skills.view":
        return this.skillsView(params);
      case "skills.pending":
        return this.skillsPending();
      case "skills.approve":
        return this.skillsApprove(params);
      case "skills.reject":
        return this.skillsReject(params);
      case "curator.status":
        return { curator: this.curator.status() };
      case "curator.run": {
        const consolidate = params["consolidate"] === true || this.cfg.curator.consolidate === true;
        const phase1 = this.curator.runPhase1({ dryRun: params["dryRun"] === true });
        const outcome = consolidate
          ? await this.curator.runConsolidation({ dryRun: params["dryRun"] === true })
          : undefined;
        return { phase1, consolidation: outcome };
      }
      case "mcp.status": {
        await this.mcpReady();
        return { servers: this.mcp?.status() ?? [] };
      }
      case "cron.status": {
        const runtime = this.cronScheduler?.status();
        return {
          started: runtime?.started ?? false,
          jobs: runtime?.jobs ?? (this.cfg.cron?.jobs ?? []),
        };
      }
      default:
        throw new RpcError(RPC_ERROR_METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  }

  /** GUI "プロバイダー" settings: persist kind / endpoint / default model and
   * the API key (never inline — see writeProviderToDisk), then hot-swap the
   * in-memory config and drop provider caches. No secret values are returned. */
  private configProviderSet(params: Record<string, unknown>): Record<string, unknown> {
    const name = str(params, "name");
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "provider name (alphanumeric) is required");
    }
    const patch: ProviderPatch = { name };
    const kind = str(params, "kind");
    if (kind !== undefined && kind !== "") {
      if (kind !== "openai_compatible" && kind !== "anthropic" && kind !== "mock") {
        throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unknown provider kind: ${kind}`);
      }
      patch.kind = kind;
    }
    const baseUrl = str(params, "base_url");
    if (baseUrl !== undefined) {
      const trimmed = baseUrl.trim();
      if (trimmed !== "" && !/^https?:\/\//i.test(trimmed)) {
        throw new RpcError(RPC_ERROR_INVALID_PARAMS, "base_url must start with http:// or https://");
      }
      patch.base_url = trimmed;
    }
    const defaultModel = str(params, "default_model");
    if (defaultModel !== undefined) patch.default_model = defaultModel.trim();
    if (params["clear_api_key"] === true) patch.clear_api_key = true;
    else {
      const apiKey = str(params, "api_key");
      if (apiKey !== undefined && apiKey.trim() !== "") patch.api_key = apiKey.trim();
    }

    const updated = writeProviderToDisk(patch);

    // hot-swap: replace the entry in the shared (reference-captured) config
    // graph, then drop cached provider instances so secrets are re-resolved.
    const nextPc: ProviderConfig = { ...updated };
    this.cfg.providers[name] = nextPc;
    this.providers.invalidate();

    return {
      updated: true,
      provider: {
        name,
        kind: nextPc.kind,
        base_url: nextPc.base_url,
        default_model: nextPc.default_model,
        auth: describeAuthSource(nextPc.auth),
      },
    };
  }

  private async modelsList(params: Record<string, unknown>): Promise<{
    provider: string;
    models: ModelInfo[];
    error?: string;
  }> {
    const providerId = str(params, "provider") ?? this.cfg.default_provider;
    try {
      const provider = this.providers.getPrimary(providerId);
      const models = await provider.listModels();
      return { provider: providerId, models };
    } catch (err) {
      return { provider: providerId, models: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * List models from a provider config that is *not saved yet* (settings GUI:
   * custom OpenAI-compatible endpoint / Ollama). A throwaway provider is
   * created on a cloned config — nothing is persisted, cached, or logged, and
   * the API key is never part of the response.
   */
  private async modelsProbe(params: Record<string, unknown>): Promise<{
    models: ModelInfo[];
    error?: string;
  }> {
    const baseUrl = (str(params, "base_url") ?? "").trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "base_url must start with http:// or https://");
    }
    const kind = str(params, "kind") ?? "openai_compatible";
    if (kind !== "openai_compatible" && kind !== "anthropic") {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unsupported kind for probe: ${kind}`);
    }
    const apiKey = str(params, "api_key");
    const probeId = "__probe__";
    const synthetic: ProviderConfig = {
      kind,
      base_url: baseUrl,
      ...(apiKey ? { auth: { api_key: apiKey } } : {}),
    };
    const cfg: ResolvedConfig = {
      ...this.cfg,
      providers: { ...this.cfg.providers, [probeId]: synthetic },
    };
    try {
      const provider = ProviderRegistry.create(probeId, cfg);
      const models = await provider.listModels();
      return { models };
    } catch (err) {
      return {
        models: [],
        error: `${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * List existing subdirectories of `path` (working-folder suggestions in the
   * GUI). Read-only; the server already exposes full filesystem access through
   * the agent tools, so this adds no new capability. Empty path = home dir.
   */
  /** ~ expansion + resolve for the fs.* helpers. */
  private resolveFsPath(raw: string, cwd?: string): string {
    if (raw === "" || raw === "~") return os.homedir();
    if (raw.startsWith("~/") || raw.startsWith("~\\"))
      return path.join(os.homedir(), raw.slice(2));
    if (cwd && cwd !== "" && !path.isAbsolute(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
      return path.resolve(cwd, raw);
    }
    return path.resolve(raw);
  }

  /** MIME guesses for the GUI file preview (by extension). */
  private static readonly PREVIEW_MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
    mp4: "video/mp4", webm: "video/webm",
    pdf: "application/pdf",
  };

  /**
   * Rich preview payload for the GUI file viewer: images / audio / video /
   * pdf come back base64-encoded (capped), markdown and text as content,
   * unknown binaries as an info stub. Read-only.
   */
  private fsPreview(params: Record<string, unknown>): {
    path: string;
    kind: "image" | "audio" | "video" | "pdf" | "markdown" | "text" | "binary";
    mime?: string;
    dataBase64?: string;
    content?: string;
    truncated?: boolean;
    size: number;
    tooLarge?: boolean;
  } {
    const raw = (str(params, "path") ?? "").trim();
    const target = this.resolveFsPath(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `cannot stat: ${target}`);
    }
    if (!stat.isFile()) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `not a file: ${target}`);
    const size = stat.size;
    const ext = path.extname(target).replace(".", "").toLowerCase();

    if (ext === "md" || ext === "markdown") {
      const CAP = 256 * 1024;
      const buf = fs.readFileSync(target);
      if (buf.subarray(0, 8192).includes(0)) return { path: target, kind: "binary", size };
      return {
        path: target, kind: "markdown",
        content: buf.subarray(0, CAP).toString("utf8"),
        truncated: buf.length > CAP, size,
      };
    }

    const mime = AgentServer.PREVIEW_MIME[ext];
    if (mime) {
      const kind = mime.startsWith("image/") ? "image"
        : mime.startsWith("audio/") ? "audio"
        : mime.startsWith("video/") ? "video"
        : "pdf";
      const cap = kind === "audio" || kind === "video" ? 64 * 1024 * 1024 : 20 * 1024 * 1024;
      if (size > cap) return { path: target, kind, mime, size, tooLarge: true };
      const buf = fs.readFileSync(target);
      return { path: target, kind, mime, dataBase64: buf.toString("base64"), size };
    }

    // everything else: text unless it sniffs binary
    const TEXT_CAP = 256 * 1024;
    const buf = fs.readFileSync(target);
    if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) {
      return { path: target, kind: "binary", size };
    }
    return {
      path: target, kind: "text",
      content: buf.subarray(0, TEXT_CAP).toString("utf8"),
      truncated: buf.length > TEXT_CAP, size,
    };
  }

  /** Directory listing with files, for the GUI file tree (read-only). */
  private fsList(params: Record<string, unknown>): {
    path: string;
    entries: Array<{ name: string; path: string; dir: boolean; size: number }>;
    home: string;
  } {
    const raw = (str(params, "path") ?? "").trim();
    const target = this.resolveFsPath(raw);
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `cannot list directory: ${target}`);
    }
    const mapped = dirents
      .filter((e) => !e.name.startsWith("."))
      .map((e) => {
        let size = 0;
        if (e.isFile()) {
          try {
            size = fs.statSync(path.join(target, e.name)).size;
          } catch {
            /* unreadable entry — report size 0 */
          }
        }
        return { name: e.name, path: path.join(target, e.name), dir: e.isDirectory(), size };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      .slice(0, 500);
    return { path: target, entries: mapped, home: os.homedir() };
  }

  /** Read a text file for the GUI viewer. Capped at 256 KiB; binary files
   * (NUL byte sniff) are rejected rather than rendered as mojibake. */
  private fsRead(params: Record<string, unknown>): {
    path: string;
    content: string;
    truncated: boolean;
    size: number;
  } {
    const raw = (str(params, "path") ?? "").trim();
    const target = this.resolveFsPath(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `cannot stat: ${target}`);
    }
    if (!stat.isFile()) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `not a file: ${target}`);
    const CAP = 256 * 1024;
    const buf = fs.readFileSync(target);
    if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `binary file: ${target}`);
    }
    return {
      path: target,
      content: buf.subarray(0, CAP).toString("utf8"),
      truncated: buf.length > CAP,
      size: buf.length,
    };
  }

  private connectorKinds = new Set([
    "jira", "confluence", "redmine", "github", "gitlab",
    "backlog", "notion", "slack", "teams", "discord", "google",
  ]);

  private connectorsDelete(params: Record<string, unknown>): Record<string, unknown> {
    const kind = String(params.kind ?? "");
    if (!this.connectorKinds.has(kind)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unknown connector kind: ${kind}`);
    }
    const connectors = { ...(this.cfg.connectors ?? {}) };
    delete connectors[kind];
    this.cfg.connectors = connectors;
    writeConnectorsToDisk(connectors, { configFile: this.cfg.configFile });
    return { ok: true, connectors };
  }


  private connectorsGet(): Record<string, unknown> {
    return { connectors: this.cfg.connectors ?? {} };
  }

  private connectorsSet(params: Record<string, unknown>): Record<string, unknown> {
    const kind = String(params.kind ?? "");
    if (!this.connectorKinds.has(kind)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unknown connector kind: ${kind}`);
    }
    const settings = params.settings;
    if (settings !== null && typeof settings !== "object") {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "settings must be an object");
    }
    const connectors = { ...(this.cfg.connectors ?? {}) };
    const incoming = { ...(settings as Record<string, unknown>) };
    // keep stored secrets when the GUI round-trips the masked "***"
    for (const [k, v] of Object.entries(incoming)) {
      if (v === "***" && typeof connectors[kind]?.[k] === "string") incoming[k] = connectors[kind][k];
    }
    connectors[kind] = incoming;
    this.cfg.connectors = connectors;
    writeConnectorsToDisk(connectors, { configFile: this.cfg.configFile });
    return { ok: true, connectors };
  }

  private async connectorsTest(params: Record<string, unknown>): Promise<{
    ok: boolean;
    status?: number;
    message: string;
  }> {
    const kind = String(params.kind ?? "");
    const c = (this.cfg.connectors ?? {})[kind] as Record<string, string> | undefined;
    if (!c) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `${kind} is not configured`);
    // github / notion / slack / teams / discord use fixed endpoints (no base_url)
    const needsBase = !["github", "notion", "slack", "teams", "discord"].includes(kind);
    const base = (c.base_url ?? "").replace(/\/+$/, "");
    if (needsBase && base === "") {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `${kind} requires base_url`);
    }
    let url = "";
    const headers: Record<string, string> = {};
    if (kind === "redmine") {
      url = `${base}/users/current.json`;
      headers["X-Redmine-API-Key"] = c.api_key ?? "";
    } else if (kind === "jira") {
      url = `${base}/rest/api/3/myself`;
      headers["Authorization"] = `Basic ${Buffer.from(`${c.email ?? ""}:${c.token ?? ""}`).toString("base64")}`;
    } else if (kind === "confluence") {
      url = `${base}/rest/api/currentUser`;
      headers["Authorization"] = `Basic ${Buffer.from(`${c.email ?? ""}:${c.token ?? ""}`).toString("base64")}`;
    } else if (kind === "github") {
      url = "https://api.github.com/user";
      headers["Authorization"] = `Bearer ${c.token ?? ""}`;
      headers["User-Agent"] = "familiar-harness";
    } else if (kind === "gitlab") {
      const base = (c.base_url || "https://gitlab.com").replace(/\/+$/, "");
      url = `${base}/api/v4/user`;
      headers["Authorization"] = `Bearer ${c.token ?? ""}`;
    } else if (kind === "backlog") {
      const base = (c.base_url || "").replace(/\/+$/, "");
      url = `${base}/api/v2/space?apiKey=${encodeURIComponent(c.api_key ?? "")}`;
    } else if (kind === "notion") {
      url = "https://api.notion.com/v1/users/me";
      headers["Authorization"] = `Bearer ${c.token ?? ""}`;
      headers["Notion-Version"] = "2022-06-28";
    } else if (kind === "slack") {
      url = "https://slack.com/api/auth.test";
      headers["Authorization"] = `Bearer ${c.token ?? ""}`;
    } else if (kind === "teams") {
      url = "https://graph.microsoft.com/v1.0/me";
      headers["Authorization"] = `Bearer ${c.token ?? ""}`;
    } else if (kind === "discord") {
      url = "https://discord.com/api/v10/users/@me";
      headers["Authorization"] = `Bot ${c.token ?? ""}`;
    } else {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unknown connector kind: ${kind}`);
    }
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (res.ok) return { ok: true, status: res.status, message: "connected" };
      const text = (await res.text()).slice(0, 160);
      return { ok: false, status: res.status, message: `HTTP ${res.status}: ${text}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private serverVersion = "0.0.0";
  private semverCmp(a: string, b: string): number {
    const triple = (v: string): [number, number, number] => {
      const [nums] = String(v).split('-');
      const p = (nums ?? '').split('.').map((n) => Number.parseInt(n, 10));
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
    };
    const [pa, pb] = [triple(a), triple(b)];
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
  }

  /** GET a URL as a buffer, tolerating self-signed CAs on the second try
   * (self-hosted Forgejo instances). FAMILIAR_TLS_STRICT=1 disables the fallback. */
  private httpsGetBuffer(url: string): Promise<{ ok: boolean; buffer: Buffer }> {
    const viaNodeHttps = () =>
      new Promise<{ ok: boolean; buffer: Buffer }>((resolve, reject) => {
        const req = https.get(url, { rejectUnauthorized: false }, (res: import("node:http").IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ ok: (res.statusCode ?? 500) < 400, buffer: Buffer.concat(chunks) }),
          );
        });
        req.on("error", reject);
        req.setTimeout(20_000, () => req.destroy(new Error("timeout")));
      });
    return fetch(url, { signal: AbortSignal.timeout(15_000) })
      .then(async (res) => ({ ok: res.ok, buffer: Buffer.from(await res.arrayBuffer()) }))
      .catch((err) => {
        const code = String((err as { cause?: { code?: string } }).cause?.code ?? "");
        if (!/CERT|SSL|TLS/i.test(code) || process.env.FAMILIAR_TLS_STRICT === "1") throw err;
        return viaNodeHttps();
      });
  }

  private async updateCheck(): Promise<Record<string, unknown>> {
    const host = process.env.FAMILIAR_FORGEJO || 'https://example.invalid:3000';
    const repo = process.env.FAMILIAR_REPO || 'owner/familiar-harness';
    let latest = '';
    let releaseUrl = host + '/' + repo + '/releases';
    try {
      const res = await this.httpsGetBuffer(host + '/api/v1/repos/' + repo + '/releases');
      if (!res.ok) throw new Error('HTTP error');
      const releases = JSON.parse(res.buffer.toString('utf8')) as Array<{ tag_name?: string; html_url?: string }>;
      for (const r of releases) {
        const v = (r.tag_name ?? '').replace(/^v/, '');
        if (!v) continue;
        if (!latest || this.semverCmp(v, latest) > 0) {
          latest = v;
          releaseUrl = r.html_url ?? releaseUrl;
        }
      }
    } catch {
      return { current: this.serverVersion, latest: '', available: false, error: 'cannot reach the release host' };
    }
    const available = latest !== '' && this.semverCmp(latest, this.serverVersion) > 0;
    return { current: this.serverVersion, latest, available, releaseUrl };
  }

  private googleState: string | null = null;

  private googleCfg(): Record<string, string> {
    return ((this.cfg.connectors ?? {}).google ?? {}) as Record<string, string>;
  }

  private googleAuthUrl(params: Record<string, unknown>): Record<string, unknown> {
    const c = this.googleCfg();
    if (!c.client_id || !c.client_secret) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "client_id / client_secret are not configured");
    }
    const origin = String(params.origin ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(origin)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "invalid origin");
    }
    const redirect_uri = `${origin}/oauth/callback`;
    const state = crypto.randomBytes(12).toString("hex");
    this.googleState = state;
    const scopes = [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "openid",
      "email",
    ];
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", c.client_id);
    url.searchParams.set("redirect_uri", redirect_uri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return { url: url.toString(), redirect_uri };
  }

  private async googleExchange(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const c = this.googleCfg();
    if (!c.client_id || !c.client_secret) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "client_id / client_secret are not configured");
    }
    const code = String(params.code ?? "");
    const state = String(params.state ?? "");
    if (!code) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "missing code");
    if (!this.googleState || state !== this.googleState) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "state mismatch");
    }
    this.googleState = null;
    const redirect_uri = String(params.redirect_uri ?? "");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: c.client_id,
        client_secret: c.client_secret,
        redirect_uri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tok = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !tok.access_token) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `token exchange failed: ${tok.error ?? res.status}`);
    }
    const connectors = { ...(this.cfg.connectors ?? {}) };
    const google = { ...c, ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}), access_token: tok.access_token, expiry: Date.now() + (tok.expires_in ?? 3600) * 1000 };
    connectors["google"] = google;
    this.cfg.connectors = connectors;
    writeConnectorsToDisk(connectors, { configFile: this.cfg.configFile });
    return { ok: true };
  }

  private async googleAccessToken(): Promise<string> {
    const c = this.googleCfg();
    if (!c.refresh_token || !c.client_id || !c.client_secret) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "google is not linked yet — run the OAuth flow");
    }
    if (c.access_token && Number(c.expiry ?? 0) > Date.now() + 30_000) {
      return c.access_token;
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: c.refresh_token,
        client_id: c.client_id,
        client_secret: c.client_secret,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tok = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!tok.access_token) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "token refresh failed");
    const connectors = { ...(this.cfg.connectors ?? {}) };
    connectors["google"] = { ...c, access_token: tok.access_token, expiry: Date.now() + (tok.expires_in ?? 3600) * 1000 };
    this.cfg.connectors = connectors;
    writeConnectorsToDisk(connectors, { configFile: this.cfg.configFile });
    return tok.access_token;
  }

  private async googleTest(): Promise<Record<string, unknown>> {
    const token = await this.googleAccessToken();
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { email?: string };
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    return { ok: true, email: body.email ?? "", message: body.email ?? "connected" };
  }

  private async googleGmailList(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.googleAccessToken();
    const max = Math.min(25, Math.max(1, Number(params.max ?? 10)));
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    );
    const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
    const out: Array<Record<string, string>> = [];
    for (const m of list.messages ?? []) {
      const meta = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      );
      const data = (await meta.json()) as {
        snippet?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      };
      const header = (n: string) => data.payload?.headers?.find((h) => h.name === n)?.value ?? "";
      out.push({ from: header("From"), subject: header("Subject"), date: header("Date"), snippet: data.snippet ?? "" });
    }
    return { items: out };
  }

  private async googleCalendarList(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.googleAccessToken();
    const max = Math.min(25, Math.max(1, Number(params.max ?? 10)));
    const timeMin = new Date().toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&maxResults=${max}&singleEvents=true&orderBy=startTime`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const data = (await res.json()) as { items?: Array<{ summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string }> };
    const items = (data.items ?? []).map((e) => ({
      summary: e.summary ?? "(no title)",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      location: e.location ?? "",
    }));
    return { items };
  }

  private skillsDelete(params: Record<string, unknown>): Record<string, unknown> {
    const name = str(params, "name");
    if (!name) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "name is required");
    // archive rather than hard-delete: the skill stays recoverable in ~/.familiar/skills/.archive/
    if (!this.selfImprove.skills.archive(name)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `skill not found: ${name}`);
    }
    return { deleted: 1, message: `archived skill ${name}` };
  }

  private skillsSave(params: Record<string, unknown>): Record<string, unknown> {
    const name = String(params.name ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `invalid skill name: ${name}`);
    }
    const body = String(params.body ?? "");
    const dir = path.join(this.cfg.homeDir, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    const existed = fs.existsSync(file);
    fs.writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o644 });
    return { ok: true, path: file, created: !existed };
  }

  private fsDirs(params: Record<string, unknown>): { dirs: string[]; home: string } {
    const raw = (str(params, "path") ?? "").trim();
    const target = this.resolveFsPath(raw);
    let dirs: string[];
    try {
      dirs = fs
        .readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => path.join(target, e.name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `cannot list directory: ${target}`);
    }
    return { dirs, home: os.homedir() };
  }

  /**
   * Path suggestions for the composer's "@" token: lists dirs AND files whose
   * name starts with the typed prefix (directories first, capped at 20).
   */
  private fsSuggest(params: Record<string, unknown>): { items: Array<{ path: string; dir: boolean }> } {
    const prefix = (str(params, "prefix") ?? "").trim();
    if (prefix === "") return { items: [] };
    const lastSep = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
    const dirPart = lastSep >= 0 ? prefix.slice(0, lastSep + 1) : "";
    const namePrefix = lastSep >= 0 ? prefix.slice(lastSep + 1) : prefix;
    const cwd = str(params, "cwd");
    let target: string;
    if (dirPart === "") {
      target = cwd && cwd !== "" ? path.resolve(cwd) : os.homedir();
    } else if (
      dirPart.startsWith("/") ||
      dirPart.startsWith("~") ||
      /^[a-zA-Z]:[\\/]/.test(dirPart)
    ) {
      target = this.resolveFsPath(dirPart);
    } else {
      target = this.resolveFsPath(dirPart, cwd && cwd !== "" ? cwd : process.cwd());
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return { items: [] };
    }
    const q = namePrefix.toLowerCase();
    const matched = entries.filter((e) => e.name.toLowerCase().startsWith(q));
    matched.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const items = matched.slice(0, 20).map((e) => ({
      path: path.join(target, e.name),
      dir: e.isDirectory(),
    }));
    return { items };
  }

  /** Session-scoped task list (the `todo` tool) for the GUI panel. */
  private todoList(params: Record<string, unknown>): { items: TodoItem[] } {
    const id = str(params, "id");
    if (!id) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
    this.requireSession(id);
    return { items: this.todos.get(id) };
  }

  private async createSession(params: Record<string, unknown>): Promise<SessionRecord> {
    const provider = str(params, "provider") ?? this.cfg.default_provider;
    const pc = this.cfg.providers[provider];
    if (!pc) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unknown provider: ${provider}`);
    const model =
      str(params, "model") ?? pc.default_model ?? this.cfg.default_model ?? resolveDefaultModel(pc.kind);
    if (!model) {
      throw new RpcError(
        RPC_ERROR_INVALID_PARAMS,
        `"model" is required for provider "${provider}" (set default_model or default_model in config)`,
      );
    }
    const cwd = path.resolve(str(params, "cwd") ?? process.cwd());
    const effortParam = str(params, "effort") ?? "";
    const effort = normalizeEffort(effortParam);
    if (effortParam !== "" && !effort) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `effort must be low | medium | high`);
    }
    const created = this.store.createSession({
      title: str(params, "title") ?? "",
      provider,
      model,
      profile: str(params, "profile"),
      effort,
      cwd,
    });
    // M5: session_start lifecycle hook (awaited; hooks can never throw).
    if (this.hooks) {
      await this.hooks.run("session_start", {
        event: "session_start",
        sessionId: created.id,
        cwd: created.cwd,
        timestamp: Date.now(),
        title: created.title,
        provider: created.provider,
        model: created.model,
      });
    }
    return created;
  }

  /** Patch a session's title / provider / model / profile (v1.1 GUI needs). */
  private updateSession(params: Record<string, unknown>): SessionRecord {
    const id = str(params, "id");
    if (!id) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
    const session = this.requireSession(id);
    const patch: {
      title?: string;
      provider?: string;
      model?: string;
      profile?: string | null;
      cwd?: string;
      effort?: string | null;
    } = {};
    if (params["title"] !== undefined) {
      patch.title = str(params, "title") ?? "";
    }
    let provider = session.provider;
    if (params["provider"] !== undefined) {
      provider = str(params, "provider") ?? provider;
      if (!this.cfg.providers[provider]) {
        throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unknown provider: ${provider}`);
      }
      patch.provider = provider;
    }
    if (params["model"] !== undefined) {
      const model = str(params, "model");
      if (!model) throw new RpcError(RPC_ERROR_INVALID_PARAMS, '"model" cannot be empty');
      patch.model = model;
    } else if (patch.provider !== undefined) {
      // provider changed without an explicit model — fall back like create does
      const fallback =
        this.cfg.providers[provider]?.default_model ?? this.cfg.default_model ?? resolveDefaultModel(this.cfg.providers[provider]?.kind ?? "mock");
      if (fallback) patch.model = fallback;
    }
    if (params["cwd"] !== undefined) {
      const cwd = str(params, "cwd");
      if (!cwd) throw new RpcError(RPC_ERROR_INVALID_PARAMS, '"cwd" cannot be empty');
      const resolved = path.resolve(cwd);
      let isDir = false;
      try {
        isDir = fs.statSync(resolved).isDirectory();
      } catch {
        /* leave false -> error below */
      }
      if (!isDir) {
        throw new RpcError(RPC_ERROR_INVALID_PARAMS, `"cwd" is not an existing directory: ${cwd}`);
      }
      patch.cwd = resolved;
    }
    if (params["profile"] !== undefined) {
      const raw = params["profile"];
      if (raw === null) {
        patch.profile = null;
      } else {
        const profile = str(params, "profile");
        if (!profile) throw new RpcError(RPC_ERROR_INVALID_PARAMS, '"profile" cannot be empty');
        patch.profile = profile;
      }
    }
    if (params["effort"] !== undefined) {
      const raw = params["effort"];
      const effortValue = raw === null ? "" : str(params, "effort") ?? "";
      const norm = normalizeEffort(effortValue);
      if (effortValue !== "" && !norm) {
        throw new RpcError(RPC_ERROR_INVALID_PARAMS, `effort must be low | medium | high`);
      }
      patch.effort = norm ?? "";
    }
    const updated = this.store.updateSession(id, patch);
    if (!updated) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session not found");
    return updated;
  }

  private async send(
    params: Record<string, unknown>,
    ctx: RpcContext,
  ): Promise<{ turnId: string; steps: number; toolCalls: number; usage: Usage; aborted?: boolean }> {
    // M5: make dynamic MCP tools visible before the first tool advertisement.
    await this.mcpReady();
    const sessionId = str(params, "id");
    const text = str(params, "text");
    if (!sessionId || text === undefined || text === null || text === "") {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "params 'id' and 'text' are required");
    }
    const session = this.requireSession(sessionId);
    const events = (event: unknown): void => ctx.onEvent?.(sessionId, event);
    const msgCountBefore = this.store.getMessages(sessionId).length;
    if (this.activeTurns.has(sessionId)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "a turn is already running for this session (stop it first)");
    }
    const controller = new AbortController();
    this.activeTurns.set(sessionId, controller);
    try {
      const res = await this.runner.runTurn({
        sessionId,
        userText: text,
        provider: str(params, "provider"),
        model: str(params, "model"),
        profile: str(params, "profile") ?? undefined,
        effort: str(params, "effort"),
        yolo: params["yolo"] === true,
        plan: params["plan"] === true,
        maxSteps: num(params, "maxSteps"),
        signal: controller.signal,
        onEvent: events,
      });
      // M3: background self-review of this turn (stage-only; never blocks long)
      if (!this.disableReview && !controller.signal.aborted) {
        await this.reviewTurn({ sessionId, session, msgCountBefore, ctx });
      }
      // M4: idle feed for the curator scheduler
      this.lastTurnAt = Date.now();
      return res;
    } catch (err) {
      if (controller.signal.aborted) {
        log.debug(`turn aborted by user: session ${sessionId}`);
        return { turnId: "", steps: 0, toolCalls: 0, usage: {}, aborted: true };
      }
      // Include the failure in the response as well (events already carried it).
      log.error(`turn failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      this.activeTurns.delete(sessionId);
    }
  }

  /** Kill the running turn of a session (GUI stop button / CLI). */
  private abortTurn(params: Record<string, unknown>): { aborting: boolean } {
    const sessionId = str(params, "id");
    if (!sessionId) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
    const controller = this.activeTurns.get(sessionId);
    if (!controller) return { aborting: false };
    controller.abort();
    return { aborting: true };
  }

  /** Spec 04 §3: extract lessons from the just-finished turn and STAGE them. */
  private async reviewTurn(args: {
    sessionId: string;
    session: SessionRecord;
    msgCountBefore: number;
    ctx: RpcContext;
  }): Promise<void> {
    try {
      const all = this.store.getMessages(args.sessionId);
      const slice = all.slice(args.msgCountBefore);
      if (slice.length === 0) return;
      const transcript = slice
        .map((m) => {
          const head = m.content.split("\n").slice(0, 6).join(" ⏎ ").slice(0, 600);
          const calls = m.toolCalls?.map((c) => `[tool ${c.name}(${c.arguments.slice(0, 200)})]`).join(" ") ?? "";
          return `${m.role}: ${head}${calls ? ` ${calls}` : ""}`;
        })
        .join("\n");
      const outcome = await postTurnReview(this.cfg, this.providers, this.selfImprove, {
        sessionId: args.sessionId,
        provider: args.session.provider,
        model: args.session.model,
        transcript,
        onStaged: (memoryCount, skillCount) => {
          args.ctx.onEvent?.(args.sessionId, { type: "improvement.staged", memoryCount, skillCount });
        },
      });
      if (outcome.memoryCount + outcome.skillCount > 0) {
        log.info(
          `self-review staged ${outcome.memoryCount} memory, ${outcome.skillCount} skill proposals (${args.sessionId.slice(0, 8)})`,
        );
      }
    } catch (err) {
      // The review pipeline must never break the main conversation.
      log.debug(`self-review error (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // M3 RPC: memory + skills
  // -------------------------------------------------------------------------

  private memoryList(): Record<string, unknown> {
    return {
      memories: this.selfImprove.memories.list(),
      pendingCount: this.selfImprove.pendingMemories.count(),
    };
  }

  private memoryPending(): Record<string, unknown> {
    return { items: this.selfImprove.pendingMemories.toApi(this.selfImprove.pendingMemories.list()) };
  }

  private memoryApprove(params: Record<string, unknown>): Record<string, unknown> {
    const prefix = str(params, "id");
    if (!prefix) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "id is required");
    const res = approveStagedMemory(this.selfImprove.pendingMemories, this.selfImprove.memories, prefix);
    if (!res.approved) throw new RpcError(RPC_ERROR_INVALID_PARAMS, res.message);
    return { approved: true, message: res.message };
  }

  private memoryReject(params: Record<string, unknown>): Record<string, unknown> {
    const prefix = str(params, "id");
    if (!prefix) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "id is required");
    const res = rejectStagedMemory(this.selfImprove.pendingMemories, prefix);
    if (!res.rejected) throw new RpcError(RPC_ERROR_INVALID_PARAMS, res.message);
    return { rejected: true, message: res.message };
  }

  private memoryApproval(params: Record<string, unknown>): Record<string, unknown> {
    const set = str(params, "set");
    if (set) {
      if (set !== "on" && set !== "off") {
        throw new RpcError(RPC_ERROR_INVALID_PARAMS, "set must be on|off");
      }
      this.selfImprove.settings.set("memory_write_approval", set === "on");
    }
    return this.approvalState();
  }

  private approvalState(): Record<string, unknown> {
    const si = this.selfImprove;
    const memOn = si.settings.get("memory_write_approval") ?? this.cfg.memory.write_approval !== false;
    const skillOn = si.settings.get("skills_write_approval") ?? this.cfg.skills.write_approval !== false;
    return { memoryWriteApproval: memOn, skillsWriteApproval: skillOn };
  }

  private skillsList(): Record<string, unknown> {
    return {
      skills: this.selfImprove.skills.list(),
      pendingCount: this.selfImprove.pendingSkills.count(),
    };
  }

  private skillsView(params: Record<string, unknown>): Record<string, unknown> {
    const name = str(params, "name");
    if (!name) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "name is required");
    const view = this.selfImprove.skills.view(name);
    if (!view) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `skill not found: ${name}`);
    return { body: view.body, warnings: view.warnings };
  }

  private skillsPending(): Record<string, unknown> {
    return { items: this.selfImprove.pendingSkills.toApi(this.selfImprove.pendingSkills.list()) };
  }

  private skillsApprove(params: Record<string, unknown>): Record<string, unknown> {
    const si = this.selfImprove;
    if (params["all"] === true) {
      const items = si.pendingSkills.list();
      const approved: string[] = [];
      const failed: string[] = [];
      for (const item of items) {
        const res = approveStagedSkill(si.pendingSkills, si.skills, item.id);
        (res.approved ? approved : failed).push(`${item.id}: ${res.message}`);
      }
      return { approved: approved.length, messages: approved, failed };
    }
    const prefix = str(params, "prefix");
    if (!prefix) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "prefix or all is required");
    const res = approveStagedSkill(si.pendingSkills, si.skills, prefix);
    if (!res.approved) throw new RpcError(RPC_ERROR_INVALID_PARAMS, res.message);
    return { approved: 1, message: res.message };
  }

  private skillsReject(params: Record<string, unknown>): Record<string, unknown> {
    const prefix = str(params, "prefix");
    if (!prefix) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "prefix is required");
    const res = rejectStagedSkill(this.selfImprove.pendingSkills, prefix);
    if (!res.rejected) throw new RpcError(RPC_ERROR_INVALID_PARAMS, res.message);
    return { rejected: 1, message: res.message };
  }

  private requireSession(id: string | undefined): SessionRecord {
    if (!id) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
    const session = this.store.getSession(id);
    if (!session) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `session not found: ${id}`);
    return session;
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function resolveDefaultModel(kind: string): string | undefined {
  if (kind === "mock") return "mock-fast";
  return undefined;
}

/** Convenience for tests/clients that want typed result access. */
export interface SendSessionResult {
  turnId: string;
  steps: number;
  toolCalls: number;
  usage: Usage;
}

export type { ChatMessage, SessionRecord, ToolCall };

/** Stable new-session generator for transports that pre-create ids. */
export const newId = (): string => crypto.randomUUID();
