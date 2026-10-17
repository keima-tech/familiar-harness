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
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Normalized conversation message. Persisted in the session store.
 * The system prompt is regenerated per turn and NOT persisted.
 */
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
  meta?: Record<string, unknown>;
}

export interface SessionRecord {
  id: string;
  title: string;
  provider: string;
  model: string;
  profile?: string;
  cwd: string;
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
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  bodyChars: number;
  useCount: number;
  lastUsedAt?: number;
  createdAt?: number;
}
