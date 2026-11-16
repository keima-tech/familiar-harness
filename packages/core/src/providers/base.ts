import type { ChatMessage, JsonSchemaObject, ModelInfo, ToolCall, ToolSchema, Usage } from "@familiar/protocol";
import type { ReasoningEffort } from "../config.js";

// ---------------------------------------------------------------------------
// Provider stream chunk model (normalized across providers)
// ---------------------------------------------------------------------------

export type ProviderChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call_start"; index: number; id?: string; name?: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string; id?: string; name?: string }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; finishReason?: string };

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** reasoning effort for models that support it (session/turn level) */
  effort?: ReasoningEffort;
  /** mark the system + tools prefix cacheable (provider-specific; Anthropic) */
  promptCache?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  stopReason?: string;
  usage?: Usage;
}

export interface Provider {
  readonly id: string;
  /** Stream a full assistant response. Resolves when the stream is complete. */
  chat(params: ChatParams, onChunk: (chunk: ProviderChunk) => void): Promise<ChatResult>;
  /** Catalogue query; should degrade gracefully (empty list) on failure. */
  listModels(): Promise<ModelInfo[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly provider?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// ---------------------------------------------------------------------------
// Shared HTTP/SSE helpers
// ---------------------------------------------------------------------------

export function authHeaders(secret: string | undefined): Record<string, string> {
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

/** Throw a ProviderError with a trimmed body excerpt on non-2xx responses. */
export async function assertOk(
  res: Response,
  providerId: string,
): Promise<void> {
  if (res.ok) return;
  let body = "";
  try {
    body = (await res.text()).slice(0, 500);
  } catch {
    /* body unreadable */
  }
  throw new ProviderError(
    `HTTP ${res.status}${body ? `: ${body}` : ""}`,
    res.status,
    providerId,
  );
}

/**
 * Consume an SSE body, calling `onData` for each `data:` payload.
 * Tolerates CRLF, comments and multi-line data fields.
 */
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onData: (payload: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length > 0) onData(dataLines.join("\n"));
    dataLines = [];
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (rawLine === "") {
        flush();
        continue;
      }
      if (rawLine.startsWith(":")) continue; // comment/keepalive
      if (rawLine.startsWith("data:")) {
        dataLines.push(rawLine.slice(5).trimStart());
      }
      // event:/id:/retry: fields are irrelevant here
    }
  }
  // a final line may arrive without a trailing newline (the stream can end
  // right after `data: {...}`) — process it before flushing, or it is dropped
  if (buffer !== "") {
    const rawLine = buffer.replace(/\r$/, "");
    if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice(5).trimStart());
  }
  flush();
}

// ---------------------------------------------------------------------------
// Tool-call accumulation (shared by openai_compatible + anthropic)
// ---------------------------------------------------------------------------

export interface ToolCallAccumulator {
  /** Completed/updated accumulator keyed by stream index. */
  calls: Map<number, { id: string; name: string; arguments: string }>;
  start(index: number, id?: string, name?: string): void;
  delta(index: number, argumentsDelta: string, id?: string, name?: string): void;
  /** Calls in index order, ready to be stored on an assistant message. */
  snapshot(): ToolCall[];
}

export function createToolCallAccumulator(): ToolCallAccumulator {
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  return {
    calls,
    start(index, id, name) {
      const existing = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (id) existing.id = id;
      if (name) existing.name = name;
      calls.set(index, existing);
    },
    delta(index, argumentsDelta, id, name) {
      this.start(index, id, name); // fills missing fields; no-ops otherwise
      const call = calls.get(index);
      if (call) call.arguments += argumentsDelta;
    },
    snapshot() {
      return [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([i, c]) => ({
          id: c.id || `call_${Date.now()}_${i}`,
          name: c.name || "unknown_tool",
          arguments: c.arguments || "{}",
        }));
    },
  };
}

/** Convert our JSON-schema tool parameters into a provider-agnostic payload. */
export function schemaParams(schema: JsonSchemaObject): JsonSchemaObject {
  return schema;
}
