/**
 * Terminal markdown renderer for assistant output (OpenCode-style):
 * headings, lists, quotes, inline formatting, fenced code blocks and
 * box-drawing tables (CJK-width aware). Streaming-friendly: complete lines
 * are rendered as they arrive, blocks (fences/tables) flush when they end.
 */
import { ansi, useColor } from "./display.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const STRIKE = "\x1b[9m";
const CYAN = "\x1b[36m";

const c = {
  bold: (s: string) => (useColor() ? `${BOLD}${s}${RESET}` : s),
  italic: (s: string) => (useColor() ? `${ITALIC}${s}${RESET}` : s),
  strike: (s: string) => (useColor() ? `${STRIKE}${s}${RESET}` : s),
  code: (s: string) => (useColor() ? `${CYAN}${s}${RESET}` : s),
  dim: (s: string) => (useColor() ? ansi.dim(s) : s),
  accent: (s: string) => (useColor() ? ansi.cyan(s) : s),
  ok: (s: string) => (useColor() ? ansi.green(s) : s),
  err: (s: string) => (useColor() ? ansi.red(s) : s),
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width (strips ANSI, counts CJK as 2). */
export function visibleWidth(s: string): number {
  const plain = s.replace(ANSI_RE, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
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
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function pad(s: string, width: number): string {
  const diff = width - visibleWidth(s);
  return diff > 0 ? s + " ".repeat(diff) : s;
}

/** Inline markdown → ANSI (code spans protected first). */
export function renderInline(src: string): string {
  let t = src;
  const codes: string[] = [];
  t = t.replace(/`([^`\n]+)`/g, (_m, inner: string) => {
    codes.push(c.code(inner));
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => c.bold(inner));
  t = t.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?=[^\w*]|$)/g, (_m, pre: string, inner: string) => `${pre}${c.italic(inner)}`);
  t = t.replace(/~~([^~]+)~~/g, (_m, inner: string) => c.strike(inner));
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text: string, url: string) => `${text} ${c.dim(url)}`);
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "");
  return t;
}

function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes("|") || !line.includes("-")) return false;
  return /^\s*\|?[\s:|-]*\|[\s:|-]*\|?\s*$/.test(line);
}

/**
 * Buffers streamed markdown and emits ANSI-rendered output for complete
 * lines/blocks. Feed deltas with push(), then flush at message end.
 */
export class TermMarkdown {
  private partial = "";
  private fenceLang: string | null = null;
  private fenceLines: string[] = [];
  private tableLines: string[] = [];

  push(text: string): string {
    this.partial += text;
    let out = "";
    for (;;) {
      const nl = this.partial.indexOf("\n");
      if (nl === -1) break;
      const line = this.partial.slice(0, nl);
      this.partial = this.partial.slice(nl + 1);
      out += this.renderLine(line);
    }
    return out;
  }

  /** Flush trailing partial line and any open block. */
  flush(): string {
    let out = "";
    if (this.partial !== "") {
      out += this.renderLine(this.partial);
      this.partial = "";
    }
    out += this.flushTable();
    if (this.fenceLang !== null) {
      out += this.renderFence();
    }
    return out;
  }

  private renderLine(line: string): string {
    if (this.fenceLang !== null) {
      if (/^\s*```/.test(line)) return this.renderFence();
      this.fenceLines.push(line);
      return "";
    }
    if (/^\s*```(\S*)/.test(line)) {
      const out = this.flushTable();
      this.fenceLang = line.match(/^\s*```(\S*)/)?.[1] ?? "";
      this.fenceLines = [];
      return out;
    }
    if (/^\s*\|/.test(line)) {
      this.tableLines.push(line);
      return "";
    }
    const table = this.flushTable();
    return table + this.renderPlainLine(line);
  }

  private renderPlainLine(line: string): string {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = (heading[1] ?? "").length;
      const text = renderInline(heading[2] ?? "");
      return `\n${level <= 2 ? c.accent(text) : c.bold(text)}\n`;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      const w = Math.min(process.stdout.columns ?? 80, 60);
      return `${c.dim("─".repeat(w))}\n`;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) return `${c.dim("│ ")}${c.dim(renderInline(quote[1] ?? ""))}\n`;
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) return `${bullet[1] ?? ""}${c.accent("•")} ${renderInline(bullet[2] ?? "")}\n`;
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ordered) return `${ordered[1] ?? ""}${c.accent(`${ordered[2]}.`)} ${renderInline(ordered[3] ?? "")}\n`;
    return `${renderInline(line)}\n`;
  }

  private renderFence(): string {
    const lang = this.fenceLang ?? "";
    const lines = this.fenceLines;
    this.fenceLang = null;
    this.fenceLines = [];
    const cols = process.stdout.columns ?? 80;
    const innerW = Math.min(
      Math.max(...lines.map((l) => visibleWidth(l)), 8),
      Math.max(20, cols - 6),
    );
    const head = `─ ${lang || "code"} ${"─".repeat(Math.max(2, innerW - (lang.length || 4)))}`;
    const body = lines.map((l) => `${c.dim("│")} ${l}`).join("\n");
    return `\n${c.dim(head)}\n${body}\n${c.dim("─".repeat(Math.min(cols - 2, visibleWidth(head) + 1)))}\n`;
  }

  private flushTable(): string {
    if (this.tableLines.length === 0) return "";
    const lines = this.tableLines;
    this.tableLines = [];
    const hasSeparator = lines.length >= 2 && isSeparatorRow(lines[1] ?? "");
    if (!hasSeparator) {
      // not a real table — render as plain lines
      return lines.map((l) => this.renderPlainLine(l)).join("");
    }
    const header = splitCells(lines[0] ?? "");
    const rows = lines.slice(2).map(splitCells);
    const cols = header.length;
    const widths: number[] = [];
    for (let i = 0; i < cols; i++) {
      const cells = [header[i] ?? "", ...rows.map((r) => r[i] ?? "")];
      widths.push(Math.max(...cells.map((cell) => visibleWidth(renderInline(cell)))));
    }
    // shrink to terminal width if needed (truncate the widest columns)
    const maxTotal = Math.max(20, (process.stdout.columns ?? 80) - (cols * 3 + 1));
    let total = widths.reduce((a, b) => a + b, 0);
    while (total > maxTotal) {
      const i = widths.indexOf(Math.max(...widths));
      widths[i] = Math.max(4, (widths[i] ?? 4) - 1);
      total = widths.reduce((a, b) => a + b, 0);
    }
    const clip = (cell: string, w: number): string => {
      const rendered = renderInline(cell);
      if (visibleWidth(rendered) <= w) return pad(rendered, w);
      let out = "";
      let used = 0;
      for (const ch of cell) {
        const cw = visibleWidth(ch);
        if (used + cw > w - 1) break;
        out += ch;
        used += cw;
      }
      return pad(renderInline(out) + "…", w);
    };
    const sep = (l: string, m: string, r: string): string =>
      c.dim(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
    const rowOut = (cells: string[], bold: boolean): string => {
      const parts = widths.map((w, i) => {
        const cell = clip(cells[i] ?? "", w);
        return ` ${bold ? c.bold(cell) : cell} `;
      });
      return `${c.dim("│")}${parts.join(c.dim("│"))}${c.dim("│")}`;
    };
    const out: string[] = [sep("┌", "┬", "┐"), rowOut(header, true), sep("├", "┼", "┤")];
    for (const r of rows) out.push(rowOut(r, false));
    out.push(sep("└", "┴", "┘"));
    return `\n${out.join("\n")}\n`;
  }
}
