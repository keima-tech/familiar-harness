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

const USAGE = `familiar — OpenCode/Claude Code-style agent harness (CLI)

Usage:
  familiar run [-p "prompt"] [--provider ID] [--model ID] [--session ID] [--new]
            [--cwd DIR] [--max-steps N] [-y] [--json] [--title S]
  familiar chat [--session ID] [--provider ID] [--model ID] [--cwd DIR] [-y]
  familiar serve [--port N] [--config PATH]
  familiar sessions list | show <id> [--messages] | delete <id>
  familiar model list [provider]
  familiar init
  familiar doctor
  familiar help | --version

Options:
  -p, --prompt TEXT      prompt text (or pass it as positional args)
  -y, --yolo             skip approval prompts for risky actions
      --json             emit NDJSON agent events (machine-readable)
      --config PATH      path to config.yaml (default ~/.familiar/config.yaml)
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
  "-p",
  "--prompt",
]);
const BOOL_FLAGS = new Set(["-y", "--yolo", "--json", "--new", "-c", "--continue", "--messages"]);

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
// commands
// ---------------------------------------------------------------------------

async function cmdRun(flags: Record<string, string | boolean>, positionals: string[]): Promise<void> {
  const text =
    flag(flags, "prompt") ?? positionals.join(" ").trim();
  if (!text) fail(`no prompt given. usage:\n${USAGE}`);
  const cwd = resolveCwd(flags);
  const cfg = loadCliConfig(flags);
  const isInteractive = !!process.stdout.isTTY && !flagBool(flags, "json");

  const server = new AgentServer({
    config: cfg,
    approval: isInteractive ? new CliApprovalAdapter() : undefined,
  });

  let sessionId: string;
  if (flag(flags, "session")) {
    sessionId = flag(flags, "session")!;
  } else if (flagBool(flags, "continue")) {
    const latest = latestSessionInCwd(server, cwd);
    if (!latest) fail("no previous session to continue (this cwd)");
    sessionId = latest.id;
  } else {
    const created = (await server.dispatch("session.create", {
      provider: providerId(flags),
      model: modelId(flags),
      cwd,
      title: flag(flags, "title"),
    })) as SessionRecord;
    sessionId = created.id;
  }

  const printer = flagBool(flags, "json")
    ? createJsonPrinter(sessionId)
    : createPrettyPrinter();

  try {
    const res = (await server.dispatch(
      "session.send",
      {
        id: sessionId,
        text,
        provider: providerId(flags),
        model: modelId(flags),
        maxSteps: toNumber(flag(flags, "max-steps")),
        yolo: flagBool(flags, "yolo"),
      },
      { onEvent: (_sid, ev) => printer(ev as AgentEvent) },
    )) as { turnId: string; steps: number };
    if (!flagBool(flags, "json")) {
      process.stdout.write(
        dim(`(session: ${sessionId} · turn: ${res.turnId.slice(0, 8)} · steps: ${res.steps})\n`),
      );
    }
  } catch (err) {
    if (!flagBool(flags, "json")) {
      process.stderr.write(red(`run failed: ${err instanceof Error ? err.message : String(err)}\n`));
    }
    process.exitCode = 1;
  }
}

async function cmdChat(flags: Record<string, string | boolean>): Promise<void> {
  const cwd = resolveCwd(flags);
  const cfg = loadCliConfig(flags);
  const server = new AgentServer({ config: cfg, approval: new CliApprovalAdapter() });

  let session: SessionRecord | null = null;
  if (flag(flags, "session")) {
    const id = flag(flags, "session")!;
    const got = (await server.dispatch("session.get", { id })) as { session: SessionRecord };
    session = got.session;
  } else if (flagBool(flags, "continue")) {
    session = latestSessionInCwd(server, cwd);
  }

  process.stdout.write(dim("familiar chat — /help for commands, /exit to quit\n"));
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ensureSession = async (): Promise<SessionRecord> => {
    if (session) return session;
    const created = (await server.dispatch("session.create", {
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
            "commands: /new /sessions /session <id> /model <id|reset> /help /exit\n(any other text is sent to the agent)\n",
          ),
        );
      } else if (line === "/new") {
        session = null;
        const s = await ensureSession();
        process.stdout.write(dim(`(new session ${s.id.slice(0, 8)})\n`));
      } else if (line.startsWith("/sessions")) {
        const list = (await server.dispatch("session.list", {})) as SessionRecord[];
        for (const s of list.slice(0, 10)) {
          process.stdout.write(
            dim(`${s.id.slice(0, 8)}  ${s.provider}/${s.model}  ${s.title || "(untitled)"}\n`),
          );
        }
      } else if (line.startsWith("/session ")) {
        const id = line.slice("/session ".length).trim();
        const got = (await server.dispatch("session.get", { id })) as { session: SessionRecord };
        session = got.session;
        process.stdout.write(dim(`(switched to ${got.session.id.slice(0, 8)})\n`));
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
        await server.dispatch(
          "session.send",
          { id: s.id, text: line, yolo: flagBool(flags, "yolo") },
          { onEvent: (_sid, ev) => printer(ev as AgentEvent) },
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
  const server = new AgentServer({ config: cfg });
  const transport = await startHttpTransport(server, { port, bind: cfg.server.bind });
  process.stdout.write(cyan(`familiar server listening on ${transport.url}\n`));
  process.stdout.write(dim(`  rpc:   POST ${transport.url}/rpc\n  events: WS ${transport.url}/ws\n`));
  process.stdout.write(dim("  press Ctrl+C to stop\n"));
  const shutdown = (): void => {
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

function latestSessionInCwd(server: AgentServer, cwd: string): SessionRecord | null {
  const list = server.store.listSessions();
  return list.find((s) => s.cwd === cwd) ?? null;
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
