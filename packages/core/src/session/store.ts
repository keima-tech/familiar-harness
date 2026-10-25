import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type {
  ChatMessage,
  SessionRecord,
  SessionRemote,
  ToolCall,
} from "@familiar/protocol";
import { ensureDir } from "../paths.js";

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
    return Number(res.changes) > 0;
  }

  appendMessage(sessionId: string, msg: ChatMessage): void {
    const maxRow = this.db
      .prepare(`SELECT MAX(seq) AS max_seq FROM messages WHERE session_id = ?`)
      .get(sessionId) as { max_seq: number | null };
    const seq = (maxRow.max_seq ?? -1) + 1;
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, content, name, tool_call_id, tool_calls, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        sessionId,
        seq,
        msg.role,
        msg.content,
        msg.name ?? null,
        msg.toolCallId ?? null,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.meta ? JSON.stringify(msg.meta) : null,
        msg.createdAt,
      );
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
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
