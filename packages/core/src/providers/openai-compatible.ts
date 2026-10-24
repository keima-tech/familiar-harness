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
    // Request usage stats on the stream by default (tok/s in the GUI). Some
    // older OpenAI-compatible servers reject the field — we retry without it.
    const includeUsage = this.cfg.stream_options !== false;
    if (includeUsage) body["stream_options"] = { include_usage: true };

    const post = (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`${this.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(this.secret) },
        body: JSON.stringify(payload),
        signal: params.signal ?? AbortSignal.timeout(300_000),
      });
    let res = await post(body);
    if (!res.ok && includeUsage && (res.status === 400 || res.status === 422)) {
      const detail = await res.text().catch(() => "");
      if (/stream_options/i.test(detail)) {
        log.warn(`${this.id}: server rejected stream_options — retrying without usage stats`);
        const retry = { ...body };
        delete retry["stream_options"];
        res = await post(retry);
      }
    }
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
      const data = (await res.json()) as {
        data?: Array<Record<string, unknown>>;
      };
      const list = data.data ?? [];
      const out: ModelInfo[] = [];
      for (const m of list) {
        if (typeof m.id !== "string" || m.id === "") continue;
        // Context window: field names differ across servers (vLLM/llama.cpp/
        // OpenRouter all expose it differently) — sum up the common ones.
        const meta = m.meta as Record<string, unknown> | undefined;
        const raw =
          m.context_length ?? m.context_tokens ?? m.max_model_len ?? meta?.n_ctx_train ?? meta?.n_ctx;
        const ctx = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
        out.push({ id: m.id, provider: this.id, ...(ctx !== undefined ? { contextTokens: ctx } : {}) });
      }
      // Ollama's OpenAI-compat /models omits context — ask /api/show for it
      // (best effort, local endpoints only, bounded to keep pickers snappy).
      if ((this.cfg.base_url ?? "").startsWith("http://")) {
        const missing = out.filter((m) => m.contextTokens === undefined).slice(0, 8);
        for (const m of missing) {
          const ctx = await this.ollamaContext(m.id).catch(() => undefined);
          if (ctx) m.contextTokens = ctx;
        }
        // llama.cpp-style servers expose the loaded context via /props
        const stillMissing = out.filter((m) => m.contextTokens === undefined);
        if (stillMissing.length > 0) {
          const ctx = await this.llamaCppContext().catch(() => undefined);
          if (ctx) for (const m of stillMissing) m.contextTokens = ctx;
        }
      }
      return out;
    } catch (err) {
      // Surface the failure to the caller: models.list wraps it in an error
      // field and pickers show the provider as unavailable — no stderr noise
      // (it would overwrite full-screen TUIs).
      throw err;
    }
  }

  /** Ollama native /api/show — the only source of context length there. */
  private async ollamaContext(model: string): Promise<number | undefined> {
    const origin = this.baseUrl().replace(/\/v1\/?$/, "");
    const res = await fetch(`${origin}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { model_info?: Record<string, unknown> };
    for (const [key, value] of Object.entries(data.model_info ?? {})) {
      if (key.endsWith("context_length") && typeof value === "number" && value > 0) return value;
    }
    return undefined;
  }

  /** llama.cpp exposes the loaded context window on its /props endpoint. */
  private async llamaCppContext(): Promise<number | undefined> {
    const origin = this.baseUrl().replace(/\/v1\/?$/, "");
    const res = await fetch(`${origin}/props`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      default_generation_settings?: { n_ctx?: unknown };
      n_ctx?: unknown;
    };
    const raw = data.default_generation_settings?.n_ctx ?? data.n_ctx;
    return typeof raw === "number" && raw > 0 ? raw : undefined;
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
