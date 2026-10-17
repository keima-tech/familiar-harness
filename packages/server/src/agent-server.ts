import crypto from "node:crypto";
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
  writeProviderToDisk,
  describeAuthSource,
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
    const created = this.store.createSession({
      title: str(params, "title") ?? "",
      provider,
      model,
      profile: str(params, "profile"),
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
    const updated = this.store.updateSession(id, patch);
    if (!updated) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session not found");
    return updated;
  }

  private async send(
    params: Record<string, unknown>,
    ctx: RpcContext,
  ): Promise<{ turnId: string; steps: number; toolCalls: number; usage: Usage }> {
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
    try {
      const res = await this.runner.runTurn({
        sessionId,
        userText: text,
        provider: str(params, "provider"),
        model: str(params, "model"),
        profile: str(params, "profile") ?? undefined,
        yolo: params["yolo"] === true,
        plan: params["plan"] === true,
        maxSteps: num(params, "maxSteps"),
        onEvent: events,
      });
      // M3: background self-review of this turn (stage-only; never blocks long)
      if (!this.disableReview) {
        await this.reviewTurn({ sessionId, session, msgCountBefore, ctx });
      }
      // M4: idle feed for the curator scheduler
      this.lastTurnAt = Date.now();
      return res;
    } catch (err) {
      // Include the failure in the response as well (events already carried it).
      log.error(`turn failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
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
