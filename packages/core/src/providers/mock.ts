import type { ModelInfo } from "@familiar/protocol";
import type { ProviderConfig } from "../config.js";
import {
  type ChatParams,
  type ChatResult,
  type Provider,
  type ProviderChunk,
  ProviderError,
} from "./base.js";

/**
 * Deterministic scripted provider for tests and offline smoke runs.
 *
 * Behaviour (stateless — decided from the tail of the transcript):
 * - last is user, text contains `@fail`            → throws ProviderError 503 (fallback tests)
 * - last is user text contains `@write <path>`     → tool call: write
 * - last is user, contains `@read <path>`          → tool call: read
 * - last is user, otherwise                        → streams back `mock: <echo>`
 * - last is a tool result                          → final summary of that result
 */
export class MockProvider implements Provider {
  readonly id: string;

  constructor(_cfg: ProviderConfig, id = "mock") {
    this.id = id;
  }

  async chat(
    params: ChatParams,
    onChunk: (chunk: ProviderChunk) => void,
  ): Promise<ChatResult> {
    const messages = params.messages;
    const last = messages[messages.length - 1];

    if (last && last.role === "tool") {
      const firstLine = last.content.split("\n")[0] ?? "";
      const text = `MOCK-OK: ${firstLine}`;
      streamText(text, onChunk);
      return { stopReason: "end_turn", usage: { promptTokens: 1, completionTokens: 2 } };
    }

    const userText = last?.role === "user" ? last.content : "";
    // `@fail` or `@fail-<providerId>`: simulate a pre-stream failure.
    // With the provider form, only that provider fails (fallback tests).
    const failMatch = userText.match(/@fail(?:-([a-z0-9_.-]+))?\b/);
    if (failMatch && (failMatch[1] === undefined || failMatch[1] === this.id)) {
      throw new ProviderError("simulated provider failure", 503, this.id);
    }
    const writeMatch = userText.match(/@write\s+(\S+)/);
    if (writeMatch) {
      onChunk({ type: "tool_call_start", index: 0, id: "call_mock_w", name: "write" });
      onChunk({
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: JSON.stringify({
          path: writeMatch[1] ?? "missing.txt",
          content: "mock content from Familiar",
        }),
      });
      onChunk({ type: "stop", finishReason: "tool_calls" });
      return { stopReason: "tool_calls" };
    }
    const bashMatch = userText.match(/@bash\s+([^\n]+)/);
    if (bashMatch) {
      onChunk({ type: "tool_call_start", index: 0, id: "call_mock_b", name: "bash" });
      onChunk({
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: JSON.stringify({ command: (bashMatch[1] ?? "").trim() }),
      });
      onChunk({ type: "stop", finishReason: "tool_calls" });
      return { stopReason: "tool_calls" };
    }
    const taskMatch = userText.match(/@task\s+([^\n]+)/);
    if (taskMatch) {
      const label = (taskMatch[1] ?? "").trim();
      onChunk({ type: "tool_call_start", index: 0, id: "call_mock_t", name: "task" });
      onChunk({
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: JSON.stringify({
          description: label,
          prompt: `research ${label} and summarize the outcome`,
        }),
      });
      onChunk({ type: "stop", finishReason: "tool_calls" });
      return { stopReason: "tool_calls" };
    }
    const readMatch = userText.match(/@read\s+(\S+)/);
    if (readMatch) {
      // Simulate a tool call (arguments arrive as one complete JSON payload).
      onChunk({ type: "tool_call_start", index: 0, id: "call_mock_1", name: "read" });
      onChunk({
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: JSON.stringify({ path: readMatch[1] ?? "missing.txt" }),
      });
      onChunk({ type: "stop", finishReason: "tool_calls" });
      return { stopReason: "tool_calls" };
    }

    streamText(`mock: ${userText}`, onChunk);
    return { stopReason: "end_turn", usage: { promptTokens: 1, completionTokens: 2 } };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-fast", provider: this.id, contextTokens: 200_000 }];
  }
}

function streamText(text: string, onChunk: (chunk: ProviderChunk) => void): void {
  // Split into small chunks to exercise the delta path deterministically.
  const parts = text.match(/.{1,12}/g) ?? [];
  for (const part of parts) onChunk({ type: "text", text: part });
  onChunk({ type: "stop", finishReason: "end_turn" });
}
