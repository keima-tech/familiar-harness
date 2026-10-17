import crypto from "node:crypto";
import type {
  AgentEvent,
  ChatMessage,
  ToolCall,
  Usage,
} from "@familiar/protocol";
import type { ResolvedConfig } from "../config.js";
import { log } from "../logger.js";
import type { SessionStore } from "../session/store.js";
import type { ProviderRegistry } from "../providers/index.js";
import { ProviderError } from "../providers/base.js";
import {
  defaultToolRegistry,
  validateToolArgs,
  type ToolRegistry,
  type Tool,
  type ToolContext,
} from "../tools/index.js";
import { DenyApprovalAdapter, type ApprovalAdapter } from "../tools/permissions.js";
import { buildSystemPrompt, todoSection } from "./prompts.js";
import type { SelfImproveContext } from "../selfimprove/context.js";
import { memorySection, skillsSection } from "../selfimprove/memory/inject.js";
import { SELF_IMPROVE_TOOLS } from "../tools/index.js";

export interface RunTurnOptions {
  sessionId: string;
  userText: string;
  provider?: string;
  model?: string;
  profile?: string;
  yolo?: boolean;
  maxSteps?: number;
  /** M2: plan mode — read-only toolset only */
  plan?: boolean;
  /** M2: injected prompt sections (todo state, memory later) */
  extraSystem?: string[];
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface RunTurnResult {
  turnId: string;
  steps: number;
  toolCalls: number;
  usage: Usage;
}

/**
 * The agent loop: user message → provider (streaming) → tool calls → results →
 * repeat until a final answer or maxSteps is reached. All messages are
 * persisted through the SessionStore; events are streamed to the caller.
 */
export class AgentRunner {
  private readonly tools: ToolRegistry;

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly providers: ProviderRegistry,
    private readonly store: SessionStore,
    opts: {
      tools?: ToolRegistry;
      approval?: ApprovalAdapter;
      /** M2: session todo store, injected into tool contexts and the prompt */
      todos?: import("@familiar/protocol").TodoStore;
      /** M2: subagent launcher for the task tool */
      taskRunner?: (args: {
        description: string;
        prompt: string;
        sessionId: string;
        yolo: boolean;
      }) => Promise<string>;
      /** M3: self-improvement stores (absent → memory/skill tools hidden) */
      selfImprove?: SelfImproveContext;
    } = {},
  ) {
    this.tools = opts.tools ?? defaultToolRegistry();
    this.approval = opts.approval ?? new DenyApprovalAdapter();
    this.todos = opts.todos;
    this.taskRunner = opts.taskRunner;
    this.selfImprove = opts.selfImprove;
  }

  private approval: ApprovalAdapter;
  private readonly todos?: import("@familiar/protocol").TodoStore;
  private readonly taskRunner?: (args: {
    description: string;
    prompt: string;
    sessionId: string;
    yolo: boolean;
  }) => Promise<string>;
  private readonly selfImprove?: SelfImproveContext;

  async runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
    const session = this.store.getSession(opts.sessionId);
    if (!session) throw new Error(`session not found: ${opts.sessionId}`);

    const providerId = opts.provider ?? session.provider;
    const model = opts.model ?? session.model;
    const profile = opts.profile ?? session.profile;
    const maxSteps = opts.maxSteps ?? 25;
    const yolo = opts.yolo ?? false;

    const turnId = crypto.randomUUID();
    const usage: Usage = {};
    let steps = 0;
    let toolCallsTotal = 0;

    // 1) persist the user message
    this.store.appendMessage(session.id, {
      id: crypto.randomUUID(),
      role: "user",
      content: opts.userText,
      createdAt: Date.now(),
      meta: { source: "user" },
    });
    // Auto-title from first user message.
    if (!session.title) {
      this.store.renameSession(session.id, opts.userText.slice(0, 60));
    }

    opts.onEvent({ type: "turn.start", turnId });

    // Plan mode (M2): only read-only tools are advertised and executable.
    const plan = opts.plan === true;
    const baseTools: Tool[] = plan
      ? this.tools.list().filter((t) => t.read_only === true)
      : this.tools.list();
    // M3: memory/skill tools only when the self-improvement context is wired.
    const effectiveTools: Tool[] = this.selfImprove
      ? baseTools
      : baseTools.filter((t) => !SELF_IMPROVE_TOOLS.includes(t.name as "memory_manage"));

    try {
      for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
        steps += 1;
        opts.onEvent({ type: "step.start", turnId, index: stepIndex });

        // Build injected prompt sections: memory + skills catalog (M3),
        // todos first, then caller extras (later phases).
        const extra: string[] = [];
        if (this.selfImprove) {
          const memoryCap = this.cfg.memory?.max_prompt_chars ?? 4000;
          const mem = memorySection(this.selfImprove.memories.list(), memoryCap);
          if (mem.text !== "") extra.push(mem.text);
          if (mem.dropped > 0) {
            opts.onEvent({ type: "memory.truncation", dropped: mem.dropped });
          }
          const sk = skillsSection(this.selfImprove.skills.list());
          if (sk !== "") extra.push(sk);
        }
        if (this.todos) {
          const todoItems = this.todos.get(session.id);
          const section = todoSection(todoItems);
          if (section !== "") extra.push(section);
        }
        for (const part of opts.extraSystem ?? []) extra.push(part);

        const system = buildSystemPrompt(this.cfg, {
          cwd: session.cwd,
          profile,
          toolNames: effectiveTools.map((t) => t.name),
          plan,
          extraSystem: extra,
        });

        let history = this.store.getMessages(session.id);
        history = this.compactIfNeeded(history, opts);

        // ---- stream the assistant response ----
        const assistantId = crypto.randomUUID();
        opts.onEvent({ type: "message.start", messageId: assistantId, role: "assistant" });

        const textParts: string[] = [];
        let stepStopReason: string | undefined;
        let stepToolCalls: ToolCall[] = [];

        const provider = this.providers.get(providerId);
        const result = await provider.chat(
          {
            model,
            messages: history,
            system,
            tools: effectiveTools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
            signal: opts.signal,
          },
          (chunk) => {
            if (chunk.type === "text") {
              textParts.push(chunk.text);
              opts.onEvent({ type: "text.delta", messageId: assistantId, text: chunk.text });
            } else if (chunk.type === "usage") {
              usage.promptTokens = (usage.promptTokens ?? 0) + (chunk.usage.promptTokens ?? 0);
              usage.completionTokens =
                (usage.completionTokens ?? 0) + (chunk.usage.completionTokens ?? 0);
            } else if (chunk.type === "stop") {
              stepStopReason = chunk.finishReason;
            } else if (chunk.type === "tool_call_start" || chunk.type === "tool_call_delta") {
              observeProviderChunk(assistantId, chunk);
            } else if (chunk.type === "reasoning") {
              if (process.env["FAMILIAR_DEBUG"]) log.debug("reasoning:", chunk.text);
            }
          },
        );

        // Accumulator is fed in parallel; simplest correct approach: re-run a
        // lightweight listener by wrapping onChunk — see registerToolObserver.
        stepToolCalls = takeObservedToolCalls(assistantId);
        stepStopReason = result.stopReason ?? stepStopReason;

        const assistantText = textParts.join("");

        // Small local models sometimes emit tool calls as fenced JSON text.
        // Salvage when no native tool_calls arrived (only for advertised tools).
        if (stepToolCalls.length === 0) {
          const salvaged = salvageTextToolCall(assistantText, effectiveTools.map((t) => t.name));
          if (salvaged) {
            log.debug(`salvaged tool call from text: ${salvaged.name}`);
            stepToolCalls = [salvaged];
            opts.onEvent({
              type: "text.delta",
              messageId: assistantId,
              text: "\n(free-form tool call salvaged)\n",
            });
          }
        }

        const assistantMsg: ChatMessage = {
          id: assistantId,
          role: "assistant",
          content: textParts.join(""),
          createdAt: Date.now(),
          toolCalls: stepToolCalls.length > 0 ? stepToolCalls : undefined,
          meta: { stopReason: stepStopReason ?? result.stopReason },
        };
        this.store.appendMessage(session.id, assistantMsg);
        opts.onEvent({
          type: "message.end",
          messageId: assistantId,
          stopReason: stepStopReason,
          usage: result.usage,
        });

        if (stepToolCalls.length === 0) break;

        toolCallsTotal += stepToolCalls.length;

        // ---- execute tool calls ----
        const toolCtx: ToolContext = {
          sessionId: session.id,
          cwd: session.cwd,
          yolo,
          config: this.cfg,
          approval: this.approval,
          todos: this.todos,
          taskRunner: this.taskRunner,
          selfImprove: this.selfImprove,
        };
        for (const call of stepToolCalls) {
          opts.onEvent({ type: "tool.call", messageId: assistantId, toolCall: call });
          const startedAt = Date.now();
          const output = await this.executeToolCall(call, toolCtx, plan, effectiveTools);
          const durationMs = Date.now() - startedAt;
          const isError = output.isError === true;
          const resultMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: "tool",
            name: call.name,
            toolCallId: call.id,
            content: output.content,
            createdAt: Date.now(),
            meta: { isError, durationMs },
          };
          this.store.appendMessage(session.id, resultMsg);
          opts.onEvent({
            type: "tool.result",
            toolCallId: call.id,
            name: call.name,
            content: output.content,
            isError,
            durationMs,
          });
        }
      }

      const finalUsage: Usage = usage.promptTokens || usage.completionTokens ? usage : {};
      opts.onEvent({ type: "turn.end", turnId, usage: finalUsage });
      return { turnId, steps, toolCalls: toolCallsTotal, usage: finalUsage };
    } catch (err) {
      const recoverable = err instanceof ProviderError && err.status !== undefined && err.status >= 500;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === "TimeoutError") {
        opts.onEvent({ type: "turn.error", turnId, error: "provider request timed out", recoverable: true });
      } else {
        opts.onEvent({ type: "turn.error", turnId, error: message, recoverable });
      }
      // Rethrow so the client (CLI/server) can exit non-zero.
      throw err;
    }
  }

  private async executeToolCall(
    call: ToolCall,
    ctx: ToolContext,
    plan: boolean,
    effectiveTools: Tool[],
  ): Promise<{ content: string; isError?: boolean }> {
    const tool = effectiveTools.find((t) => t.name === call.name);
    if (!tool) {
      const available = effectiveTools.map((t) => t.name).join(", ");
      return {
        content: plan
          ? `not available in plan mode: ${call.name} (plan mode allows only: ${available})`
          : `unknown tool: ${call.name} (available: ${available})`,
        isError: true,
      };
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    } catch {
      return { content: `tool arguments are not valid JSON: ${call.arguments.slice(0, 200)}`, isError: true };
    }
    const validation = validateToolArgs(tool.parameters, args);
    if (!validation.ok) return { content: validation.error, isError: true };

    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      return { content: `tool crashed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  /**
   * M1 compaction guard: character-based estimate; if over the soft limit,
   * drop the oldest messages except the first user message and the last N.
   * Ephemeral (not persisted); real summarisation arrives in M3.
   */
  private compactIfNeeded(
    history: ChatMessage[],
    opts: RunTurnOptions,
  ): ChatMessage[] {
    const limitChars = this.cfg.context.token_soft_limit * 4;
    let total = 0;
    for (const m of history) total += m.content.length + (m.toolCalls?.length ?? 0) * 128;

    if (total <= limitChars) return history;
    const keepLast = Math.max(2, this.cfg.context.keep_last);
    const keepFirst = history.filter((m) => m.role === "user")[0];

    const firstIdx = keepFirst ? history.indexOf(keepFirst) : -1;
    const mid = history.slice(firstIdx + 1, history.length - keepLast);
    const dropped = mid.length;
    if (dropped <= 0) return history;

    const compacted: ChatMessage[] = [];
    if (firstIdx >= 0) compacted.push(history[firstIdx]!);
    compacted.push({
      id: crypto.randomUUID(),
      role: "user",
      content: `[familiar: compaction guard: ${dropped} older messages were dropped from context]`,
      createdAt: Date.now(),
      meta: { ephemeral: true },
    });
    compacted.push(...history.slice(history.length - keepLast));

    let kept = 0;
    for (const m of compacted) kept += m.content.length;
    opts.onEvent({ type: "compaction", dropped, kept });
    log.warn(`compaction: dropped ${dropped} messages (estimate ${total} chars > ${limitChars})`);
    return compacted;
  }
}

// ---------------------------------------------------------------------------
// Tool-call observation
// ---------------------------------------------------------------------------

/**
 * Provider chunks are pushed by the streaming callback; tool_call_start/delta
 * accumulate into per-assistant buffers collected by this module.
 */
const callBuffers = new Map<string, ReturnType<typeof newCallBuffer>>();

interface CallBuffer {
  calls: Map<number, { id: string; name: string; arguments: string }>;
}

function newCallBuffer(): CallBuffer {
  return { calls: new Map() };
}

/** Exported for AgentRunner wiring: feed provider chunks here. */
export function observeProviderChunk(
  messageId: string,
  chunk:
    | { type: "tool_call_start"; index: number; id?: string; name?: string }
    | { type: "tool_call_delta"; index: number; argumentsDelta: string; id?: string; name?: string },
): void {
  let buf = callBuffers.get(messageId);
  if (!buf) {
    buf = newCallBuffer();
    callBuffers.set(messageId, buf);
  }
  const entry =
    buf.calls.get(chunk.index) ?? { id: "", name: "", arguments: "" };
  if (chunk.id) entry.id = chunk.id;
  if (chunk.name) entry.name = chunk.name;
  if (chunk.type === "tool_call_delta") entry.arguments += chunk.argumentsDelta;
  buf.calls.set(chunk.index, entry);
}

function takeObservedToolCalls(messageId: string): ToolCall[] {
  const buf = callBuffers.get(messageId);
  if (!buf) return [];
  callBuffers.delete(messageId);
  return [...buf.calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, c]) => ({
      id: c.id || `call_${i}`,
      name: c.name || "unknown_tool",
      arguments: c.arguments || "{}",
    }));
}

/**
 * Best-effort recovery of a tool call emitted as plain text by weak models:
 * ```json {"name":"bash","arguments":{...}} ```
 * Only fires when `name` matches a real tool, so mere JSON discussions stay text.
 */
export function salvageTextToolCall(
  text: string,
  toolNames: string[],
): ToolCall | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const bare = text.match(/\{[\s\S]*"name"[\s\S]*\}/);
  if (bare) candidates.push(bare[0]);
  candidates.push(text);
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as {
        name?: unknown;
        arguments?: unknown;
        parameters?: unknown;
        input?: unknown;
      };
      if (typeof parsed.name !== "string" || !toolNames.includes(parsed.name)) continue;
      const args =
        parsed.arguments ??
        parsed.parameters ??
        parsed.input ?? {};
      return {
        id: `call_salvaged_${Date.now()}`,
        name: parsed.name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      };
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON-schema subset validation lives in tools/registry.ts (validateToolArgs).
// ---------------------------------------------------------------------------
