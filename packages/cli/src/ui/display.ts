/**
 * Shared UI helpers for the CLI (ANSI colors, event pretty-printing).
 */
import type { AgentEvent } from "@familiar/protocol";

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

/**
 * Pretty printer for AgentEvents (human mode).
 * Text deltas stream live; tool activity gets status lines.
 */
export function createPrettyPrinter(): (event: AgentEvent) => void {
  const think = new ThinkingFilter();
  return (event: AgentEvent) => {
    switch (event.type) {
      case "text.delta": {
        const visible = think.push(event.text);
        if (visible) process.stdout.write(visible);
        break;
      }
      case "message.start":
        process.stdout.write("\n");
        break;
      case "tool.call": {
        process.stdout.write(
          `\n${c.key("⏺")} ${c.faint(toolCallSummary(event.toolCall.name, event.toolCall.arguments))}\n`,
        );
        break;
      }
      case "tool.result":
        if (event.isError) {
          const first = event.content.split("\n")[0] ?? "";
          process.stdout.write(`  ${c.err(`⚠ ${first.slice(0, 240)}`)}\n`);
        } else if (event.name === "bash") {
          process.stdout.write(c.faint(`  ↳ exit ok (${event.durationMs}ms)\n`));
        } else {
          process.stdout.write(c.faint(`  ↳ ok (${event.durationMs}ms)\n`));
        }
        break;
      case "compaction":
        process.stdout.write(c.faint(`\n  … compacted ${event.dropped} older messages\n`));
        break;
      case "turn.error":
        process.stdout.write(`\n${c.err(`✖ ${event.error}`)}\n`);
        break;
      case "message.end": {
        const tail = think.finish();
        if (tail) process.stdout.write(tail);
        break;
      }
      case "turn.end":
        process.stdout.write("\n");
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
