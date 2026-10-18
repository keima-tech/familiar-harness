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
  authHeaders,
  consumeSse,
} from "./base.js";

/**
 * Any OpenAI-compatible chat/completions endpoint:
 * OpenAI, OpenRouter, Ollama, LM Studio, vLLM, etc.
 */
export class OpenAiCompatibleProvider implements Provider {
  readonly id: string;
  private readonly cfg: ProviderConfig;
  private readonly secret: string | undefined;

  constructor(cfg: ProviderConfig, id: string, secret: string | undefined) {
    this.cfg = cfg;
    this.id = id;
    this.secret = secret;
  }

  private baseUrl(): string {
    const raw = this.cfg.base_url ?? "https://api.openai.com/v1";
    return raw.replace(/\/+$/, "");
  }

  async chat(params: ChatParams, onChunk: (c: ProviderChunk) => void): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: this.toWireMessages(params),
      stream: true,
    };
    if (params.temperature !== undefined) body["temperature"] = params.temperature;
    if (params.maxTokens !== undefined) body["max_tokens"] = params.maxTokens;
    // reasoning effort (OpenAI standard field; OpenRouter/nvidia/OpenAI o-series)
    if (params.effort) body["reasoning_effort"] = params.effort;
    if (params.tools && params.tools.length > 0) {
      body["tools"] = params.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (this.cfg.stream_options === true) {
      body["stream_options"] = { include_usage: true };
    }

    const res = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(this.secret) },
      body: JSON.stringify(body),
      signal: params.signal ?? AbortSignal.timeout(300_000),
    });
    await assertOk(res, this.id);
    if (!res.body) throw new ProviderError("empty response body", 200, this.id);

    let usage: ChatResult["usage"] | undefined;
    let finalFinish: string | undefined;

    await consumeSse(res.body, (payload) => {
      if (payload === "[DONE]") return;
      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(payload) as OpenAiChunk;
      } catch (err) {
        log.warn(`openai: unparseable SSE chunk ignored (${String(err)})`);
        return;
      }
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
        onChunk({ type: "usage", usage });
      }
      const choice = chunk.choices[0];
      if (!choice) return;
      const delta = choice.delta;
      if (delta?.content) onChunk({ type: "text", text: delta.content });
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content !== "") {
        onChunk({ type: "reasoning", text: delta.reasoning_content });
      }
      for (const tc of delta?.tool_calls ?? []) {
        if (tc.index === undefined) continue;
        if (tc.id !== undefined || tc.function?.name !== undefined) {
          onChunk({
            type: "tool_call_start",
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
          });
        }
        if (tc.function?.arguments) {
          onChunk({
            type: "tool_call_delta",
            index: tc.index,
            argumentsDelta: tc.function.arguments,
            id: tc.id,
            name: tc.function?.name,
          });
        }
      }
      if (choice.finish_reason) {
        finalFinish = choice.finish_reason;
        onChunk({ type: "stop", finishReason: choice.finish_reason });
      }
    });

    const stopReason = mapStopReason(finalFinish);
    return { stopReason, usage };
  }

  private toWireMessages(params: ChatParams): OpenAiMessage[] {
    const messages: OpenAiMessage[] = [];
    if (params.system) messages.push({ role: "system", content: params.system });
    for (const msg of params.messages) {
      if (msg.role === "system") {
        messages.push({ role: "system", content: msg.content });
      } else if (msg.role === "user") {
        messages.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        const wire: OpenAiMessage = { role: "assistant", content: msg.content || null };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          wire.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        messages.push(wire);
      } else if (msg.role === "tool") {
        messages.push({
          role: "tool",
          tool_call_id: msg.toolCallId ?? "",
          content: msg.content,
        });
      }
    }
    return messages;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl()}/models`, {
        method: "GET",
        headers: authHeaders(this.secret),
        signal: AbortSignal.timeout(10_000),
      });
      await assertOk(res, this.id);
      const data = (await res.json()) as { data?: { id?: string }[] };
      const list = data.data ?? [];
      const out: ModelInfo[] = [];
      for (const m of list) {
        if (m.id) out.push({ id: m.id, provider: this.id });
      }
      return out;
    } catch (err) {
      // Surface the failure instead of looking like "no models" — an
      // unreachable endpoint must report an error to the caller.
      log.warn(`models.list failed for provider ${this.id}: ${String(err)}`);
      throw err;
    }
  }
}

function mapStopReason(finish: string | undefined): string {
  switch (finish) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return finish ?? "end_turn";
  }
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface OpenAiChunk {
  choices: {
    index?: number;
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
