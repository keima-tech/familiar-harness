import type { ChatMessage, ModelInfo } from "@familiar/protocol";
import type { ProviderConfig } from "../config.js";
import { log } from "../logger.js";
import {
  type ChatParams,
  type ChatResult,
  ProviderError,
  type Provider,
  type ProviderChunk,
  assertOk,
  consumeSse,
} from "./base.js";

/** Anthropic Messages API (streaming). */
export class AnthropicProvider implements Provider {
  readonly id: string;

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly secret: string | undefined,
    id = "anthropic",
  ) {
    this.id = id;
  }

  private baseUrl(): string {
    const raw = this.cfg.base_url ?? "https://api.anthropic.com/v1";
    return raw.replace(/\/+$/, "");
  }

  async chat(params: ChatParams, onChunk: (c: ProviderChunk) => void): Promise<ChatResult> {
    const { system, messages } = splitSystem(params.messages);
    const body: Record<string, unknown> = {
      model: params.model,
      // Anthropic requires an explicit ceiling.
      max_tokens: params.maxTokens ?? 8192,
      stream: true,
      messages: toAnthropicMessages(messages),
    };
    if (system) body["system"] = system;
    if (params.temperature !== undefined) body["temperature"] = params.temperature;
    if (params.tools && params.tools.length > 0) {
      body["tools"] = params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const res = await fetch(`${this.baseUrl()}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(this.secret ? { "x-api-key": this.secret } : {}),
      },
      body: JSON.stringify(body),
      signal: params.signal ?? AbortSignal.timeout(300_000),
    });
    await assertOk(res, this.id);
    if (!res.body) throw new ProviderError("empty response body", 200, this.id);

    let usage: ChatResult["usage"] | undefined;
    let stopReason: string | undefined;
    /** tool_use blocks carry id/name in content_block_start, JSON in input_json_delta */
    const openToolBlocks = new Map<number, { id: string; name: string }>();

    await consumeSse(res.body, (payload) => {
      let event: AnthropicSseEvent;
      try {
        event = JSON.parse(payload) as AnthropicSseEvent;
      } catch (err) {
        log.warn(`anthropic: unparseable SSE chunk ignored (${String(err)})`);
        return;
      }
      switch (event.type) {
        case "message_start": {
          const u = event.message?.usage;
          if (u?.input_tokens !== undefined) {
            usage = { ...usage, promptTokens: u.input_tokens };
          }
          break;
        }
        case "content_block_start": {
          if (event.content_block?.type === "tool_use") {
            openToolBlocks.set(event.index, {
              id: event.content_block.id ?? "",
              name: event.content_block.name ?? "",
            });
            onChunk({
              type: "tool_call_start",
              index: event.index,
              id: event.content_block.id,
              name: event.content_block.name,
            });
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          if (delta?.type === "text_delta" && delta.text) {
            onChunk({ type: "text", text: delta.text });
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            onChunk({ type: "reasoning", text: delta.thinking });
          } else if (delta?.type === "input_json_delta" && delta.partial_json) {
            onChunk({
              type: "tool_call_delta",
              index: event.index,
              argumentsDelta: delta.partial_json,
            });
          }
          break;
        }
        case "content_block_stop": {
          openToolBlocks.delete(event.index);
          break;
        }
        case "message_delta": {
          if (event.usage?.output_tokens !== undefined) {
            usage = { ...usage, completionTokens: event.usage.output_tokens };
          }
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
            onChunk({ type: "stop", finishReason: event.delta.stop_reason });
          }
          break;
        }
        case "message_stop": {
          break;
        }
        case "error": {
          throw new ProviderError(`anthropic stream error: ${JSON.stringify(event.error)}`, 500, this.id);
        }
        default:
          break;
      }
    });

    return { stopReason: mapStop(stopReason), usage };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl()}/models`, {
        method: "GET",
        headers: {
          "anthropic-version": "2023-06-01",
          ...(this.secret ? { "x-api-key": this.secret } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      await assertOk(res, this.id);
      const data = (await res.json()) as { data?: { id?: string }[] };
      const out: ModelInfo[] = [];
      for (const m of data.data ?? []) {
        if (m.id) out.push({ id: m.id, provider: this.id });
      }
      return out;
    } catch (err) {
      // Surface the failure instead of looking like "no models".
      log.warn(`models.list failed for provider ${this.id}: ${String(err)}`);
      throw err;
    }
  }
}

function splitSystem(messages: ChatMessage[]): { system: string; messages: ChatMessage[] } {
  const parts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(m.content);
    else rest.push(m);
  }
  return { system: parts.join("\n\n"), messages: rest };
}

/** Anthropic only accepts user/assistant roles; tool results become user blocks. */
function toAnthropicMessages(messages: ChatMessage[]): AnthropicWireMessage[] {
  const wire: AnthropicWireMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      const content: AnthropicBlock[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      if (msg.role === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: safeParse(tc.arguments),
          });
        }
      }
      wire.push({ role: msg.role, content });
    } else if (msg.role === "tool") {
      wire.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "",
            content: msg.content,
            is_error: msg.meta?.["isError"] === true,
          },
        ],
      });
    }
  }
  return wire;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json || "{}") as unknown;
  } catch {
    return { _invalid_json: json };
  }
}

function mapStop(s: string | undefined): string {
  switch (s) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return s ?? "end_turn";
  }
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface AnthropicWireMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

type AnthropicSseEvent =
  | { type: "message_start"; message?: { usage?: { input_tokens?: number } } }
  | {
      type: "content_block_start";
      index: number;
      content_block?: { type: string; id?: string; name?: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta?:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta?: { stop_reason?: string };
      usage?: { output_tokens?: number };
    }
  | { type: "message_stop" }
  | { type: "error"; error?: { type?: string; message?: string } };
