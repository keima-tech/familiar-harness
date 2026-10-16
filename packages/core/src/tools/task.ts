import type { Tool } from "./registry.js";

/**
 * Delegate focused work to a subagent (separate session, same provider/model
 * by default). Available when the server injects a taskRunner (M2, serial).
 */
export function createTaskTool(): Tool {
  return {
    name: "task",
    description:
      "Run a focused subagent on its own session and get its final answer. " +
      "Use for self-contained research/analysis that would clutter the main conversation. " +
      "The subagent has the same tools you do, so give it a complete, unambiguous instruction.",
    read_only: false,
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short label of the delegated work (shown to the user)", minLength: 1 },
        prompt: { type: "string", description: "Full instruction for the subagent, incl. expected output shape", minLength: 1 },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const runner = ctx.taskRunner;
      if (!runner) return { content: "task tool unavailable in this context", isError: true };
      const description = typeof args.description === "string" ? args.description.trim() : "";
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!description || !prompt) {
        return { content: "arguments 'description' and 'prompt' are required", isError: true };
      }
      try {
        const result = await runner({ description, prompt, sessionId: ctx.sessionId, yolo: ctx.yolo });
        return {
          content:
            `[task done] ${description}\n--- subagent final message ---\n${result}`.trim(),
          isError: false,
        };
      } catch (err) {
        return {
          content: `subagent failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
