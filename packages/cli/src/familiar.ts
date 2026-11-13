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
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import https from "node:https";
import type { AgentEvent, ChatMessage, ModelInfo, SessionRecord } from "@familiar/protocol";
import {
  CONFIG_TEMPLATE,
  loadConfig,
  familiarPaths,
  describeAuthSource,
  resolveServerAuthToken,
  writeServerAuthConfig,
  defaultAuthTokenFile,
  ProviderRegistry,
  SqliteSessionStore,
  ensureDir,
  log,
  type ApprovalAdapter,
} from "@familiar/core";
import { AgentServer, startHttpTransport } from "@familiar/server";
import { createPrettyPrinter, createJsonPrinter, ansi, useColor } from "./ui/display.js";
import { FullScreenTui, type TuiModelGroup } from "./ui/tui.js";
import { CliApprovalAdapter, TuiApprovalAdapter } from "./ui/approvals.js";
import { RemoteFamiliarClient } from "./client/remote.js";
import { cmdWorktree } from "./worktree.js";

const USAGE = `familiar — OpenCode/Claude Code-style agent harness (CLI)

Usage:
  familiar                            # open the interactive chat (TUI) on a terminal
  familiar run [-p "prompt"] [--provider ID] [--model ID] [--effort low|medium|high]
            [--session ID] [--cwd DIR] [--max-steps N] [-y] [--plan] [--json] [--title S]
  familiar chat [--session ID] [--provider ID] [--model ID] [--effort low|medium|high]
             [--cwd DIR] [-y]
             # TTY opens the full-screen TUI; --line keeps the classic REPL
  familiar serve [--port N] [--bind ADDR] [--config PATH]
              [--token-file PATH] [--print-ready]
  familiar update [--check] [--forgejo URL] [--repo SLUG]
                        # self-update from release assets (install.sh installs)
  familiar token [--write] [--clear]   # M2 bearer token for familiar serve
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
  "--effort",
  "--config",
  "--cwd",
  "--session",
  "--max-steps",
  "--port",
  "--bind",
  "--token-file",
  "--profile",
  "--title",
  "--server",
  "--root",
  "--forgejo",
  "--repo",
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
  "--print-ready",
  "--check",
  "--force",
  "--consolidate",
  "--dry-run",
  "--write",
  "--clear",
  "--version",
  "-V",
  "--line",
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
  approval?: ApprovalAdapter,
): Promise<{
  transport: FamiliarTransport;
  setJsonServerSink?: (sink: (ev: AgentEvent) => void) => void;
  close?: () => void;
}> {
  if (flagBool(flags, "local")) {
    const server = new AgentServer({
      config: cfg,
      approval: approval ?? (interactive ? new CliApprovalAdapter() : undefined),
    });
    return { transport: localTransport(server) };
  }
  const baseUrl = flag(flags, "server") ?? `http://${cfg.server.bind}:${cfg.server.port}`;
  // M2: remote mode sends the configured bearer token when the server has
  // server.auth_token_file set. A missing local token file is only a warning
  // here (the server stays fail-closed) — the server answers 401 otherwise.
  const authToken = resolveClientToken(cfg);
  if (await RemoteFamiliarClient.probe(baseUrl, 700, authToken)) {
    let sink: ((ev: AgentEvent) => void) | undefined = serverEventPrettyPrinter();
    const approvalAd = approval ?? (interactive ? new CliApprovalAdapter() : undefined);
    const client = new RemoteFamiliarClient(
      baseUrl,
      approvalAd
        ? (req) => approvalAd.request({ tool: req.tool, summary: req.summary, detail: req.detail })
        : undefined,
      (ev) => sink?.(ev),
      authToken,
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
    approval: approval ?? (interactive ? new CliApprovalAdapter() : undefined),
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
      profile: flag(flags, "profile"),
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
        effort: flag(flags, "effort"),
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

  const modeLabel = (): string => (flagBool(flags, "plan") ? "plan" : "build");
  const banner = (): void => {
    const prov = session
      ? `${session.provider}/${session.model}`
      : `${providerId(flags) ?? cfg.default_provider}/${modelId(flags) ?? "default"}`;
    const lines = [
      "",
      `  ${cyan("◍ Familiar Harness")} ${dim(`v${readVersion()}`)}`,
      dim("  ────────────────────────────────────────────"),
      `  ${dim("cwd")}      ${session?.cwd ?? cwd}`,
      `  ${dim("model")}    ${prov}`,
      session ? `  ${dim("session")}  ${session.id.slice(0, 8)}` : dim("  session  (created on first message)"),
      dim("  /help for commands · /exit to quit · Tab completes /commands and @files"),
      "",
    ];
    process.stdout.write(lines.join("\n") + "\n");
  };
  banner();
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ensureSession = async (): Promise<SessionRecord> => {
    if (session) return session;
    const created = (await transport.dispatch("session.create", {
      provider: providerId(flags),
      model: modelId(flags),
      cwd,
      profile: flag(flags, "profile"),
    })) as SessionRecord;
    session = created;
    process.stdout.write(
      `${dim("●")} ${dim(`session ${created.id.slice(0, 8)} · ${created.provider}/${created.model}`)}\n`,
    );
    return created;
  };

  const promptText = (): string => `${dim(modeLabel())} ${cyan("❯")} `;
  rl.setPrompt(promptText());
  rl.prompt();
  let busy = false;
  const pending: string[] = [];
  rl.on("line", (line: string) => {
    pending.push(line.trim());
    void drain();
  });

  /** Serialize input: turns and commands never overlap (queued, not dropped). */
  async function drain(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (pending.length > 0) {
        const next = pending.shift() ?? "";
        try {
          await handleLine(next);
        } catch (err) {
          process.stderr.write(red(`error: ${err instanceof Error ? err.message : String(err)}\n`));
        }
      }
    } finally {
      busy = false;
      rl.prompt();
    }
  }
  rl.on("close", () => {
    process.stdout.write("\nbye\n");
    process.exit(0);
  });

  let lastUser = "";

  async function sendToAgent(text: string): Promise<void> {
    const s = await ensureSession();
    const printer = createPrettyPrinter();
    await transport.dispatch(
      "session.send",
      {
        id: s.id,
        text,
        yolo: flagBool(flags, "yolo"),
        plan: flagBool(flags, "plan"),
        effort: flag(flags, "effort"),
      },
      { onEvent: (ev) => printer(ev) },
    );
    lastUser = text;
  }

  async function handleLine(line: string): Promise<void> {
    if (line === "" || line.startsWith("#")) {
        /* ignore empty lines / comments */
      } else if (line === "/exit" || line === "/quit" || line === "/q") {
        rl.close();
        return;
      } else if (line === "/help") {
        process.stdout.write(
          dim(
            "commands:\n" +
              "  /new                 new session with the configured defaults\n" +
              "  /sessions           list recent sessions\n" +
              "  /session <id>       switch to a session\n" +
              "  /models [p/m]      pick provider/model (list popup in the TUI)\n" +
              "  /effort [l|m|h|off] reasoning effort (low/medium/high)\n" +
              "  /cwd <path>         change the session working folder\n" +
              "  /todo               show the session task list\n" +
              "  /plan [off]         toggle plan mode\n" +
              "  /retry              resend the previous message\n" +
              "  /compact            summarize and shrink the context now\n" +
              "  /export [file]      dump the transcript as markdown\n" +
              "  /clear              clear the screen\n" +
              "  /exit               quit\n" +
              "(any other text is sent to the agent)\n",
          ),
        );
      } else if (line === "/clear") {
        process.stdout.write("\x1b[2J\x1b[H");
      } else if (line === "/retry") {
        if (!lastUser) {
          process.stderr.write(red("nothing to retry\n"));
        } else {
          await sendToAgent(lastUser);
        }
      } else if (line === "/todo") {
        if (!session) {
          process.stderr.write(red("no session yet\n"));
        } else {
          const res = (await transport.dispatch("todo.list", { id: session.id })) as {
            items: Array<{ title: string; status: string }>;
          };
          if ((res.items ?? []).length === 0) {
            process.stdout.write(dim("(no todos)\n"));
          }
          for (const it of res.items ?? []) {
            const icon = it.status === "done" ? "●" : it.status === "in_progress" ? "◐" : "○";
            const strike = it.status === "done" ? "~~" : "";
            process.stdout.write(`${icon} ${strike}${it.title}${strike}\n`);
          }
        }
      } else if (line === "/compact") {
        if (!session) {
          process.stderr.write(red("no session yet\n"));
        } else {
          const res = (await transport.dispatch("session.compact", { id: session.id })) as {
            compacted: boolean;
            dropped: number;
            kept: number;
          };
          process.stdout.write(
            dim(
              res.compacted
                ? `compacted: dropped ${res.dropped} message(s), kept ${res.kept}\n`
                : "nothing to compact\n",
            ),
          );
        }
      } else if (line.startsWith("/cwd")) {
        const value = line.slice("/cwd".length).trim();
        if (!session) {
          process.stderr.write(red("no session yet\n"));
        } else if (!value) {
          process.stdout.write(dim(`${session.cwd}\n`));
        } else {
          const updated = (await transport.dispatch("session.update", {
            id: session.id,
            cwd: value,
          })) as SessionRecord;
          session = updated;
          process.stdout.write(dim(`(cwd: ${updated.cwd})\n`));
        }
      } else if (line.startsWith("/export")) {
        if (!session) {
          process.stderr.write(red("no session yet\n"));
        } else {
          const file = line.slice("/export".length).trim();
          const text = await transcriptMarkdown(transport, session.id);
          if (file) {
            const fs = await import("node:fs");
            fs.writeFileSync(file, text, "utf8");
            process.stdout.write(dim(`(exported to ${file})\n`));
          } else {
            process.stdout.write(text + "\n");
          }
        }
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
        process.stdout.write(dim(`(mode: ${modeLabel()})\n`));
      } else if (line.startsWith("/effort")) {
        const value = line.slice("/effort".length).trim().toLowerCase();
        if (value === "" || value === "default" || value === "off") {
          delete flags["effort"];
          if (session) {
            await transport.dispatch("session.update", { id: session.id, effort: "" });
          }
          process.stdout.write(dim(`(effort: provider default)\n`));
        } else if (value === "low" || value === "medium" || value === "high") {
          flags["effort"] = value;
          if (session) {
            await transport.dispatch("session.update", { id: session.id, effort: value });
          }
          process.stdout.write(dim(`(effort: ${value})\n`));
        } else {
          process.stderr.write(red("usage: /effort low|medium|high|off\n"));
        }
      } else if (line.startsWith("/model")) {
        const value = (line.startsWith("/models") ? line.slice("/models".length) : line.slice("/model".length)).trim();
        if (!session && !value) {
          const s = await ensureSession();
          process.stdout.write(dim(`(model: ${s.provider}/${s.model})\n`));
        } else if (!value) {
          process.stdout.write(dim(`(model: ${session!.provider}/${session!.model})\n`));
        } else if (value === "reset") {
          session = null;
          delete flags["model"];
          const s = await ensureSession();
          process.stdout.write(dim(`(model: ${s.provider}/${s.model})\n`));
        } else {
          const [provider, model] = value.includes("/") ? value.split("/", 2) : [session?.provider, value];
          const updated = (await transport.dispatch("session.update", {
            id: (session ?? (await ensureSession())).id,
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
          })) as SessionRecord;
          session = updated;
          process.stdout.write(dim(`(model: ${updated.provider}/${updated.model})\n`));
        }
      } else if (line.startsWith("/")) {
        process.stderr.write(red(`unknown chat command: ${line} (try /help)\n`));
      } else {
        await sendToAgent(line);
      }
  }
}

/**
 * Full-screen TUI chat (OpenCode-style). Shares the line-REPL command set;
 * output lands in transcript blocks instead of stdout.
 */
async function cmdTui(flags: Record<string, string | boolean>): Promise<void> {
  const cwd = resolveCwd(flags);
  const cfg = loadCliConfig(flags);
  const readlineMod = await import("node:readline");

  // build the TUI first so tool approvals surface in the prompt panel
  // (the readline prompt would fight the alt-screen over stdin)
  const tui = new FullScreenTui();
  const { transport } = await openRunTransport(
    flags,
    cfg,
    true,
    false,
    false,
    new TuiApprovalAdapter((req) => tui.requestApproval(req)),
  );

  let session: SessionRecord | null = null;
  if (flag(flags, "session")) {
    const id = flag(flags, "session")!;
    const got = (await transport.dispatch("session.get", { id })) as { session: SessionRecord };
    session = got.session;
  } else if (flagBool(flags, "continue")) {
    const list = (await transport.dispatch("session.list", {})) as SessionRecord[];
    session = list.find((s) => s.cwd === cwd) ?? null;
  }

  const modeOf = (): "build" | "plan" => (flagBool(flags, "plan") ? "plan" : "build");
  /** Tab (with no popup open) toggles Build/Plan like opencode's agent switch. */
  tui.onModeToggle = (): void => {
    if (flagBool(flags, "plan")) delete flags["plan"];
    else flags["plan"] = true;
    const mode = modeOf();
    tui.setSessionInfo({ mode });
    tui.toast(`agent: ${mode}`);
  };
  const sessionBits = (s: SessionRecord): void => {
    tui.setSessionInfo({
      title: s.title || s.id.slice(0, 8),
      sessionId: s.id,
      provider: s.provider || providerId(flags) || cfg.default_provider,
      model: s.model || "-",
      mode: modeOf(),
      effort: s.effort || flag(flags, "effort") || "",
      cwd: s.cwd || cwd,
    });
  };
  if (session) {
    const got = (await transport.dispatch("session.get", { id: session.id })) as {
      session: SessionRecord;
      messages: ChatMessage[];
    };
    session = got.session;
    tui.loadHistory(got.messages ?? []);
  }
  sessionBits(
    session ?? {
      id: "",
      title: "",
      provider: providerId(flags) ?? cfg.default_provider,
      model: modelId(flags) ?? cfg.default_model ?? "-",
      cwd,
      createdAt: 0,
      updatedAt: 0,
    },
  );

  tui.start();

  let lastUser = "";
  const pending: string[] = [];
  let busy = false;
  let quitting = false;

  const cleanup = (): void => {
    tui.stop();
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(false);
  };
  const quit = (): void => {
    cleanup();
    process.stdout.write("\nbye\n");
    process.exit(0);
  };

  const ensureSession = async (): Promise<SessionRecord> => {
    if (session) return session;
    const created = (await transport.dispatch("session.create", {
      provider: providerId(flags),
      model: modelId(flags),
      cwd,
      profile: flag(flags, "profile"),
    })) as SessionRecord;
    session = created;
    sessionBits(created);
    return created;
  };

  /** hook from the /models popup: set provider/model like /model <p/m>. */
  tui.onModelPick = async (provider: string, model: string): Promise<void> => {
    try {
      const updated = (await transport.dispatch("session.update", {
        id: (session ?? (await ensureSession())).id,
        provider,
        model,
      })) as SessionRecord;
      session = updated;
      sessionBits(updated);
      tui.toast(`model: ${provider}/${model}`);
    } catch (err) {
      tui.toast(`✖ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** hook from the /sessions popup: switch to another session. */
  tui.onSessionPick = async (id: string): Promise<void> => {
    try {
      const got = (await transport.dispatch("session.get", { id })) as {
        session: SessionRecord;
        messages: ChatMessage[];
      };
      session = got.session;
      tui.clearTranscript();
      tui.loadHistory(got.messages ?? []);
      sessionBits(session);
      tui.toast(`session: ${session.title || session.id.slice(0, 8)}`);
    } catch (err) {
      tui.toast(`✖ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Esc while streaming: abort the running turn (opencode "esc stop"). */
  tui.onAbortTurn = (): void => {
    if (!session) return;
    void transport.dispatch("session.abort", { id: session.id }).catch(() => {});
  };

  /** Progressive model catalog: one models.list per configured provider
   * (same pattern as the settings GUI). Groups arrive over time; each result
   * is merged into the picker while it stays open. */
  const loadModelsCatalog = (): void => {
    const names = Object.keys(cfg.providers ?? {}).sort((a, b) =>
      a === cfg.default_provider ? -1 : b === cfg.default_provider ? 1 : a.localeCompare(b),
    );
    if (names.length === 0) {
      tui.toast("no providers configured");
      return;
    }
    const groups = new Map<string, TuiModelGroup>();
    const push = (provider: string, g: TuiModelGroup): void => {
      groups.set(provider, g);
      tui.setModelGroups(names.map((n) => groups.get(n) ?? { provider: n, models: [] }));
    };
    for (const provider of names) {
      void (transport.dispatch("models.list", { provider }) as Promise<{ models?: ModelInfo[]; error?: string }>)
        .then((res) =>
          push(provider, {
            provider,
            models: (res.models ?? []).map((m) => ({
              provider,
              id: m.id,
              ...(m.contextTokens !== undefined ? { contextTokens: m.contextTokens } : {}),
            })),
            error: res.error,
          }),
        )
        .catch((err: unknown) =>
          push(provider, { provider, models: [], error: err instanceof Error ? err.message : String(err) }),
        );
    }
  };

  const refreshSession = async (): Promise<void> => {
    if (!session) return;
    try {
      const got = (await transport.dispatch("session.get", { id: session.id })) as {
        session: SessionRecord;
      };
      session = got.session;
      sessionBits(got.session);
    } catch {
      /* keep the last known info */
    }
  };

  async function sendToAgent(text: string): Promise<void> {
    const s = await ensureSession();
    await transport.dispatch(
      "session.send",
      {
        id: s.id,
        text,
        yolo: flagBool(flags, "yolo"),
        plan: flagBool(flags, "plan"),
        effort: flag(flags, "effort"),
      },
      { onEvent: (ev) => tui.printer(ev) },
    );
    lastUser = text;
  }

  async function handleLine(line: string): Promise<void> {
    if (line === "" || line.startsWith("#")) return;
    const die = (msg: string): void => tui.setInfo(`✖ ${msg}`);
    if (line === "/exit" || line === "/quit" || line === "/q") {
      quit();
      return;
    }
    if (line === "/help") {
      tui.setInfo(
        [
          "commands:  (type / or ctrl+p for the palette — ↑/↓ select, Tab complete, ↵ run)",
          "  /new            new session with the configured defaults",
          "  /sessions       switch session from a list (or /session <id>)",
          "  /models [p/m]   pick provider/model (list popup; keeps /model alias)",
          "  /rename <name>  rename this session",
          "  /effort l|m|h|off  reasoning effort (low/medium/high)",
          "  /cwd <path>     change the session working folder",
          "  /todo           show the session task list",
          "  /plan [off]     toggle plan mode",
          "  /retry          resend the previous message",
          "  /compact        summarize and shrink the context now",
          "  /export <file>  dump the transcript as markdown",
          "  /clear          clear the transcript",
          "  /exit           quit",
          "(Tab switches build/plan when the popup is closed; any other text is sent)",
        ].join("\n"),
      );
      return;
    }
    if (line === "/clear") {
      tui.clearTranscript();
      return;
    }
    if (line === "/retry") {
      if (!lastUser) die("nothing to retry");
      else await sendToAgent(lastUser);
      return;
    }
    if (line === "/todo") {
      if (!session) {
        die("no session yet");
        return;
      }
      const res = (await transport.dispatch("todo.list", { id: session.id })) as {
        items: Array<{ title: string; status: string }>;
      };
      if ((res.items ?? []).length === 0) {
        tui.setInfo("(no todos)");
        return;
      }
      tui.setInfo(
        (res.items ?? [])
          .map((it) => {
            const icon = it.status === "done" ? "●" : it.status === "in_progress" ? "◐" : "○";
            const strike = it.status === "done" ? " ~" : "";
            return `${icon} ${it.title}${strike}`;
          })
          .join("\n"),
      );
      return;
    }
    if (line === "/compact") {
      if (!session) {
        die("no session yet");
        return;
      }
      const res = (await transport.dispatch("session.compact", { id: session.id })) as {
        compacted: boolean;
        dropped: number;
        kept: number;
      };
      tui.setInfo(
        res.compacted
          ? `compacted: dropped ${res.dropped} message(s), kept ${res.kept}`
          : "nothing to compact",
      );
      return;
    }
    if (line.startsWith("/cwd")) {
      const value = line.slice("/cwd".length).trim();
      if (!session) {
        die("no session yet");
      } else if (!value) {
        tui.setInfo(`cwd: ${session.cwd}`);
      } else {
        const updated = (await transport.dispatch("session.update", {
          id: session.id,
          cwd: value,
        })) as SessionRecord;
        session = updated;
        sessionBits(updated);
        tui.setInfo(`cwd: ${updated.cwd}`);
      }
      return;
    }
    if (line.startsWith("/export")) {
      if (!session) {
        die("no session yet");
        return;
      }
      const file = line.slice("/export".length).trim();
      if (!file) {
        tui.setInfo("usage: /export <file>");
        return;
      }
      const text = await transcriptMarkdown(transport, session.id);
      const fs = await import("node:fs");
      fs.writeFileSync(file, text, "utf8");
      tui.setInfo(`exported to ${file}`);
      return;
    }
    if (line === "/new") {
      session = null;
      const s = await ensureSession();
      tui.setInfo(`new session ${s.id.slice(0, 8)}`);
      return;
    }
    if (line.startsWith("/sessions")) {
      if (line.trim() === "/sessions") {
        // opencode-style dialog: recent sessions in a picker
        const list = (await transport.dispatch("session.list", {})) as SessionRecord[];
        tui.openSessionsPopup(
          list.slice(0, 20).map((s) => ({
            id: s.id,
            title: s.title ?? "",
            provider: s.provider ?? "",
            model: s.model ?? "",
            cwd: s.cwd ?? "",
            updatedAt: s.updatedAt ?? 0,
          })),
        );
      } else {
        const list = (await transport.dispatch("session.list", {})) as SessionRecord[];
        tui.setInfo(
          ["sessions:", ...list.slice(0, 10).map((s) => `  ${s.id.slice(0, 8)}  ${s.provider}/${s.model}  ${s.title || "(untitled)"}`)].join("\n"),
        );
      }
      return;
    }
    if (line.startsWith("/rename")) {
      const name = line.slice("/rename".length).trim();
      if (name === "") {
        tui.toast("usage: /rename <title>");
        return;
      }
      const updated = (await transport.dispatch("session.update", {
        id: (session ?? (await ensureSession())).id,
        title: name,
      })) as SessionRecord;
      session = updated;
      sessionBits(updated);
      tui.toast(`renamed: ${name}`);
      return;
    }
    if (line.startsWith("/session ")) {
      const id = line.slice("/session ".length).trim();
      const got = (await transport.dispatch("session.get", { id })) as { session: SessionRecord };
      session = got.session;
      tui.clearTranscript();
      const all = (await transport.dispatch("session.get", { id })) as {
        messages: ChatMessage[];
      };
      tui.loadHistory(all.messages ?? []);
      sessionBits(session);
      return;
    }
    if (line.startsWith("/plan")) {
      const value = line.slice("/plan".length).trim();
      if (value === "off") delete flags["plan"];
      else flags["plan"] = true;
      tui.setSessionInfo({ mode: modeOf() });
      return;
    }
    if (line.startsWith("/effort")) {
      const value = line.slice("/effort".length).trim().toLowerCase();
      if (value === "" || value === "default" || value === "off") {
        delete flags["effort"];
        if (session) {
          await transport.dispatch("session.update", { id: session.id, effort: "" });
        }
        tui.setInfo("effort: provider default");
        return;
      }
      if (value === "low" || value === "medium" || value === "high") {
        flags["effort"] = value;
        if (session) {
          await transport.dispatch("session.update", { id: session.id, effort: value });
        }
        tui.setInfo(`effort: ${value}`);
        return;
      }
      die("usage: /effort low|medium|high|off");
      return;
    }
    if (line.startsWith("/model")) {
      const value = (line.startsWith("/models") ? line.slice("/models".length) : line.slice("/model".length)).trim();
      if (value === "reset") {
        session = null;
        delete flags["model"];
        const s = await ensureSession();
        sessionBits(s);
        return;
      }
      if (value) {
        const [provider, model] = value.includes("/") ? value.split("/", 2) : [session?.provider, value];
        const updated = (await transport.dispatch("session.update", {
          id: (session ?? (await ensureSession())).id,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        })) as SessionRecord;
        session = updated;
        sessionBits(updated);
        tui.toast(`model: ${updated.provider}/${updated.model}`);
        return;
      }
      // no argument → open the model picker (opencode-style dialog)
      void loadModelsCatalog();
      tui.openModelsPopup();
      return;
    }
    if (line.startsWith("/")) {
      die(`unknown chat command: ${line} (try /help)`);
      return;
    }
    await sendToAgent(line);
  }

  /** Serialize queued lines like the line REPL does. */
  async function drain(): Promise<void> {
    if (busy) return;
    busy = true;
    tui.setBusy(true);
    try {
      while (pending.length > 0) {
        const next = pending.shift() ?? "";
        try {
          await handleLine(next);
        } catch (err) {
          tui.setInfo(`✖ ${err instanceof Error ? err.message : String(err)}`);
        }
        void refreshSession();
      }
    } finally {
      busy = false;
      tui.setBusy(false);
    }
  }

  // ---- raw input decoding (keys, mouse wheel SGR) ------------------------
  const StringDecoder = (await import("node:string_decoder")).StringDecoder;
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  // bracketed paste (mode 2004, enabled by tui.start())
  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";
  let inPaste = false;
  let pasteBuf = "";
  const submit = (line: string): void => {
    const trimmed = line.trim();
    pending.push(trimmed);
    if (trimmed !== "" && !trimmed.startsWith("/")) tui.setUserLine(trimmed);
    void drain();
  };

  const onData = (chunk: Buffer | string): void => {
    if (quitting) return;
    if (escTimer) {
      clearTimeout(escTimer); // new bytes complete the escape sequence
      escTimer = null;
    }
    let buf = carry + decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    carry = "";
    // Extract bracketed-paste segments first (terminals wrap pastes between
    // "ESC[200~ … ESC[201~"; the markers can split across chunks).
    while (true) {
      if (inPaste) {
        const end = buf.indexOf("\x1b[201~");
        if (end === -1) {
          pasteBuf += buf;
          buf = "";
          break;
        }
        pasteBuf += buf.slice(0, end);
        buf = buf.slice(end + PASTE_END.length);
        tui.pasteText(pasteBuf);
        pasteBuf = "";
        inPaste = false;
        continue;
      }
      const start = buf.indexOf(PASTE_START);
      if (start === -1) break;
      const head = buf.slice(0, start);
      buf = buf.slice(start + PASTE_START.length);
      inPaste = true;
      pasteBuf = "";
      if (head !== "") feedKeys(head);
    }
    if (buf !== "" && !inPaste) feedKeys(buf);
  };

  /** Decode one chunk of keystrokes (escape sequences, mouse, control codes). */
  const feedKeys = (inData: string): void => {
    let data = inData;
    // hold back a trailing incomplete escape sequence (or bare ESC)
    const escIdx = data.lastIndexOf("\x1b");
    carry = "";
    if (escIdx !== -1) {
      const tail = data.slice(escIdx);
      const incomplete =
        tail.length === 1 ||
        (tail[1] === "[" && /[[0-9;<>]$/.test(tail)) ||
        (tail[1] === "O" && tail.length === 2);
      if (incomplete) {
        carry = tail;
        data = data.slice(0, escIdx);
      }
    }
    for (let i = 0; i < data.length; ) {
      if (data[i] === "\x1b" && i + 1 < data.length) {
        const rest = data.slice(i);
        const seq = /^(\x1b\[<(\d+);(\d+);(\d+)([Mm]))/.exec(rest);
        if (seq && seq[1]) {
          const btn = Number(seq[2]);
          const col = Number(seq[3]);
          const row = Number(seq[4]);
          const isRelease = seq[5] === "m";
          if (btn >= 64) {
            tui.wheel(seq[1]); // 64/65 = wheel up/down (SGR 1006)
          } else if (!isRelease && btn <= 2) {
            const line = tui.click(row, col - 1);
            if (line) submit(line);
          }
          i += seq[1].length;
          continue;
        }
        const isMouseLike = /^\x1b\[[<\d;]/.exec(rest);
        const named = /^(\x1b(?:\[([A-DHZ])|(\d(?:~)?)|O([A-D])))/.exec(rest);
        if (named && named[0]) {
          const code = named[2] ?? named[4];
          const tilde = named[3];
          let name: string | null = null;
          if (code === "A") name = "up";
          else if (code === "B") name = "down";
          else if (code === "H") name = "home";
          else if (code === "F") name = "end";
          else if (code === "Z") name = "tab"; // Shift-Tab ≙ Tab
          else if (tilde === "1") name = "home";
          else if (tilde === "4") name = "end";
          else if (tilde === "5") name = "pageup";
          else if (tilde === "6") name = "pagedown";
          if (name) {
            const r = tui.key({ name });
            if (r !== null) submit(r);
          }
          i += named[0].length;
          continue;
        }
        if (!isMouseLike) {
          // bare ESC: close any popup (opencode dialogs)
          const r = tui.key({ name: "escape" });
          void r;
        }
        i += isMouseLike ? rest.length : 1;
        continue;
      }
      const ch = data[i]!;
      const code = data.codePointAt(i)!;
      let consumed = ch.codePointAt(0)! > 0xffff ? 2 : 1;
      if (code === 27) {
        i += 1;
        continue;
      }
      if (code === 3) {
        // route through the TUI: two ctrl+c within 2s quit (first shows a hint)
        const r = tui.key({ ctrl: true, name: "c" });
        if (r !== null) {
          quitting = true;
          cleanup();
          process.stdout.write("\nbye\n");
          process.exit(0);
        }
        i += consumed;
        continue;
      }
      if (code === 21) {
        tui.clearInput(); // Ctrl+U: clear the editor
        i += consumed;
        continue;
      }
      if (code === 16) {
        const r = tui.key({ name: "p", ctrl: true }); // Ctrl+P: command palette
        if (r !== null) submit(r);
        i += consumed;
        continue;
      }
      if (code === 12) {
        tui.repaint();
        i += consumed;
        continue;
      }
      if (code === 127 || code === 8) {
        const r = tui.key({ name: "backspace" });
        void r;
        i += consumed;
        continue;
      }
      if (code === 13 || code === 10) {
        const line = tui.key({ name: "return" });
        if (line !== null) submit(line);
        i += consumed;
        continue;
      }
      if (code === 9) {
        const r = tui.key({ name: "tab" }); // accept suggestion / toggle mode
        if (r !== null) submit(r);
        i += consumed;
        continue;
      }
      const r = tui.key({ sequence: data.slice(i, i + consumed) });
      if (r !== null) submit(r);
      i += consumed;
    }
    if (carry === "\x1b") {
      // a lone ESC is ambiguous (alt-keys vs escape); treat as escape after a beat
      if (escTimer) clearTimeout(escTimer);
      escTimer = setTimeout(() => {
        escTimer = null;
        if (carry === "\x1b" && !quitting) {
          carry = "";
          tui.key({ name: "escape" });
        }
      }, 40);
    }
  };
  process.stdin.on("data", onData);
  const onResize = (): void => {
    tui.repaint();
  };
  process.on("SIGWINCH", onResize);

  if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
  process.stdin.resume();

  await new Promise<never>(() => {
    /* TUI owns the process; exits via Ctrl+C / /exit */
  });
}

/** Build a markdown transcript of a session (/export in the REPL). */
async function transcriptMarkdown(
  transport: FamiliarTransport,
  sessionId: string,
): Promise<string> {
  const got = (await transport.dispatch("session.get", { id: sessionId })) as {
    session: SessionRecord;
    messages: ChatMessage[];
  };
  const s = got.session;
  const out: string[] = [
    `# ${s.title || s.id.slice(0, 8)}`,
    "",
    `- provider: ${s.provider}${s.model ? `/${s.model}` : ""}`,
    `- created: ${new Date(s.createdAt).toISOString()}`,
    "",
  ];
  for (const m of got.messages ?? []) {
    if ((m.meta as { ephemeral?: boolean } | undefined)?.ephemeral === true) continue;
    if (m.role === "user") {
      out.push("## User", "", m.content ?? "", "");
    } else if (m.role === "assistant") {
      out.push("## Assistant", "", m.content ?? "", "");
    } else {
      out.push(`### ${m.name ?? "tool"}`, "", "```", String(m.content ?? "").slice(0, 4000), "```", "");
    }
  }
  return out.join("\n");
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
  const cfg = loadCliConfig(flags);
  const port = toNumber(flag(flags, "port")) ?? cfg.server.port;
  const bind = typeof flag(flags, "bind") === "string" ? (flag(flags, "bind") as string) : cfg.server.bind;
  // M2: fail closed — a configured-but-unreadable token file aborts startup.
  // `--token-file` lets a desktop client hand the remote server a per-tunnel
  // token file (never passed as an argument value that shows up in argv).
  const tokenFileFlag = typeof flag(flags, "token-file") === "string" ? (flag(flags, "token-file") as string) : undefined;
  const authTokenFile = tokenFileFlag ?? cfg.server.auth_token_file;
  const printReady = flagBool(flags, "print-ready");
  const authToken = resolveServerAuthToken(authTokenFile);
  const server = new AgentServer({ config: cfg, rpcApprovals: true });
  const transport = await startHttpTransport(server, {
    port,
    bind,
    version: readVersion(),
    authToken,
    authTokenFile: authTokenFile ? path.resolve(authTokenFile.replace(/^~(?=$|[\\/])/, os.homedir())) : undefined,
    onTunnelStop: (stopId) => server.stopTunnel(stopId),
  });
  if (printReady) {
    // One machine-readable line for remote launchers (desktop SSH connect):
    // the actual bound port is essential with --port 0.
    const boundPort = Number.parseInt(new URL(transport.url).port, 10) || port;
    process.stdout.write(
      `FAMILIAR_READY ${JSON.stringify({ url: transport.url, port: boundPort, tokenFile: authTokenFile })}\n`,
    );
  }
  await server.mcpReady();
  server.startCuratorScheduler();
  server.startCronScheduler();
  server.startUploadPruner();
  if (!printReady) {
    process.stdout.write(cyan(`familiar server listening on ${transport.url}\n`));
    process.stdout.write(dim(`  rpc:   POST ${transport.url}/rpc\n  events: WS ${transport.url}/ws\n  ui:    GET ${transport.url}/\n`));
    if (authToken) {
      process.stdout.write(dim(`  auth:  bearer token required (file: ${authTokenFile})\n`));
    } else {
      process.stdout.write(dim(`  auth:  off — only bind to a trusted network or set server.auth_token_file\n`));
    }
  }
  const mcpServers = printReady ? [] : (server.mcp?.status() ?? []);
  if (mcpServers.length > 0) {
    const ready = mcpServers.filter((s) => s.state === "ok").length;
    process.stdout.write(dim(`  mcp:   ${ready}/${mcpServers.length} server(s) up, ${mcpServers.reduce((n, s) => n + s.tools.length, 0)} tool(s)\n`));
  }
  const cronJobs = printReady ? 0 : (server.cronScheduler?.status().jobs.length ?? 0);
  if (cronJobs > 0) {
    process.stdout.write(dim(`  cron:  ${cronJobs} job(s) scheduled\n`));
  }
  if (!printReady) process.stdout.write(dim("  press Ctrl+C to stop\n"));
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

/** Numeric semver triple compare: >0 when a is newer, <0 older, 0 equal. */
function compareSemver(a: string, b: string): number {
  const triple = (v: string): [number, number, number] => {
    const [nums] = v.split("-");
    const parts = (nums ?? "").split(".").map((n) => Number.parseInt(n, 10));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [pa, pb] = [triple(a), triple(b)];
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

interface UpdateRelease {
  tag_name?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

/**
 * GET a URL as a buffer, tolerating self-signed CAs on the second try
 * (self-hosted Forgejo instances). Prefer NODE_EXTRA_CA_CERTS for a trusted
 * setup; FAMILIAR_TLS_STRICT=1 disables the fallback.
 */
async function httpGet(url: string): Promise<{ ok: boolean; status: number; buffer: Buffer }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    return { ok: res.ok, status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    const code = String((err as { cause?: { code?: string } }).cause?.code ?? "");
    if (!/CERT|SSL|TLS/i.test(code) || process.env.FAMILIAR_TLS_STRICT === "1") throw err;
    process.stdout.write(
      `warn: TLS verification failed (${code}) — retrying without verification; ` +
        "set NODE_EXTRA_CA_CERTS to trust your CA, or FAMILIAR_TLS_STRICT=1 to abort\n",
    );
    return new Promise((resolve, reject) => {
      const req = https.get(url, { rejectUnauthorized: false }, (res) => {
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
      req.setTimeout(300_000, () => req.destroy(new Error("timeout")));
    });
  }
}

/**
 * `familiar update` — self-update for installs created by install.sh.
 * Resolves the latest Forgejo release with a familiar-*.tar.gz asset, compares
 * versions, then download → verify → swap the install directory (same
 * filesystem, old tree restored if the swap fails midway).
 * Source checkouts must update via `git pull && npm run build`.
 */
async function cmdUpdate(flags: Record<string, string | boolean>): Promise<void> {
  const host = (flag(flags, "forgejo") as string) || process.env.FAMILIAR_FORGEJO || "https://example.invalid:3000";
  const repo = (flag(flags, "repo") as string) || process.env.FAMILIAR_REPO || "owner/familiar-harness";
  const checkOnly = flagBool(flags, "check");
  const current = readVersion();

  // Locate the install root this binary belongs to (~/.local/lib/familiar/…).
  const self = fs.realpathSync(import.meta.url.replace(/^file:\/\//, "")).replace(/\\/g, "/");
  const m = /(.*)\/packages\/cli\/dist\/familiar\.js$/.exec(self);
  if (!m || !fs.existsSync(path.join(m[1] as string, "packages", "server", "public"))) {
    fail(
      "`familiar update` maintains installs created by install.sh. " +
        "This looks like a source checkout — update with `git pull && npm run build`.",
    );
  }
  const lib = m[1] as string;

  const api = `${host}/api/v1/repos/${repo}/releases`;
  process.stdout.write(`checking ${api} …\n`);
  let releases: UpdateRelease[];
  try {
    const res = await httpGet(api);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    releases = JSON.parse(res.buffer.toString("utf8")) as UpdateRelease[];
  } catch (err) {
    fail(`cannot list releases at ${api}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const withAsset = (releases ?? [])
    .filter((r) => (r.assets ?? []).some((a) => /^familiar-.*\.tar\.gz$/.test(a.name ?? "")))
    .sort((a, b) => compareSemver((b.tag_name ?? "").replace(/^v/, ""), (a.tag_name ?? "").replace(/^v/, "")))[0];
  if (!withAsset?.tag_name) fail(`no release with a familiar-*.tar.gz asset at ${api}`);
  const latest = (withAsset.tag_name as string).replace(/^v/, "");
  const asset =
    (withAsset.assets ?? []).find((a) => a.browser_download_url && a.name?.endsWith(`v${latest}.tar.gz`)) ??
    (withAsset.assets ?? []).find((a) => /^familiar-.*\.tar\.gz$/.test(a.name ?? ""));
  if (!asset?.browser_download_url) fail(`release v${latest} has no usable asset URL`);

  if (compareSemver(latest, current) <= 0) {
    process.stdout.write(`familiar ${current} — already up to date (latest release: v${latest})\n`);
    return;
  }
  process.stdout.write(`update available: ${current} -> v${latest}\n`);
  if (checkOnly) {
    process.stdout.write("dry run — re-run without --check to install\n");
    return;
  }

  // Stage on the SAME filesystem as `lib` (rename must not cross devices).
  const stage = `${lib}.update-${process.pid}`;
  const backup = `${lib}.bak-${process.pid}`;
  const tgz = path.join(os.tmpdir(), `familiar-v${latest}.tar.gz`);
  try {
    process.stdout.write(`downloading ${asset.browser_download_url} …\n`);
    const dl = await httpGet(asset.browser_download_url);
    if (!dl.ok) throw new Error(`download failed (HTTP ${dl.status})`);
    fs.writeFileSync(tgz, dl.buffer);

    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["-xzf", tgz, "-C", stage], (err) => (err ? reject(err) : resolve()));
    });
    if (!fs.existsSync(path.join(stage, "packages", "cli", "dist", "familiar.js")) ||
        !fs.existsSync(path.join(stage, "packages", "server", "public"))) {
      throw new Error("extracted tree looks incomplete — refusing to swap");
    }
    const stagedVersion = JSON.parse(
      fs.readFileSync(path.join(stage, "packages", "cli", "package.json"), "utf8"),
    ).version as string;
    if (stagedVersion !== latest) {
      throw new Error(`staged version ${stagedVersion} does not match release v${latest}`);
    }

    process.stdout.write(`swapping ${lib} → v${latest} …\n`);
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(lib, backup);
    try {
      fs.renameSync(stage, lib);
    } catch (err) {
      fs.renameSync(backup, lib); // restore
      throw err;
    }
    // best effort — the tree is already swapped at this point
    try {
      fs.chmodSync(path.join(lib, "packages", "cli", "dist", "familiar.js"), 0o755);
    } catch {
      /* ignore */
    }
    fs.rmSync(backup, { recursive: true, force: true });
    process.stdout.write(`updated: familiar ${current} -> ${latest}\n`);
    process.stdout.write("restart any running `familiar serve` / desktop app to pick it up\n");
  } catch (err) {
    fail(`update failed (install unchanged): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    fs.rmSync(tgz, { force: true });
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  }
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
// server auth token (M2) — `familiar token`
// ---------------------------------------------------------------------------

/**
 * Token for the *client* side of remote mode: `FAMILIAR_SERVER_TOKEN` wins
 * (handy for LAN clients that don't share the server's home dir), otherwise
 * the local config's auth_token_file is read. Missing files warn, not abort —
 * the server remains fail-closed.
 */
function resolveClientToken(cfg: ReturnType<typeof loadCliConfig>): string | undefined {
  const envToken = process.env["FAMILIAR_SERVER_TOKEN"];
  if (envToken) return envToken;
  try {
    return resolveServerAuthToken(cfg.server.auth_token_file);
  } catch (err) {
    log.warn(`server token: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Generate / persist the bearer token used by `familiar serve` (M2).
 *   familiar token            print a fresh token
 *   familiar token --write    write it to the configured token file (0600)
 *                           and enable server.auth_token_file in config.yaml
 *   familiar token --clear     remove the setting (auth off)
 */
async function cmdToken(flags: Record<string, string | boolean>): Promise<void> {
  const cfg = loadCliConfig(flags);
  const write = flagBool(flags, "write");
  const clear = flagBool(flags, "clear");
  if (clear) {
    writeServerAuthConfig(undefined);
    process.stdout.write(dim(`server.auth_token_file cleared — token auth is off\n`));
    return;
  }
  const token = crypto.randomBytes(24).toString("base64url");
  const file = cfg.server.auth_token_file ?? defaultAuthTokenFile();
  if (!write) {
    process.stdout.write(`${token}\n`);
    process.stdout.write(dim(`hint: familiar token --write persists this to ${file} and enables auth\n`));
    return;
  }
  const expanded = file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : file;
  fs.mkdirSync(path.dirname(expanded), { recursive: true });
  fs.writeFileSync(expanded, `${token}\n`, { mode: 0o600 });
  writeServerAuthConfig(expanded);
  process.stdout.write(green(`wrote token file ${expanded} (0600)\n`));
  process.stdout.write(`${token}\n`);
  process.stdout.write(dim(`server.auth_token_file is set — restart familiar serve to enforce it\n`));
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
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8")) as {
        version?: string;
      };
      if (pkg.version) return pkg.version;
    } catch {
      /* try the next candidate */
    }
  }
  return "0.0.0";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { flags, positionals } = parseArgs(argv);
  const command = positionals[0] ?? "";

  const rest = positionals.slice(1);

  // `familiar --version` / `-V` (flag form; the command form is handled below too)
  if (command === "" && (flags["version"] === true || flags["V"] === true)) {
    process.stdout.write(`familiar ${readVersion()}\n`);
    return;
  }

  try {
    switch (command) {
      case "":
        // bare `familiar` on a terminal opens the interactive chat (TUI);
        // non-interactive callers (pipes, CI) keep getting the usage text.
        if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
          await cmdTui(flags);
          break;
        }
        process.stdout.write(USAGE);
        break;
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        break;
      case "--version":
      case "-V":
      case "version":
        process.stdout.write(`familiar ${readVersion()}\n`);
        break;
      case "run":
        await cmdRun(flags, rest);
        break;
      case "chat":
        if (process.stdin.isTTY === true && process.stdout.isTTY === true && !flagBool(flags, "line")) {
          await cmdTui(flags);
        } else {
          await cmdChat(flags);
        }
        break;
      case "serve":
        await cmdServe(flags);
        break;
      case "update":
        await cmdUpdate(flags);
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
      case "token":
        await cmdToken(flags);
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
