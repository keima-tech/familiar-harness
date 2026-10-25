/**
 * Full-screen TUI (OpenCode-style). Raw ANSI only — no dependencies.
 *
 * Layout (no outer frame, matching opencode):
 *   - startup: centered two-tone block-letter wordmark ("familiar" dim gray,
 *     "harness" bright) above the prompt panel; keyboard hints right-aligned
 *     on the bottom row.
 *   - prompt panel: raised background, left accent bar (┃), placeholder row,
 *     metadata row (agent · model provider · effort) and a thin underline row.
 *   - once messages exist the transcript fills the upper area and the panel
 *     pins to the bottom; the wordmark disappears (like opencode's session view).
 *   - slash-command suggestions (typed "/" or ctrl+p) and the /models picker
 *     render as centered raised panels above the prompt box
 *     (↑/↓ + Enter + click + Esc, like opencode dialogs).
 *
 * Frames are line-diffed: only changed rows are rewritten.
 */
import { ansi, useColor, ThinkingFilter, renderDiff, toolCallDetail } from "./display.js";
import { TermMarkdown } from "./markdown.js";
import type { AgentEvent } from "@familiar/protocol";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const INV = "\x1b[7m";
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ---------------------------------------------------------------------------
// ANSI-safe measurement / wrapping / clipping
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

/** Byte offset keeping the rightmost `width` display columns of a plain string. */
function chatKeepTail(s: string, width: number): number {
  const chars = [...s];
  let w = 0;
  let start = chars.length;
  while (start > 0) {
    const cp = chars[start - 1]!.codePointAt(0) ?? 0;
    const cw = charWidth(cp);
    if (w + cw > width) break;
    w += cw;
    start -= 1;
  }
  const head = chars.slice(0, start).join("");
  return head.length;
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

/** Right-truncate by display width, keeping ANSI, ellipsis when clipped. */
function truncateWidth(s: string, width: number): string {
  if (width <= 0) return "";
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
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > width - 1) return `${out}…`;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out.length === s.length ? s : out;
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
// palette
// ---------------------------------------------------------------------------

const COLOR = useColor();

// 256-color numbers used on painted (raised) rows.
// bright ANSI colors map to xterm codes 8-15; bg 233 ≈ #121212 (opencode
// background.raised #141414), bg 234 = one step lighter for the active row.
const N_ACCENT = 12; // Build agent / active bar
const N_PLAN = 13; // Plan agent
const N_WARN = 11; // effort / warnings
const N_GRAY = 8; // border / muted / hints
const N_WHITE = 15; // strong text (model name)
const BG_BOX = 233; // prompt panel background
const BG_ACTIVE = 234; // selected popup row background

/** SGR that resets style then applies optional 256 fg + 256 bg. */
function sgr(fg: number | null, bg: number | null = BG_BOX): string {
  if (!COLOR) return "";
  const parts = ["0"];
  if (fg !== null) parts.push(`38;5;${fg}`);
  if (bg !== null) parts.push(`48;5;${bg}`);
  return `\x1b[${parts.join(";")}m`;
}

const cc = {
  dim: (s: string) => (COLOR ? ansi.dim(s) : s),
  gray: (s: string) => (COLOR ? `\x1b[90m${s}${RESET}` : s),
  red: (s: string) => (COLOR ? ansi.red(s) : s),
  green: (s: string) => (COLOR ? ansi.green(s) : s),
  cyan: (s: string) => (COLOR ? ansi.cyan(s) : s),
  accent: (s: string) => (COLOR ? `\x1b[94m${s}${RESET}` : s),
  planCol: (s: string) => (COLOR ? `\x1b[95m${s}${RESET}` : s),
  bold: (s: string) => (COLOR ? `${BOLD}${s}${RESET}` : s),
  inv: (s: string) => (COLOR ? `${INV}${s}${RESET}` : s),
};

// ---------------------------------------------------------------------------
// wordmark — opencode-style lowercase block letters
// ---------------------------------------------------------------------------

// Glyph semantics (opencode logo font): each letter is 4 columns; "_" is a
// hollow counter (a shadowed-background space), "^" a filled top (▀ painted
// over the hollow bg), "~" a shadowed top line. Row 0 carries ascender marks.
// Letters cover "familiar harness": o r b i t h a e s (+n for future words).
const WM_GLYPHS: Record<string, string[]> = {
  o: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
  r: ["    ", "█▀▀▄", "█▀__", "▀▀▀▀"],
  b: ["▄   ", "█▀▀█", "█__█", "▀▀▀▀"],
  i: [" ▄  ", " █  ", " █  ", " ▀  "],
  t: [" ▄  ", "▀▀▀▀", " █  ", " ▀  "],
  h: ["▄   ", "█▀▀▄", "█__█", "▀~~▀"],
  a: ["    ", "▄▀▀█", "█__█", "▀~~▀"],
  e: ["    ", "█▀▀█", "█^^^", "▀▀▀▀"],
  s: ["    ", "▄▀▀▀", "▀▀▄_", "▄▄▄▀"],
  n: ["    ", "█▀▀█", "█__█", "▀~~▀"],
};

const BLANK_GLYPH = ["    ", "    ", "    ", "    "] as const;

/** One glyph row of one word half. */
function markHalf(word: string, row: number, rightHalf: boolean): string {
  const line = [...word].map((ch) => (WM_GLYPHS[ch] ?? BLANK_GLYPH)[row]).join(" ");
  if (!COLOR) return line.replace(/[_^~]/g, " ").replace(/ +$/, "");
  // left half: dim gray glyphs with #333 shadow · right half: default fg
  const shadow = rightHalf ? "\x1b[38;5;238m" : "\x1b[38;5;235m";
  const hollow = rightHalf ? "\x1b[48;5;238m" : "\x1b[48;5;235m";
  const fg = rightHalf ? "" : "\x1b[90m";
  let out = "";
  for (const char of [...line]) {
    if (char === "_") out += `${hollow} ${RESET}`;
    else if (char === "^") out += `${fg}${hollow}▀${RESET}`;
    else if (char === "~") out += `${shadow}▀${RESET}`;
    else if (char === " ") out += " ";
    else out += `${fg}${char}${RESET}`;
  }
  return out;
}

/** Two-tone wordmark rows (opencode exit-splash style). */
function markRows(withHarness: boolean): string[] {
  const rows: string[] = [];
  for (let row = 0; row < 4; row++) {
    let line = markHalf("familiar", row, false);
    if (withHarness) {
      const right = markHalf("harness", row, true);
      if (right !== "") line += ` ${right}`;
    }
    rows.push(line.replace(/ +$/, ""));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// transcript blocks
// ---------------------------------------------------------------------------

type Block =
  | { kind: "user"; text: string; mode?: string }
  | { kind: "assistant"; src: string; lines: string[] | null; done: boolean; lastRender: number }
  | { kind: "reasoning"; text: string; done?: boolean; expanded?: boolean }
  | { kind: "tool"; name: string; detail: string; status: "run" | "ok" | "err"; ms?: number; extra?: string[]; toolCallId?: string }
  | { kind: "info"; text: string };

function blockLines(b: Block, width: number): string[] {
  switch (b.kind) {
    case "user": {
      // opencode-style bordered user message: agent-colored ┃ on every row
      const bar = b.mode === "plan" ? cc.planCol("┃") : cc.accent("┃");
      return wrapAnsi(b.text, Math.max(8, width - 3)).map((l) => `${bar} ${l}`);
    }
    case "assistant":
      return b.lines ?? [];
    case "reasoning": {
      // ◌ = still streaming; · = closed (message/turn ended)
      const mark = b.done ? cc.gray("·") : cc.gray("◌");
      if (!b.expanded) {
        // collapsed: header only — click the row to reveal the text
        return [`${mark} ${cc.gray("thinking…")} ${cc.dim(`(+${b.text.length} chars — click to view)`)}`];
      }
      const out = [`${mark} ${cc.gray("thinking…")} ${cc.dim("(click to collapse)")}`];
      for (const piece of b.text.split("\n")) {
        if (piece !== "") out.push(...wrapAnsi(cc.dim(piece), width));
      }
      return out;
    }
    case "tool": {
      const mark = b.status === "run" ? cc.gray("●") : b.status === "ok" ? cc.green("✓") : cc.red("✗");
      let head = `${mark} ${cc.cyan(b.name)}`;
      if (b.detail) head += ` ${cc.gray(`· ${b.detail}`)}`;
      if (b.status === "ok" && b.ms !== undefined) head += `  ${cc.gray(`${b.ms}ms`)}`;
      const lines = [...wrapAnsi(head, width)];
      for (const l of b.extra ?? []) lines.push(...wrapAnsi(l, width));
      return lines;
    }
    case "info":
      return b.text === ""
        ? []
        : b.text.split("\n").flatMap((piece) => (piece === "" ? [""] : wrapAnsi(cc.gray(piece), width)));
  }
}

// ---------------------------------------------------------------------------
// slash-command catalog (shared by the line REPL /help and the TUI menu)
// ---------------------------------------------------------------------------

export interface TuiCommand {
  name: string;
  desc: string;
  /** command takes an argument: completion ends in "name " instead of running */
  needsArg?: boolean;
}

export const TUI_COMMANDS: TuiCommand[] = [
  { name: "/help", desc: "show the command list" },
  { name: "/new", desc: "new session with the configured defaults" },
  { name: "/sessions", desc: "switch session from a list" },
  { name: "/session", desc: "switch to a session (id)", needsArg: true },
  { name: "/models", desc: "pick provider/model from a list" },
  { name: "/rename", desc: "rename this session", needsArg: true },
  { name: "/effort", desc: "reasoning effort low|medium|high|off", needsArg: true },
  { name: "/cwd", desc: "change the working folder", needsArg: true },
  { name: "/plan", desc: "toggle plan mode" },
  { name: "/todo", desc: "show the session task list" },
  { name: "/retry", desc: "resend the previous message" },
  { name: "/export", desc: "dump the transcript as markdown", needsArg: true },
  { name: "/clear", desc: "clear the transcript" },
  { name: "/exit", desc: "quit (also /quit, /q)" },
];

// model catalog fed by the caller (config provider names + models.list RPC)
export interface TuiModelEntry {
  provider: string;
  id: string;
  contextTokens?: number;
}

export interface TuiModelGroup {
  provider: string;
  models: TuiModelEntry[];
  error?: string;
}

/** One recent session (fed by the caller via session.list). */
export interface TuiSessionSummary {
  id: string;
  title: string;
  provider: string;
  model: string;
  cwd: string;
  updatedAt: number;
}

/** One flat popup row. */
type PopupRow =
  | { kind: "header"; text: string }
  | { kind: "cmd"; cmd: TuiCommand }
  | { kind: "model"; entry: TuiModelEntry }
  | { kind: "session"; entry: TuiSessionSummary };

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const PLACEHOLDERS = ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"];

const NAV_KEYS = new Set([
  "up", "down", "left", "right", "pageup", "pagedown", "home", "end",
  "escape", "delete", "tab",
]);

export interface TuiInfo {
  app: string;
  title: string;
  provider: string;
  model: string;
  mode: "build" | "plan" | string;
  effort?: string;
  cwd: string;
  /** current session id (marks the ● row in the session picker) */
  sessionId?: string;
}

// prompt metadata row (inside the raised panel), width-budgeted like
// opencode's promptMetadataLayout: first candidate that fits, else truncate.
function metadataRow(info: TuiInfo, width: number): string {
  type Piece = { text: string; fg: number | null; bold?: boolean };
  const agentLabel = info.mode === "plan" ? "Plan" : "Build";
  const agentFg = info.mode === "plan" ? N_PLAN : N_ACCENT;
  const head: Piece[] = [
    { text: agentLabel, fg: agentFg },
    { text: "·", fg: N_GRAY },
    { text: info.model === "" ? "-" : info.model, fg: N_WHITE },
  ];
  const provider = info.provider && info.provider !== "" ? [{ text: info.provider, fg: N_GRAY }] : [];
  const effort = info.effort && info.effort !== "" ? [{ text: info.effort, fg: N_WARN, bold: true }] : [];
  // candidates: full → drop provider (all fragments are ASCII)
  const candidates: Piece[][] = [
    [...head, ...provider, ...effort],
    [...head, ...effort],
  ];
  const plainW = (list: Piece[]) => list.map((p) => p.text).join(" ").length;
  let chosen = candidates[1]!;
  for (const cand of candidates) {
    if (plainW(cand) <= width) {
      chosen = cand;
      break;
    }
  }
  if (plainW(chosen) > width) {
    // last resort: truncate the model id
    const fixed = plainW(chosen) - chosen[2]!.text.length;
    chosen[2]!.text = truncateWidth(chosen[2]!.text, Math.max(3, width - fixed - 1));
  }
  let out = "";
  for (const p of chosen) {
    out += `${sgr(p.fg, BG_BOX)}${p.bold ? `${BOLD}${p.text}` : p.text}${RESET}`;
    out += COLOR ? `${sgr(null, BG_BOX)} ` : " ";
  }
  return out;
}

export class FullScreenTui {
  private blocks: Block[] = [];
  private flowCache: string[] | null = null;
  /** flow line index → the block that rendered it (for click-to-toggle) */
  private flowBlockAt = new Map<number, Block>();
  private width = 80;
  private height = 24;
  private prevRows: (string | null)[] = [];
  private lastFlowLen: number | null = null;
  private input = "";
  private scrollOffset = 0;
  private busy = false;
  private startedAt = 0;
  private usage = { prompt: 0, completion: 0 };
  private info: TuiInfo = {
    app: "Familiar Harness", title: "", provider: "", model: "", mode: "build", cwd: "",
  };
  private placeholder: string = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]!;
  private running = false;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly think = new ThinkingFilter();
  private toolCount = 0;
  private assistantStream: Block & { kind: "assistant" } | null = null;
  private reasoningStream: Block & { kind: "reasoning" } | null = null;
  // popups: slash-command suggestions ("commands"), the model picker
  // ("models") or the session switcher ("sessions")
  private popupKind: "commands" | "models" | "sessions" | null = null;
  private cmdItems: TuiCommand[] = [];
  private modelGroups: TuiModelGroup[] = [];
  private sessions: TuiSessionSummary[] = [];
  private popupSel = 0;
  /** 0-based screen row → absolute popup row index (for mouse clicks) */
  private popupRowAt: number[] = [];
  /** transient notice rendered above the prompt panel until the timer expires */
  private toastMsg = "";
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** caller hook: Tab pressed with no popup open (= toggling build/plan) */
  onModeToggle?: () => void;
  /** caller hook: a model is picked in the /models popup */
  onModelPick?: (provider: string, model: string) => void | Promise<void>;
  /** caller hook: a session is picked in the /sessions popup */
  onSessionPick?: (id: string) => void | Promise<void>;
  /** caller hook: Esc pressed while streaming (≈ "stop the turn") */
  onAbortTurn?: () => void | Promise<void>;
  /** double ctrl+c to quit: armed after the first press (toast hint) */
  private ctrlCArmed = false;
  private ctrlCTimer: NodeJS.Timeout | null = null;
  /** pending tool approval (y/N prompt rendered into the prompt panel) */
  private approvalReq: { tool: string; summary: string } | null = null;
  private approvalResolve: ((ok: boolean) => void) | null = null;

  /** Ask the user to approve a tool call (replaces the readline prompt the
   * plain CLI uses, which would fight the full-screen TUI over stdin). */
  requestApproval(req: { tool: string; summary: string }): Promise<boolean> {
    if (this.approvalResolve !== null) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.approvalResolve = resolve;
      this.approvalReq = { tool: req.tool, summary: req.summary };
      this.frame();
    });
  }

  private answerApproval(ok: boolean): void {
    const resolve = this.approvalResolve;
    this.approvalResolve = null;
    this.approvalReq = null;
    resolve?.(ok);
    this.frame();
  }

  // ---- lifecycle ---------------------------------------------------------

  start(): void {
    this.running = true;
    this.refreshSize();
    // ?25l is intentionally NOT used: a hidden cursor leaves CJK IME
    // candidate windows anchored at the screen corner (unusable input).
    process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[2J\x1b[6 q");
    this.applyTitle();
    this.frame();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.ctrlCTimer) {
      clearTimeout(this.ctrlCTimer);
      this.ctrlCTimer = null;
    }
    this.ctrlCArmed = false;
    this.clearFrameTimer();
    process.stdout.write("\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[0 q\x1b[?1049l");
  }

  /** OSC 0 terminal title, updated alongside the session metadata. */
  private applyTitle(): void {
    if (!process.stdout.isTTY) return;
    const home = process.env.HOME ?? "";
    let label = this.info.cwd;
    if (home && label.startsWith(home)) label = `~${label.slice(home.length)}`;
    process.stdout.write(`\x1b]0;familiar — ${this.info.title || label}\x07`);
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

  setUserLine(text: string, mode?: string): void {
    this.blocks.push({ kind: "user", text, mode });
    this.frameSoon();
  }

  setInfo(text: string): void {
    if (text.trim() === "") return;
    this.blocks.push({ kind: "info", text: text.replace(/^\n+|\s+$/g, "") });
    this.frameSoon();
  }

  /** Transient notice above the prompt panel (auto-hides). */
  toast(text: string, ms = 2600): void {
    this.toastMsg = text;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastMsg = "";
      this.toastTimer = null;
      this.frame();
    }, ms);
    this.frame();
  }

  clearToast(): void {
    this.toastMsg = "";
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
  }

  /** Bracketed paste: insert pasted text into the editor (breaks/tabs flattened). */
  pasteText(text: string): void {
    if (!this.running || text === "") return;
    const normalized = text
      .replace(/\r\n?/g, "\n")
      .replace(/[\n\t]+/g, " ") // single-line editor; keep content, drop breaks
      .replace(/[ ]{2,}/g, " ")
      .slice(0, 8000);
    if (normalized === "" || this.input.length + normalized.length > 8000) return;
    this.input += normalized;
    this.afterInputChanged();
    this.frame();
  }

  setSessionInfo(info: Partial<TuiInfo>): void {
    const titleOrCwd = info.title !== undefined || info.cwd !== undefined;
    Object.assign(this.info, info);
    if (titleOrCwd) this.applyTitle();
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
    this.closePopup();
    this.frame();
  }

  clearTranscript(): void {
    this.blocks = [];
    this.flowCache = null;
    this.frame();
  }

  /** Persisted history ("familiar chat --session") loaded before start(). */
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

  // ---- model catalog (fed progressively from familiar.ts) -----------------------

  /** Land the selection on the current model (or the first entry). */
  private landSelection(): void {
    const flat = this.popupFlat() ?? [];
    let firstEntry = -1;
    let current = -1;
    for (let i = 0; i < flat.length; i++) {
      const r = flat[i];
      if (!r || r.kind !== "model") continue;
      if (firstEntry === -1) firstEntry = i;
      if (current === -1 && this.isCurrent(r.entry)) current = i;
    }
    this.popupSel = current !== -1 ? current : firstEntry !== -1 ? firstEntry : 0;
  }

  /** Groups arrive with models referencing their own provider; normalize so
   * every entry carries the group's provider id (models.list may omit it). */
  setModelGroups(groups: readonly TuiModelGroup[]): void {
    this.modelGroups = groups.map((g) => ({
      provider: g.provider,
      error: g.error,
      models: g.models.map((m) => ({
        provider: g.provider,
        id: m.id,
        ...(m.contextTokens !== undefined ? { contextTokens: m.contextTokens } : {}),
      })),
    }));
    if (this.popupKind === "models") {
      const flat = this.popupFlat() ?? [];
      const onHeader = flat[this.popupSel]?.kind === "header";
      if (onHeader || this.popupSel >= flat.length) this.landSelection();
      this.frame();
    }
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
          toolCallId: event.toolCall.id,
        });
        this.frameSoon();
        break;
      }
      case "tool.result": {
        // match by id first: parallel task calls are all still "run" when the
        // first result lands and the newest-running rule paints the wrong card
        const byId = [...this.blocks].reverse().find(
          (b): b is Block & { kind: "tool" } =>
            b.kind === "tool" && b.status === "run" && b.toolCallId === event.toolCallId,
        );
        const tb =
          byId ??
          [...this.blocks].reverse().find(
            (b): b is Block & { kind: "tool" } => b.kind === "tool" && b.status === "run",
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
      case "turn.aborted":
        this.closeStreams();
        this.blocks.push({ kind: "info", text: "■ stopped" });
        this.toast("stopped");
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
    b.lines = out === "" ? [""] : out.replace(/\n+$/, "").split("\n");
    b.lastRender = Date.now();
  }

  private closeStreams(): void {
    if (this.assistantStream) {
      this.assistantStream.done = true;
      this.assistantStream.lines = null;
      this.reRenderAssistant(this.assistantStream);
      this.assistantStream = null;
    }
    if (this.reasoningStream) {
      this.reasoningStream.done = true;
      this.reasoningStream = null;
      this.frameSoon();
    }
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

  /** Render one frame: recompose and rewrite only the changed rows. */
  frame(): void {
    if (!this.running) return;
    this.refreshSize();
    this.flowCache = null; // blocks may have changed — rebuild the transcript
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
    // keep the real terminal cursor at the editor caret cell — IME candidate
    // windows and screen readers track it (hiding it breaks CJK input)
    out += this.cursorPosition();
    process.stdout.write(out);
  }

  /** Cursor placement for the prompt panel caret (1-based row;col). */
  private cursorPosition(): string {
    const bl = this.bottomHeight();
    const slim = this.height < 14;
    const row = this.height - bl + (slim ? 1 : 2);
    const { w: boxW, x } = this.boxLayout();
    const available = Math.max(1, boxW - 5);
    const vis = Math.min(available, visibleWidth(this.input));
    return `\x1b[${row};${x + 3 + vis}H\x1b[?25h`;
  }

  // ---- scrolling ------------------------------------------------------------

  private flow(): string[] {
    if (this.flowCache) return this.flowCache;
    const inner = Math.max(10, this.width - 5);
    for (const b of this.blocks) {
      if (b.kind === "assistant") this.reRenderAssistant(b);
    }
    const all: string[] = [];
    this.flowBlockAt = new Map();
    let flowIdx = 0;
    for (const b of this.blocks) {
      if (all.length > 0) {
        all.push("");
        flowIdx++;
      }
      for (const l of blockLines(b, inner)) {
        all.push(l);
        this.flowBlockAt.set(flowIdx, b);
        flowIdx++;
      }
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
    const view = Math.max(1, this.height - this.bottomHeight());
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
    const view = Math.max(1, this.height - this.bottomHeight());
    const max = Math.max(0, this.flow().length - view);
    this.scrollOffset = max;
    this.frame();
  }

  // ---- bottom area metrics ------------------------------------------------

  /** Rows below the transcript: [pad] editor meta [underline] hints. */
  private bottomHeight(): number {
    return this.height < 14 ? 3 : 5;
  }

  /** Prompt panel width + left origin (opencode: maxWidth 75, centered). */
  private boxLayout(): { w: number; x: number } {
    const boxW = Math.max(24, Math.min(75, this.width - 4));
    return { w: boxW, x: Math.floor((this.width - boxW) / 2) };
  }

  // ---- painting helpers ------------------------------------------------------

  /**
   * One painted panel row: pre-painted fragments (their visible widths must
   * fit `width`), then padding inside the raised background to the row end.
   */
  private panelRow(segs: string[], width: number, bg: number | null = BG_BOX): string {
    let body = "";
    let vis = 0;
    for (const s of segs) {
      const v = visibleWidth(s);
      if (vis + v > width) break;
      body += s;
      vis += v;
    }
    const pad = Math.max(0, width - vis);
    let row = "";
    if (COLOR && bg !== null) row += sgr(null, bg);
    row += body;
    if (COLOR && bg !== null) {
      if (pad > 0) row += sgr(null, bg) + " ".repeat(pad);
      row += RESET;
    } else {
      row += " ".repeat(pad);
    }
    return row;
  }

  /** Paint one popup/panel fragment with optional 256 fg (bg-confirmed). */
  private frag(fg: number | null, text: string, bold = false, bg: number | null = BG_BOX): string {
    if (!COLOR) return bold ? `${BOLD}${text}${RESET}` : text;
    return `${sgr(fg, bg)}${bold ? `${BOLD}${text}` : text}${RESET}`;
  }

  /** Background-painted gap (keeps the panel unbroken between fragments). */
  private gap(w: number): string {
    if (w <= 0) return "";
    return COLOR ? `${sgr(null, BG_BOX)}${" ".repeat(w)}` : " ".repeat(w);
  }

  /** Editor row fragment: accent bar + approval question / placeholder / text. */
  private editorFragment(boxW: number): string {
    const bar = this.info.mode === "plan"
      ? `${sgr(N_PLAN, BG_BOX)}┃`
      : `${sgr(N_ACCENT, BG_BOX)}┃`;
    if (this.approvalReq !== null) {
      const r = this.approvalReq;
      // summaries are already "tool: args" — avoid the double prefix
      const label = r.summary.startsWith(`${r.tool}:`) ? r.summary : `${r.tool}: ${r.summary}`;
      const q = `approve ${label}? (y/N)`;
      const text = truncateWidth(q, Math.max(1, boxW - 5));
      return `${bar}${RESET}  ${sgr(N_WHITE, BG_BOX)}${text}${RESET}`;
    }
    const available = Math.max(1, boxW - 5); // bar + 2 lead + cursor + margin
    if (this.input === "") {
      const ph = `Ask anything… "${this.placeholder}"`;
      const text = truncateWidth(ph, available);
      return `${bar}${RESET}  ${sgr(N_GRAY, BG_BOX)}${text}${RESET}`;
    }
    const clipped = padLine(this.input, available);
    return `${bar}${RESET}  ${sgr(N_WHITE, BG_BOX)}${clipped}${RESET}${COLOR ? sgr(null, BG_BOX) : ""}`;
  }

  /** Metadata row fragment (agent · model provider · effort). */
  private metaFragment(boxW: number): string {
    return metadataRow(this.info, Math.max(8, boxW - 4));
  }

  // ---- bottom fixed area ------------------------------------------------------

  /** The rows below the transcript area (opencode prompt + footer). */
  private composeBottom(): string[] {
    const { w: boxW, x: bx } = this.boxLayout();
    const slim = this.height < 14;
    const out: string[] = [];
    if (!slim) out.push(" ".repeat(bx) + this.panelRow([], boxW));
    out.push(" ".repeat(bx) + this.panelRow([this.editorFragment(boxW)], boxW));
    out.push(" ".repeat(bx) + this.panelRow([this.metaFragment(boxW)], boxW));
    if (!slim) {
      if (this.toastMsg !== "") {
        out.push(" ".repeat(bx) + this.panelRow([this.frag(N_GRAY, truncateWidth(this.toastMsg, boxW))], boxW));
      } else {
        out.push(" ".repeat(bx) + cc.gray("╹"));
      }
    }
    out.push(this.composeHints());
    return out;
  }

  /** Last row: left cwd/status, right keyboard hints (opencode footer row). */
  private composeHints(): string {
    const w = this.width;
    let left = "";
    if (this.toastMsg !== "" && this.height < 14) {
      left = cc.gray(truncateWidth(this.toastMsg, Math.max(4, Math.floor(w / 3))));
    } else if (this.busy) {
      const g = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length] ?? "⠋";
      left = cc.dim(`${g} ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`);
    } else if (this.info.cwd !== "") {
      // opencode footer: shorten $HOME to ~ and keep the tail when long
      let display = this.info.cwd;
      const home = process.env.HOME ?? "";
      if (home && display.startsWith(home)) display = `~${display.slice(home.length)}`;
      const maxW = Math.max(8, Math.floor(w / 3));
      if (visibleWidth(display) > maxW) {
        display = `…${display.slice(chatKeepTail(display, maxW - 1))}`;
      }
      left = cc.gray(display);
    }
    const pairs: Array<[string, string]> = this.approvalReq !== null
      ? [["y", "approve"], ["n", "deny"]]
      : this.popupKind
        ? [["enter", "select"], ["esc", "close"]]
        : this.busy
          ? [["esc", "stop"], ["ctrl+p", "commands"]]
          : [["tab", "switch agent"], ["ctrl+p", "commands"]];
    const render = ([key, label]: [string, string]): string =>
      this.popupKind ? ` ${label} ${cc.gray(key)} ` : ` ${key} ${cc.gray(label)} `;
    const hintStr = pairs.map(render).join(" ");
    const lw = visibleWidth(left);
    const rw = visibleWidth(hintStr);
    if (lw + rw > w - 2) {
      // narrow terminal: hints win
      return padLine(hintStr, w);
    }
    const mid = " ".repeat(Math.max(1, w - lw - rw));
    return padLine(left + mid + hintStr, w);
  }

  // ---- wordmark ------------------------------------------------------------

  /** Splash wordmark rows + width (null when the screen is too small). */
  private wordmark(): { rows: string[]; width: number; left: number } | null {
    const w = this.width;
    if (w < 28) return null;
    const rows = markRows(w >= 61);
    let total = 0;
    for (const r of rows) total = Math.max(total, visibleWidth(r));
    return { rows, width: total, left: Math.max(0, Math.floor((w - total) / 2)) };
  }

  // ---- compose ------------------------------------------------------------

  private compose(): string[] {
    const w = this.width;
    const h = this.height;
    const rows: string[] = new Array(h).fill("");
    const hasTranscript = this.blocks.length > 0;

    const bottom = this.composeBottom();
    const bottomH = bottom.length;
    const topH = Math.max(0, h - bottomH);

    if (hasTranscript) {
      // transcript fills the area above the prompt panel
      this.clampScroll();
      const flow = this.flow();
      const start = Math.max(0, flow.length - topH - this.scrollOffset);
      const window = flow.slice(start, start + topH);
      for (let i = 0; i < topH; i++) {
        let line = window[i] ?? "";
        if (i === 0 && start > 0) line = line === "" ? cc.dim("▲") : `${cc.dim("▲")} ${line}`;
        rows[i] = padLine(`  ${line}`, w);
      }
    } else {
      // startup splash: wordmark block pinned slightly above center
      // (opencode hides the logo on short terminals, h < 12)
      const mark = this.height >= 12 ? this.wordmark() : null;
      if (mark) {
        const blank = Math.max(0, topH - mark.rows.length - 1);
        let y = Math.floor(blank * 0.4);
        for (const m of mark.rows) {
          rows[y] = padLine(" ".repeat(mark.left) + m, w);
          y += 1;
        }
      }
    }

    for (let i = 0; i < bottomH; i++) rows[topH + i] = bottom[i] ?? padLine("", w);

    this.composePopupOverlay(rows, topH);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] === undefined || rows[i] === null) rows[i] = padLine("", w);
    }
    return rows as string[];
  }

  // ---- popups -------------------------------------------------------------

  /** Flat filtered popup rows for the active kind (null when closed). */
  private popupFlat(): PopupRow[] | null {
    if (this.popupKind === "commands") {
      return this.cmdItems.map((c): PopupRow => ({ kind: "cmd", cmd: c }));
    }
    if (this.popupKind === "sessions") {
      const q = this.input.trim().toLowerCase();
      const rows: PopupRow[] = [];
      const hit = (s: TuiSessionSummary): boolean =>
        q === "" ||
        `${s.title} ${s.id.slice(0, 8)} ${s.provider}/${s.model} ${s.cwd}`.toLowerCase().includes(q);
      const list = this.sessions.filter(hit);
      rows.push({ kind: "header", text: "Select session" });
      for (const s of list) rows.push({ kind: "session", entry: s });
      if (list.length === 0) rows.push({ kind: "header", text: q === "" ? "no sessions yet" : "no matching sessions" });
      return rows;
    }
    if (this.popupKind !== "models") return null;
    const q = this.input.trim().toLowerCase();
    const rows: PopupRow[] = [];
    if (this.modelGroups.length === 0) {
      rows.push({ kind: "header", text: "loading providers…" });
      return rows;
    }
    for (const g of this.modelGroups) {
      const matches = (id: string): boolean =>
        q === "" || `${g.provider}/${id}`.toLowerCase().includes(q) || id.toLowerCase().includes(q);
      const entries = g.models.filter((m) => matches(m.id));
      if (entries.length === 0 && q !== "" && g.models.length > 0) continue;
      rows.push({ kind: "header", text: g.error ? `${g.provider} · unavailable` : g.provider });
      for (const m of entries) {
        rows.push({ kind: "model", entry: m });
      }
      if (entries.length === 0 && g.error) rows.push({ kind: "header", text: `→ ${truncateWidth(g.error, 46)}` });
    }
    if (rows.length === 0) rows.push({ kind: "header", text: "no matching models" });
    return rows;
  }

  /** ● marker for the session's current model. */
  private isCurrent(e: TuiModelEntry): boolean {
    if (this.info.provider !== "" && e.provider !== this.info.provider) return false;
    return this.info.model === "" || e.id === this.info.model;
  }

  /** Open the /models picker (caller feeds groups via setModelGroups). */
  openModelsPopup(): void {
    this.popupKind = "models";
    this.input = ""; // opencode dialogs open with an empty query
    this.landSelection();
    this.frame();
  }

  /** Open the /sessions switcher (caller feeds the list here beforehand). */
  openSessionsPopup(list: readonly TuiSessionSummary[]): void {
    this.sessions = [...list];
    this.popupKind = "sessions";
    this.input = "";
    const flat = this.popupFlat() ?? [];
    let firstEntry = -1;
    let current = -1;
    for (let i = 0; i < flat.length; i++) {
      const r = flat[i];
      if (!r || r.kind !== "session") continue;
      if (firstEntry === -1) firstEntry = i;
      if (current === -1 && r.entry.id === this.info.sessionId) current = i;
    }
    this.popupSel = current !== -1 ? current : firstEntry !== -1 ? firstEntry : 0;
    this.frame();
  }

  /** Open the command palette (ctrl+p) or the slash-driven suggestion list. */
  openCommandPopup(): void {
    this.popupKind = "commands";
    this.popupSel = 0;
    this.refreshCmdItems(this.input);
    this.frame();
  }

  private closePopup(): void {
    if (this.popupKind === "models" || this.popupKind === "sessions") this.input = "";
    this.popupKind = null;
    this.cmdItems = [];
    this.popupSel = 0;
  }

  /** Re-filter the command popup list from the current editor text. */
  private refreshCmdItems(v: string): void {
    const q = v.toLowerCase();
    if (v.startsWith("/") && !v.includes(" ")) {
      this.cmdItems = TUI_COMMANDS.filter((c) => c.name.startsWith(q));
    } else {
      this.cmdItems = q === ""
        ? [...TUI_COMMANDS]
        : TUI_COMMANDS.filter(
            (c) => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q),
          );
    }
    if (this.cmdItems.length === 0) this.closePopup();
    if (this.popupSel >= this.cmdItems.length) this.popupSel = 0;
  }

  moveMenu(delta: number): void {
    const rows = this.popupFlat();
    if (!rows || rows.length === 0) return;
    let sel = this.popupSel;
    for (let step = 0; step < rows.length; step++) {
      sel = sel + delta;
      if (sel < 0) sel = rows.length - 1;
      if (sel >= rows.length) sel = 0;
      const r = rows[sel];
      if (r && r.kind !== "header") break;
    }
    this.popupSel = sel;
    this.frame();
  }

  /** Accept the highlighted popup row (Enter / Tab / click). */
  private acceptPopup(i: number): string | null {
    const rows = this.popupFlat();
    const len = rows?.length ?? 0;
    const r = len === 0 ? undefined : (rows ?? [])[Math.max(0, Math.min(i, len - 1))];
    if (!r || r.kind === "header") {
      // land on the nearest selectable row (headers are not selectable)
      const idx = r ? i : 0;
      for (let d = 1; d < len; d++) {
        const fwd = (idx + d) % len;
        if (rows![fwd] && rows![fwd]!.kind !== "header") return this.acceptPopup(fwd);
      }
      for (let d = 1; d < len; d++) {
        const back = ((idx - d) % len + len) % len;
        if (rows![back] && rows![back]!.kind !== "header") return this.acceptPopup(back);
      }
      return null;
    }
    if (r.kind === "cmd") {
      const c = r.cmd;
      this.closePopup();
      this.input = "";
      if (c.needsArg) {
        // completion only: keep waiting for the argument
        this.input = `${c.name} `;
        this.frame();
        return null;
      }
      this.frame();
      return c.name;
    }
    // model / session picked — dispatch through the caller hooks
    this.closePopup();
    this.frame();
    if (r.kind === "session") {
      void this.onSessionPick?.(r.entry.id);
      return null;
    }
    const e = r.entry;
    void this.onModelPick?.(e.provider, e.id);
    return null;
  }

  /** Render the popup as a centered raised panel above the prompt box. */
  private composePopupOverlay(rows: string[], topH: number): void {
    this.popupRowAt = [];
    if (!this.popupKind) return;
    const flat = this.popupFlat();
    if (!flat || flat.length === 0) return;
    const w = this.width;
    const { x: px } = this.boxLayout();
    const pw = this.boxLayout().w;
    const avail = topH; // rows above the prompt panel
    if (avail < 3) return; // no room even for the panel skeleton
    const headerH = avail >= 5 ? 1 : 0; // title row when there is room
    const hintH = 1;
    const listH = Math.max(1, Math.min(flat.length, avail - headerH - hintH));
    const panelH = headerH + listH + hintH;
    const startY = topH - panelH;
    const from = Math.max(0, Math.min(this.popupSel - (listH - 1), flat.length - listH));
    const B = sgr(null, BG_BOX);

    // title row
    let y = startY;
    if (headerH > 0) {
      const titleText = this.popupKind === "models"
        ? "Select model"
        : this.popupKind === "sessions"
          ? "Select session"
          : "Select a command";
      const title = this.frag(N_WHITE, titleText, true);
      const esc = this.gap(1) + this.frag(N_GRAY, "esc");
      const used = visibleWidth(title) + visibleWidth(esc) + 2;
      const midGap = Math.max(1, pw - used - 1);
      rows[y] = " ".repeat(px) + this.panelRow([this.gap(2), title, this.gap(midGap), esc, this.gap(1)], pw);
      y += 1;
    }

    // list rows
    for (let i = 0; i < listH; i++) {
      const abs = from + i;
      const r = flat[abs];
      const selected = abs === this.popupSel;
      const bg = selected ? BG_ACTIVE : BG_BOX;
      if (!r) continue;
      let segs: string[];
      if (r.kind === "header") {
        segs = [
          this.gap(2),
          this.frag(N_GRAY, truncateWidth(r.text, pw - 5), false, bg),
        ];
      } else if (r.kind === "model") {
        const e = r.entry;
        const ctx = e.contextTokens ? fmtCtx(e.contextTokens) : "";
        segs = [
          selected ? this.frag(N_ACCENT, "┃", false, bg) : this.gap(1),
          this.isCurrent(e) ? this.frag(N_ACCENT, "●", false, bg) : this.gap(1),
          this.gap(1),
          this.frag(null, truncateWidth(e.id, Math.max(3, pw - 12)), false, bg),
          ...(ctx ? [this.gap(2), this.frag(N_GRAY, ctx, false, bg)] : []),
        ];
      } else if (r.kind === "session") {
        // ┃● <title  id> <model provider> ………… <2m ago>
        const s = r.entry;
        const when = tsRel(s.updatedAt);
        const pm = `${s.model} ${s.provider}`.trim();
        const rightW = visibleWidth(pm) + 1 + when.length; // + separator
        const labelBudget = Math.max(10, pw - 10 - rightW);
        const head =
          s.title && s.title !== ""
            ? truncateWidth(s.title, labelBudget)
            : `session ${s.id.slice(0, 8)}`;
        const tail = `  ${s.id.slice(0, 8)}`;
        const label = padLine(head + tail, labelBudget);
        const labelW = visibleWidth(label);
        const stretch = Math.max(1, pw - 2 - labelW - 1 - visibleWidth(pm) - 1 - when.length);
        segs = [
          selected ? this.frag(N_ACCENT, "┃", false, bg) : this.gap(1),
          s.id === this.info.sessionId ? this.frag(N_ACCENT, "●", false, bg) : this.gap(1),
          this.gap(1),
          this.frag(null, label, false, bg),
          this.gap(1),
          this.frag(N_GRAY, truncateWidth(pm, Math.max(6, pw - 14 - labelW)), false, bg),
          this.gap(stretch),
          this.frag(N_GRAY, when, false, bg),
        ];
      } else {
        const c = r.cmd;
        const bar = selected ? this.frag(N_ACCENT, "┃", false, bg) : this.gap(1);
        const desc = c.desc
          ? this.frag(N_GRAY, truncateWidth(c.desc, Math.max(0, pw - c.name.length - 9)), false, bg)
          : "";
        segs = [bar, this.gap(1), this.frag(null, c.name, false, bg), this.gap(2) + desc];
      }
      rows[y] = " ".repeat(px) + this.panelRow(segs, pw, bg);
      if (r.kind !== "header") this.popupRowAt[y] = abs;
      y += 1;
    }

    // footer hint row: left "close esc" · right "select enter"
    const leftSegs = [this.gap(2), this.frag(null, "close"), this.gap(1), this.frag(N_GRAY, "esc")];
    const rightSegs = [this.frag(null, "select"), this.gap(1), this.frag(N_GRAY, "enter"), this.gap(1)];
    const leftW = visibleWidth(leftSegs.join(""));
    const rightW = visibleWidth(rightSegs.join(""));
    const midGap = Math.max(1, pw - leftW - rightW);
    rows[y] = " ".repeat(px) + this.panelRow([...leftSegs, this.gap(midGap), ...rightSegs], pw);
  }

  // ---- mouse --------------------------------------------------------------

  /** Mouse click (SGR): accept the popup row under it; outside → close. */
  click(row: number, _col: number): string | null {
    const abs = this.popupRowAt[row - 1];
    if (abs === undefined) {
      // opencode dialogs close when you click outside them
      if (this.popupKind) {
        this.closePopup();
        this.frame();
        return null;
      }
      // transcript rows: click a reasoning block to toggle its text
      const block = this.flowBlockAt.get(this.flowRowOf(row));
      if (block && block.kind === "reasoning" && block.text.length > 0) {
        block.expanded = !block.expanded;
        this.flowCache = null;
        this.frame();
      }
      return null;
    }
    this.popupSel = abs;
    return this.acceptPopup(abs);
  }

  /** map a 1-based screen row to the flow line index (scroll-aware) */
  private flowRowOf(row: number): number {
    const view = Math.max(1, this.height - this.bottomHeight());
    const flow = this.flow();
    const start = Math.max(0, flow.length - view - this.scrollOffset);
    return start + (row - 1);
  }

  /** Mouse wheel (SGR 1006): "<64 b ; c ; r M" up / "<65 … M" down. */
  wheel(sequence: string): boolean {
    const m = /^\x1b\[<(64|65);\d+;\d+M$/.exec(sequence);
    if (!m) return false;
    if (this.popupKind) {
      this.moveMenu(m[1] === "64" ? -1 : 1);
      return true;
    }
    this.scroll((m[1] === "64" ? -1 : 1) * 3);
    return true;
  }

  // ---- editor / keys ---------------------------------------------------------

  /** Handle a keypress; returns the submitted line, "quit" or null. */
  key(key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }): string | null {
    if (key.ctrl && key.name === "c") {
      // two ctrl+c within 2s quit the TUI (one press only shows a hint)
      if (this.ctrlCArmed) {
        this.ctrlCArmed = false;
        if (this.ctrlCTimer) {
          clearTimeout(this.ctrlCTimer);
          this.ctrlCTimer = null;
        }
        this.clearToast();
        return "\x03";
      }
      this.ctrlCArmed = true;
      this.toast("press ctrl+c again to exit", 2000);
      if (this.ctrlCTimer) clearTimeout(this.ctrlCTimer);
      this.ctrlCTimer = setTimeout(() => {
        this.ctrlCArmed = false;
        this.ctrlCTimer = null;
        this.frame();
      }, 2000);
      return null;
    }
    // a pending approval swallows every key except y / n (= deny / esc-like)
    if (this.approvalResolve !== null) {
      const seq = (key.sequence ?? "").toLowerCase();
      if (key.name === "y" || seq === "y") this.answerApproval(true);
      else if (key.name === "n" || seq === "n" || key.name === "escape" || seq === "\x1b") {
        this.answerApproval(false);
      }
      return null;
    }
    if (key.ctrl && key.name === "l") {
      this.repaint();
      return null;
    }
    if (key.ctrl && key.name === "u") {
      this.clearInput();
      return null;
    }
    if (key.ctrl && key.name === "p") {
      this.openCommandPopup();
      return null;
    }
    switch (key.name) {
      case "escape":
        if (this.popupKind) {
          this.closePopup();
          this.frame();
          return null;
        }
        if (this.busy) {
          // opencode footer "esc stop": abort the running turn
          void this.onAbortTurn?.();
          return null;
        }
        return null;
      case "return":
      case "enter": {
        if (this.popupKind) {
          return this.acceptPopup(this.popupSel);
        }
        const line = this.input;
        this.input = "";
        return line;
      }
      case "backspace":
        if (this.input.length > 0) {
          this.input = [...this.input].slice(0, -1).join("");
          this.afterInputChanged();
          this.frame();
        }
        return null;
      case "up":
        if (this.popupKind) {
          this.moveMenu(-1);
          return null;
        }
        this.scroll(-1);
        return null;
      case "down":
        if (this.popupKind) {
          this.moveMenu(1);
          return null;
        }
        this.scroll(1);
        return null;
      case "tab":
        if (this.popupKind) {
          return this.acceptPopup(this.popupSel);
        }
        // no popup → toggle Build/Plan (caller owns the mode state)
        this.onModeToggle?.();
        return null;
      case "pageup":
        this.scroll(-(this.height - this.bottomHeight() - 1));
        return null;
      case "pagedown":
        this.scroll(this.height - this.bottomHeight() - 1);
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
      if (this.scrollOffset !== 0 && this.flow().length > this.height - this.bottomHeight()) {
        this.scrollEnd();
      }
      this.input += key.sequence;
      this.afterInputChanged();
      this.frame();
    }
    return null;
  }

  /** Re-filter the active popup after the editor text changed. */
  private afterInputChanged(): void {
    if (this.popupKind === "commands") {
      this.refreshCmdItems(this.input);
      if (this.popupKind !== "commands") {
        // list emptied by filtering — reopened nothing
      }
    } else if (this.popupKind === "models") {
      if (this.popupSel >= (this.popupFlat()?.length ?? 0)) this.popupSel = 0;
    } else if (this.input.startsWith("/") && !this.input.includes(" ")) {
      this.openCommandPopup();
    }
  }
}

function fmtCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}k`;
  return String(tokens);
}

/** Short relative timestamp for the session picker ("now", "5m ago", "3d ago"). */
function tsRel(ms: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
