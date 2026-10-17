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
    // Skill consolidation request (M4 curator): emit a deterministic umbrella.
    if (userText.includes("# Skill consolidation request (familiar)")) {
      streamText(
        JSON.stringify({
          proposals: [
            {
              kind: "umbrella",
              targets: ["skill-a", "skill-b"],
              name: "deploys-checklist",
              description: "merged deploy checks (deterministic mock)",
              body: "# deploys-checklist\n\nWhen: releasing\nProcedure: 1. lint 2. test 3. ship\nWhy: merged from overlapping skills",
            },
          ],
        }),
        onChunk,
      );
      return { stopReason: "end_turn", usage: { promptTokens: 1, completionTokens: 8 } };
    }
    // Compaction summarization request (M4): echo a deterministic note.
    // MUST be matched before other directives — the prompt embeds an older
    // transcript that may itself contain "@..." markers.
    if (userText.includes("# Compaction summary request (familiar)")) {
      const n = userText.match(/CLIPPED=(\d+)/)?.[1] ?? "0";
      streamText(`mock summary: ${n} older messages condensed into this durable note`, onChunk);
      return { stopReason: "end_turn", usage: { promptTokens: 1, completionTokens: 3 } };
    }
    // Background self-review prompt (M3): if the review prompt contains the
    // marker "@make-lesson <text>", emit a deterministic memory.create proposal.
    if (userText.includes("# LAST TURN (transcript)")) {
      const lesson = userText.match(/@make-lesson\s+([^\n]+)/);
      const proposals = lesson
        ? [
            {
              kind: "memory.create",
              content: `Lesson: ${lesson[1]?.trim() ?? "flagged correction"}`,
              tags: ["review"],
              reason: "user-flagged correction from the turn",
            },
          ]
        : [];
      streamText(JSON.stringify({ proposals }), onChunk);
      return { stopReason: "end_turn", usage: { promptTokens: 1, completionTokens: 2 } };
    }
    // `@fail` or `@fail-<providerId>`: simulate a pre-stream failure.
    // With the provider form, only that provider fails (fallback tests).
    const failMatch = userText.match(/@fail(?:-([a-z0-9_.-]+))?\b/);
    if (failMatch && (failMatch[1] === undefined || failMatch[1] === this.id)) {
      throw new ProviderError("simulated provider failure", 503, this.id);
    }
    if (userText.includes("@dump-prompt-memory")) {
      const sys = params.system ?? "";
      const target = userText.match(/@dump-prompt-memory\s+(.+)/)?.[1]?.trim();
      const present = target ? sys.includes(target) : sys.includes("# Long-term memory");
      streamText(present ? "MEMORY-PRESENT" : "MEMORY-ABSENT", onChunk);
      return { stopReason: "end_turn", usage: { promptTokens: 1, completionTokens: 2 } };
    }
    if (userText.includes("@dump-prompt-skill")) {
      const sys = params.system ?? "";
      const target = userText.match(/@dump-prompt-skill\s+(.+)/)?.[1]?.trim();
      const present = target ? sys.includes(target) : sys.includes("# Skills");
      streamText(present ? "SKILLS-PRESENT" : "SKILLS-ABSENT", onChunk);
      return { stopReason: "end_turn", usage: { promptTokens: 1, completionTokens: 2 } };
    }
    const skillCreate = userText.match(/@skill-create\s+([^\n]+)/);
    if (skillCreate) {
      const name = (skillCreate[1] ?? "").trim();
      onChunk({ type: "tool_call_start", index: 0, id: "call_mock_s", name: "skill_manage" });
      onChunk({
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: JSON.stringify({
          action: "create",
          name,
          description: `test skill ${name}`,
          body: `# ${name}\n\nWhen: smoke tests ask about ${name}\nProcedure: 1. do it\nWhy it works: deterministic`,
        }),
      });
      onChunk({ type: "stop", finishReason: "tool_calls" });
      return { stopReason: "tool_calls" };
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
