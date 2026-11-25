import type { ChatMessage, ModelInfo, SessionRecord } from "./types.js";

/** JSON-RPC 2.0 envelope */
export interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const RPC_ERROR_METHOD_NOT_FOUND = -32601;
export const RPC_ERROR_INVALID_PARAMS = -32602;
export const RPC_ERROR_INTERNAL = -32603;

/** Event sink handed to dispatch(); matches the WebSocket push envelope. */
export interface RpcContext {
  /** Called whenever the server produces an AgentEvent for a session. */
  onEvent?: (sessionId: string, event: unknown) => void;
}

// ---- method params / results (M1 subset) ----

export interface SessionCreateParams {
  title?: string;
  provider?: string;
  model?: string;
  profile?: string;
  cwd?: string;
}

export interface SessionGetParams {
  id: string;
}

export interface SessionDeleteParams {
  id: string;
}

export interface SessionSendParams {
  id: string;
  text: string;
  provider?: string;
  model?: string;
  maxSteps?: number;
  yolo?: boolean;
  /** M2: plan mode — read-only toolset, research/design only */
  plan?: boolean;
}

export interface PermissionRespondParams {
  requestId: string;
  approved: boolean;
}

export interface SessionGetResult {
  session: SessionRecord;
  messages: ChatMessage[];
  /** true while a turn is streaming for this session (any client) */
  running?: boolean;
  /** when the running turn started (ms epoch) */
  runningStartedAt?: number;
  /** the instruction being processed (duplicate-send guard) */
  runningText?: string;
}

export interface ModelsListParams {
  provider?: string;
}

export interface ModelsListResult {
  provider: string;
  models: ModelInfo[];
  error?: string;
}

export const RPC_METHODS = [
  "ping",
  "config.get",
  "models.list",
  "session.create",
  "session.list",
  "session.get",
  "session.repair",
  "office.templates",
  "office.templates.import",
  "office.templates.delete",
  "session.delete",
  "session.send",
  "session.steer",
  "session.compact",
  "permission.respond",
  "memory.list",
  "memory.pending",
  "memory.approve",
  "memory.reject",
  "memory.approval",
  "skills.list",
  "skills.view",
  "skills.pending",
  "skills.approve",
  "skills.reject",
  "curator.status",
  "connectors.get",
  "connectors.set",
  "connectors.test",
  "skills.save",
  "skills.delete",
  "fs.list",
  "fs.read",
  "fs.preview",
  "fs.rename",
  "fs.delete",
  "curator.run",
  "mcp.status",
  "mcp.servers.set",
  "mcp.servers.delete",
  "lsp.servers.set",
  "lsp.servers.delete",
  "cron.status",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];
