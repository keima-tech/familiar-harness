import crypto from "node:crypto";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  MessageAttachment,
  ModelInfo,
  RpcContext,
  SessionRecord,
  SessionRemote,
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
  createBackend,
  type ExecBackend,
  readDocx,
  readXlsx,
  readPptx,
  listOfficeTemplates,
  importOfficeTemplate,
  deleteOfficeTemplate,
  loadConfig,
  configFilePath,
  writeConnectorsToDisk,
  writeProviderToDisk,
  writeServerConfig,
  writeCronJobEnabled,
  writeWebSearchConfig,
  readBashPolicy,
  writeBashPolicy,
  commandDecision,
  DEFAULT_CONFIG,
  describeAuthSource,
  normalizeEffort,
  familiarPaths,
  sanitizeConfigForApi,
  ProviderRegistry,
  SqliteSessionStore,
  type PermissionMode,
  MemoryStore,
  PendingMemoryStore,
  SkillStore,
  PendingSkillStore,
  resolveSkillRoots,
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
  disposeSshLspHubs,
  type ApprovalAdapter,
  type CronJob,
  type CuratorScheduler,
  type ResolvedConfig,
  type WebSearchConfig,
  type ProviderConfig,
  type ProviderPatch,
  type SessionStore,
  type SelfImproveContext,
  type Tool,
  type ToolRegistry,
} from "@familiar/core";
import { log } from "@familiar/core";
import { SessionTodoStore } from "./todo-store.js";
import { RpcApprovalAdapter } from "./rpc-approvals.js";
import {
  SshConnectionManager,
  scanHostKeys,
  trustHostKeys,
  sanitizeProfile as sanitizeSshProfile,
} from "./ssh-connections.js";

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
          skills: new SkillStore(home, { extraRoots: resolveSkillRoots(this.cfg.skills) }),
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
    // Tunnel host mirrors the server bind: a 0.0.0.0 server hands LAN clients
    // a tunnel they can actually reach, loopback stays loopback-only.
    const bind = this.cfg.server?.bind ?? "127.0.0.1";
    const tunnelHost = bind === "0.0.0.0" ? "0.0.0.0" : bind === "" || bind === "localhost" ? "127.0.0.1" : bind;
    this.sshConnections = new SshConnectionManager(tunnelHost);
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
  private readonly activeTurns = new Map<
    string,
    { controller: AbortController; text: string; startedAt: number }
  >();
  /** steering: user messages injected into a running turn (drained by the loop) */
  private readonly injections = new Map<
    string,
    { text: string; attachments?: MessageAttachment[] }[]
  >();
  /** M5: MCP dynamic tools */
  readonly mcp?: McpHub;
  private mcpDiscover?: Promise<void>;
  /** MCP hubs bound to SSH hosts (proxy sessions), one per target */
  private readonly remoteMcpHubs = new Map<string, McpHub>();
  /** Config snapshot each remote hub was built from (rebuild on GUI edits). */
  private readonly remoteMcpHubConfigKeys = new Map<string, string>();
  /** SSH profiles + remote-serve tunnels, shared with the desktop shell */
  readonly sshConnections: SshConnectionManager;
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
    // keep disabled jobs too so cron.setEnabled can resume them live
    const jobs = (this.cfg.cron?.jobs ?? []).filter(
      (j) => typeof j.prompt === "string" && j.prompt.trim() !== "" && Number.isFinite(j.every_minutes),
    );
    if (jobs.length === 0) return undefined;
    this.cronScheduler = new CronScheduler(jobs, (job) => this.runCronJob(job));
    this.cronScheduler.start();
    return this.cronScheduler;
  }

  /** Kill MCP servers / cron timers (serve shutdown, tests). */
  dispose(): void {
    this.mcp?.stopAll();
    for (const hub of this.remoteMcpHubs.values()) hub.stopAll();
    this.remoteMcpHubs.clear();
    this.remoteMcpHubConfigKeys.clear();
    this.cronScheduler?.stop();
    if (this.uploadPruner) clearInterval(this.uploadPruner);
    this.uploadPruner = undefined;
    this.sshConnections.dispose();
    disposeLspHub();
    disposeSshLspHubs();
  }

  /** `{id}` or `{host, port}` for the host-key RPCs. */
  private sshHostPort(params: Record<string, unknown>): { host: string; port: number } {
    const id = str(params, "id");
    if (id) {
      const profile = this.sshConnections.getProfile(id);
      if (!profile) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "connection profile not found");
      return { host: profile.host, port: profile.port };
    }
    const host = (str(params, "host") ?? "").trim();
    if (!host || /[\s/]/.test(host) || host.startsWith("-")) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "host is required");
    }
    const portRaw = Number(params["port"] ?? 22);
    const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 22;
    return { host, port };
  }

  /** Capability stop for `/tunnel/stop` (called by remote browser UIs). */
  stopTunnel(stopId: string): boolean {
    return this.sshConnections.stopById(stopId);
  }

  /** Uploaded attachments for a deleted session (proxy and serve modes). */
  private async cleanupUploads(session: SessionRecord): Promise<void> {
    try {
      const backend = createBackend(session.remote ?? null);
      const p = backend.path;
      const home = await backend.home();
      await backend.removeTree(p.join(home, ".familiar", "uploads", session.id.slice(0, 8)));
    } catch (err) {
      log.debug(
        `uploads: cleanup for ${session.id.slice(0, 8)} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private uploadPruner?: NodeJS.Timeout;

  /** Serve process: periodically drop old uploads from this machine. */
  startUploadPruner(intervalMinutes = 360): void {
    if (this.uploadPruner) return;
    const tick = (): void => {
      try {
        this.pruneUploads();
      } catch (err) {
        log.debug(`uploads: prune failed: ${err instanceof Error ? err.message : err}`);
      }
    };
    tick();
    this.uploadPruner = setInterval(tick, Math.max(5, intervalMinutes) * 60_000);
    this.uploadPruner.unref?.();
  }

  /** Delete files older than `uploads.retention_days` (0 disables) and drop
   * empty buckets. Remote buckets are removed when their session is deleted. */
  private pruneUploads(): void {
    const days = this.cfg.uploads?.retention_days ?? 0;
    if (days <= 0) return;
    const root = path.join(os.homedir(), ".familiar", "uploads");
    if (!fs.existsSync(root)) return;
    const cutoff = Date.now() - days * 86_400_000;
    let removed = 0;
    const walk = (dir: string): boolean => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      let empty = true;
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (walk(full)) {
            try {
              fs.rmdirSync(full);
              removed += 1;
            } catch {
              empty = false;
            }
          } else {
            empty = false;
          }
        } else {
          try {
            if (fs.statSync(full).mtimeMs < cutoff) {
              fs.unlinkSync(full);
              removed += 1;
              continue;
            }
          } catch {
            /* unreadable — keep it */
          }
          empty = false;
        }
      }
      return empty;
    };
    walk(root);
    if (removed > 0) log.info(`uploads: pruned ${removed} item(s) older than ${days}d`);
  }

  /** MCP hub for an SSH target (lazily spawned, cached per host + config). */
  private remoteMcpHub(target: SessionRemote): McpHub {
    const key = `${target.user ?? ""}@${target.host}:${target.port ?? 22}:${target.identityFile ?? ""}`;
    const configKey = JSON.stringify(this.cfg.mcp.servers);
    let hub = this.remoteMcpHubs.get(key);
    if (!hub || this.remoteMcpHubConfigKeys.get(key) !== configKey) {
      hub?.stopAll();
      hub = new McpHub(this.cfg, { remote: target });
      installMcpExitCleanup(hub);
      this.remoteMcpHubs.set(key, hub);
      this.remoteMcpHubConfigKeys.set(key, configKey);
    }
    return hub;
  }

  /** Tools a session advertises: local MCP, or per-host MCP over ssh. */
  private async mcpToolsFor(remote?: SessionRemote | null): Promise<Tool[]> {
    if (remote) {
      const hub = this.remoteMcpHub(remote);
      await hub.discover();
      return hub.tools();
    }
    await this.mcpReady();
    return this.mcp?.tools() ?? [];
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
      ...(parent.remote ? { remote: parent.remote } : {}),
    });
    log.debug(`subagent task: session ${child.id} (parent ${parent.id.slice(0, 8)})`);
    // Single-level recursion by design (M2): the subagent runner has no taskRunner.
    const subRunner = new AgentRunner(this.cfg, this.providers, this.store, {
      approval: this.approval,
    });
    const subRemoteTools = parent.remote ? await this.mcpToolsFor(parent.remote) : undefined;
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
      ...(subRemoteTools ? { extraTools: subRemoteTools } : {}),
      ...(parent.remote ? { excludeToolPrefix: "mcp__" } : {}),
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
      case "fs.upload":
        return this.fsUpload(params);
      case "fs.rename":
        return this.fsRename(params);
      case "fs.delete":
        return this.fsDelete(params);
      case "todo.list":
        return this.todoList(params);
      case "session.create":
        return this.createSession(params);
      case "session.list":
        // `running` lets clients show that a turn is live — a reloaded page
        // or a second client has no local busy state otherwise
        return this.store.listSessions().map((s) => ({
          ...s,
          running: this.activeTurns.has(s.id),
        }));
      case "session.get": {
        const session = this.requireSession(str(params, "id"));
        const running = this.activeTurns.get(session.id);
        return {
          session,
          messages: this.store.getMessages(session.id),
          running: running !== undefined,
          ...(running
            ? { runningStartedAt: running.startedAt, runningText: running.text }
            : {}),
        };
      }
      case "session.repair": {
        // un-poison a session whose stored tool-call arguments are not valid
        // JSON (a truncated stream makes every later request HTTP 400)
        const repairId = str(params, "id");
        if (!repairId) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
        this.requireSession(repairId);
        const repaired = this.store.repairToolCallArguments(repairId);
        return { repaired };
      }
      case "session.delete": {
        const delId = str(params, "id");
        if (!delId) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
        const doomed = this.store.getSession(delId);
        const deleted = this.store.deleteSession(delId);
        if (!deleted) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session not found");
        this.todos.drop(delId);
        if (doomed) void this.cleanupUploads(doomed);
        return { deleted: true };
      }
      case "session.update":
        return this.updateSession(params);
      case "session.send":
        return this.send(params, ctx);
      case "session.steer":
        return this.steer(params);
      case "session.compact":
        return this.compact(params, ctx);
      case "session.undo":
        return this.undo(params);
      case "session.search": {
        const query = str(params, "query") ?? "";
        if (query.trim() === "") {
          throw new RpcError(RPC_ERROR_INVALID_PARAMS, "query is required");
        }
        const limit = typeof params["limit"] === "number" ? params["limit"] : undefined;
        return { hits: this.store.searchMessages(query, limit) };
      }
      case "session.export":
        return this.exportSession(params);
      case "session.import":
        return this.importSession(params);
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
      case "office.templates":
        return { templates: listOfficeTemplates(this.cfg.homeDir || familiarPaths.home()) };
      case "office.templates.import": {
        // `path` (desktop) or `dataBase64` + `name` (browser uploads)
        const source: { path?: string; dataBase64?: string; name?: string } = {};
        const pathArg = str(params, "path");
        if (pathArg) source.path = pathArg;
        const dataArg = str(params, "dataBase64");
        if (dataArg) source.dataBase64 = dataArg;
        const nameArg = str(params, "name");
        if (nameArg) source.name = nameArg;
        try {
          const template = importOfficeTemplate(this.cfg.homeDir || familiarPaths.home(), source);
          return { template, templates: listOfficeTemplates(this.cfg.homeDir || familiarPaths.home()) };
        } catch (err) {
          throw new RpcError(RPC_ERROR_INVALID_PARAMS, err instanceof Error ? err.message : String(err));
        }
      }
      case "office.templates.delete": {
        const name = str(params, "name");
        if (!name) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "name is required");
        const removed = deleteOfficeTemplate(this.cfg.homeDir || familiarPaths.home(), name);
        return { removed, templates: listOfficeTemplates(this.cfg.homeDir || familiarPaths.home()) };
      }
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
      case "conn.list":
        return { connections: this.sshConnections.listProfilesPublic(), current: this.sshConnections.status() };
      case "conn.save": {
        const profile = this.sshConnections.saveProfile(params);
        return { ok: true, profile, connections: this.sshConnections.listProfilesPublic() };
      }
      case "conn.delete": {
        const deletedId = str(params, "id") ?? "";
        const doomed = deletedId ? this.sshConnections.getProfile(deletedId) : null;
        const ok = this.sshConnections.deleteProfile(deletedId);
        if (ok && doomed) this.sshConnections.forgetPassword(doomed);
        return { ok, connections: this.sshConnections.listProfilesPublic() };
      }
      case "conn.test": {
        const id = str(params, "id");
        let profile = id ? this.sshConnections.getProfile(id) : null;
        if (!profile && params["profile"] !== undefined) {
          profile = sanitizeSshProfile(params["profile"], null);
        }
        if (!profile) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "connection profile not found");
        return await this.sshConnections.probe(profile);
      }
      case "conn.hostkey": {
        const target = this.sshHostPort(params);
        return await scanHostKeys(target.host, target.port);
      }
      case "conn.trusthost": {
        const target = this.sshHostPort(params);
        const keys = Array.isArray(params["keys"]) ? (params["keys"] as unknown[]).map((k) => String(k)) : [];
        return await trustHostKeys(target.host, target.port, keys);
      }
      case "conn.connect": {
        const profile = this.sshConnections.getProfile(str(params, "id") ?? "");
        if (!profile) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "connection profile not found");
        const { tunnel, token } = await this.sshConnections.connect(profile);
        return {
          ok: true,
          url: tunnel.url,
          token,
          stop: tunnel.stop,
          id: tunnel.id,
          name: tunnel.name,
          host: tunnel.host,
          hostname: tunnel.hostname,
          platform: tunnel.platform,
          version: tunnel.version,
        };
      }
      case "conn.disconnect":
        return { ok: await this.sshConnections.disconnect() };
      case "conn.status":
        return { current: this.sshConnections.status() };
      case "mcp.status": {
        // with a session: proxy sessions report the ssh host's servers instead
        const sessionId = str(params, "session");
        const session = sessionId ? this.store.getSession(sessionId) : null;
        if (session?.remote) {
          const hub = this.remoteMcpHub(session.remote);
          await hub.discover();
          const label = `${session.remote.user ? `${session.remote.user}@` : ""}${session.remote.host}`;
          return { servers: hub.status(), remote: label };
        }
        await this.mcpReady();
        return { servers: this.mcp?.status() ?? [] };
      }
      case "mcp.servers.set":
        return this.serverConfigSet("mcp", params);
      case "mcp.servers.delete":
        return this.serverConfigDelete("mcp", params);
      case "lsp.servers.set":
        return this.serverConfigSet("lsp", params);
      case "lsp.servers.delete":
        return this.serverConfigDelete("lsp", params);
      case "mcp.restart": {
        const name = str(params, "name");
        if (!name) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "server name is required");
        await this.mcpReady();
        if (!this.mcp) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "MCP not available");
        const sessionId = str(params, "session");
        const session = sessionId ? this.store.getSession(sessionId) : null;
        const hub = session?.remote ? this.remoteMcpHub(session.remote) : this.mcp;
        const ok = await hub.restart(name);
        if (!ok) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unknown MCP server: ${name}`);
        return { name, servers: hub.status() };
      }
      case "cron.status": {
        const runtime = this.cronScheduler?.status();
        return {
          started: runtime?.started ?? false,
          jobs: runtime?.jobs ?? (this.cfg.cron?.jobs ?? []),
        };
      }
      case "cron.run": {
        const name = str(params, "name");
        if (!name) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "job name is required");
        // run one job directly (no scheduler start, so a CLI one-shot does not
        // kick off every other timer / once-at-boot job)
        if (this.cronScheduler) {
          if (!this.cronScheduler.runNow(name)) {
            throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unknown cron job: ${name}`);
          }
        } else {
          const job = (this.cfg.cron?.jobs ?? []).find(
            (j) => (j.name ?? j.prompt.slice(0, 24)) === name || j.name === name,
          );
          if (!job || typeof job.prompt !== "string") {
            throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unknown cron job: ${name}`);
          }
          await this.runCronJob(job);
        }
        return { started: true };
      }
      case "permissions.policy":
        return { user: readBashPolicy(), effective: this.cfg.permissions.bash };
      case "permissions.test": {
        const command = str(params, "command") ?? "";
        if (command.trim() === "") {
          throw new RpcError(RPC_ERROR_INVALID_PARAMS, "command is required");
        }
        return commandDecision(command, this.cfg.permissions.bash);
      }
      case "permissions.websearch.set":
        return this.websearchSet(params);
      case "permissions.setPolicy": {
        const asList = (v: unknown): string[] | undefined =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
        const modeRaw = params["mode"];
        const user: { mode?: "allow" | "ask"; allow?: string[]; ask?: string[]; deny?: string[] } = {};
        if (modeRaw === "allow" || modeRaw === "ask") user.mode = modeRaw;
        const allow = asList(params["allow"]);
        const ask = asList(params["ask"]);
        const deny = asList(params["deny"]);
        if (allow) user.allow = allow;
        if (ask) user.ask = ask;
        if (deny) user.deny = deny;
        writeBashPolicy(user);
        // hot-swap the effective policy (built-ins stay unioned)
        const builtin = DEFAULT_CONFIG.permissions.bash;
        const union = (a: string[], b?: string[]): string[] => [...new Set([...a, ...(b ?? [])])];
        this.cfg.permissions.bash = {
          mode: user.mode ?? this.cfg.permissions.bash.mode,
          allow: allow ? union(builtin.allow, allow) : this.cfg.permissions.bash.allow,
          ask: ask ? union(builtin.ask, ask) : this.cfg.permissions.bash.ask,
          deny: deny ? union(builtin.deny, deny) : this.cfg.permissions.bash.deny,
          max_timeout_ms: this.cfg.permissions.bash.max_timeout_ms,
        };
        return { ok: true, effective: this.cfg.permissions.bash };
      }
      case "cron.setEnabled": {
        const name = str(params, "name");
        if (!name) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "job name is required");
        const enabled = params["enabled"] === true;
        // live toggle for a running server, then persist so it survives restart
        this.cronScheduler?.setEnabled(name, enabled);
        const updated = writeCronJobEnabled(name, enabled);
        if (!updated && !this.cronScheduler) {
          throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unknown cron job: ${name}`);
        }
        return { name, enabled };
      }
      default:
        throw new RpcError(RPC_ERROR_METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  }

  /** Settings → Permissions → web search: persist provider + SearXNG endpoint. */
  private websearchSet(params: Record<string, unknown>): Record<string, unknown> {
    const provider = params["provider"];
    if (provider !== "duckduckgo" && provider !== "searxng") {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "provider must be duckduckgo or searxng");
    }
    const rawBase = str(params, "base_url") ?? "";
    let updated: WebSearchConfig;
    try {
      updated = writeWebSearchConfig(provider, rawBase, { configFile: this.cfg.configFile });
    } catch (err) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, err instanceof Error ? err.message : String(err));
    }
    // mutate in place: tool contexts capture the same config reference
    this.cfg.permissions.websearch = updated;
    return { ok: true, websearch: { ...updated } };
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

  /**
   * Settings → Connectors → servers: create/update one MCP or LSP server.
   * Persists to config.yaml, then hot-swaps the shared config so the live
   * MCP hub / LSP hub pick up the change without a server restart.
   */
  private async serverConfigSet(
    kind: "mcp" | "lsp",
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = str(params, "name");
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "server name (alphanumeric) is required");
    }
    const command = str(params, "command")?.trim();
    if (!command || /[\r\n]/.test(command)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "command must be a non-empty single line");
    }
    // Every GUI field is written explicitly: false / [] / null clear the old
    // value instead of being dropped by the YAML merge. writeServerConfig
    // removes those empty values from disk so the config stays readable.
    const entry: Record<string, unknown> = {
      command,
      args: serverStringList(params["args"], "args", 64),
    };
    if (Object.prototype.hasOwnProperty.call(params, "timeout_ms")) {
      // null = the timeout field was cleared in the GUI
      entry["timeout_ms"] = serverTimeout(params["timeout_ms"]) ?? null;
    }
    if (kind === "mcp") {
      // "***" values are restored by writeServerConfig from the on-disk value.
      entry["env"] = serverEnv(params["env"]);
      entry["read_only"] = params["read_only"] === true;
    } else {
      const extensions = serverStringList(params["extensions"], "extensions", 64);
      if (extensions.length === 0) {
        throw new RpcError(RPC_ERROR_INVALID_PARAMS, "at least one extension is required");
      }
      for (const ext of extensions) {
        if (!/^[A-Za-z0-9][A-Za-z0-9+#._-]*$/.test(ext)) {
          throw new RpcError(RPC_ERROR_INVALID_PARAMS, `invalid extension: ${ext}`);
        }
      }
      entry["extensions"] = extensions;
    }
    entry["disabled"] = params["disabled"] === true;

    const options = { configFile: this.cfg.configFile };
    writeServerConfig(kind, name, entry, options);
    await this.applyServerConfig(kind, options.configFile);
    return { updated: true, name };
  }

  /** Settings → Connectors → servers: remove one MCP or LSP server. */
  private async serverConfigDelete(
    kind: "mcp" | "lsp",
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = str(params, "name");
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "server name (alphanumeric) is required");
    }
    const options = { configFile: this.cfg.configFile };
    writeServerConfig(kind, name, null, options);
    await this.applyServerConfig(kind, options.configFile);
    return { deleted: true, name };
  }

  /** Share the freshly written subtree into the in-memory config and refresh hubs. */
  private async applyServerConfig(kind: "mcp" | "lsp", configFile?: string): Promise<void> {
    const fresh = loadConfig({ configFile });
    const servers = kind === "mcp" ? fresh.mcp.servers : fresh.lsp.servers;
    const target = kind === "mcp" ? this.cfg.mcp : this.cfg.lsp;
    for (const key of Object.keys(target.servers)) delete target.servers[key];
    Object.assign(target.servers, servers);

    if (kind === "lsp") return; // LspHub rebuilds itself when the config key changes
    if (!this.mcp) return; // --disable-mcp (CLI): nothing to refresh
    const oldTools = this.mcp.tools().map((tool) => tool.name);
    this.mcp.sync(this.cfg.mcp.servers);
    if (this.mcp.hasServers()) installMcpExitCleanup(this.mcp);
    this.runner.unregisterExtraTools(oldTools);
    this.mcpDiscover = undefined;
    // Discovery can wait on a child process handshake: keep the save RPC
    // responsive. `mcp.status` awaits the same memoized promise, so the card
    // shows the result once it is ready.
    void this.mcpReady();
  }

  /** provider -> { model -> context window }, learned from models.list */
  private readonly modelWindows = new Map<string, Map<string, number>>();
  private modelWarmInFlight = new Set<string>();

  private async modelsList(params: Record<string, unknown>): Promise<{
    provider: string;
    models: ModelInfo[];
    error?: string;
  }> {
    const providerId = str(params, "provider") ?? this.cfg.default_provider;
    try {
      const provider = this.providers.getPrimary(providerId);
      const models = await provider.listModels();
      const windows = new Map<string, number>();
      for (const m of models) {
        if ((m.contextTokens ?? 0) > 0) windows.set(m.id, m.contextTokens!);
      }
      if (windows.size > 0) this.modelWindows.set(providerId, windows);
      return { provider: providerId, models };
    } catch (err) {
      return { provider: providerId, models: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Context window of a model, from the (GUI-warmed) cache — 0 when unknown. */
  private cachedContextWindow(providerId: string, model: string): number {
    return this.modelWindows.get(providerId)?.get(model) ?? 0;
  }

  /** Fetch model metadata in the background so compaction has a window. */
  private warmModelWindows(providerId: string): void {
    if (this.modelWindows.has(providerId) || this.modelWarmInFlight.has(providerId)) return;
    this.modelWarmInFlight.add(providerId);
    void this.modelsList({ provider: providerId })
      .catch(() => {
        /* offline provider: compaction falls back to the estimate */
      })
      .finally(() => this.modelWarmInFlight.delete(providerId));
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
  private async fsPreview(params: Record<string, unknown>): Promise<{
    path: string;
    kind:
      | "image"
      | "audio"
      | "video"
      | "pdf"
      | "markdown"
      | "text"
      | "csv"
      | "json"
      | "docx"
      | "xlsx"
      | "pptx"
      | "binary";
    mime?: string;
    dataBase64?: string;
    content?: string;
    /** csv: parsed rows (first row is usually the header) */
    rows?: string[][];
    /** docx / pptx: parsed content (mirrors office_create input) */
    blocks?: unknown;
    slides?: unknown;
    /** xlsx: worksheets */
    sheets?: unknown;
    truncated?: boolean;
    size: number;
    tooLarge?: boolean;
  }> {
    const backend = this.backendFor(params);
    const raw = (str(params, "path") ?? "").trim();
    const target = await this.resolveOnBackend(backend, raw);
    let stat: Awaited<ReturnType<ExecBackend["stat"]>>;
    try {
      stat = await backend.stat(target);
    } catch {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `cannot stat: ${target}`);
    }
    if (!stat.isFile) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `not a file: ${target}`);
    const size = stat.size;
    const ext = path.extname(target).replace(".", "").toLowerCase();

    if (ext === "md" || ext === "markdown") {
      const CAP = 256 * 1024;
      const buf = await backend.readFile(target, CAP + 1);
      if (buf.subarray(0, 8192).includes(0)) return { path: target, kind: "binary", size };
      return {
        path: target, kind: "markdown",
        content: buf.subarray(0, CAP).toString("utf8"),
        truncated: buf.length > CAP || size > CAP, size,
      };
    }

    // Office documents: unzip the OOXML parts and return the parsed content so
    // the viewer can render a real preview (no temp file, no external app)
    if (ext === "docx" || ext === "xlsx" || ext === "pptx") {
      const CAP = 32 * 1024 * 1024;
      if (size > CAP) return { path: target, kind: ext, size, tooLarge: true };
      const buf = await backend.readFile(target, CAP);
      try {
        if (ext === "docx") return { path: target, kind: "docx", blocks: readDocx(buf), size };
        if (ext === "xlsx") return { path: target, kind: "xlsx", sheets: readXlsx(buf), size };
        return { path: target, kind: "pptx", slides: readPptx(buf), size };
      } catch {
        return { path: target, kind: "binary", size };
      }
    }

    // delimited text and JSON get structured rendering
    if (ext === "csv" || ext === "tsv") {
      const CAP = 1024 * 1024;
      const buf = await backend.readFile(target, CAP + 1);
      if (buf.subarray(0, 8192).includes(0)) return { path: target, kind: "binary", size };
      const text = buf.subarray(0, CAP).toString("utf8");
      const delim = ext === "tsv" ? "\t" : (text.split("\n")[0] ?? "").includes(",") ? "," : "\t";
      return {
        path: target, kind: "csv", rows: parseDelimited(text, delim),
        truncated: buf.length > CAP || size > CAP, size,
      };
    }
    if (ext === "json") {
      const CAP = 512 * 1024;
      const buf = await backend.readFile(target, CAP + 1);
      if (buf.subarray(0, 8192).includes(0)) return { path: target, kind: "binary", size };
      const raw = buf.subarray(0, CAP).toString("utf8");
      let pretty = raw;
      try {
        pretty = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        /* not valid JSON — show it as-is */
      }
      return {
        path: target, kind: "json", content: pretty,
        truncated: buf.length > CAP || size > CAP, size,
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
      const buf = await backend.readFile(target, cap);
      return { path: target, kind, mime, dataBase64: buf.toString("base64"), size };
    }

    // everything else: text unless it sniffs binary
    const TEXT_CAP = 256 * 1024;
    const buf = await backend.readFile(target, TEXT_CAP + 1);
    if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) {
      return { path: target, kind: "binary", size };
    }
    return {
      path: target, kind: "text",
      content: buf.subarray(0, TEXT_CAP).toString("utf8"),
      truncated: buf.length > TEXT_CAP || size > TEXT_CAP, size,
    };
  }

  /** Directory listing with files, for the GUI file tree (read-only). */
  private async fsList(params: Record<string, unknown>): Promise<{
    path: string;
    entries: Array<{ name: string; path: string; dir: boolean; size: number }>;
    home: string;
  }> {
    const backend = this.backendFor(params);
    const raw = (str(params, "path") ?? "").trim();
    const target = await this.resolveOnBackend(backend, raw);
    let listed;
    try {
      listed = await backend.listDir(target);
    } catch {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `cannot list directory: ${target}`);
    }
    const mapped = listed
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: e.path, dir: e.dir, size: e.size }))
      .slice(0, 500);
    return { path: target, entries: mapped, home: await backend.home() };
  }

  /** Read a text file for the GUI viewer. Capped at 256 KiB; binary files
   * (NUL byte sniff) are rejected rather than rendered as mojibake. */
  private async fsRead(params: Record<string, unknown>): Promise<{
    path: string;
    content: string;
    truncated: boolean;
    size: number;
  }> {
    const backend = this.backendFor(params);
    const raw = (str(params, "path") ?? "").trim();
    const target = await this.resolveOnBackend(backend, raw);
    let stat: Awaited<ReturnType<ExecBackend["stat"]>>;
    try {
      stat = await backend.stat(target);
    } catch {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `cannot stat: ${target}`);
    }
    if (!stat.isFile) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `not a file: ${target}`);
    const CAP = 256 * 1024;
    const buf = await backend.readFile(target, CAP + 1);
    if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `binary file: ${target}`);
    }
    return {
      path: target,
      content: buf.subarray(0, CAP).toString("utf8"),
      truncated: buf.length > CAP || stat.size > CAP,
      size: stat.size,
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
    return { ok: true, connectors: this.maskConnectors(connectors) };
  }


  /** Mask secret-looking connector fields: API responses never carry them. */
  private maskConnectors(
    connectors: Record<string, Record<string, unknown> | undefined>,
  ): Record<string, unknown> {
    const secret = /secret|token|password|api_?key|credential|signature/i;
    const out: Record<string, unknown> = {};
    for (const [kind, cfg] of Object.entries(connectors)) {
      const masked: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cfg ?? {})) {
        masked[k] = secret.test(k) && typeof v === "string" && v !== "" ? "***" : v;
      }
      out[kind] = masked;
    }
    return out;
  }

  private connectorsGet(): Record<string, unknown> {
    return { connectors: this.maskConnectors(this.cfg.connectors ?? {}) };
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
    return { ok: true, connectors: this.maskConnectors(connectors) };
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
  private httpsGetBuffer(url: string): Promise<{ ok: boolean; status: number; buffer: Buffer }> {
    const viaNodeHttps = () =>
      new Promise<{ ok: boolean; status: number; buffer: Buffer }>((resolve, reject) => {
        const req = https.get(url, { rejectUnauthorized: false }, (res: import("node:http").IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              ok: (res.statusCode ?? 500) < 400,
              status: res.statusCode ?? 0,
              buffer: Buffer.concat(chunks),
            }),
          );
        });
        req.on("error", reject);
        req.setTimeout(20_000, () => req.destroy(new Error("timeout")));
      });
    return fetch(url, { signal: AbortSignal.timeout(15_000) })
      .then(async (res) => ({
        ok: res.ok,
        status: res.status,
        buffer: Buffer.from(await res.arrayBuffer()),
      }))
      .catch((err) => {
        const code = String((err as { cause?: { code?: string } }).cause?.code ?? "");
        if (!/CERT|SSL|TLS/i.test(code) || process.env.FAMILIAR_TLS_STRICT === "1") throw err;
        return viaNodeHttps();
      });
  }

  private async updateCheck(): Promise<Record<string, unknown>> {
    const githubRepo = process.env.FAMILIAR_GITHUB_REPO || 'keima-tech/familiar-harness';
    const githubApi = process.env.FAMILIAR_GITHUB_API || 'https://api.github.com';
    const api = githubApi + '/repos/' + githubRepo + '/releases';
    let latest = '';
    let releaseUrl = 'https://github.com/' + githubRepo + '/releases';
    try {
      const res = await this.httpsGetBuffer(api);
      if (res.status === 404) {
        return { current: this.serverVersion, latest: '', available: false, error: 'no release (HTTP 404)' };
      }
      if (!res.ok) {
        // 403 (rate limit) / 401 / 5xx: report instead of hiding it
        return { current: this.serverVersion, latest: '', available: false, error: 'HTTP ' + res.status };
      }
      const releases = JSON.parse(res.buffer.toString('utf8')) as Array<{ tag_name?: string; html_url?: string }>;
      for (const r of releases) {
        const v = (r.tag_name ?? '').replace(/^v/, '');
        if (!v) continue;
        if (!latest || this.semverCmp(v, latest) > 0) {
          latest = v;
          releaseUrl = r.html_url ?? releaseUrl;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { current: this.serverVersion, latest: '', available: false, error: 'cannot reach GitHub (' + msg + ')' };
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
    // Round-trip through the store: skills.view hands the GUI a body that has
    // its frontmatter stripped, so writing it verbatim would drop the
    // description on every save.
    const existing = this.selfImprove.skills.get(name);
    const description = existing
      ? existing.description
      : String(params.description ?? "").trim();
    const { warnings } = this.selfImprove.skills.write(name, description, body);
    const file = path.join(this.cfg.homeDir, "skills", name, "SKILL.md");
    return { ok: true, path: file, created: !existing, warnings };
  }

  // -------------------------------------------------------------------------
  // execution backends (this machine, or an ssh host for proxy sessions)
  // -------------------------------------------------------------------------

  /** Validate an ssh target from RPC params (`session.create`, browser RPCs). */
  private parseRemote(input: unknown): SessionRemote | undefined {
    if (input === undefined || input === null || input === "") return undefined;
    if (typeof input !== "object") {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "ssh must be an object");
    }
    const o = input as Record<string, unknown>;
    const host = String(o["host"] ?? "").trim();
    if (!host || /[\s/]/.test(host) || host.startsWith("-")) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "ssh.host is required");
    }
    const user = String(o["user"] ?? "").trim();
    if (user && !/^[A-Za-z0-9._-]+$/.test(user)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `invalid ssh.user: ${user}`);
    }
    const portRaw = Number(o["port"] ?? 22);
    const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 22;
    const identityFile = String(o["identityFile"] ?? "").trim();
    return {
      host,
      ...(user ? { user } : {}),
      ...(port !== 22 ? { port } : {}),
      ...(identityFile ? { identityFile } : {}),
    };
  }

  /** File RPC backend: the session's ssh host when a session is given, else
   * an inline `ssh` target (new-session browsing), else this machine. */
  private backendFor(params: Record<string, unknown>): ExecBackend {
    const sessionId = str(params, "session");
    if (sessionId) {
      const session = this.store.getSession(sessionId);
      if (session?.remote) return createBackend(session.remote);
      return createBackend();
    }
    return createBackend(this.parseRemote(params["ssh"]) ?? null);
  }

  /** Resolve a GUI-supplied path on the backend; mirrors resolveFsPath but
   * uses the remote home for ssh backends (never the local one). */
  private async resolveOnBackend(backend: ExecBackend, raw: string, base?: string): Promise<string> {
    if (backend.kind === "local") {
      return base !== undefined ? this.resolveFsPath(raw, base) : this.resolveFsPath(raw);
    }
    const p = backend.path;
    const home = await backend.home();
    const text = raw.trim();
    if (text === "" || text === "~") return home;
    if (text.startsWith("~/")) return p.join(home, text.slice(2));
    if (p.isAbsolute(text)) return p.normalize(text);
    if (base !== undefined && base !== "") return p.resolve(base, text);
    return p.join(home, text);
  }

  /** Upload a composer attachment: written on the session's backend so the
   * model can `read` it at the returned path (proxy and serve modes alike). */
  private async fsUpload(params: Record<string, unknown>): Promise<{ path: string; size: number }> {
    const backend = this.backendFor(params);
    const rawName = (str(params, "name") ?? "").trim() || "upload.bin";
    const name = rawName
      .replace(/[\\/]+/g, "_")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^[.]+/, "")
      .slice(0, 100) || "upload.bin";
    const data = str(params, "data") ?? "";
    if (data === "") throw new RpcError(RPC_ERROR_INVALID_PARAMS, "data (base64) is required");
    const buf = Buffer.from(data, "base64");
    const MAX = 20 * 1024 * 1024;
    if (buf.length > MAX) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `attachment too large (max ${MAX / 1024 / 1024}MB)`);
    }
    const sessionId = str(params, "session");
    // The bucket is derived from a client-supplied id: keep it to a safe slug so
    // it can never climb out of ~/.familiar/uploads via ".." segments.
    const bucket = (sessionId ? sessionId.slice(0, 8) : "adhoc").replace(/[^A-Za-z0-9_-]/g, "_") || "adhoc";
    const p = backend.path;
    const home = await backend.home();
    const dir = p.join(home, ".familiar", "uploads", bucket);
    await backend.mkdirp(dir);
    const unique = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}-${name}`;
    const target = p.join(dir, unique);
    await backend.writeFile(target, buf);
    return { path: target, size: buf.length };
  }

  /**
   * Rename a file/folder inside its own directory (GUI file tree). The new
   * name is a bare base name — separators are refused — so a rename cannot
   * move the entry elsewhere, and an existing destination is rejected rather
   * than silently overwritten. The GUI asks the user to confirm first.
   */
  private async fsRename(params: Record<string, unknown>): Promise<{ path: string }> {
    const backend = this.backendFor(params);
    const raw = (str(params, "path") ?? "").trim();
    if (raw === "") throw new RpcError(RPC_ERROR_INVALID_PARAMS, "path is required");
    const name = (str(params, "name") ?? "").trim();
    if (name === "" || name === "." || name === ".." || /[\\/]/.test(name)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `invalid name: ${name}`);
    }
    const target = await this.resolveOnBackend(backend, raw);
    await this.guardProtected(backend, target);
    const next = backend.path.join(backend.path.dirname(target), name);
    if (next === target) return { path: target };
    if (await backend.exists(next)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `already exists: ${name}`);
    }
    try {
      await backend.rename(target, next);
    } catch (err) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `cannot rename: ${(err as Error).message}`);
    }
    return { path: next };
  }

  /** Delete a file or folder (recursive) from the GUI file tree. */
  private async fsDelete(params: Record<string, unknown>): Promise<{ deleted: true }> {
    const backend = this.backendFor(params);
    const raw = (str(params, "path") ?? "").trim();
    if (raw === "") throw new RpcError(RPC_ERROR_INVALID_PARAMS, "path is required");
    const target = await this.resolveOnBackend(backend, raw);
    await this.guardProtected(backend, target);
    try {
      await backend.remove(target);
    } catch (err) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `cannot delete: ${(err as Error).message}`);
    }
    return { deleted: true };
  }

  /** Refuse to rename/delete a filesystem root or the host home directory. */
  private async guardProtected(backend: ExecBackend, target: string): Promise<void> {
    const p = backend.path;
    const norm = p.resolve(target);
    if (norm === p.parse(norm).root) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "refusing to modify a filesystem root");
    }
    let home = "";
    try {
      home = await backend.home();
    } catch {
      home = "";
    }
    if (home !== "" && norm === p.resolve(home)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "refusing to modify the home directory");
    }
  }

  private async fsDirs(params: Record<string, unknown>): Promise<{ dirs: string[]; home: string }> {
    const backend = this.backendFor(params);
    const raw = (str(params, "path") ?? "").trim();
    const sessionId = str(params, "session");
    const cwdOf = sessionId ? this.store.getSession(sessionId)?.cwd : undefined;
    const target = await this.resolveOnBackend(backend, raw, cwdOf);
    let dirs: string[];
    try {
      const entries = await backend.listDir(target);
      dirs = entries
        .filter((e) => e.dir && !e.name.startsWith("."))
        .map((e) => e.path)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `cannot list directory: ${target}`);
    }
    return { dirs, home: await backend.home() };
  }

  /**
   * Path suggestions for the composer's "@" token: lists dirs AND files whose
   * name starts with the typed prefix (directories first, capped at 20).
   */
  private async fsSuggest(
    params: Record<string, unknown>,
  ): Promise<{ items: Array<{ path: string; dir: boolean }> }> {
    const prefix = (str(params, "prefix") ?? "").trim();
    if (prefix === "") return { items: [] };
    const backend = this.backendFor(params);
    const p = backend.path;
    const lastSep = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
    const dirPart = lastSep >= 0 ? prefix.slice(0, lastSep + 1) : "";
    const namePrefix = lastSep >= 0 ? prefix.slice(lastSep + 1) : prefix;
    const cwd = str(params, "cwd");
    let target: string;
    if (dirPart === "") {
      target = cwd && cwd !== "" ? await this.resolveOnBackend(backend, cwd) : await backend.home();
    } else if (p.isAbsolute(dirPart) || dirPart.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(dirPart)) {
      target = await this.resolveOnBackend(backend, dirPart);
    } else {
      const fallback = backend.kind === "local" ? process.cwd() : await backend.home();
      target = await this.resolveOnBackend(backend, dirPart, cwd && cwd !== "" ? cwd : fallback);
    }
    let entries;
    try {
      entries = await backend.listDir(target);
    } catch {
      return { items: [] };
    }
    const q = namePrefix.toLowerCase();
    const matched = entries.filter((e) => e.name.toLowerCase().startsWith(q));
    matched.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    const items = matched.slice(0, 20).map((e) => ({ path: e.path, dir: e.dir }));
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
    const remote = this.parseRemote(params["ssh"]);
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
    // `~`-prefixed cwds (typed in the new-session/cwd dialogs) resolve to the
    // server's home. ssh proxy sessions take the path as given: it lives on
    // the remote host, so local path math must not touch it.
    const rawCwd = str(params, "cwd");
    let cwd: string;
    if (remote) {
      const remoteCwd = (rawCwd ?? "").trim();
      if (!remoteCwd.startsWith("/")) {
        throw new RpcError(
          RPC_ERROR_INVALID_PARAMS,
          "ssh sessions need an absolute cwd on the remote host",
        );
      }
      cwd = path.posix.normalize(remoteCwd);
    } else {
      cwd = rawCwd ? this.resolveFsPath(rawCwd) : process.cwd();
    }
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
      ...(remote ? { remote } : {}),
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
  private async updateSession(params: Record<string, unknown>): Promise<SessionRecord> {
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
      if (session.remote) {
        // An ssh session's folder lives on the remote host: resolve it with that
        // backend (posix flavor + remote home) and stat it there. The local
        // path.resolve/statSync would reject every valid remote directory.
        const backend = this.backendFor({ session: id });
        const resolved = await this.resolveOnBackend(backend, cwd);
        let isDir = false;
        try {
          isDir = (await backend.stat(resolved)).isDir;
        } catch {
          /* leave false -> error below */
        }
        if (!isDir) {
          throw new RpcError(
            RPC_ERROR_INVALID_PARAMS,
            `"cwd" is not an existing directory on ${backend.label}: ${cwd}`,
          );
        }
        patch.cwd = resolved;
      } else {
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
    const attachments = this.parseAttachments(params);
    const session = this.requireSession(sessionId);
    const events = (event: unknown): void => ctx.onEvent?.(sessionId, event);
    const msgCountBefore = this.store.getMessages(sessionId).length;
    const running = this.activeTurns.get(sessionId);
    if (running) {
      // The running turn's text travels with the error: a client that retries
      // the very same instruction (double Enter, a stale tab, /retry) can
      // recognize it and NOT deliver a duplicate some minutes later.
      throw new RpcError(
        RPC_ERROR_INVALID_PARAMS,
        "a turn is already running for this session (stop it first)",
        { runningText: running.text, runningStartedAt: running.startedAt },
      );
    }
    // Token budget guard: refuse to start when a hard limit is already exceeded.
    const breach = this.budgetBreach(sessionId);
    if (breach && this.cfg.budget?.enforce) {
      throw new RpcError(
        RPC_ERROR_INVALID_PARAMS,
        `${breach.scope} token budget exceeded (${breach.used}/${breach.limit}) — ` +
          `raise budget.max_tokens_per_${breach.scope} or set budget.enforce: false`,
      );
    }
    const controller = new AbortController();
    this.activeTurns.set(sessionId, { controller, text, startedAt: Date.now() });
    // Hoisted so the HTTP-400 repair retry below replays the same options
    // (proxy sessions must not fall back to the local MCP toolset).
    let remoteTools: Awaited<ReturnType<typeof this.mcpToolsFor>> | undefined;
    let contextWindowTokens = 0;
    try {
      // Proxy sessions advertise the host's MCP tools instead of local ones.
      remoteTools = session.remote ? await this.mcpToolsFor(session.remote) : undefined;
      // Compaction ratio needs the model window; the GUI's models.list warms
      // this cache, and we ask for it in the background when still unknown.
      const providerForWindow = str(params, "provider") ?? session.provider;
      const modelForWindow = str(params, "model") ?? session.model;
      contextWindowTokens = this.cachedContextWindow(providerForWindow, modelForWindow);
      if (contextWindowTokens === 0) this.warmModelWindows(providerForWindow);
      const res = await this.runner.runTurn({
        sessionId,
        userText: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        provider: str(params, "provider"),
        model: str(params, "model"),
        profile: str(params, "profile") ?? undefined,
        effort: str(params, "effort"),
        yolo: params["yolo"] === true,
        plan: params["plan"] === true,
        permissionMode: permissionModeOf(params["permissionMode"]),
        maxSteps: num(params, "maxSteps"),
        signal: controller.signal,
        onEvent: events,
        takeInjections: () => this.takeInjections(sessionId),
        ...(contextWindowTokens > 0 ? { contextWindowTokens } : {}),
        ...(remoteTools ? { extraTools: remoteTools } : {}),
        ...(session.remote ? { excludeToolPrefix: "mcp__" } : {}),
      });
      // Budget: record this turn's tokens and warn if a threshold was crossed.
      this.recordUsage(sessionId, res.usage, events);
      // M3: background self-review of this turn (stage-only). It must not
      // hold the per-session turn lock — a review can take up to a minute and
      // would reject the user's next message the whole time.
      if (!this.disableReview && !controller.signal.aborted) {
        void this.reviewTurn({ sessionId, session, msgCountBefore, ctx });
      }
      // M4: idle feed for the curator scheduler
      this.lastTurnAt = Date.now();
      return res;
    } catch (err) {
      if (controller.signal.aborted) {
        // info, not debug: an aborted turn leaves no assistant message, and
        // "the session went quiet" reports were impossible to diagnose
        log.info(
          `turn aborted by user: session ${sessionId} ("${text.length > 60 ? `${text.slice(0, 60)}…` : text}")`,
        );
        return { turnId: "", steps: 0, toolCalls: 0, usage: {}, aborted: true };
      }
      // A "HTTP 400" here is nearly always the provider rejecting a stored
      // tool-call argument that was truncated mid-stream: repair the history
      // and retry once so the session heals instead of staying broken.
      const message = err instanceof Error ? err.message : String(err);
      // Only a *bad request* (400) can be the truncated tool-call argument
      // poison. 401/403/404 (auth, unknown model) must not mutate history.
      if (/HTTP 400\b/.test(message)) {
        const fixed = this.store.repairToolCallArguments(sessionId);
        if (fixed > 0) {
          // the failed attempt already appended the user message (and possibly
          // a step or two): drop them, or the retry would store the request twice
          this.store.truncateMessages(sessionId, msgCountBefore);
          log.warn(`turn failed (${message}); repaired ${fixed} message(s) — retrying once`);
          try {
            const retry = await this.runner.runTurn({
              sessionId,
              userText: text,
              attachments: attachments.length > 0 ? attachments : undefined,
              provider: str(params, "provider"),
              model: str(params, "model"),
              profile: str(params, "profile") ?? undefined,
              effort: str(params, "effort"),
              yolo: params["yolo"] === true,
              plan: params["plan"] === true,
              permissionMode: permissionModeOf(params["permissionMode"]),
              maxSteps: num(params, "maxSteps"),
              signal: controller.signal,
              onEvent: events,
              takeInjections: () => this.takeInjections(sessionId),
              ...(contextWindowTokens > 0 ? { contextWindowTokens } : {}),
              ...(remoteTools ? { extraTools: remoteTools } : {}),
              ...(session.remote ? { excludeToolPrefix: "mcp__" } : {}),
            });
            return retry;
          } catch {
            /* fall through to the original error */
          }
        }
      }
      // Include the failure in the response as well (events already carried it).
      log.error(`turn failed: ${message}`);
      throw err;
    } finally {
      this.activeTurns.delete(sessionId);
      // A steering message that landed after the loop's final drain: run it as
      // its own turn so it is never silently dropped (a tiny race window).
      // After an abort the user asked to stop — drop them instead of starting
      // a fresh turn behind their back.
      const leftover = this.injections.get(sessionId) ?? [];
      this.injections.delete(sessionId);
      if (!controller.signal.aborted && leftover.length > 0) {
        const [first, ...rest] = leftover;
        if (rest.length > 0) this.injections.set(sessionId, rest);
        if (first) {
          void this.send(
            {
              id: sessionId,
              text: first.text,
              ...(first.attachments && first.attachments.length > 0
                ? { attachments: first.attachments }
                : {}),
            },
            ctx,
          ).catch(() => {
            // The follow-up could not start (another turn grabbed the session in
            // the meantime) — put the message back so that running turn drains
            // it instead of losing it.
            const queued = this.injections.get(sessionId) ?? [];
            this.injections.set(sessionId, [first, ...queued]);
          });
        }
      }
    }
  }

  /**
   * Steer a running turn: queue the message so the loop appends it at the next
   * step boundary and the model reads it then. Unlike session.send it neither
   * aborts nor waits for the turn to finish (and unlike the client-side queue it
   * is read mid-turn rather than after).
   */
  private steer(params: Record<string, unknown>): Record<string, unknown> {
    const sessionId = str(params, "id");
    const text = str(params, "text");
    if (!sessionId || text === undefined || text === null || text === "") {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "params 'id' and 'text' are required");
    }
    this.requireSession(sessionId);
    if (!this.activeTurns.has(sessionId)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "no running turn to steer");
    }
    const list = this.injections.get(sessionId) ?? [];
    list.push({ text, attachments: this.parseAttachments(params) });
    this.injections.set(sessionId, list);
    return { steered: true, pending: list.length };
  }

  /**
   * Manual compaction (`/compact`): summarize the middle of the stored history
   * and rewrite it so future turns start small. Persisted (unlike the per-step
   * guard). Refused while a turn runs (it is rewriting the same history).
   */
  private async compact(
    params: Record<string, unknown>,
    ctx: RpcContext,
  ): Promise<Record<string, unknown>> {
    const id = str(params, "id");
    if (!id) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
    this.requireSession(id);
    if (this.activeTurns.has(id)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "a turn is running — stop it before compacting");
    }
    return this.runner.compactSession(id, {
      onEvent: (event) => ctx.onEvent?.(id, event),
    });
  }

  /**
   * `/undo`: restore the files the most recent turn's write/edit tools changed.
   * The turn's recorded edits are applied in reverse (newest first) on the
   * session's own backend, then forgotten so the next `/undo` steps further
   * back. Refused while a turn is running (it may be mid-edit).
   */
  private async undo(
    params: Record<string, unknown>,
  ): Promise<{ undone: boolean; turnId?: string; paths: string[]; failed: string[] }> {
    const id = str(params, "id");
    if (!id) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
    this.requireSession(id);
    if (this.activeTurns.has(id)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "a turn is running — stop it before undoing");
    }
    const turn = this.store.peekUndoTurn(id);
    if (!turn) return { undone: false, paths: [], failed: [] };
    const backend = this.backendFor({ session: id });
    const paths: string[] = [];
    const failed: string[] = [];
    for (const change of turn.changes) {
      try {
        if (change.before === null) {
          // the file was created by that turn → remove it
          try {
            await backend.remove(change.path);
          } catch {
            /* already gone */
          }
        } else {
          await backend.writeFile(change.path, change.before);
        }
        paths.push(change.path);
      } catch {
        failed.push(change.path);
      }
    }
    this.store.dropTurnFileEdits(id, turn.turnId);
    return { undone: true, turnId: turn.turnId, paths, failed };
  }

  /** `/export`: the transcript as markdown or a lossless JSON document. */
  private exportSession(
    params: Record<string, unknown>,
  ): { format: "markdown" | "json"; filename: string; content: string } {
    const id = str(params, "id");
    if (!id) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
    const session = this.requireSession(id);
    const format = str(params, "format") === "json" ? "json" : "markdown";
    const messages = this.store.getMessages(id).filter(
      (m) => (m.meta as { ephemeral?: boolean } | undefined)?.ephemeral !== true,
    );
    const slug =
      (session.title || "session")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "session";
    const filename = `${slug}-${id.slice(0, 8)}.${format === "json" ? "json" : "md"}`;
    if (format === "json") {
      return {
        format,
        filename,
        content: JSON.stringify({ version: 1, session, messages }, null, 2),
      };
    }
    const out: string[] = [
      `# ${session.title || session.id.slice(0, 8)}`,
      "",
      `- provider: ${session.provider}${session.model ? `/${session.model}` : ""}`,
      `- cwd: ${session.cwd}`,
      `- created: ${new Date(session.createdAt).toISOString()}`,
      "",
    ];
    for (const m of messages) {
      if (m.role === "user") out.push("## User", "", m.content ?? "", "");
      else if (m.role === "assistant") out.push("## Assistant", "", m.content ?? "", "");
      else out.push(`### ${m.name ?? "tool"}`, "", "```", String(m.content ?? "").slice(0, 4000), "```", "");
    }
    return { format, filename, content: out.join("\n") };
  }

  /** `/import`: build a new session from a JSON transcript (export format). */
  private importSession(
    params: Record<string, unknown>,
  ): { session: SessionRecord; imported: number } {
    const content = str(params, "content");
    if (!content) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "content is required");
    let parsed: {
      session?: Partial<SessionRecord>;
      messages?: unknown[];
    };
    try {
      parsed = JSON.parse(content) as typeof parsed;
    } catch {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "content must be a JSON transcript");
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
    if (!messages) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "transcript has no messages array");
    }
    const src: Partial<SessionRecord> = parsed.session ?? {};
    const provider =
      (src.provider && this.cfg.providers[src.provider] ? src.provider : undefined) ??
      this.cfg.default_provider;
    const pc = this.cfg.providers[provider];
    const model =
      src.model ??
      pc?.default_model ??
      this.cfg.default_model ??
      resolveDefaultModel(pc?.kind ?? "mock");
    if (!model) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `"model" is required for provider "${provider}"`);
    }
    const session = this.store.createSession({
      title: str(params, "title") ?? src.title ?? "Imported session",
      provider,
      model,
      ...(src.profile ? { profile: src.profile } : {}),
      ...(src.effort ? { effort: src.effort } : {}),
      cwd: str(params, "cwd") ?? src.cwd ?? process.cwd(),
    });
    let imported = 0;
    for (const raw of messages) {
      const m = raw as Partial<ChatMessage> | null;
      if (!m || typeof m.role !== "string") continue;
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: m.role,
        content: String(m.content ?? ""),
        createdAt: Number.isFinite(m.createdAt) ? Number(m.createdAt) : Date.now(),
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        ...(m.meta ? { meta: m.meta } : {}),
      };
      this.store.appendMessage(session.id, msg);
      imported += 1;
    }
    return { session: this.store.getSession(session.id) ?? session, imported };
  }

  /** Today's calendar day (UTC) used as the day-budget bucket. */
  private usageDay(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** A hard token limit that is already reached, if any (session first). */
  private budgetBreach(
    sessionId: string,
  ): { scope: "session" | "day"; used: number; limit: number } | null {
    const budget = this.cfg.budget;
    if (!budget) return null;
    if (budget.max_tokens_per_session > 0) {
      const used = this.store.sessionUsage(sessionId);
      if (used >= budget.max_tokens_per_session) {
        return { scope: "session", used, limit: budget.max_tokens_per_session };
      }
    }
    if (budget.max_tokens_per_day > 0) {
      const used = this.store.dayUsage(this.usageDay());
      if (used >= budget.max_tokens_per_day) {
        return { scope: "day", used, limit: budget.max_tokens_per_day };
      }
    }
    return null;
  }

  /** Persist a turn's token usage and emit a warning past warn_ratio / limit. */
  private recordUsage(sessionId: string, usage: Usage, events: (event: unknown) => void): void {
    const tokens =
      (usage.totalPromptTokens ?? usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    if (tokens > 0) this.store.addUsage(sessionId, this.usageDay(), tokens);
    const budget = this.cfg.budget;
    if (!budget) return;
    const warnAt = budget.warn_ratio > 0 ? budget.warn_ratio : 1;
    const check = (scope: "session" | "day", used: number, limit: number): void => {
      if (limit <= 0) return;
      const ratio = used / limit;
      if (used >= limit || ratio >= warnAt) {
        events({ type: "budget.warning", scope, used, limit, ratio, exceeded: used >= limit });
      }
    };
    check("session", this.store.sessionUsage(sessionId), budget.max_tokens_per_session);
    check("day", this.store.dayUsage(this.usageDay()), budget.max_tokens_per_day);
  }

  /** Drain the steering messages queued for a running session. */
  private takeInjections(sessionId: string): { text: string; attachments?: MessageAttachment[] }[] {
    const list = this.injections.get(sessionId) ?? [];
    this.injections.set(sessionId, []);
    return list;
  }

  /** Validate image attachments for session.send (multimodal input). */
  private parseAttachments(params: Record<string, unknown>): MessageAttachment[] {
    const raw = params["attachments"];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, "attachments must be an array");
    }
    const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const MAX_IMAGES = 4;
    const MAX_BASE64 = 7_000_000; // ~5MB binary per image
    if (raw.length > MAX_IMAGES) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `at most ${MAX_IMAGES} images per message`);
    }
    const out: MessageAttachment[] = [];
    for (const item of raw) {
      const a = item as Partial<MessageAttachment> | null;
      if (!a || typeof a.media_type !== "string" || typeof a.data !== "string") {
        throw new RpcError(RPC_ERROR_INVALID_PARAMS, "each attachment needs media_type and base64 data");
      }
      if (!allowed.has(a.media_type)) {
        throw new RpcError(RPC_ERROR_INVALID_PARAMS, `unsupported image type: ${a.media_type}`);
      }
      if (a.data.length > MAX_BASE64) {
        throw new RpcError(RPC_ERROR_INVALID_PARAMS, `image too large (max ~5MB): ${a.name ?? a.media_type}`);
      }
      out.push({
        media_type: a.media_type,
        data: a.data,
        ...(typeof a.name === "string" && a.name !== "" ? { name: a.name } : {}),
      });
    }
    return out;
  }

  /** Kill the running turn of a session (GUI stop button / CLI). */
  private abortTurn(params: Record<string, unknown>): { aborting: boolean } {
    const sessionId = str(params, "id");
    if (!sessionId) throw new RpcError(RPC_ERROR_INVALID_PARAMS, "session id is required");
    const running = this.activeTurns.get(sessionId);
    if (!running) return { aborting: false };
    running.controller.abort();
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
    const items = this.selfImprove.pendingSkills.toApi(this.selfImprove.pendingSkills.list());
    // mark patches/removes whose target changed since staging (CAS mismatch):
    // approving them can only fail, so the UI offers reject instead
    const skills = this.selfImprove.skills;
    const marked = items.map((item) => {
      if (item.kind === "create" || item.snapshotBodyHash === undefined) {
        return { ...item, stale: false };
      }
      const current = skills.bodyHash(item.name ?? item.target ?? "");
      const stale = current === undefined || current !== item.snapshotBodyHash;
      return { ...item, stale };
    });
    return { items: marked };
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
    /** extra machine-readable detail, forwarded as JSON-RPC `error.data` */
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Parse CSV/TSV (RFC4180-style quoting) into a row matrix for the viewer. */
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delim) pushField();
    else if (ch === "\n") pushRow();
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows.slice(0, 1000).map((r) => r.slice(0, 100));
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** GUI server form: a list of short single-line strings (args / extensions). */
function serverStringList(raw: unknown, label: string, max: number): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `${label} must be an array`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new RpcError(RPC_ERROR_INVALID_PARAMS, `${label} must contain strings`);
    const value = item.trim();
    if (value === "") continue;
    if (/[\r\n]/.test(value)) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `${label} entries must be single-line`);
    out.push(value);
    if (out.length > max) throw new RpcError(RPC_ERROR_INVALID_PARAMS, `${label} has too many entries`);
  }
  return out;
}

/** GUI server form: env keys are identifiers; "***" means "keep the saved secret". */
function serverEnv(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcError(RPC_ERROR_INVALID_PARAMS, "env must be an object");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `invalid env key: ${key}`);
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new RpcError(RPC_ERROR_INVALID_PARAMS, `invalid env value for ${key}`);
    }
    out[key] = value;
  }
  return out;
}

function serverTimeout(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 100 || value > 600_000) {
    throw new RpcError(RPC_ERROR_INVALID_PARAMS, "timeout_ms must be between 100 and 600000");
  }
  return Math.floor(value);
}

/** Composer permission mode: ask | edit | yolo (absent → keep legacy yolo/plan). */
function permissionModeOf(raw: unknown): PermissionMode | undefined {
  return raw === "ask" || raw === "edit" || raw === "yolo" ? raw : undefined;
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
