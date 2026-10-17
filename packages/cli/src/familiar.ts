#!/usr/bin/env node
/**
 * familiar — CLI entry point.
 *
 * Subcommands:
 *   run     headless one-shot agent execution (-p / positional prompt)
 *   chat    interactive REPL
 *   serve   start the HTTP+WS server for external clients (Desktop)
 *   sessions   list | show <id> | delete <id>
 *   model      list [provider]
 *   init    create ~/.familiar/config.yaml (+ directories) if missing
 *   doctor  environment checks
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, SessionRecord } from "@familiar/protocol";
import {
  CONFIG_TEMPLATE,
  loadConfig,
  familiarPaths,
  describeAuthSource,
  ProviderRegistry,
  SqliteSessionStore,
  ensureDir,
  log,
} from "@familiar/core";
import { AgentServer, startHttpTransport } from "@familiar/server";
import { createPrettyPrinter, createJsonPrinter, ansi, useColor } from "./ui/display.js";
import { CliApprovalAdapter } from "./ui/approvals.js";
import { RemoteFamiliarClient } from "./client/remote.js";
import { cmdWorktree } from "./worktree.js";

const USAGE = `familiar — OpenCode/Claude Code-style agent harness (CLI)

Usage:
  familiar run [-p "prompt"] [--provider ID] [--model ID] [--session ID] [--new]
            [--cwd DIR] [--max-steps N] [-y] [--plan] [--json] [--title S]
  familiar chat [--session ID] [--provider ID] [--model ID] [--cwd DIR] [-y]
  familiar serve [--port N] [--config PATH]
  familiar sessions list | show <id> [--messages] | delete <id>
  familiar model list [provider]
  familiar memory [list] | pending | approve <id> | reject <id> | approval on|off
  familiar skills [list] | view <name> | pending | approve <id|all> | reject <id>
  familiar curator status | run [--dry-run] [--consolidate] | pause | resume
  familiar mcp                       # MCP server status + exposed tool names
           | pin/unpin <skill> | restore <skill> | list-archived | backup
           | rollback <id> | prune --days N | ledger [--skill]
  familiar worktree list | add <name> | remove <name> | prune   (git worktree wrapper)
  familiar init
  familiar doctor
  familiar help | --version

Options:
  -p, --prompt TEXT      prompt text (or pass it as positional args)
  -y, --yolo             skip approval prompts for risky actions
      --plan             plan mode: read-only tools, produce a plan instead of edits
      --json             emit NDJSON agent events (machine-readable)
      --config PATH      path to config.yaml (default ~/.familiar/config.yaml)
      --server URL       RPC base URL of a running 'familiar serve'
      --local            force in-process mode (skip the serve probe)
  -c, --continue         resume the most recent session
`;

// ---------------------------------------------------------------------------
// tiny argv parser
// ---------------------------------------------------------------------------

const STRING_FLAGS = new Set([
  "--provider",
  "--model",
  "--config",
  "--cwd",
  "--session",
  "--max-steps",
  "--port",
  "--profile",
  "--title",
  "--server",
  "--root",
  "-p",
  "--prompt",
  "--days",
  "--reason",
]);
const BOOL_FLAGS = new Set([
  "-y",
  "--yolo",
  "--json",
  "--new",
  "-c",
  "--continue",
  "--messages",
  "--plan",
  "--local",
  "--force",
  "--consolidate",
  "--dry-run",
]);

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg.startsWith("-") && arg !== "-") {
      if (STRING_FLAGS.has(arg)) {
        const value = argv[i + 1];
        if (value === undefined) fail(`missing value for ${arg}\n${USAGE}`);
        flags[normalizeFlag(arg)] = value;
        i += 1;
      } else if (BOOL_FLAGS.has(arg)) {
        flags[normalizeFlag(arg)] = true;
      } else {
        fail(`unknown option: ${arg}\n${USAGE}`);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function normalizeFlag(flag: string): string {
  switch (flag) {
    case "-y":
      return "yolo";
    case "-p":
      return "prompt";
    case "-c":
      return "continue";
    default:
      return flag.replace(/^--?/, "");
    }
}

function fail(msg: string): never {
  process.stderr.write(`familiar: ${msg}\n`);
  process.exit(2);
}

const flag = (f: Record<string, string | boolean>, name: string): string | undefined => {
  const v = f[name];
  return typeof v === "string" ? v : undefined;
};
const flagBool = (f: Record<string, string | boolean>, name: string): boolean => f[name] === true;

// ---------------------------------------------------------------------------
// shared setup helpers
// ---------------------------------------------------------------------------

function resolveCwd(flags: Record<string, string | boolean>): string {
  const raw = flag(flags, "cwd");
  return raw ? path.resolve(raw) : process.cwd();
}

function loadCliConfig(flags: Record<string, string | boolean>) {
  return loadConfig({
    configFile: flag(flags, "config"),
    overrides: { default_provider: flag(flags, "provider") },
  });
}

function providerId(flags: Record<string, string | boolean>): string | undefined {
  return flag(flags, "provider");
}

function modelId(flags: Record<string, string | boolean>): string | undefined {
  return flag(flags, "model");
}

const dim = (s: string) => (useColor() ? ansi.dim(s) : s);
const red = (s: string) => (useColor() ? ansi.red(s) : s);
const cyan = (s: string) => (useColor() ? ansi.cyan(s) : s);
const green = (s: string) => (useColor() ? ansi.green(s) : s);

// ---------------------------------------------------------------------------
// transports: in-process or remote (familiar serve)
// ---------------------------------------------------------------------------

interface FamiliarTransport {
  kind: "local" | "remote";
  dispatch(
    method: string,
    params: Record<string, unknown>,
    opts?: { onEvent?: (ev: AgentEvent) => void },
  ): Promise<unknown>;
}

function localTransport(server: AgentServer): FamiliarTransport {
  return {
    kind: "local",
    async dispatch(method, params, opts) {
      return server.dispatch(method, params, {
        onEvent: (_sid, ev) => opts?.onEvent?.(ev as AgentEvent),
      });
    },
  };
}

/** Pretty-print server-level events (permission prompts) in human mode. */
function serverEventPrettyPrinter(): (ev: AgentEvent) => void {
  return (ev) => {
    if (ev.type === "permission.request") {
      process.stdout.write(dim(`\n⏺ approval needed (${ev.tool}): ${ev.summary}\n`));
    } else if (ev.type === "permission.resolved") {
      process.stdout.write(dim(`⏺ approval ${ev.approved ? "granted" : "denied"}\n`));
    }
  };
}

async function openRunTransport(
  flags: Record<string, string | boolean>,
  cfg: ReturnType<typeof loadCliConfig>,
  interactive: boolean,
  json: boolean,
  closeAfterDispatch: boolean,
): Promise<{
  transport: FamiliarTransport;
  setJsonServerSink?: (sink: (ev: AgentEvent) => void) => void;
  close?: () => void;
}> {
  if (flagBool(flags, "local")) {
    const server = new AgentServer({
      config: cfg,
      approval: interactive ? new CliApprovalAdapter() : undefined,
    });
    return { transport: localTransport(server) };
  }
  const baseUrl = flag(flags, "server") ?? `http://${cfg.server.bind}:${cfg.server.port}`;
  if (await RemoteFamiliarClient.probe(baseUrl)) {
    let sink: ((ev: AgentEvent) => void) | undefined = serverEventPrettyPrinter();
    const approval = interactive ? new CliApprovalAdapter() : undefined;
    const client = new RemoteFamiliarClient(
      baseUrl,
      approval
        ? (req) => approval.request({ tool: req.tool, summary: req.summary, detail: req.detail })
        : undefined,
      (ev) => sink?.(ev),
    );
    return {
      transport: {
        kind: "remote",
        async dispatch(method, params, opts) {
          const sessionId = typeof params["id"] === "string" ? (params["id"] as string) : undefined;
          return client.dispatch(method, params, {
            sessionId,
            onEvent: opts?.onEvent,
          });
        },
      },
      setJsonServerSink: (next) => {
        sink = next;
      },
      close: () => client.close(),
    };
  }
  const server = new AgentServer({
    config: cfg,
    approval: interactive ? new CliApprovalAdapter() : undefined,
  });
  return { transport: localTransport(server) };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdRun(flags: Record<string, string | boolean>, positionals: string[]): Promise<void> {
  const text =
    flag(flags, "prompt") ?? positionals.join(" ").trim();
  if (!text) fail(`no prompt given. usage:\n${USAGE}`);
  const cwd = resolveCwd(flags);
  const cfg = loadCliConfig(flags);
  const json = flagBool(flags, "json");
  const isInteractive = !!process.stdout.isTTY && !json;

  const { transport, setJsonServerSink, close } = await openRunTransport(
    flags,
    cfg,
    isInteractive,
    json,
    true,
  );

  let sessionId: string;
  if (flag(flags, "session")) {
    sessionId = flag(flags, "session")!;
  } else if (flagBool(flags, "continue")) {
    const list = (await transport.dispatch("session.list", {})) as SessionRecord[];
    const latest = list.find((s) => s.cwd === cwd);
    if (!latest) fail("no previous session to continue (this cwd)");
    sessionId = latest.id;
  } else {
    const created = (await transport.dispatch("session.create", {
      provider: providerId(flags),
      model: modelId(flags),
      cwd,
      title: flag(flags, "title"),
    })) as SessionRecord;
    sessionId = created.id;
  }

  const printer = json ? createJsonPrinter(sessionId) : createPrettyPrinter();
  if (json && setJsonServerSink) {
    setJsonServerSink((ev) => {
      process.stdout.write(`${JSON.stringify({ sessionId, ...ev })}\n`);
    });
  }

  try {
    const res = (await transport.dispatch(
      "session.send",
      {
        id: sessionId,
        text,
        provider: providerId(flags),
        model: modelId(flags),
        maxSteps: toNumber(flag(flags, "max-steps")),
        yolo: flagBool(flags, "yolo"),
        plan: flagBool(flags, "plan"),
      },
      { onEvent: (ev) => printer(ev) },
    )) as { turnId: string; steps: number };
    if (!json) {
      process.stdout.write(
        dim(
          `(session: ${sessionId} · turn: ${res.turnId.slice(0, 8)} · steps: ${res.steps}${flagBool(flags, "plan") ? " · plan" : ""})\n`,
        ),
      );
    }
  } catch (err) {
    if (!json) {
      process.stderr.write(red(`run failed: ${err instanceof Error ? err.message : String(err)}\n`));
    }
    process.exitCode = 1;
  } finally {
    // In remote mode the WebSocket keeps the process alive — release it after
    // a short drain so trailing events can still print.
    if (!flagBool(flags, "local")) {
      setTimeout(() => close?.(), 250).unref();
    }
  }
}

async function cmdChat(flags: Record<string, string | boolean>): Promise<void> {
  const cwd = resolveCwd(flags);
  const cfg = loadCliConfig(flags);
  const { transport } = await openRunTransport(flags, cfg, true, false, false);

  let session: SessionRecord | null = null;
  if (flag(flags, "session")) {
    const id = flag(flags, "session")!;
    const got = (await transport.dispatch("session.get", { id })) as { session: SessionRecord };
    session = got.session;
  } else if (flagBool(flags, "continue")) {
    const list = (await transport.dispatch("session.list", {})) as SessionRecord[];
    session = list.find((s) => s.cwd === cwd) ?? null;
  }

  process.stdout.write(dim("familiar chat — /help for commands, /exit to quit\n"));
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ensureSession = async (): Promise<SessionRecord> => {
    if (session) return session;
    const created = (await transport.dispatch("session.create", {
      provider: providerId(flags),
      model: modelId(flags),
      cwd,
    })) as SessionRecord;
    session = created;
    process.stdout.write(
      dim(`(new session ${created.id.slice(0, 8)} · ${created.provider}/${created.model})\n`),
    );
    return created;
  };

  rl.setPrompt("❯ ");
  rl.prompt();
  rl.on("line", (line: string) => {
    void handleLine(line.trim());
  });
  rl.on("close", () => {
    process.stdout.write("\nbye\n");
    process.exit(0);
  });

  async function handleLine(line: string): Promise<void> {
    try {
      if (line === "" || line.startsWith("#")) {
        /* ignore empty lines / comments */
      } else if (line === "/exit" || line === "/quit" || line === "/q") {
        rl.close();
        return;
      } else if (line === "/help") {
        process.stdout.write(
          dim(
            "commands: /new /sessions /session <id> /model <id|reset> /plan [off] /help /exit\n(any other text is sent to the agent)\n",
          ),
        );
      } else if (line === "/new") {
        session = null;
        const s = await ensureSession();
        process.stdout.write(dim(`(new session ${s.id.slice(0, 8)})\n`));
      } else if (line.startsWith("/sessions")) {
        const list = (await transport.dispatch("session.list", {})) as SessionRecord[];
        for (const s of list.slice(0, 10)) {
          process.stdout.write(
            dim(`${s.id.slice(0, 8)}  ${s.provider}/${s.model}  ${s.title || "(untitled)"}\n`),
          );
        }
      } else if (line.startsWith("/session ")) {
        const id = line.slice("/session ".length).trim();
        const got = (await transport.dispatch("session.get", { id })) as { session: SessionRecord };
        session = got.session;
        process.stdout.write(dim(`(switched to ${got.session.id.slice(0, 8)})\n`));
      } else if (line.startsWith("/plan")) {
        const value = line.slice("/plan".length).trim();
        if (value === "off") delete flags["plan"];
        else flags["plan"] = true;
        process.stdout.write(dim(`(plan mode ${flags["plan"] ? "ON" : "OFF"} for the next messages)\n`));
      } else if (line.startsWith("/model")) {
        const value = line.slice("/model".length).trim();
        // start a fresh session with the new model (model is per-session)
        session = null;
        if (value && value !== "reset") flags["model"] = value;
        else delete flags["model"];
        const s = await ensureSession();
        process.stdout.write(dim(`(model: ${s.provider}/${s.model})\n`));
      } else if (line.startsWith("/")) {
        process.stderr.write(red(`unknown chat command: ${line} (try /help)\n`));
      } else {
        const s = await ensureSession();
        const printer = createPrettyPrinter();
        await transport.dispatch(
          "session.send",
          {
            id: s.id,
            text: line,
            yolo: flagBool(flags, "yolo"),
            plan: flagBool(flags, "plan"),
          },
          { onEvent: (ev) => printer(ev) },
        );
      }
    } catch (err) {
      process.stderr.write(red(`error: ${err instanceof Error ? err.message : String(err)}\n`));
    } finally {
      rl.prompt();
    }
  }
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
  const cfg = loadCliConfig(flags);
  const port = toNumber(flag(flags, "port")) ?? cfg.server.port;
  const server = new AgentServer({ config: cfg, rpcApprovals: true });
  const transport = await startHttpTransport(server, { port, bind: cfg.server.bind });
  await server.mcpReady();
  server.startCuratorScheduler();
  server.startCronScheduler();
  process.stdout.write(cyan(`familiar server listening on ${transport.url}\n`));
  process.stdout.write(dim(`  rpc:   POST ${transport.url}/rpc\n  events: WS ${transport.url}/ws\n  ui:    GET ${transport.url}/\n`));
  const mcpServers = server.mcp?.status() ?? [];
  if (mcpServers.length > 0) {
    const ready = mcpServers.filter((s) => s.state === "ok").length;
    process.stdout.write(dim(`  mcp:   ${ready}/${mcpServers.length} server(s) up, ${mcpServers.reduce((n, s) => n + s.tools.length, 0)} tool(s)\n`));
  }
  const cronJobs = server.cronScheduler?.status().jobs.length ?? 0;
  if (cronJobs > 0) {
    process.stdout.write(dim(`  cron:  ${cronJobs} job(s) scheduled\n`));
  }
  process.stdout.write(dim("  press Ctrl+C to stop\n"));
  const shutdown = (): void => {
    server.dispose();
    void transport.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdSessions(flags: Record<string, string | boolean>, positionals: string[]): Promise<void> {
  const sub = positionals[0] ?? "list";
  const server = new AgentServer({ config: loadCliConfig(flags) });
  if (sub === "list") {
    const list = (await server.dispatch("session.list", {})) as SessionRecord[];
    if (list.length === 0) {
      process.stdout.write(dim("(no sessions)\n"));
      return;
    }
    for (const s of list) {
      const date = new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ");
      process.stdout.write(
        `${dim(s.id.slice(0, 8))}  ${dim(date)}  ${cyan(s.provider)}/${cyan(s.model)}  ${s.title || dim("(untitled)")}\n`,
      );
    }
  } else if (sub === "show") {
    const id = resolveSessionPrefix(server, positionals[1]);
    if (!id) fail("usage: familiar sessions show <id> (--messages)");
    const data = (await server.dispatch("session.get", { id })) as { session: SessionRecord; messages: unknown[] };
    process.stdout.write(
      `${green(data.session.id)}  ${data.session.provider}/${data.session.model}  cwd: ${data.session.cwd}\n`,
    );
    if (flagBool(flags, "messages")) {
      const messages = data.messages as { role: string; content: string; name?: string }[];
      for (const m of messages) {
        const head = m.content.split("\n").slice(0, 8).join("\n").slice(0, 400);
        process.stdout.write(`\n${cyan(m.role)}${m.name ? ` ${dim(m.name)}` : ""}\n${head}\n`);
      }
    }
  } else if (sub === "delete") {
    const id = resolveSessionPrefix(server, positionals[1]);
    if (!id) fail("usage: familiar sessions delete <id>");
    await server.dispatch("session.delete", { id });
    process.stdout.write(green(`deleted ${id}\n`));
  } else {
    fail(`unknown sessions subcommand: ${sub}`);
  }
}

async function cmdModel(flags: Record<string, string | boolean>, positionals: string[]): Promise<void> {
  const sub = positionals[0] ?? "";
  if (sub !== "list") {
    process.stdout.write(dim("usage: familiar model list [provider]\n(interactive picker comes in M2)\n"));
    return;
  }
  const cfg = loadCliConfig(flags);
  const providerIdValue = positionals[1] ?? cfg.default_provider;
  const server = new AgentServer({ config: cfg });
  const res = (await server.dispatch("models.list", { provider: providerIdValue })) as {
    provider: string;
    models: { id: string }[];
    error?: string;
  };
  if (res.error) process.stderr.write(red(`model list warning: ${res.error}\n`));
  if (res.models.length === 0) {
    process.stdout.write(dim("(no models returned)\n"));
    return;
  }
  for (const m of res.models) process.stdout.write(`${m.id}\n`);
  process.stdout.write(dim(`\n(${res.models.length} models on ${res.provider})\n`));
}

async function cmdInit(): Promise<void> {
  const cfgFile = familiarPaths.config();
  for (const dir of [familiarPaths.home(), familiarPaths.profiles(), familiarPaths.skills(), familiarPaths.memories(), familiarPaths.pendingMemory(), familiarPaths.pendingSkills()]) {
    ensureDir(dir);
  }
  if (fs.existsSync(cfgFile)) {
    process.stdout.write(`config already exists: ${cfgFile}\n`);
  } else {
    fs.writeFileSync(cfgFile, CONFIG_TEMPLATE, { mode: 0o600 });
    process.stdout.write(green(`wrote ${cfgFile}\n`));
  }
  process.stdout.write(dim(`home:   ${familiarPaths.home()}\nstate:  ${familiarPaths.stateDb()}\n`));
}

// ---------------------------------------------------------------------------
// self-improvement: memory / skills commands (M3)
// ---------------------------------------------------------------------------

function openLocalServer(flags: Record<string, string | boolean>): AgentServer {
  return new AgentServer({ config: loadCliConfig(flags) });
}

type PendingApi = { id: string; kind: string; target?: string; summary: string; createdAt: number };

async function cmdMemory(flags: Record<string, string | boolean>, positionals: string[]): Promise<void> {
  const server = openLocalServer(flags);
  const si = server.selfImprove; // note: in remote-daemon mode use node RPC; CLI keeps local for now
  const sub = positionals[0] ?? "list";
  if (sub === "list") {
    const entries = si.memories.list().sort((a, b) => b.updatedAt - a.updatedAt);
    const st = approvalStateOr(server);
    process.stdout.write(
      `${cyan(String(entries.length))} memories · write_approval ${st.memoryWriteApproval ? green("on") : red("off")} (skills: ${st.skillsWriteApproval ? green("on") : red("off")})\n`,
    );
    for (const m of entries) {
      const tags = m.tags.length > 0 ? dim(` [${m.tags.join(",")}]`) : "";
      const stamp = new Date(m.updatedAt).toISOString().slice(0, 10);
      process.stdout.write(`${dim(m.id.slice(0, 6))}  ${dim(stamp)}  ${(m.source === "background" ? cyan : (s: string) => s)(m.source.slice(0, 1))}  ${m.content.slice(0, 140)}${tags}\n`);
    }
    if (entries.length === 0) process.stdout.write(dim("(no memories yet — the agent can create them with memory_manage)\n"));
    return;
  }
  if (sub === "pending") {
    const items = si.pendingMemories.list();
    if (items.length === 0) process.stdout.write(dim("(no staged memory writes)\n"));
    for (const item of items) {
      process.stdout.write(`${green(item.id)}  ${item.kind}  ${item.summary}\n`);
    }
    return;
  }
  if (sub === "approve" || sub === "reject") {
    const prefix = positionals[1];
    if (!prefix) fail(`usage: familiar memory ${sub} <id|prefix|all>`);
    const result = await server.dispatch(`memory.${sub}`, { id: prefix });
    process.stdout.write(green(JSON.stringify(result) + "\n"));
    return;
  }
  if (sub === "approval") {
    const set = positionals[1];
    if (set === "on" || set === "off") {
      await server.dispatch("memory.approval", { set });
      process.stdout.write(green(`memory write_approval: ${set}\n`));
      return;
    }
    const st = approvalStateOr(server);
    process.stdout.write(`memory write_approval: ${st.memoryWriteApproval ? "on" : "off"}\nusage: familiar memory approval on|off\n`);
    return;
  }
  fail(`unknown memory subcommand: ${sub} (list | pending | approve <id> | reject <id> | approval on|off)`);
}

async function cmdSkills(flags: Record<string, string | boolean>, positionals: string[]): Promise<void> {
  const server = openLocalServer(flags);
  const si = server.selfImprove;
  const sub = positionals[0] ?? "list";
  if (sub === "list") {
    const catalog = si.skills.list();
    process.stdout.write(`${cyan(String(catalog.length))} skills\n`);
    for (const s of catalog) {
      const last = s.lastUsedAt ? dim(` · last ${new Date(s.lastUsedAt).toISOString().slice(0, 10)}`) : "";
      process.stdout.write(`${cyan(s.name)}${s.useCount > 0 ? dim(` · used ${s.useCount}x${last}`) : dim(" · unused")}\n    ${s.description.slice(0, 120)}\n`);
    }
    if (catalog.length === 0) process.stdout.write(dim("(no skills yet)\n"));
    return;
  }
  if (sub === "view") {
    const name = positionals[1];
    if (!name) fail("usage: familiar skills view <name>");
    const view = si.skills.view(name);
    if (!view) fail(`skill not found: ${name}`);
    process.stdout.write(`${view.description}${view.warnings.length > 0 ? `\n${cyan("warns:")} ${view.warnings.join("; ")}` : ""}\n\n${view.body}\n`);
    return;
  }
  if (sub === "pending") {
    const items = si.pendingSkills.list();
    if (items.length === 0) process.stdout.write(dim("(no staged skill writes)\n"));
    for (const item of items) {
      const warns = item.warnings && item.warnings.length > 0 ? ` ${dim(`[${item.warnings.join("; ")}]`)}` : "";
      process.stdout.write(`${green(item.id)}  ${item.kind}  ${item.summary}${warns}\n`);
    }
    return;
  }
  if (sub === "approve") {
    if (positionals[1] === "all") {
      const res = (await server.dispatch("skills.approve", { all: true })) as { approved: number; messages: string[]; failed?: string[] };
      for (const m of res.messages ?? []) process.stdout.write(green(`${m}\n`));
      for (const m of res.failed ?? []) process.stdout.write(red(`FAIL ${m}\n`));
      return;
    }
    const prefix = positionals[1];
    if (!prefix) fail("usage: familiar skills approve <id|prefix|all>");
    const res = await server.dispatch("skills.approve", { prefix });
    process.stdout.write(green(JSON.stringify(res) + "\n"));
    return;
  }
  if (sub === "reject") {
    const prefix = positionals[1];
    if (!prefix) fail("usage: familiar skills reject <id|prefix>");
    const res = await server.dispatch("skills.reject", { prefix });
    process.stdout.write(green(JSON.stringify(res) + "\n"));
    return;
  }
  fail(`unknown skills subcommand: ${sub} (list | view <name> | pending | approve <id|all> | reject <id>)`);
}

// ---------------------------------------------------------------------------
// mcp diagnostics (M5)
// ---------------------------------------------------------------------------

async function cmdMcp(flags: Record<string, string | boolean>): Promise<void> {
  const server = openLocalServer(flags);
  await server.mcpReady();
  const res = (await server.dispatch("mcp.status", {})) as {
    servers: { name: string; state: string; tools: string[]; error?: string }[];
  };
  const servers = res.servers ?? [];
  if (servers.length === 0) {
    process.stdout.write(dim("no MCP servers configured (config: mcp.servers)\n"));
    return;
  }
  for (const s of servers) {
    const stateMark =
      s.state === "ok" ? green("ready") : s.state === "error" ? red("error") : dim("stopped");
    process.stdout.write(
      `${stateMark}  ${cyan(s.name)}  tools: ${s.tools.map((t) => `mcp__${s.name}__${t}`).join(", ") || dim("(none)")}${s.error ? `  ${dim(s.error.slice(0, 120))}` : ""}\n`,
    );
  }
}

function approvalStateOr(server: AgentServer): { memoryWriteApproval: boolean; skillsWriteApproval: boolean } {
  const si = server.selfImprove;
  const memOn = si.settings.get("memory_write_approval") ?? server.cfg.memory.write_approval !== false;
  const skillOn = si.settings.get("skills_write_approval") ?? server.cfg.skills.write_approval !== false;
  return { memoryWriteApproval: memOn, skillsWriteApproval: skillOn };
}

// ---------------------------------------------------------------------------
// curator commands (M4)
// ---------------------------------------------------------------------------

async function cmdCurator(flags: Record<string, string | boolean>, positionals: string[]): Promise<void> {
  const server = openLocalServer(flags);
  const cur = server.curator;
  const sub = positionals[0] ?? "status";

  if (sub === "status") {
    const st = cur.status();
    process.stdout.write(
      `${cyan("curator")}  enabled: ${st.enabled ? green("yes") : red("no")}  paused: ${st.paused ? red("yes") : "no"}  consolidation: ${st.consolidate ? green("opt-in ON") : dim("off")}\n`,
    );
    const last = st.lastRunAt ? new Date(st.lastRunAt).toISOString().slice(0, 16).replace("T", " ") : "(never)";
    const due = st.nextDueAt ? new Date(st.nextDueAt).toISOString().slice(0, 16).replace("T", " ") : dim("(first run pending)");
    process.stdout.write(`  lastRun: ${dim(last)}  nextDue: ${dim(due)}\n`);
    process.stdout.write(`  stale (${st.stale.length}): ${st.stale.join(", ") || dim("none")}\n`);
    process.stdout.write(`  archived (${st.archived.length}): ${st.archived.join(", ") || dim("none")}\n`);
    process.stdout.write(`  snapshots: ${st.snapshots} ${dim("(familiar curator ledger for history)")}\n`);
    return;
  }

  if (sub === "run") {
    const dryRun = flags["dry-run"] === true;
    const p1 = cur.runPhase1({ dryRun });
    process.stdout.write(
      `phase-1 ${dryRun ? dim("(dry-run)") : ""}: staled ${cyan(String(p1.staled.length))}, archived ${cyan(String(p1.archived.length))}, unstaled ${String(p1.unstaled.length)}${p1.snapshotId ? dim(` · snapshot ${p1.snapshotId.slice(0, 16)}`) : ""}\n`,
    );
    for (const m of p1.staled) process.stdout.write(green(`was stale  ${m}\n`));
    for (const m of p1.archived) process.stdout.write(green(`was archived  ${m}\n`));
    if (flags["consolidate"] === true || server.cfg.curator.consolidate === true) {
      const res = await cur.runConsolidation({ dryRun });
      if (res.skipped) {
        process.stdout.write(dim(`consolidation: ${res.note ?? "skipped"}\n`));
      } else {
        process.stdout.write(`consolidation: ${cyan(String(res.staged))} staged proposal(s)\n`);
        for (const p of res.proposals) {
          process.stdout.write(green(`${p.kind}  ${p.name}  ${dim(p.reason.slice(0, 100))}\n`));
        }
      }
    }
    return;
  }

  if (sub === "pause" || sub === "resume") {
    if (sub === "pause") cur.pause();
    else cur.resume();
    process.stdout.write(green(`curator ${sub}d\n`));
    return;
  }

  if (sub === "pin" || sub === "unpin") {
    const name = positionals[1];
    if (!name) fail(`usage: familiar curator ${sub} <skill>`);
    const res = cur.pin(name, sub === "pin");
    if (!res.ok) fail(res.message);
    process.stdout.write(green(`${res.message}\n`));
    return;
  }

  if (sub === "restore") {
    const name = positionals[1];
    if (!name) fail("usage: familiar curator restore <skill>");
    const res = cur.restore(name);
    if (!res.ok) fail(res.message);
    process.stdout.write(green(`${res.message}\n`));
    return;
  }

  if (sub === "list-archived") {
    const all = cur.status().archived;
    if (all.length === 0) process.stdout.write(dim("(no archived skills)\n"));
    for (const s of all) process.stdout.write(`${s}\n`);
    return;
  }

  if (sub === "backup") {
    const id = cur.backup(flags["reason"] ? String(flags["reason"]) : "manual backup");
    if (!id) fail("no skills to back up");
    process.stdout.write(green(`snapshot ${id}\n`));
    return;
  }

  if (sub === "rollback") {
    const id = positionals[1];
    if (!id) fail("usage: familiar curator rollback <snapshot-id-prefix>  (see ~/.familiar/snapshots/)");
    const res = cur.rollback(id);
    if (!res.ok) fail(res.message);
    process.stdout.write(green(`${res.message}\n`));
    return;
  }

  if (sub === "prune") {
    const days = toNumber(flag(flags, "days")) ?? 30;
    const removed = cur.pruneSnapshots(days);
    process.stdout.write(green(`pruned ${removed} snapshot(s) older than ${days}d\n`));
    return;
  }

  if (sub === "ledger") {
    const entries = cur.ledger.list({ skill: positionals[1] ?? undefined, limit: 40 });
    if (entries.length === 0) {
      process.stdout.write(dim("(no ledger entries yet)\n"));
      return;
    }
    for (const e of entries) {
      const when = new Date(e.ts).toISOString().slice(0, 16).replace("T", " ");
      const skill = e.skill ? cyan(e.skill) : dim("-");
      const detail = e.detail ? dim(`  ${e.detail.slice(0, 90)}`) : "";
      process.stdout.write(`${dim(when)}  ${e.actor}  ${e.action}  ${skill}${detail}\n`);
    }
    return;
  }

  fail(
    "unknown curator subcommand: " +
      sub +
      " (status | run [--dry-run] [--consolidate] | pause | resume | pin/unpin <skill> | restore <skill> | list-archived | backup | rollback <id> | prune --days N | ledger [--skill])",
  );
}


async function cmdDoctor(): Promise<void> {
  let failures = 0;
  const ok = (msg: string): void => {
    process.stdout.write(`${green("ok  ")} ${msg}\n`);
  };
  const warn = (msg: string): void => {
    process.stdout.write(`${cyan("warn")} ${msg}\n`);
  };
  const bad = (msg: string): void => {
    failures += 1;
    process.stdout.write(`${red("FAIL")} ${msg}\n`);
  };

  try {
    const cfg = loadConfig();
    ok(`config loaded (default provider: ${cfg.default_provider})`);
    for (const [id, pc] of Object.entries(cfg.providers)) {
      const s = describeAuthSource(pc.auth);
      if (s.source === "env:none" || s.source === "none") {
        if (id === "ollama" || id === "mock") ok(`provider ${id}: no auth needed`);
        else warn(`provider ${id}: no secret configured`);
      } else if (s.resolved) {
        ok(`provider ${id}: secret from ${s.source}`);
      } else {
        warn(`provider ${id}: secret not found (${s.source})`);
      }
    }
    try {
      const store = new SqliteSessionStore(":memory:");
      store.close();
      ok("sqlite (node:sqlite) available");
    } catch (err) {
      bad(`node:sqlite unavailable: ${String(err)} (need Node >= 22.5)`);
    }
    try {
      const ollama = cfg.providers["ollama"];
      if (ollama?.base_url) {
        const res = await fetch(`${ollama.base_url.replace(/\/+$/, "")}/models`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) ok(`ollama reachable at ${ollama.base_url}`);
        else warn(`ollama responded ${res.status} at ${ollama.base_url}`);
      }
    } catch {
      warn(`ollama not reachable (${cfg.providers["ollama"]?.base_url ?? "unset"})`);
    }
  } catch (err) {
    bad(`config load failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  process.stdout.write(
    failures === 0
      ? green("\ndoctor: all checks passed\n")
      : red(`\ndoctor: ${failures} failure(s)\n`),
  );
  if (failures > 0) process.exitCode = 1;
}

/** Accept 8-char prefixes for session ids in CLI commands. */
function resolveSessionPrefix(server: AgentServer, partial: string | undefined): string | undefined {
  if (!partial) return undefined;
  const list = server.store.listSessions();
  const exact = list.find((s) => s.id === partial);
  if (exact) return exact.id;
  const matches = list.filter((s) => s.id.startsWith(partial));
  if (matches.length === 1) return matches[0]?.id ?? undefined;
  if (matches.length > 1) fail(`ambiguous session id prefix: ${partial} (${matches.length} matches)`);
  fail(`session not found: ${partial}`);
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { flags, positionals } = parseArgs(argv);
  const command = positionals[0] ?? "";

  const rest = positionals.slice(1);

  try {
    switch (command) {
      case "":
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        break;
      case "--version":
      case "version":
        process.stdout.write(`familiar ${readVersion()}\n`);
        break;
      case "run":
        await cmdRun(flags, rest);
        break;
      case "chat":
        await cmdChat(flags);
        break;
      case "serve":
        await cmdServe(flags);
        break;
      case "sessions":
        await cmdSessions(flags, rest);
        break;
      case "model":
        await cmdModel(flags, rest);
        break;
      case "memory":
        await cmdMemory(flags, rest);
        break;
      case "skills":
        await cmdSkills(flags, rest);
        break;
      case "curator":
        await cmdCurator(flags, rest);
        break;
      case "mcp":
        await cmdMcp(flags);
        break;
      case "worktree":
        await cmdWorktree(flags, rest, resolveCwd(flags));
        break;
      case "init":
        await cmdInit();
        break;
      case "doctor":
        await cmdDoctor();
        break;
      default:
        fail(`unknown command: ${command}\n${USAGE}`);
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

await main();
