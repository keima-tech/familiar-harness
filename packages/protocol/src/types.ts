/**
 * @familiar/protocol — shared data model.
 * Zero-dependency package. Every client (CLI / Desktop / future Web) and the
 * server speak only these types.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** A tool call observed in an assistant message (arguments held as raw JSON text). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Tool descriptor advertised to providers and clients. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "integer" | "array" | "object";
  description?: string;
  /** Bound to ToolOutput patterns; kept loose on purpose. */
  items?: unknown;
  enum?: (string | number)[];
  minLength?: number;
  [key: string]: unknown;
}

export interface Usage {
  /** prompt tokens of the LAST model call (the current context size) */
  promptTokens?: number;
  /** prompt tokens summed over every step of the turn (cost view) */
  totalPromptTokens?: number;
  /** explicit alias for promptTokens (context gauge / compaction signal) */
  contextTokens?: number;
  completionTokens?: number;
  /** estimated USD cost of the turn, when `pricing` is configured for the model */
  costUsd?: number;
}

/**
 * Normalized conversation message. Persisted in the session store.
 * The system prompt is regenerated per turn and NOT persisted.
 */
/** A multimodal attachment carried on a user message (base64, no data: prefix). */
export interface MessageAttachment {
  /** image/png | image/jpeg | image/webp | image/gif */
  media_type: string;
  /** base64-encoded payload */
  data: string;
  /** original filename (display only) */
  name?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** tool role: the tool name */
  name?: string;
  /** tool role: id of the originating ToolCall */
  toolCallId?: string;
  /** assistant role: tool calls requested by the assistant */
  toolCalls?: ToolCall[];
  createdAt: number;
  /** user role: image attachments live under meta.attachments (MessageAttachment[]) */
  meta?: Record<string, unknown>;
}

/** Read the image attachments stored on a user message (meta.attachments). */
export function messageAttachments(msg: ChatMessage): MessageAttachment[] {
  const raw = msg.meta?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is MessageAttachment =>
      !!a && typeof (a as MessageAttachment).media_type === "string" && typeof (a as MessageAttachment).data === "string",
  );
}

/** SSH proxy target: sessions whose tools run on another host over ssh — the
 * remote needs no familiar installation, only a POSIX shell. */
export interface SessionRemote {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  provider: string;
  model: string;
  profile?: string;
  /** reasoning effort for models that support it: "low" | "medium" | "high"; null = provider default */
  effort?: string | null;
  cwd: string;
  /** set when tools execute on a remote host over ssh (proxy mode) */
  remote?: SessionRemote | null;
  createdAt: number;
  updatedAt: number;
}

export interface ModelInfo {
  id: string;
  provider: string;
  contextTokens?: number;
}

/** M2: session-scoped task list managed by the `todo` tool. */
export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  createdAt: number;
}

/** Implemented by the server (memory-backed); consumed by the todo tool. */
export interface TodoStore {
  get(sessionId: string): TodoItem[];
  set(sessionId: string, items: TodoItem[]): void;
}

// ---------------------------------------------------------------------------
// M3: self-improvement (memory + skills)
// ---------------------------------------------------------------------------

export type MemorySource = "foreground" | "background";

export interface MemoryEntry {
  id: string;
  namespace: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  source: MemorySource;
}

/** Staged write waiting under ~/.familiar/pending/{memory,skills}/ (write_approval). */
export interface PendingWrite {
  id: string;
  kind: "create" | "patch" | "remove";
  /** memory: entry id / skill: name */
  target?: string;
  summary: string;
  reason?: string;
  warnings?: string[];
  createdAt: number;
  /** skills: the proposed skill name */
  name?: string;
  /** skills: the proposed description */
  description?: string;
  /** skills (patch/remove): target body hash captured at staging time (CAS) */
  snapshotBodyHash?: string;
  /** skills (patch/remove): the target changed since staging — apply would be refused */
  stale?: boolean;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  bodyChars: number;
  useCount: number;
  lastUsedAt?: number;
  createdAt?: number;
  /** "familiar" for the local store, otherwise the absolute directory it came from */
  source?: string;
}
