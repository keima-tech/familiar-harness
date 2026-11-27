/**
 * `familiar demo` — a 60-second, offline walkthrough of the parts that make
 * Familiar different:
 *
 *   1. the agent reviews its own turn and proposes a durable lesson
 *   2. the proposal is STAGED, never applied behind the user's back
 *   3. a human approves it
 *   4. the next turn inherits the lesson (it is injected into the prompt)
 *   5. skills (procedures) go through the same gate
 *   6. one core engine serves the CLI, the browser and the desktop app
 *
 * Everything runs in a throw-away FAMILIAR_HOME against the mock provider:
 * no API key, no network, and the real ~/.familiar is never touched.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** dist/demo.js -> dist/familiar.js (the CLI entry point we re-invoke). */
const CLI_ENTRY = fileURLToPath(new URL("./familiar.js", import.meta.url));

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

const useColor = process.env["NO_COLOR"] === undefined && process.stdout.isTTY === true;
const c = {
  dim: (s: string) => (useColor ? `${DIM}${s}${RESET}` : s),
  bold: (s: string) => (useColor ? `${BOLD}${s}${RESET}` : s),
  green: (s: string) => (useColor ? `${GREEN}${s}${RESET}` : s),
  cyan: (s: string) => (useColor ? `${CYAN}${s}${RESET}` : s),
};

const DEMO_CONFIG = `version: 1
default_provider: mock
providers:
  mock:
    kind: mock
memory:
  write_approval: true
skills:
  write_approval: true
  include_global: false
`;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function indent(text: string, prefix = "      "): void {
  for (const line of text.split("\n")) {
    out(line.trim() === "" ? "" : `${prefix}${line}`);
  }
}

function step(index: number, title: string): void {
  out();
  out(`${c.cyan(`[${index}/6]`)} ${c.bold(title)}`);
}

/** Run the CLI in the demo home and capture its output. */
function runCli(home: string, cwd: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env: { ...process.env, FAMILIAR_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: `${stderr}${String(err)}` }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** Start `familiar serve` and wait for its FAMILIAR_READY line. */
function startDaemon(home: string, cwd: string): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [CLI_ENTRY, "serve", "--bind", "127.0.0.1", "--port", "0", "--print-ready"],
      {
        cwd,
        env: { ...process.env, FAMILIAR_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let buf = "";
    const timer = setTimeout(() => reject(new Error("serve did not become ready")), 20_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/FAMILIAR_READY\s+(\{.*\})/);
      if (!m?.[1]) return;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(m[1]) as { url?: string };
        if (parsed.url) resolve({ url: parsed.url, proc });
        else reject(new Error("serve ready line had no url"));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function stopDaemon(proc: ChildProcess): void {
  proc.kill("SIGTERM");
}

export async function cmdDemo(flags: Record<string, string | boolean>): Promise<void> {
  const keep = flags["keep"] === true || flags["keep"] === "true";
  const cwdFlag = flags["cwd"];
  const cwd = typeof cwdFlag === "string" && cwdFlag !== "" ? path.resolve(cwdFlag) : process.cwd();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-demo-"));
  fs.writeFileSync(path.join(home, "config.yaml"), DEMO_CONFIG);

  out();
  out(`${c.bold("familiar demo")} ${c.dim("— self-improvement + one core, three frontends")}`);
  out(c.dim(`  isolated home : ${home}`));
  out(c.dim("  provider      : mock (no API key, no network)"));
  out(c.dim("  your ~/.familiar : untouched"));

  const lesson = "Always run npm run smoke before committing";

  try {
    // ---- 1: the turn runs, a separate reviewer agent reads it afterwards ----
    step(1, "a turn runs — then a separate reviewer agent reads it");
    out(c.dim(`      $ familiar run -p "@make-lesson ${lesson}"`));
    const first = await runCli(home, cwd, ["run", "-p", `@make-lesson ${lesson}`, "--yolo"]);
    indent(first.stdout.trim() || first.stderr.trim());
    if (!first.stdout.includes("self-review staged")) {
      out(c.dim("      (no proposal staged — the reviewer produced nothing)"));
    }

    // ---- 2: the proposal waits for a human ----------------------------------
    step(2, "the proposal is STAGED, not applied (write_approval is on)");
    out(c.dim("      $ familiar memory pending"));
    const pending = await runCli(home, cwd, ["memory", "pending"]);
    indent(pending.stdout.trim() || pending.stderr.trim());
    const pendingId = (pending.stdout.match(/^([0-9a-f]{6,})\s/m) ?? [])[1] ?? "";

    // ---- 3: the human approves ---------------------------------------------
    step(3, "a human approves it");
    if (pendingId) {
      out(c.dim(`      $ familiar memory approve ${pendingId}`));
      const approved = await runCli(home, cwd, ["memory", "approve", pendingId]);
      indent(approved.stdout.trim() || approved.stderr.trim());
    } else {
      out(c.dim("      (nothing to approve)"));
    }

    // ---- 4: the next turn inherits the lesson ------------------------------
    step(4, "the next turn inherits the lesson (injected into the system prompt)");
    out(c.dim(`      $ familiar run -p "@dump-prompt-memory ${lesson}"`));
    const inherited = await runCli(home, cwd, ["run", "-p", `@dump-prompt-memory ${lesson}`, "--yolo"]);
    const marker = (inherited.stdout.match(/MEMORY-(PRESENT|ABSENT)/) ?? [])[1] ?? "";
    indent(inherited.stdout.trim() || inherited.stderr.trim());
    if (marker === "PRESENT") out(c.green("      ✓ the lesson is now part of every prompt"));
    else out(c.dim("      (the lesson was not injected — check the approval step above)"));

    // ---- 5: skills are procedures, gated the same way ----------------------
    step(5, "skills (procedures) go through the same approval gate");
    out(c.dim("      $ familiar run -p \"@skill-create release-checklist\""));
    const skillTurn = await runCli(home, cwd, ["run", "-p", "@skill-create release-checklist", "--yolo"]);
    const skillLine = skillTurn.stdout.split("\n").find((l) => l.includes("skill")) ?? "";
    if (skillLine.trim()) indent(skillLine.trim());
    out(c.dim("      $ familiar skills pending"));
    const skillsPending = await runCli(home, cwd, ["skills", "pending"]);
    indent(skillsPending.stdout.trim() || skillsPending.stderr.trim());
    const skillId = (skillsPending.stdout.match(/^([0-9a-f]{6,})\s/m) ?? [])[1] ?? "";
    if (skillId) {
      out(c.dim(`      $ familiar skills approve ${skillId}`));
      const skillApproved = await runCli(home, cwd, ["skills", "approve", skillId]);
      indent(skillApproved.stdout.trim() || skillApproved.stderr.trim());
    }
    out(c.dim("      $ familiar skills list"));
    const skillList = await runCli(home, cwd, ["skills", "list"]);
    indent(skillList.stdout.trim() || skillList.stderr.trim());

    // ---- 6: one core, three frontends --------------------------------------
    step(6, "one core engine — the CLI, the browser and the desktop app share it");
    let daemon: { url: string; proc: ChildProcess } | undefined;
    try {
      daemon = await startDaemon(home, cwd);
      const health = await fetch(`${daemon.url}/healthz`)
        .then((r) => r.json() as Promise<Record<string, unknown>>)
        .catch(() => undefined);
      out(`      ${c.dim("$ curl")} ${daemon.url}/healthz`);
      out(
        `      ok=${String(health?.["ok"])}  protocol=${String(health?.["protocol"])}  version=${String(health?.["version"])}`,
      );
      const rpc = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.list", params: {} }),
      })
        .then((r) => r.json() as Promise<{ result?: unknown }>)
        .catch(() => undefined);
      const sessions = Array.isArray(rpc?.result) ? rpc.result.length : 0;
      out(`      ${c.dim("$")} POST /rpc session.list → ${sessions} session(s) in the same store`);
      out(c.dim(`      open ${daemon.url}/ in a browser — same core, same history`));
    } catch (err) {
      out(c.dim(`      (daemon step skipped: ${err instanceof Error ? err.message : String(err)})`));
    } finally {
      if (daemon) stopDaemon(daemon.proc);
    }

    // ---- closing -----------------------------------------------------------
    out();
    out(c.bold("What you just saw"));
    out("  • the agent writes to its own memory — but only after a human approves it");
    out("  • memory (always-on facts) and skills (on-demand procedures) are separate stores");
    out("  • the curator keeps skills fresh: stale → archive, optional LLM consolidation, ledger + snapshots");
    out("  • one core engine, three frontends (TUI / Web / desktop) on the same daemon");
    out();
    out(c.dim("  Run it against a real model instead: familiar run -p \"...\"  (see docs/guide.md)"));
    if (keep) out(c.dim(`  Demo home kept at: ${home}`));
    else out(c.dim(`  Demo home removed (--keep to inspect it)`));
  } finally {
    if (!keep) fs.rmSync(home, { recursive: true, force: true });
  }
}
