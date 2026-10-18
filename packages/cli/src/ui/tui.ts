/**
 * Full-screen TUI (OpenCode-style): alternating screen buffer with an outer
 * rounded border (title embedded in the top border, status in the bottom),
 * scrollable transcript viewport, single-line editor and spinner. No
 * dependencies — raw ANSI only. Frames are line-diffed: only changed rows
 * are rewritten.
 */
import { ansi, useColor, ThinkingFilter, renderDiff, toolCallDetail } from "./display.js";
import { TermMarkdown } from "./markdown.js";
import type { AgentEvent } from "@familiar/protocol";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ---------------------------------------------------------------------------
// ANSI-safe measurement / wrapping / padding
// ---------------------------------------------------------------------------

function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** Truncate by display width (keeping ANSI) and right-pad to `width`. */
function padLine(s: string, width: number): string {
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = s[i]!;
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += 1;
  }
  while (w < width) {
    out += " ";
    w += 1;
  }
  return out;
}

/** Word-preferred wrap that falls back to hard breaks (CJK friendly). */
export function wrapAnsi(s: string, width: number): string[] {
  if (width < 4) return [padLine(s, Math.max(1, width))];
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  let active = ""; // SGR state carried onto continuation lines
  let i = 0;
  while (i < s.length) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) {
      cur += m[0];
      active = m[0] === RESET ? "" : active + m[0];
      i += m[0].length;
      continue;
    }
    const ch = s[i]!;
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (curW + cw > width) {
      let cut = cur.length;
      for (let k = cur.length - 1; k >= Math.max(0, cur.length - 60); k--) {
        if (cur[k] === " ") {
          cut = k;
          break;
        }
      }
      const head = cut > 0 && cut < cur.length ? cur.slice(0, cut) : cur;
      lines.push(head);
      cur = active + cur.slice(head.length).replace(/^ /, "");
      curW = visibleWidth(cur);
      continue;
    }
    cur += ch;
    curW += cw;
    i += 1;
  }
  lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------------------
// transcript blocks
// ---------------------------------------------------------------------------

type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; src: string; lines: string[] | null; done: boolean; lastRender: number }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; detail: string; status: "run" | "ok" | "err"; ms?: number; extra?: string[] }
  | { kind: "info"; text: string };

const cc = {
  dim: (s: string) => (useColor() ? ansi.dim(s) : s),
  red: (s: string) => (useColor() ? ansi.red(s) : s),
  green: (s: string) => (useColor() ? ansi.green(s) : s),
  cyan: (s: string) => (useColor() ? ansi.cyan(s) : s),
  bold: (s: string) => (useColor() ? `${BOLD}${s}${RESET}` : s),
};

function blockLines(b: Block, width: number): string[] {
  switch (b.kind) {
    case "user":
      return wrapAnsi(`${cc.cyan("❯")} ${b.text}`, width);
    case "assistant": {
      if (b.lines === null) {
        const md = new TermMarkdown();
        const out = md.push(b.src) + md.flush();
        b.lines = out === "" ? [""] : out.replace(/\n+$/, "").split("\n");
        b.lastRender = Date.now();
      }
      return b.lines;
    }
    case "reasoning": {
      const out = [cc.dim("◌ thinking…")];
      for (const piece of b.text.split("\n")) {
        if (piece !== "") out.push(...wrapAnsi(cc.dim(piece), width));
      }
      return out;
    }
    case "tool": {
      const mark = b.status === "run" ? cc.dim("●") : b.status === "ok" ? cc.green("✓") : cc.red("✗");
      let head = `${mark} ${cc.cyan(b.name)}`;
      if (b.detail) head += ` ${cc.dim(`· ${b.detail}`)}`;
      if (b.status === "ok" && b.ms !== undefined) head += `  ${cc.dim(`${b.ms}ms`)}`;
      const lines = [...wrapAnsi(head, width)];
      for (const l of b.extra ?? []) lines.push(...wrapAnsi(l, width));
      return lines;
    }
    case "info":
      return b.text === ""
        ? []
        : b.text.split("\n").flatMap((piece) => (piece === "" ? [""] : wrapAnsi(cc.dim(piece), width)));
  }
}

// ---------------------------------------------------------------------------
// screen manager
// ---------------------------------------------------------------------------

export interface TuiInfo {
  app: string;
  title: string;
  model: string;
  mode: "build" | "plan" | string;
  cwd: string;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const NAV_KEYS = new Set([
  "up", "down", "left", "right", "pageup", "pagedown", "home", "end",
  "escape", "delete", "tab",
]);

export class FullScreenTui {
  private blocks: Block[] = [];
  private flowCache: string[] | null = null;
  private width = 80;
  private height = 24;
  private prevRows: (string | null)[] = [];
  private lastFlowLen: number | null = null;
  private input = "";
  private scrollOffset = 0;
  private busy = false;
  private startedAt = 0;
  private usage = { prompt: 0, completion: 0 };
  private info: TuiInfo = { app: "Familiar Harness", title: "", model: "", mode: "build", cwd: "" };
  private running = false;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly think = new ThinkingFilter();
  private toolCount = 0;
  private assistantStream: Block & { kind: "assistant" } | null = null;
  private reasoningStream: Block & { kind: "reasoning" } | null = null;

  // ---- lifecycle ---------------------------------------------------------

  start(): void {
    this.running = true;
    this.refreshSize();
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J");
    this.frame();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.clearFrameTimer();
    process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
  }

  get isRunning(): boolean {
    return this.running;
  }

  refreshSize(): void {
    const w = Math.max(30, process.stdout.columns ?? 80);
    const h = Math.max(9, process.stdout.rows ?? 24);
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.flowCache = null;
      for (const b of this.blocks) if (b.kind === "assistant") b.lines = null;
    }
  }

  /** Repaint everything (resize / Ctrl+L). */
  repaint(): void {
    this.prevRows = [];
    process.stdout.write("\x1b[2J");
    this.frame();
  }

  // ---- content feeding -----------------------------------------------------

  setUserLine(text: string): void {
    this.blocks.push({ kind: "user", text });
    this.frameSoon();
  }

  setInfo(text: string): void {
    if (text.trim() === "") return;
    this.blocks.push({ kind: "info", text: text.replace(/^\n+|\s+$/g, "") });
    this.frameSoon();
  }

  noSessionNote(): void {
    this.blocks.push({ kind: "info", text: "(no session yet — the first message creates one)" });
    this.frameSoon();
  }

  setSessionInfo(info: Partial<TuiInfo>): void {
    Object.assign(this.info, info);
    this.frameSoon();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.startedAt = busy ? Date.now() : 0;
    if (busy && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        if (!this.busy) return;
        this.spinnerFrame += 1;
        this.frame();
      }, 120);
    }
    if (!busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.frame();
  }

  clearInput(): void {
    this.input = "";
    this.frame();
  }

  clearTranscript(): void {
    this.blocks = [];
    this.flowCache = null;
    this.frame();
  }

  /** Persisted history ("lfamiliar chat --session") loaded before start(). */
  loadHistory(messages: ReadonlyArray<{ role: string; content?: string; name?: string; meta?: unknown }>): void {
    for (const m of messages) {
      const meta = (m.meta ?? {}) as { ephemeral?: boolean };
      if (meta.ephemeral === true) continue;
      if (m.role === "user") {
        this.blocks.push({ kind: "user", text: m.content ?? "" });
      } else if (m.role === "assistant") {
        this.blocks.push({ kind: "assistant", src: m.content ?? "", lines: null, done: true, lastRender: 0 });
      } else if (m.role === "tool") {
        const first = (m.content ?? "").split("\n")[0] ?? "";
        this.blocks.push({
          kind: "tool",
          name: m.name ?? "tool",
          detail: first.length > 90 ? `${first.slice(0, 90)}…` : first,
          status: "ok",
        });
      }
    }
    this.flowCache = null;
  }

  // ---- AgentEvent printer -------------------------------------------------

  printer = (event: AgentEvent): void => {
    switch (event.type) {
      case "turn.start":
        this.toolCount = 0;
        break;
      case "reasoning.delta": {
        if (!this.reasoningStream) {
          this.reasoningStream = { kind: "reasoning", text: "" };
          this.blocks.push(this.reasoningStream);
        }
        this.reasoningStream.text += event.text;
        this.frameSoon();
        break;
      }
      case "message.start":
        this.closeStreams();
        this.assistantStream = { kind: "assistant", src: "", lines: [], done: false, lastRender: 0 };
        this.blocks.push(this.assistantStream);
        this.frameSoon();
        break;
      case "text.delta": {
        const visible = this.think.push(event.text);
        if (visible) {
          if (!this.assistantStream) {
            this.assistantStream = { kind: "assistant", src: "", lines: [], done: false, lastRender: 0 };
            this.blocks.push(this.assistantStream);
          }
          this.assistantStream.src += visible;
          this.reRenderAssistant(this.assistantStream);
          this.frameSoon();
        }
        break;
      }
      case "tool.call": {
        this.closeStreams();
        this.toolCount += 1;
        this.blocks.push({
          kind: "tool",
          name: event.toolCall.name,
          detail: toolCallDetail(event.toolCall.name, event.toolCall.arguments),
          status: "run",
        });
        this.frameSoon();
        break;
      }
      case "tool.result": {
        const tb = [...this.blocks].reverse().find(
          (b): b is Block & { kind: "tool" } => b.kind === "tool",
        );
        if (tb && tb.status === "run") {
          if (event.isError) {
            tb.status = "err";
            tb.detail = (event.content.split("\n")[0] ?? "").slice(0, 200);
          } else {
            tb.status = "ok";
            tb.ms = event.durationMs;
            if (event.diff) {
              tb.extra = renderDiff(event.diff).split("\n").map((l) => `  ${l}`);
            }
          }
        }
        this.frameSoon();
        break;
      }
      case "message.end": {
        const tail = this.think.finish();
        if (tail && this.assistantStream) this.assistantStream.src += tail;
        this.closeStreams();
        this.frameSoon();
        break;
      }
      case "turn.error":
        this.closeStreams();
        this.blocks.push({ kind: "info", text: `✖ ${event.error}` });
        this.frameSoon();
        break;
      case "turn.end": {
        const u = event.usage ?? {};
        if (u.promptTokens !== undefined) this.usage.prompt = u.promptTokens ?? 0;
        if (u.completionTokens !== undefined) this.usage.completion = u.completionTokens ?? 0;
        break;
      }
      case "compaction":
        this.blocks.push({ kind: "info", text: `… compacted ${event.dropped} older messages` });
        this.frameSoon();
        break;
      default:
        break;
    }
  };

  private reRenderAssistant(b: Block & { kind: "assistant" }): void {
    if (b.lines !== null && Date.now() - b.lastRender < (b.done ? 900 : 150)) return;
    const md = new TermMarkdown();
    const out = md.push(b.src) + md.flush();
    const rendered = out === "" ? [""] : out.replace(/\n+$/, "").split("\n");
    b.lines = rendered;
    b.lastRender = Date.now();
  }

  private closeStreams(): void {
    if (this.assistantStream) {
      this.assistantStream.done = true;
      this.assistantStream.lines = null;
      this.reRenderAssistant(this.assistantStream);
      this.assistantStream = null;
    }
    this.reasoningStream = null;
  }

  get toolTotal(): number {
    return this.toolCount;
  }

  // ---- frame scheduling ---------------------------------------------------

  private clearFrameTimer(): void {
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
  }

  /** Coalesce rapid deltas into ~20 fps. */
  frameSoon(): void {
    if (this.frameTimer || !this.running) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.frame();
    }, 50);
  }

  // ---- scrolling ------------------------------------------------------------

  private flow(): string[] {
    if (this.flowCache) return this.flowCache;
    const inner = Math.max(10, this.width - 4);
    for (const b of this.blocks) {
      if (b.kind === "assistant") this.reRenderAssistant(b);
    }
    const all: string[] = [];
    for (const b of this.blocks) {
      if (all.length > 0) all.push("");
      for (const l of blockLines(b, inner)) all.push(l);
    }
    if (this.lastFlowLen !== null && this.scrollOffset > 0) {
      // keep the viewport anchored when new output lands while scrolled up
      this.scrollOffset += Math.max(0, all.length - this.lastFlowLen);
    }
    this.lastFlowLen = all.length;
    this.flowCache = all;
    return all;
  }

  scroll(delta: number): void {
    if (delta > 0) {
      this.scrollOffset = Math.max(0, this.scrollOffset - delta);
    } else {
      this.scrollOffset = this.scrollOffset - delta;
    }
    this.clampScroll();
    this.frame();
  }

  private clampScroll(): void {
    const view = Math.max(1, this.height - 4);
    const max = Math.max(0, this.flow().length - view);
    if (this.scrollOffset > max) this.scrollOffset = max;
  }

  /** End follows the tail (offset 0). */
  scrollEnd(): void {
    this.scrollOffset = 0;
    this.frame();
  }

  /** To the very top. */
  scrollTop(): void {
    const view = Math.max(1, this.height - 4);
    void view;
    const max = Math.max(0, this.flow().length - view);
    this.scrollOffset = max;
    this.frame();
  }

  // ---- painting ------------------------------------------------------------

  frame(): void {
    if (!this.running) return;
    this.refreshSize();
    this.flowCache = null; // blocks changed (or cache semantics) — rebuild
    const rows = this.compose();
    let out = "";
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] ?? "";
      if (this.prevRows[i] === row) continue;
      out += `\x1b[${i + 1};1H\x1b[2K${row}`;
      this.prevRows[i] = row;
    }
    for (let i = rows.length; i < this.prevRows.length; i++) {
      out += `\x1b[${i + 1};1H\x1b[2K`;
      this.prevRows[i] = null;
    }
    this.prevRows.length = rows.length;
    process.stdout.write(out);
  }

  private compose(): string[] {
    const w = this.width;
    const rows: string[] = [];
    const dimRun = (n: number): string => cc.dim("─".repeat(n));

    // top border: title left, model right
    {
      const L = ` ◍ ${this.info.app}${this.info.title ? ` · ${this.info.title}` : ""} `;
      const R = this.info.model === "" ? "" : ` ${this.info.model} `;
      const mid = dimRun(Math.max(0, w - visibleWidth(L) - visibleWidth(R) - 2));
      rows.push(`╭${cc.dim(L)}${mid}${R === "" ? "" : cc.dim(R)}╮`);
    }

    // transcript viewport
    const view = Math.max(1, this.height - 4);
    this.clampScroll();
    const flow = this.flow();
    const start = Math.max(0, flow.length - view - this.scrollOffset);
    const window = flow.slice(start, start + view);
    for (let i = 0; i < view; i++) {
      let line = window[i] ?? "";
      if (i === 0 && start > 0) line = line === "" ? cc.dim("▲") : `${cc.dim("▲")} ${line}`;
      rows.push(`│${padLine(` ${line}`, Math.max(0, w - 2))}│`);
    }

    // input separator + editor row
    rows.push(`├${dimRun(w - 2)}┤`);
    {
      const prompt = ` ${cc.cyan("❯")} `;
      const editor = prompt + this.input;
      const caret = useColor() ? "\x1b[7m \x1b[0m" : "_";
      rows.push(`│${padLine(editor + caret, Math.max(0, w - 2))}│`);
    }

    // bottom border: mode · model left, activity/tokens + cwd right
    {
      const left = ` ${this.info.mode === "plan" ? "plan" : "build"} · ${this.info.model} `;
      const leftRendered =
        this.info.mode === "plan"
          ? ` ${cc.bold(cc.cyan("plan"))} · ${this.info.model} `
          : cc.dim(left);
      const bits: string[] = [];
      if (this.busy) {
        const g = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length] ?? "⠋";
        bits.push(`${g} ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`);
      }
      if (this.usage.prompt || this.usage.completion) bits.push(`↑${this.usage.prompt} ↓${this.usage.completion} tok`);
      const cwdBase = this.info.cwd.split("/").filter(Boolean).pop() ?? "";
      if (cwdBase) bits.push(cwdBase);
      const right = bits.length > 0 ? ` ${bits.join(" · ")} ` : "";
      const mid = dimRun(Math.max(0, w - visibleWidth(left) - visibleWidth(right) - 2));
      rows.push(`╰${leftRendered}${mid}${right === "" ? "" : cc.dim(right)}╯`);
    }

    return rows.map((r) => padLine(r, w));
  }

  // ---- editor / keys ---------------------------------------------------------

  /** Handle a keypress; returns the submitted line, "quit" control or null. */
  key(key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }): string | null {
    if (key.ctrl && key.name === "c") return "\x03";
    if (key.ctrl && key.name === "l") {
      this.repaint();
      return null;
    }
    if (key.ctrl && key.name === "u") {
      this.input = "";
      this.frame();
      return null;
    }
    switch (key.name) {
      case "return":
      case "enter": {
        const line = this.input;
        this.input = "";
        return line;
      }
      case "backspace":
        if (this.input.length > 0) {
          this.input = [...this.input].slice(0, -1).join("");
          this.frame();
        }
        return null;
      case "up":
        this.scroll(-1);
        return null;
      case "down":
        this.scroll(1);
        return null;
      case "pageup":
        this.scroll(-(this.height - 6));
        return null;
      case "pagedown":
        this.scroll(this.height - 6);
        return null;
      case "end":
        this.scrollEnd();
        return null;
      case "home":
        this.scrollTop();
        return null;
      default:
        break;
    }
    if (
      key.sequence &&
      [...key.sequence].length === 1 &&
      key.sequence.length <= 2 &&
      !key.ctrl &&
      !key.meta &&
      !(key.name !== undefined && NAV_KEYS.has(key.name))
    ) {
      if ((this.scrollOffset !== 0 && this.flow().length > this.height - 4)) {
        this.scrollEnd();
      }
      this.input += key.sequence;
      this.frame();
    }
    return null;
  }

  /** Mouse wheel (SGR 1006): "<64 b ; c ; r M" up / "<65 … M" down. */
  wheel(sequence: string): boolean {
    const m = /^\x1b\[<(64|65);\d+;\d+M$/.exec(sequence);
    if (!m) return false;
    this.scroll((m[1] === "64" ? -1 : 1) * 3);
    return true;
  }
}
