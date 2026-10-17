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
  /** reasoning ("thinking") stream from providers that emit it (o-series, claude thinking, ...) */
  | { type: "reasoning.delta"; messageId: string; text: string }
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
  | { type: "compaction"; dropped: number; kept: number; /** M4: true when an aux model wrote the summary note (false / absent = drop guard) */ summarized?: boolean }
  /** M2 dynamic approval (serve mode): broadcast, wait for permission.respond */
  | { type: "permission.request"; requestId: string; tool: string; summary: string; detail?: string }
  | { type: "permission.resolved"; requestId: string; approved: boolean }
  /** M3 self-improvement: staged proposals count after a reviewed turn */
  | { type: "improvement.staged"; memoryCount: number; skillCount: number }
  /** M3: memory entries dropped from the prompt injection due to the char cap */
  | { type: "memory.truncation"; dropped: number }
  /** M5: a cron job finished running its prompt on a dedicated session */
  | { type: "cron.run"; name: string; status: "ok" | "error"; durationMs: number };

export const isTerminalEvent = (e: AgentEvent): boolean =>
  e.type === "turn.end" || e.type === "turn.error";
