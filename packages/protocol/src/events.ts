import type { ToolCall, Usage } from "./types.js";

/**
 * All events emitted during a turn. Transport-independent:
 * CLI uses the in-process callback, `familiar serve` forwards them over WebSocket.
 */
export type AgentEvent =
  | { type: "turn.start"; turnId: string }
  | { type: "step.start"; turnId: string; index: number }
  | { type: "message.start"; messageId: string; role: "assistant" }
  | { type: "text.delta"; messageId: string; text: string }
  | { type: "message.end"; messageId: string; stopReason?: string; usage?: Usage }
  | { type: "tool.call"; messageId: string; toolCall: ToolCall }
  | {
      type: "tool.result";
      toolCallId: string;
      name: string;
      content: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: "turn.end"; turnId: string; usage?: Usage }
  | { type: "turn.error"; turnId: string; error: string; recoverable: boolean }
  | { type: "compaction"; dropped: number; kept: number };

export const isTerminalEvent = (e: AgentEvent): boolean =>
  e.type === "turn.end" || e.type === "turn.error";
