import crypto from "node:crypto";
import type {
  AgentEvent,
  ChatMessage,
  ToolCall,
  Usage,
} from "@familiar/protocol";
import type { ResolvedConfig } from "../config.js";
import { normalizeEffort } from "../config.js";
import { log } from "../logger.js";
import type { SessionStore } from "../session/store.js";
import type { MessageAttachment, SessionRecord, SessionRemote } from "@familiar/protocol";
import type { ProviderRegistry } from "../providers/index.js";
import { ProviderError } from "../providers/base.js";
import { repairToolArguments } from "../providers/tool-args.js";
import {
  defaultToolRegistry,
  validateToolArgs,
  type ToolRegistry,
  type Tool,
  type ToolContext,
} from "../tools/index.js";
import { createBackend } from "../exec/index.js";
import { DenyApprovalAdapter, type ApprovalAdapter, type PermissionMode } from "../tools/permissions.js";
import type { ToolOutput } from "../tools/registry.js";
import { buildSystemPrompt, todoSection } from "./prompts.js";
import type { SelfImproveContext } from "../selfimprove/context.js";
import { memorySection, skillsSection } from "../selfimprove/memory/inject.js";
import { SELF_IMPROVE_TOOLS } from "../tools/index.js";

export interface RunTurnOptions {
  sessionId: string;
  userText: string;
  /** images attached to this user message (multimodal models) */
  attachments?: MessageAttachment[];
  provider?: string;
  model?: string;
  profile?: string;
  /** per-turn reasoning effort override (falls back to session.effort) */
  effort?: string;
  yolo?: boolean;
  maxSteps?: number;
  /** M2: plan mode — read-only toolset only */
  plan?: boolean;
  /** composer permission mode (ask | edit | yolo) — refines write approvals */
  permissionMode?: PermissionMode;
  /** M2: injected prompt sections (todo state, memory later) */
  extraSystem?: string[];
  /** per-session dynamic tools (e.g. MCP servers spawned on an SSH host) */
  extraTools?: Tool[];
  /** registry tools to hide for this turn (local MCP tools in ssh sessions) */
  excludeToolPrefix?: string;
  onEvent: (event: AgentEvent) => void;
  /** cancel the turn (provider streams abort; tools finish their step) */
  signal?: AbortSignal;
  /** the model's context window, when the caller knows it (compaction ratio) */
  contextWindowTokens?: number;
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
  /** M5: lifecycle hooks (may be undefined) */
  private readonly hooks?: import("../hooks/index.js").HookRunner;

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
      /** M5: lifecycle hooks (optional; failures never break a turn) */
      hooks?: import("../hooks/index.js").HookRunner;
    } = {},
  ) {
    this.tools = opts.tools ?? defaultToolRegistry();
    this.approval = opts.approval ?? new DenyApprovalAdapter();
    this.todos = opts.todos;
    this.taskRunner = opts.taskRunner;
    this.selfImprove = opts.selfImprove;
    this.hooks = opts.hooks;
  }

  /**
   * M5: register dynamic tools discovered after construction (MCP annexes
   * arrive asynchronously from child processes).
   */
  registerExtraTools(tools: Tool[]): void {
    for (const tool of tools) this.tools.register(tool);
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

    // Every file/command tool call talks to this backend: this machine, or an
    // ssh host when the session was created in proxy mode.
    const backend = createBackend(session.remote ?? null);

    const providerId = opts.provider ?? session.provider;
    const model = opts.model ?? session.model;
    const profile = opts.profile ?? session.profile;
    const effort = normalizeEffort(opts.effort ?? (session as { effort?: string | null }).effort);
    // `maxSteps` is the size of one step window. When the caller did not pin
    // it (CLI/RPC override), the turn keeps going past the window up to the
    // configured ceiling — heavy multi-step chores used to stop dead at 25
    // steps and wait for the user to type 続けて.
    const stepWindow = opts.maxSteps ?? 25;
    const stepCeiling =
      opts.maxSteps ?? Math.max(stepWindow, this.cfg.context?.max_turn_steps ?? 100);
    /** consecutive "open todos" nudges issued in this turn */
    let todoNudges = 0;
    /** system note for the next step (an auto-continue instruction) */
    let pendingNudge: string | undefined;
    /** true when the model finished on its own (no tool calls) */
    let finishedNaturally = false;
    // "Full access" on the composer is the same thing as --yolo for tools:
    // both file writes and risky commands must stop asking (bash only looks at
    // `ctx.yolo`, so the permission mode has to fold into it here).
    const yolo = (opts.yolo ?? false) || opts.permissionMode === "yolo";

    const turnId = crypto.randomUUID();
    const usage: Usage = {};
    /** prompt tokens reported by the LAST step — the real context size */
    let lastStepPromptTokens = 0;
    /** prompt tokens of the step currently streaming (fallback source) */
    let stepPromptFromChunks = 0;
    let steps = 0;
    let toolCallsTotal = 0;

    // 1) persist the user message
    this.store.appendMessage(session.id, {
      id: crypto.randomUUID(),
      role: "user",
      content: opts.userText,
      createdAt: Date.now(),
      meta: {
        source: "user",
        ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
      },
    });
    // Auto-title from first user message.
    if (!session.title) {
      this.store.renameSession(session.id, opts.userText.slice(0, 60));
    }

    opts.onEvent({ type: "turn.start", turnId, text: opts.userText });

    // Plan mode (M2): only read-only tools are advertised and executable.
    const plan = opts.plan === true;
    let baseTools: Tool[] = plan
      ? this.tools.list().filter((t) => t.read_only === true)
      : this.tools.list();
    // SSH sessions must not advertise local-only dynamic tools (MCP servers
    // spawned on this machine): the server passes per-host tools instead.
    if (opts.excludeToolPrefix) {
      const prefix = opts.excludeToolPrefix;
      baseTools = baseTools.filter((t) => !t.name.startsWith(prefix));
    }
    if (opts.extraTools && opts.extraTools.length > 0) {
      const present = new Set(baseTools.map((t) => t.name));
      baseTools = [...baseTools, ...opts.extraTools.filter((t) => !present.has(t.name))];
    }
    // M3: memory/skill tools only when the self-improvement context is wired.
    const effectiveTools: Tool[] = this.selfImprove
      ? baseTools
      : baseTools.filter((t) => !SELF_IMPROVE_TOOLS.includes(t.name as "memory_manage"));

    try {
      for (let stepIndex = 0; stepIndex < stepCeiling; stepIndex++) {
        steps += 1;
        if (stepIndex > 0 && stepIndex % stepWindow === 0) {
          // the previous window ended with tool calls pending — keep working
          opts.onEvent({
            type: "turn.continuing",
            turnId,
            kind: "steps",
            step: stepIndex,
            ceiling: stepCeiling,
          });
        }
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
        if (pendingNudge !== undefined) {
          extra.push(pendingNudge);
          pendingNudge = undefined;
        }
        if (session.remote) {
          extra.push(
            `## Remote execution\n` +
              `This session runs on the SSH host \`${backend.label}\` — bash/read/write/edit/glob/grep ` +
              `execute there over ssh, and the working directory \`${session.cwd}\` is on that host. ` +
              `MCP servers and language servers configured with a remote entry run there too; ` +
              `locally spawned MCP tools are hidden in this session.`,
          );
        }

        const system = buildSystemPrompt(this.cfg, {
          cwd: session.cwd,
          profile,
          toolNames: effectiveTools.map((t) => t.name),
          plan,
          extraSystem: extra,
        });

        let history = this.store.getMessages(session.id);
        history = await this.compactIfNeeded(history, session, opts);

        // ---- stream the assistant response ----
        const assistantId = crypto.randomUUID();
        opts.onEvent({ type: "message.start", messageId: assistantId, role: "assistant" });

        const textParts: string[] = [];
        const reasoningParts: string[] = [];
        let stepStopReason: string | undefined;
        let stepToolCalls: ToolCall[] = [];

        const provider = this.providers.get(providerId);
        let result!: Awaited<ReturnType<typeof provider.chat>>;
        try {
          result = await provider.chat(
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
              effort,
            },
            (chunk) => {
              if (chunk.type === "text") {
                textParts.push(chunk.text);
                opts.onEvent({ type: "text.delta", messageId: assistantId, text: chunk.text });
              } else if (chunk.type === "usage") {
                // cumulative (cost) vs per-step (context size) are tracked apart
                usage.totalPromptTokens =
                  (usage.totalPromptTokens ?? 0) + (chunk.usage.promptTokens ?? 0);
                usage.completionTokens =
                  (usage.completionTokens ?? 0) + (chunk.usage.completionTokens ?? 0);
                stepPromptFromChunks = chunk.usage.promptTokens ?? stepPromptFromChunks;
                lastStepPromptTokens = stepPromptFromChunks;
              } else if (chunk.type === "stop") {
                stepStopReason = chunk.finishReason;
              } else if (chunk.type === "tool_call_start" || chunk.type === "tool_call_delta") {
                observeProviderChunk(assistantId, chunk);
              } else if (chunk.type === "reasoning") {
                reasoningParts.push(chunk.text);
                opts.onEvent({ type: "reasoning.delta", messageId: assistantId, text: chunk.text });
              }
            },
          );
          // Collect here (before finally runs): the buffer must be drained
          // while the try body still owns it.
          stepToolCalls = takeObservedToolCalls(assistantId);
          stepStopReason = result.stopReason ?? stepStopReason;
        } finally {
          // never leak the observation buffer when a provider errors mid-stream
          callBuffers.delete(assistantId);
        }

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
          meta: {
            stopReason: stepStopReason ?? result.stopReason,
            ...(reasoningParts.length > 0 ? { reasoning: reasoningParts.join("") } : {}),
            // per-step usage — lets the web UI show the real context size after
            // a reload instead of guessing from the transcript
            ...(result.usage && (result.usage.promptTokens ?? 0) > 0 ? { usage: result.usage } : {}),
          },
        };
        this.store.appendMessage(session.id, assistantMsg);
        opts.onEvent({
          type: "message.end",
          messageId: assistantId,
          stopReason: stepStopReason,
          usage: result.usage,
        });

        // the step's own prompt size (provider usage wins over chunk sums)
        if ((result.usage?.promptTokens ?? 0) > 0) lastStepPromptTokens = result.usage!.promptTokens!;
        stepPromptFromChunks = 0;

        if (stepToolCalls.length === 0) {
          // The model stopped. If it left TODO items open and did not ask the
          // user a question, nudge it to keep working (what the user used to
          // have to trigger by typing 続けて). Bounded and visible.
          const nudge = this.todoContinuationNudge(session, assistantText, todoNudges);
          if (nudge !== undefined) {
            todoNudges += 1;
            pendingNudge = nudge;
            opts.onEvent({
              type: "turn.continuing",
              turnId,
              kind: "todos",
              step: stepIndex + 1,
              ceiling: stepCeiling,
            });
            continue;
          }
          finishedNaturally = true;
          break;
        }

        toolCallsTotal += stepToolCalls.length;

        // ---- execute tool calls ----
        const toolCtx: ToolContext = {
          sessionId: session.id,
          cwd: session.cwd,
          backend,
          remote: session.remote ?? null,
          yolo,
          ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
          config: this.cfg,
          approval: this.approval,
          todos: this.todos,
          taskRunner: this.taskRunner,
          selfImprove: this.selfImprove,
        };
        const runOne = async (call: ToolCall): Promise<void> => {
          opts.onEvent({ type: "tool.call", messageId: assistantId, toolCall: call });
          const startedAt = Date.now();
          await this.hooks?.run("pre_tool_use", {
            event: "pre_tool_use",
            sessionId: session.id,
            cwd: session.cwd,
            turnId,
            timestamp: startedAt,
            tool: call.name,
            args: safeArgs(call.arguments),
          });
          const output = await this.executeToolCall(call, toolCtx, plan, effectiveTools);
          const durationMs = Date.now() - startedAt;
          const isError = output.isError === true;
          const diff = output.diff && output.diff !== "" ? output.diff : undefined;
          await this.hooks?.run("post_tool_use", {
            event: "post_tool_use",
            sessionId: session.id,
            cwd: session.cwd,
            turnId,
            timestamp: Date.now(),
            tool: call.name,
            args: safeArgs(call.arguments),
            isError,
            durationMs,
            ...(diff ? { diff } : {}),
          });
          const resultMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: "tool",
            name: call.name,
            toolCallId: call.id,
            content: output.content,
            createdAt: Date.now(),
            meta: { isError, durationMs, ...(diff ? { diff } : {}) },
          };
          this.store.appendMessage(session.id, resultMsg);
          opts.onEvent({
            type: "tool.result",
            toolCallId: call.id,
            name: call.name,
            content: output.content,
            isError,
            durationMs,
            ...(diff ? { diff } : {}),
          });
        };
        // M5: subagent parallelization — one assistant message with several
        // task calls runs the subagents concurrently (other tools stay
        // sequential for deterministic file effects); results persist per call.
        const allTasks =
          stepToolCalls.length > 1 && stepToolCalls.every((c) => c.name === "task");
        if (allTasks) {
          await Promise.all(stepToolCalls.map((call) => runOne(call)));
        } else {
          for (const call of stepToolCalls) await runOne(call);
        }
      }

      if (!finishedNaturally) {
        // Step ceiling hit with work still in flight: leave a visible marker
        // instead of the transcript just stopping on a tool result.
        const marker =
          `[familiar: step ceiling (${stepCeiling}) reached — the turn paused mid-work. ` +
          `Reply “続けて” (or “continue”) to resume.]`;
        this.store.appendMessage(session.id, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: marker,
          createdAt: Date.now(),
          meta: { stopReason: "step_ceiling" },
        });
        opts.onEvent({ type: "turn.ceiling", turnId, step: stepCeiling });
      }

      const finalUsage: Usage = {
        ...(lastStepPromptTokens > 0
          ? { promptTokens: lastStepPromptTokens, contextTokens: lastStepPromptTokens }
          : {}),
        ...((usage.totalPromptTokens ?? 0) > 0
          ? { totalPromptTokens: usage.totalPromptTokens }
          : (usage.promptTokens ?? 0) > 0
            ? { totalPromptTokens: usage.promptTokens }
            : {}),
        ...(usage.completionTokens ? { completionTokens: usage.completionTokens } : {}),
      };
      opts.onEvent({ type: "turn.end", turnId, usage: finalUsage });
      await this.hooks?.run("turn_complete", {
        event: "turn_complete",
        sessionId: session.id,
        cwd: session.cwd,
        turnId,
        timestamp: Date.now(),
      });
      return { turnId, steps, toolCalls: toolCallsTotal, usage: finalUsage };
    } catch (err) {
      // User abort: not an error — announce and stop (provider fetch raised).
      if (opts.signal?.aborted) {
        opts.onEvent({ type: "turn.aborted", turnId });
        throw err;
      }
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
  ): Promise<ToolOutput> {
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
   * The model ended its turn with open TODO items and without asking a
   * question — tell it (as a system note for the next step) to keep going.
   * Returns undefined when there is nothing to nudge (no store, no open
   * items, a question was asked, or the per-turn budget is spent).
   */
  private todoContinuationNudge(
    session: SessionRecord,
    lastText: string,
    usedNudges: number,
  ): string | undefined {
    if (!this.todos || usedNudges >= 2) return undefined;
    const open = (this.todos.get(session.id) ?? []).filter((t) => t.status !== "done");
    if (open.length === 0) return undefined;
    // a question near the end is a deliberate hand-back: don't talk over it
    if (/[?？]/.test(lastText.slice(-200))) return undefined;
    const list = open
      .slice(0, 5)
      .map((t) => `${t.status}: ${t.title}`)
      .join("; ");
    return (
      `## Unfinished work\n` +
      `${open.length} TODO item(s) are still open (${list}). Continue working on them now. ` +
      `Do not stop while work remains — if you are truly blocked, state exactly what you need.`
    );
  }

  /**
   * M1/M4 compaction guard: character-based estimate over the soft limit.
   * mode "summarize" (default M4): ask the aux compactor (auxiliary.compactor
   * slot, else the session model) for a durable note; any failure falls back
   * to the M1 drop guard. Ephemeral either way (not persisted).
   *
   * The trigger combines two signals:
   *  - the character estimate (4 chars ≈ 1 token) — cheap but weak for
   *    Japanese, where real tokens are 3-4x the estimate;
   *  - the provider's own prompt-token count of the previous turn's last step
   *    (stored per assistant message) — the ground truth.
   * The threshold is `compaction.ratio` (default 0.9) of the model window
   * when the caller knows it, lowered by `token_soft_limit` when set.
   */
  private async compactIfNeeded(
    history: ChatMessage[],
    session: SessionRecord,
    opts: RunTurnOptions,
  ): Promise<ChatMessage[]> {
    let chars = 0;
    for (const m of history) {
      chars += m.content.length + (m.toolCalls?.length ?? 0) * 128;
      // image attachments ride along on every step, so they count too
      const atts = m.meta?.["attachments"];
      if (Array.isArray(atts)) {
        for (const a of atts) {
          if (a && typeof a === "object" && typeof (a as { data?: unknown }).data === "string") {
            chars += ((a as { data: string }).data.length * 3) / 4;
          }
        }
      }
    }
    const estimatedTokens = Math.ceil(chars / 4);
    const observedTokens = lastPromptTokens(history);
    const usedTokens = Math.max(estimatedTokens, observedTokens ?? 0);

    const ratio = this.cfg.context.compaction?.ratio ?? 0.9;
    const win = opts.contextWindowTokens ?? 0;
    const soft = this.cfg.context.token_soft_limit || 0;
    const limits: number[] = [];
    if (win > 0 && ratio > 0) limits.push(Math.max(1_000, Math.floor(win * ratio)));
    if (soft > 0) limits.push(soft);
    // nothing known about the model: keep a conservative fallback
    const limitTokens = limits.length > 0 ? Math.min(...limits) : 128_000;

    if (usedTokens < limitTokens) return history;
    const total = chars; // kept for the log line below
    const keepLast = Math.max(2, this.cfg.context.keep_last);
    const keepFirst = history.filter((m) => m.role === "user")[0];

    const firstIdx = keepFirst ? history.indexOf(keepFirst) : -1;
    const mid = history.slice(firstIdx + 1, history.length - keepLast);
    const dropped = mid.length;
    if (dropped <= 0) return history;

    let noteText: string | undefined;
    let summarized = false;
    if (this.cfg.context.compaction?.mode !== "drop") {
      noteText = await this.summarizeCompaction(mid, session);
      summarized = noteText !== undefined;
    }

    const note =
      noteText ??
      `[familiar: compaction guard: ${dropped} older messages were dropped from context]`;
    const compacted: ChatMessage[] = [];
    if (firstIdx >= 0) compacted.push(history[firstIdx]!);
    compacted.push({
      id: crypto.randomUUID(),
      role: "user",
      content: note,
      createdAt: Date.now(),
      meta: { ephemeral: true },
    });
    // Never start the kept tail on a tool result: its owning assistant
    // tool_calls message was just dropped and providers reject an orphan
    // `tool` message with a 400 (both OpenAI-style and Anthropic).
    let tailStart = history.length - keepLast;
    while (tailStart < history.length && history[tailStart]!.role === "tool") tailStart += 1;
    compacted.push(...history.slice(tailStart));

    let kept = 0;
    for (const m of compacted) kept += m.content.length;
    opts.onEvent({ type: "compaction", dropped, kept, summarized });
    log.warn(
      `compaction: ${summarized ? "summarized" : "dropped"} ${dropped} messages ` +
        `(estimate ${estimatedTokens} tok / observed ${observedTokens ?? "-"} tok >= ${limitTokens} tok${
          win > 0 ? ` = ${Math.round(ratio * 100)}% of ${win}` : ""
        })`,
    );
    return compacted;
  }

  /** One-shot aux chat for the compaction note; undefined on any failure. */
  private async summarizeCompaction(
    mid: ChatMessage[],
    session: SessionRecord,
  ): Promise<string | undefined> {
    try {
      const slot = this.cfg.auxiliary?.["compactor"];
      const providerId = slot?.provider ?? session.provider;
      const model = slot?.model ?? session.model;

      const transcript = mid
        .map((m) => `${m.role}: ${m.content.slice(0, 1200)}`)
        .join("\n")
        .slice(-12_000);
      const prompt =
        "# Compaction summary request (familiar)\n" +
        `CLIPPED=${mid.length}\n` +
        "The following older messages will be removed from context. Write a compact durable note (state, decisions, open questions, file paths, lessons) that future turns can rely on. Output ONLY the note text, max ~1200 chars.\n\nTRANSCRIPT:\n" +
        transcript;

      const parts: string[] = [];
      await this.providers
        .get(providerId)
        .chat(
          {
            model: model ?? "",
            messages: [{ id: crypto.randomUUID(), role: "user", content: prompt, createdAt: Date.now() }],
            tools: [],
            signal: AbortSignal.timeout(45_000),
          },
          (chunk) => {
            if (chunk.type === "text") parts.push(chunk.text);
          },
        );
      const text = parts.join("").trim().slice(0, 2000);
      return text.length > 0 ? text : undefined;
    } catch (err) {
      log.debug(
        `compaction summarize failed (drop fallback): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
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
/** Prompt tokens of the newest assistant step (the real context size). */
function lastPromptTokens(history: ChatMessage[]): number | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (!m || m.role !== "assistant") continue;
    const usage = m.meta?.["usage"] as { promptTokens?: unknown } | undefined;
    const n = Number(usage?.promptTokens);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

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
      arguments: repairToolArguments(c.arguments || "{}"),
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

/** Hook payloads carry whatever the model passed; tolerate non-JSON strings. */
function safeArgs(json?: string): unknown {
  try {
    return json ? JSON.parse(json) : undefined;
  } catch {
    return json;
  }
}
