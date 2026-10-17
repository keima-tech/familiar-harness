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
  "session.delete",
  "session.send",
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
  "curator.run",
  "mcp.status",
  "cron.status",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];
