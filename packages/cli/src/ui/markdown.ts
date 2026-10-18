/**
 * Terminal markdown renderer for the CLI (OpenCode-style output).
 *
 * Line-buffered so it can be fed streaming text deltas: complete lines are
 * rendered as they arrive, while fenced code and tables are held until their
 * block closes. Also handles CJK display widths for table alignment.
 */
import { ansi, useColor } from "./display.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITAL = "\x1b[3m";
const STRIKE = "\x1b[9m";
const CYAN = "\x1b[36m";

const c = {
  bold: (s: string) => (useColor() ? `${BOLD}${s}${RESET}` : s),
  italic: (s: string) => (useColor() ? `${ITAL}${s}${RESET}` : s),
  strike: (s: string) => (useColor() ? `${STRIKE}${s}${RESET}` : s),
  code: (s: string) => (useColor() ? `${CYAN}${s}${RESET}` : s),
  dim: (s: string) => (useColor() ? ansi.dim(s) : s),
  accent: (s: string) => (useColor() ? ansi.cyan(s) : s),
};

// ---------------------------------------------------------------------------
// width helpers (CJK / full-width aware)
// ---------------------------------------------------------------------------

/** Rough East-Asian wide detection for alignment purposes. */
export function charWidth(cp: number): number {
  if (cp >= 0x1100 && (
    cp <= 0x115f || // Hangul Jamo
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // full-width forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd)
  )) return 2;
  return 1;
}

/** Display width ignoring ANSI escapes. */
export function displayWidth(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

// ---------------------------------------------------------------------------
// inline formatting
// ---------------------------------------------------------------------------

export function inlineMd(src: string): string {
  let t = src;
  const codes: string[] = [];
  t = t.replace(/`([^`\n]+)`/g, (_m, inner) => {
    codes.push(c.code(inner));
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, inner) => c.bold(inner));
  t = t.replace(/__([^_]+)__/g, (_m, inner) => c.bold(inner));
  t = t.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, (_m, pre, inner) => `${pre}${c.italic(inner)}`);
  t = t.replace(/~~([^~]+)~~/g, (_m, inner) => c.strike(inner));
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text, url) => `${text} ${c.dim(`(${url})`)}`);
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)] ?? "");
  return t;
}

// ---------------------------------------------------------------------------
// block helpers
// ---------------------------------------------------------------------------

function termWidth(): number {
  return Math.max(40, process.stdout.columns ?? 80);
}

function renderFence(lines: string[], lang: string): string {
  const w = Math.min(termWidth() - 2, Math.max(...lines.map((l) => displayWidth(l)), 12) + 2);
  const label = lang ? ` ${lang} ` : "";
  const top = `╭─${label}${"─".repeat(Math.max(0, w - 2 - label.length))}`;
  const out = [c.dim(top)];
  for (const l of lines) out.push(`${c.dim("│")} ${l}`);
  out.push(c.dim(`╰${"─".repeat(Math.max(0, w - 2))}`));
  return out.join("\n") + "\n";
}

/** Border-box table with CJK-aware column widths. */
export function renderTable(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = Array.from({ length: cols }, (_, i) =>
    Math.max(...rows.map((r) => displayWidth(r[i] ?? ""))),
  );
  const line = (l: string, m: string, r: string) =>
    c.dim(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const row = (cells: string[], bold: boolean) => {
    const parts: string[] = [];
    for (let i = 0; i < cols; i++) {
      const cell = cells[i] ?? "";
      const pad = " ".repeat(Math.max(0, widths[i]! - displayWidth(cell)));
      const text = `${cell}${pad}`;
      parts.push(` ${bold ? c.bold(text) : text} `);
    }
    return `${c.dim("│")}${parts.join(c.dim("│"))}${c.dim("│")}`;
  };
  const out = [line("┌", "┬", "┐"), row(rows[0] ?? [], true), line("├", "┼", "┤")];
  for (const r of rows.slice(1)) out.push(row(r, false));
  out.push(line("└", "┴", "┘"));
  return out.join("\n") + "\n";
}

function isSeparatorRow(line: string): boolean {
  return line.includes("|") && line.includes("-") && /^\s*\|?[\s:|-]*\|[\s:|-]*\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((cell) => cell.trim());
}

// ---------------------------------------------------------------------------
// streaming renderer
// ---------------------------------------------------------------------------

export class TermMarkdown {
  private buf = "";
  private fenceLang: string | null = null;
  private fenceLines: string[] = [];
  private tableLines: string[] = [];

  /** Feed streamed text; returns the ANSI output for any complete lines. */
  push(text: string): string {
    this.buf += text;
    let out = "";
    for (;;) {
      const idx = this.buf.indexOf("\n");
      if (idx === -1) break;
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      out += this.handleLine(line);
    }
    return out;
  }

  /** End of message: flush partial lines, close fences/tables. */
  flush(): string {
    let out = "";
    if (this.buf !== "") {
      out += this.handleLine(this.buf);
      this.buf = "";
    }
    out += this.flushTable();
    if (this.fenceLang !== null) {
      out += renderFence(this.fenceLines, this.fenceLang);
      this.fenceLang = null;
      this.fenceLines = [];
    }
    return out;
  }

  private handleLine(line: string): string {
    // fenced code
    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (this.fenceLang !== null) {
      if (fence) {
        const out = renderFence(this.fenceLines, this.fenceLang);
        this.fenceLang = null;
        this.fenceLines = [];
        return out;
      }
      this.fenceLines.push(line);
      return "";
    }
    if (fence) {
      const pre = this.flushTable();
      this.fenceLang = fence[1] ?? "";
      return pre;
    }
    // tables (buffered until the block ends)
    if (line.trimStart().startsWith("|")) {
      const pre = this.fenceLang === null ? "" : "";
      this.tableLines.push(line);
      return pre;
    }
    const tableOut = this.flushTable();
    // headings
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const text = inlineMd(heading[2] ?? "");
      return `${tableOut}${level <= 2 ? `\n${c.accent(text)}` : c.bold(text)}\n`;
    }
    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      return `${tableOut}${c.dim("─".repeat(Math.min(termWidth() - 4, 60)))}\n`;
    }
    // blockquote
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) return `${tableOut}${c.dim("▌ ")}${c.dim(inlineMd(quote[1] ?? ""))}\n`;
    // lists
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) return `${tableOut}${bullet[1] ?? ""}${c.accent("•")} ${inlineMd(bullet[2] ?? "")}\n`;
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ordered) return `${tableOut}${ordered[1] ?? ""}${c.accent(`${ordered[2]}.`)} ${inlineMd(ordered[3] ?? "")}\n`;
    return `${tableOut}${inlineMd(line)}\n`;
  }

  private flushTable(): string {
    if (this.tableLines.length === 0) return "";
    const lines = this.tableLines;
    this.tableLines = [];
    const isTable = lines.length >= 2 && isSeparatorRow(lines[1] ?? "");
    if (!isTable) {
      return lines.map((l) => `${inlineMd(l)}\n`).join("");
    }
    const rows = [lines[0]!, ...lines.slice(2)].map(splitRow);
    return renderTable(rows);
  }
}
