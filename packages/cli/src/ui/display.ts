/**
 * Shared UI helpers for the CLI (ANSI colors, event pretty-printing).
 */
import type { AgentEvent } from "@familiar/protocol";
import { TermMarkdown } from "./markdown.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

export const ansi = {
  reset: RESET,
  dim: (s: string) => `${DIM}${s}${RESET}`,
  red: (s: string) => `${RED}${s}${RESET}`,
  green: (s: string) => `${GREEN}${s}${RESET}`,
  cyan: (s: string) => `${CYAN}${s}${RESET}`,
};

export function useColor(): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  return process.stdout.isTTY === true;
}

const c = {
  key: (s: string) => (useColor() ? ansi.cyan(s) : s),
  ok: (s: string) => (useColor() ? ansi.green(s) : s),
  err: (s: string) => (useColor() ? ansi.red(s) : s),
  faint: (s: string) => (useColor() ? ansi.dim(s) : s),
  plain: (s: string) => s,
};

/** Key argument for a tool line (command/path/pattern/url). */
export function toolCallDetail(name: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    const keys = name === "bash" ? ["command", "path", "pattern", "url"] : ["path", "pattern", "command", "url", "query"];
    for (const key of keys) {
      const v = args[key];
      if (typeof v === "string" && v !== "") {
        const flat = v.replace(/\s+/g, " ").trim();
        return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
      }
    }
    const json = JSON.stringify(args);
    return json.length > 60 ? `${json.slice(0, 60)}…` : json;
  } catch {
    return "";
  }
}

/** Indent a rendered diff block by two spaces with a dim gutter. */
function indentDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}

/** Display one primary argument of a tool call compactly. */
export function toolCallSummary(name: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    const candidates = ["command", "path", "pattern", "url"];
    for (const key of candidates) {
      const v = args[key];
      if (typeof v === "string" && v !== "") {
        return `${name}: ${v.length > 120 ? v.slice(0, 120) + "…" : v}`;
      }
    }
    return `${name}: ${JSON.stringify(args).slice(0, 120)}`;
  } catch {
    return `${name}: (unparseable arguments)`;
  }
}

/**
 * Stateful filter that hides `<think>…</think>` reasoning spans arriving as
 * ordinary text deltas (common for small local models). Holds back a small
 * tail buffer so split tags never leak.
 */
export class ThinkingFilter {
  private inThinking = false;
  private held = "";

  push(text: string): string {
    this.held += text;
    let out = "";
    for (;;) {
      if (this.inThinking) {
        const end = this.held.indexOf("</think>");
        if (end === -1) {
          // keep a bounded tail in case </think> is split later
          if (this.held.length > 64) this.held = this.held.slice(-64);
          return out;
        }
        this.held = this.held.slice(end + "</think>".length);
        this.inThinking = false;
        continue;
      }
      const start = this.held.indexOf("<think>");
      if (start === -1) {
        const keep = Math.min(this.held.length, "<think>".length - 1);
        out += this.held.slice(0, this.held.length - keep);
        this.held = this.held.slice(Math.max(0, this.held.length - keep));
        return out;
      }
      out += this.held.slice(0, start);
      this.held = this.held.slice(start + "<think>".length);
      this.inThinking = true;
    }
  }

  /** Flush at end of message. */
  finish(): string {
    if (this.inThinking) return "";
    const out = this.held;
    this.held = "";
    return out;
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Single-line spinner with elapsed seconds ("⠙ working… 3.2s"). Pauses while
 * real output is printed so streams never interleave. No-op without a TTY.
 */
export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private paused = false;
  private shown = false;

  constructor(
    private readonly enabled: boolean,
    private readonly label = "working",
  ) {}

  start(): void {
    if (!this.enabled) return;
    this.startedAt = Date.now();
    this.paused = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.paint(), 120);
    this.paint();
  }

  private paint(): void {
    if (!this.enabled || this.paused) return;
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const glyph = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? "⠋";
    this.frame += 1;
    process.stdout.write(`\r${c.faint(`${glyph} ${this.label}… ${secs}s`)}`);
    this.shown = true;
  }

  /** Erase the spinner line so real output can be printed. */
  pause(): void {
    if (!this.enabled || !this.shown) return;
    process.stdout.write("\r\x1b[2K");
    this.shown = false;
  }

  resume(): void {
    if (!this.enabled || this.paused) return;
    this.paint();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.shown) {
      process.stdout.write("\r\x1b[2K");
      this.shown = false;
    }
  }
}

/** Render a unified diff with ANSI colors (bounded to `maxLines`). */
export function renderDiff(diff: string, maxLines = 40): string {
  const lines = diff.split("\n");
  const out: string[] = [];
  let truncated = false;
  for (const ln of lines) {
    if (out.length >= maxLines) {
      truncated = true;
      break;
    }
    if (ln.startsWith("+") && !ln.startsWith("+++")) out.push(c.ok(ln));
    else if (ln.startsWith("-") && !ln.startsWith("---")) out.push(c.err(ln));
    else if (ln.startsWith("@@")) out.push(c.key(ln));
    else out.push(c.faint(ln));
  }
  if (truncated) out.push(c.faint("  … (diff truncated)"));
  return out.join("\n");
}

/**
 * Pretty printer for AgentEvents (human mode).
 * Text deltas stream live; tool activity gets status lines; a spinner tracks
 * the turn between outputs; edit/write diffs render in color.
 */
export function createPrettyPrinter(): (event: AgentEvent) => void {
  const think = new ThinkingFilter();
  const md = new TermMarkdown();
  const spinner = new Spinner(process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined);
  let turnStartedAt = 0;
  let toolCount = 0;
  let inThinking = false;
  const write = (s: string): void => {
    if (s !== "") process.stdout.write(s);
  };
  return (event: AgentEvent) => {
    switch (event.type) {
      case "turn.start":
        turnStartedAt = Date.now();
        toolCount = 0;
        spinner.start();
        break;
      case "text.delta": {
        const visible = think.push(event.text);
        if (visible) {
          if (inThinking) {
            inThinking = false;
            spinner.pause();
            process.stdout.write("\n");
          }
          spinner.pause();
          write(md.push(visible));
        }
        break;
      }
      case "reasoning.delta": {
        if (!inThinking) {
          inThinking = true;
          spinner.pause();
          process.stdout.write(`\n${c.faint("💭 thinking…")}\n`);
        }
        spinner.pause();
        process.stdout.write(c.faint(event.text));
        break;
      }
      case "message.start":
        spinner.pause();
        process.stdout.write("\n");
        break;
      case "tool.call": {
        toolCount += 1;
        spinner.pause();
        // "⏺ 2  edit · src/foo.ts" — number, name, key argument
        const detail = toolCallDetail(event.toolCall.name, event.toolCall.arguments);
        process.stdout.write(
          `\n${c.faint(`⏺ ${toolCount}`)}  ${c.key(event.toolCall.name)}` +
            (detail ? ` ${c.faint(`· ${detail}`)}` : "") +
            "\n",
        );
        spinner.resume();
        break;
      }
      case "tool.result": {
        spinner.pause();
        if (event.isError) {
          const first = event.content.split("\n")[0] ?? "";
          process.stdout.write(`  ${c.err(`✗ ${first.slice(0, 240)}`)}\n`);
        } else {
          process.stdout.write(`  ${c.ok("✓")} ${c.faint(`${event.durationMs}ms`)}\n`);
        }
        if (!event.isError && event.diff) {
          process.stdout.write(`${indentDiff(renderDiff(event.diff))}\n`);
        }
        spinner.resume();
        break;
      }
      case "compaction":
        process.stdout.write(c.faint(`\n  … compacted ${event.dropped} older messages\n`));
        break;
      case "turn.error":
        spinner.stop();
        process.stdout.write(`\n${c.err(`✖ ${event.error}`)}\n`);
        break;
      case "message.end": {
        const tail = think.finish();
        spinner.pause();
        if (tail) write(md.push(tail));
        write(md.flush());
        if (inThinking) {
          inThinking = false;
          process.stdout.write("\n");
        }
        break;
      }
      case "turn.end": {
        spinner.stop();
        if (inThinking) {
          inThinking = false;
          process.stdout.write("\n");
        }
        const bits: string[] = [];
        const secs = turnStartedAt ? (Date.now() - turnStartedAt) / 1000 : 0;
        if (secs > 0) bits.push(`${secs.toFixed(1)}s`);
        const u = event.usage ?? {};
        if (u.completionTokens !== undefined || u.promptTokens !== undefined) {
          bits.push(`↑${u.promptTokens ?? 0} ↓${u.completionTokens ?? 0} tok`);
          if (secs > 0 && (u.completionTokens ?? 0) > 0) {
            bits.push(`${Math.round((u.completionTokens ?? 0) / secs)} tok/s`);
          }
        }
        process.stdout.write(`${c.ok("✓")} ${c.faint(bits.join(" · "))}\n`);
        break;
      }
      case "improvement.staged": {
        const parts: string[] = [];
        if (event.memoryCount > 0) parts.push(`${event.memoryCount} memory`);
        if (event.skillCount > 0) parts.push(`${event.skillCount} skill`);
        if (parts.length > 0) {
          process.stdout.write(
            c.faint(`  ✎ self-review staged ${parts.join(", ")} — run 'familiar memory pending' / 'familiar skills pending' to review\n`),
          );
        }
        break;
      }
      case "memory.truncation":
        process.stdout.write(c.faint(`  … ${event.dropped} memory entries dropped (prompt cap)\n`));
        break;
      default:
        break;
    }
  };
}

/** NDJSON sink for --json mode (machine-readable). */
export function createJsonPrinter(sessionId: string): (event: AgentEvent) => void {
  return (event: AgentEvent) => {
    process.stdout.write(`${JSON.stringify({ type: "event", sessionId, event })}\n`);
  };
}
