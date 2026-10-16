import type { ModelInfo } from "@familiar/protocol";
import type { ProviderConfig } from "../config.js";
import {
  type ChatParams,
  type ChatResult,
  type Provider,
  type ProviderChunk,
  createToolCallAccumulator,
} from "./base.js";

/**
 * Deterministic scripted provider for tests and offline smoke runs.
 *
 * Behaviour (stateless — decided from the tail of the transcript):
 * - last message is user, contains `@read <path>`  → tool call: read
 * - last message is user, otherwise                → streams back `mock: <echo>`
 * - last message is a tool result                  → final summary of that result
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
