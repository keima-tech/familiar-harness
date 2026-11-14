import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type {
  ChatMessage,
  SessionRecord,
  SessionRemote,
  ToolCall,
} from "@familiar/protocol";
import { repairToolArguments } from "../providers/tool-args.js";
import type { FileChange } from "../tools/registry.js";
import { ensureDir } from "../paths.js";

/** One hit from cross-session full-text search. */
export interface SessionSearchHit {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  role: string;
  seq: number;
  createdAt: number;
  /** Matched excerpt; the match is wrapped in << >>. */
  snippet: string;
}

/**
 * SQLite-backed session persistence (node:sqlite, zero native deps).
 * Interface kept narrow so backing store can be swapped (spec 06 risk table).
 */
export interface SessionStore {
  createSession(opts: {
    title?: string;
    provider: string;
    model: string;
    profile?: string;
    effort?: string;
    cwd: string;
    /** ssh proxy target: tools run on this host instead of locally */
    remote?: SessionRemote;
  }): SessionRecord;
  getSession(id: string): SessionRecord | null;
  listSessions(): SessionRecord[];
  appendMessage(sessionId: string, msg: ChatMessage): void;
  getMessages(sessionId: string): ChatMessage[];
  /**
   * Repair malformed tool-call arguments in stored messages (un-poisons a
   * session that a truncated stream left unable to reach the provider).
   */
  repairToolCallArguments(sessionId: string): number;
  /**
   * Drop every message after the first `keep` ones (seq >= keep). Used to undo
   * the messages an attempt appended before it failed — e.g. the user message
   * of a turn that a provider 400 aborted before any answer.
   */
  truncateMessages(sessionId: string, keep: number): number;
  /** Replace the whole message history in one transaction (manual compaction). */
  replaceMessages(sessionId: string, messages: ChatMessage[]): void;
  /** Set/update the title (used for first user message). */
  renameSession(id: string, title: string): void;
  /** Patch session options (title / provider / model / profile / cwd / effort). Returns the updated record. */
  updateSession(
    id: string,
    patch: {
      title?: string;
      provider?: string;
      model?: string;
      /** `null` clears the profile. */
      profile?: string | null;
      /** absolute path of the working directory */
      cwd?: string;
      /** reasoning effort: "low" | "medium" | "high"; "" / null clears */
      effort?: string | null;
    },
  ): SessionRecord | null;
  deleteSession(id: string): boolean;
  /**
   * Persist reversible file mutations (write/edit) for one turn so `/undo`
   * can restore the previous state.
   */
  recordFileEdits(sessionId: string, turnId: string, changes: FileChange[]): void;
  /**
   * The most recent turn that still has recorded edits, newest edit first so
   * repeated edits to one file revert in the right order. Null when nothing is
   * left to undo.
   */
  peekUndoTurn(sessionId: string): { turnId: string; changes: FileChange[] } | null;
  /** Forget a turn's edits once they have been applied (or abandoned). */
  dropTurnFileEdits(sessionId: string, turnId: string): number;
  /** Cross-session full-text search over message bodies (newest first). */
  searchMessages(query: string, limit?: number): SessionSearchHit[];
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  profile TEXT,
  effort TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL,
  remote TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  name TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE TABLE IF NOT EXISTS file_edits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  before TEXT,
  after TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_edits_session ON file_edits(session_id, seq);
-- Full-text search over message bodies. trigram tokenizer so Japanese substring
-- queries work (unicode61 would treat a whole CJK run as one token).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

interface SessionRow {
  id: string;
  title: string;
  provider: string;
  model: string;
  profile: string | null;
  cwd: string;
  remote: string | null;
  created_at: number;
  updated_at: number;
  effort: string | null;
}

interface SearchRow {
  messageId: string;
  sessionId: string;
  role: string;
  seq: number;
  createdAt: number;
  title: string | null;
  snippet: string;
}

/** Shape a raw search row into a SessionSearchHit. */
function toHit(r: SearchRow): SessionSearchHit {
  return {
    sessionId: r.sessionId,
    sessionTitle: r.title ?? "",
    messageId: r.messageId,
    role: r.role,
    seq: r.seq,
    createdAt: r.createdAt,
    snippet: r.snippet ?? "",
  };
}

/** Build a `<<match>>` excerpt for the LIKE fallback path. */
function makeSnippet(body: string, needle: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const idx = needle ? flat.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (idx === -1) return flat.slice(0, 160);
  const start = Math.max(0, idx - 60);
  const end = Math.min(flat.length, idx + needle.length + 80);
  const excerpt = flat.slice(start, end);
  const marked = excerpt.replace(
    new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    (m) => `<<${m}>>`,
  );
  return (start > 0 ? "…" : "") + marked + (end < flat.length ? "…" : "");
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    ensureDir(path.dirname(file));
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    // migration: pre-v1.1 databases lack the effort column
    const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "effort")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN effort TEXT NOT NULL DEFAULT ''`);
    }
    // migration: ssh proxy sessions carry a remote target (JSON)
    if (!cols.some((c) => c.name === "remote")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN remote TEXT`);
    }
    // backfill the FTS index for messages written before messages_fts existed
    const msgCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
    const ftsCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM messages_fts`).get() as { n: number }).n;
    if (ftsCount !== msgCount) {
      this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
    }
  }

  createSession(opts: {
    title?: string;
    provider: string;
    model: string;
    profile?: string;
    effort?: string;
    cwd: string;
    remote?: SessionRemote;
  }): SessionRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, provider, model, profile, effort, cwd, remote, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.title ?? "",
        opts.provider,
        opts.model,
        opts.profile ?? null,
        opts.effort ?? "",
        opts.cwd,
        opts.remote ? JSON.stringify(opts.remote) : null,
        now,
        now,
      );
    return {
      id,
      title: opts.title ?? "",
      provider: opts.provider,
      model: opts.model,
      profile: opts.profile,
      ...(opts.effort ? { effort: opts.effort } : {}),
      cwd: opts.cwd,
      ...(opts.remote ? { remote: opts.remote } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  listSessions(): SessionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`).all() as unknown as SessionRow[];
    return rows.map(toRecord);
  }

  renameSession(id: string, title: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, Date.now(), id);
  }

  updateSession(
    id: string,
    patch: {
      title?: string;
      provider?: string;
      model?: string;
      profile?: string | null;
      cwd?: string;
      /** "low" | "medium" | "high"; "" / null clears */
      effort?: string | null;
    },
  ): SessionRecord | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.provider !== undefined) {
      sets.push("provider = ?");
      values.push(patch.provider);
    }
    if (patch.model !== undefined) {
      sets.push("model = ?");
      values.push(patch.model);
    }
    if (patch.profile !== undefined) {
      sets.push("profile = ?");
      values.push(patch.profile);
    }
    if (patch.cwd !== undefined) {
      sets.push("cwd = ?");
      values.push(patch.cwd);
    }
    if (patch.effort !== undefined) {
      sets.push("effort = ?");
      values.push(patch.effort ?? "");
    }
    if (sets.length === 0) return this.getSession(id);
    sets.push("updated_at = ?");
    values.push(Date.now());
    this.db
      .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
    return this.getSession(id);
  }

  deleteSession(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM file_edits WHERE session_id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  recordFileEdits(sessionId: string, turnId: string, changes: FileChange[]): void {
    if (changes.length === 0) return;
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO file_edits (id, session_id, turn_id, seq, path, before, after, created_at)
       VALUES (?, ?, ?, COALESCE((SELECT MAX(seq) + 1 FROM file_edits WHERE session_id = ?), 0), ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const c of changes) {
        insert.run(crypto.randomUUID(), sessionId, turnId, sessionId, c.path, c.before, c.after, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  peekUndoTurn(sessionId: string): { turnId: string; changes: FileChange[] } | null {
    const last = this.db
      .prepare(`SELECT turn_id FROM file_edits WHERE session_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(sessionId) as { turn_id: string } | undefined;
    if (!last) return null;
    const rows = this.db
      .prepare(
        `SELECT path, before, after FROM file_edits
         WHERE session_id = ? AND turn_id = ? ORDER BY seq DESC`,
      )
      .all(sessionId, last.turn_id) as { path: string; before: string | null; after: string | null }[];
    return {
      turnId: last.turn_id,
      changes: rows.map((r) => ({ path: r.path, before: r.before, after: r.after })),
    };
  }

  dropTurnFileEdits(sessionId: string, turnId: string): number {
    const res = this.db
      .prepare(`DELETE FROM file_edits WHERE session_id = ? AND turn_id = ?`)
      .run(sessionId, turnId);
    return Number(res.changes ?? 0);
  }

  searchMessages(query: string, limit = 30): SessionSearchHit[] {
    const q = query.trim();
    if (q === "") return [];
    const cap = Math.max(1, Math.min(200, Math.floor(limit)));
    const tokens = q.split(/\s+/).filter(Boolean).map((t) => t.replace(/"/g, ""));
    if (tokens.length === 0) return [];
    // The trigram tokenizer needs >= 3 chars per token; shorter (e.g. a 2-char
    // Japanese word) queries fall back to a LIKE scan.
    const useFts = tokens.every((t) => t.length >= 3);
    if (useFts) {
      const match = tokens.map((t) => `"${t}"`).join(" ");
      const rows = this.db
        .prepare(
          `SELECT m.id AS messageId, m.session_id AS sessionId, m.role AS role,
                  m.seq AS seq, m.created_at AS createdAt, s.title AS title,
                  snippet(messages_fts, 0, '<<', '>>', '…', 12) AS snippet
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
           LEFT JOIN sessions s ON s.id = m.session_id
           WHERE messages_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(match, cap) as unknown as SearchRow[];
      return rows.map(toHit);
    }
    const where = tokens.map(() => `m.content LIKE ? ESCAPE '\\'`).join(" AND ");
    const likes = tokens.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
    const rows = this.db
      .prepare(
        `SELECT m.id AS messageId, m.session_id AS sessionId, m.role AS role,
                m.seq AS seq, m.created_at AS createdAt, s.title AS title,
                m.content AS body
         FROM messages m
         LEFT JOIN sessions s ON s.id = m.session_id
         WHERE ${where}
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(...likes, cap) as unknown as (SearchRow & { body: string })[];
    return rows.map((r) => ({ ...toHit(r), snippet: makeSnippet(r.body, tokens[0] ?? "") }));
  }

  appendMessage(sessionId: string, msg: ChatMessage): void {
    // One statement so the seq is read and written under the same lock: a
    // separate MAX()+INSERT races another process (serve + `familiar run` sharing
    // the DB) and both would pick the same seq (UNIQUE violation).
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, content, name, tool_call_id, tool_calls, meta, created_at)
         SELECT ?, ?, COALESCE(MAX(seq) + 1, 0), ?, ?, ?, ?, ?, ?, ?
         FROM messages WHERE session_id = ?`,
      )
      .run(
        msg.id,
        sessionId,
        msg.role,
        msg.content,
        msg.name ?? null,
        msg.toolCallId ?? null,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.meta ? JSON.stringify(msg.meta) : null,
        msg.createdAt,
        sessionId,
      );
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
  }

  /**
   * Rewrite every message's tool-call arguments so they are valid JSON.
   * Sessions written before the streaming truncation was fixed can hold a
   * malformed `arguments` string that makes providers reject the whole
   * transcript (HTTP 400) — this un-poisons them in place. Returns the number
   * of messages changed.
   */
  repairToolCallArguments(sessionId: string): number {
    const rows = this.db
      .prepare(`SELECT id, tool_calls FROM messages WHERE session_id = ? AND tool_calls IS NOT NULL`)
      .all(sessionId) as { id: string; tool_calls: string }[];
    let changed = 0;
    for (const row of rows) {
      let calls: ToolCall[];
      try {
        calls = JSON.parse(row.tool_calls) as ToolCall[];
      } catch {
        continue;
      }
      let dirty = false;
      for (const call of calls) {
        const fixed = repairToolArguments(call.arguments ?? "");
        if (fixed !== call.arguments) {
          call.arguments = fixed;
          dirty = true;
        }
      }
      if (dirty) {
        this.db
          .prepare(`UPDATE messages SET tool_calls = ? WHERE id = ?`)
          .run(JSON.stringify(calls), row.id);
        changed += 1;
      }
    }
    return changed;
  }

  truncateMessages(sessionId: string, keep: number): number {
    const res = this.db
      .prepare(`DELETE FROM messages WHERE session_id = ? AND seq >= ?`)
      .run(sessionId, keep);
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
    return Number(res.changes ?? 0);
  }

  /** Replace the whole message history in one transaction (manual compaction). */
  replaceMessages(sessionId: string, messages: ChatMessage[]): void {
    const insert = this.db.prepare(
      `INSERT INTO messages (id, session_id, seq, role, content, name, tool_call_id, tool_calls, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
      messages.forEach((m, i) => {
        insert.run(
          m.id,
          sessionId,
          i,
          m.role,
          m.content,
          m.name ?? null,
          m.toolCallId ?? null,
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.meta ? JSON.stringify(m.meta) : null,
          m.createdAt,
        );
      });
      this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as {
      id: string;
      role: string;
      content: string;
      name: string | null;
      tool_call_id: string | null;
      tool_calls: string | null;
      meta: string | null;
      created_at: number;
    }[];
    return rows.map((r) => {
      const msg: ChatMessage = {
        id: r.id,
        role: r.role as ChatMessage["role"],
        content: r.content,
        createdAt: r.created_at,
      };
      if (r.name) msg.name = r.name;
      if (r.tool_call_id) msg.toolCallId = r.tool_call_id;
      if (r.tool_calls) msg.toolCalls = JSON.parse(r.tool_calls) as ToolCall[];
      if (r.meta) msg.meta = JSON.parse(r.meta) as Record<string, unknown>;
      return msg;
    });
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: SessionRow): SessionRecord {
  let remote: SessionRemote | undefined;
  if (row.remote) {
    try {
      remote = JSON.parse(row.remote) as SessionRemote;
    } catch {
      remote = undefined; // corrupt blob: treat as a local session
    }
  }
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    model: row.model,
    profile: row.profile ?? undefined,
    effort: row.effort ? row.effort : null,
    cwd: row.cwd,
    ...(remote ? { remote } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
