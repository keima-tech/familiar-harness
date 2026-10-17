import type { Tool, ToolContext } from "../../tools/registry.js";

/**
 * memory_manage — durable facts injected every turn.
 * All writes go through the approval gate (staged by default).
 */
export function createMemoryManageTool(): Tool {
  return {
    name: "memory_manage",
    description:
      "Create/patch/remove durable memory entries that are injected into every future turn " +
      "(small facts the user wants remembered: preferences, corrections, stable project facts). " +
      "Writes are staged for user approval by default. Do NOT store secrets, session transcripts, or PR logs.",
    read_only: false,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "patch", "remove", "list"], description: "Operation" },
        id: { type: "string", description: "Memory id for patch/remove (e.g. a3f2... from the prompt)" },
        content: { type: "string", description: "New content for create/patch (a generalizable fact)" },
        tags: { type: "array", description: "Optional short tags", items: { type: "string" } },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const si = ctx.selfImprove;
      if (!si) return { content: "memory store unavailable in this context", isError: true };
      const action = String(args.action);
      const approvalOn =
        si.settings.get("memory_write_approval") ?? ctx.config?.memory?.write_approval !== false;

      if (action === "list") {
        const entries = si.memories.list();
        const pending = si.pendingMemories.count();
        const lines = entries
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((m) => `- (${m.id}, ${new Date(m.updatedAt).toISOString().slice(0, 10)}) ${m.content}`);
        return {
          content: `${entries.length} memories, ${pending} staged for approval\n${lines.join("\n") || "(none)"}`,
          isError: false,
        };
      }

      if (action === "create") {
        const content = typeof args.content === "string" ? args.content.trim() : "";
        if (!content) return { content: "argument 'content' is required for create", isError: true };
        const tags = readTags(args.tags);
        if (approvalOn) {
          const { id } = si.pendingMemories.stage({
            kind: "create",
            namespace: "default",
            content,
            tags,
            reason: `staged by agent (${ctx.sessionId.slice(0, 8)})`,
          });
          return {
            content: `staged for approval (#${id}, kind=create). The user can run 'familiar memory approve ${id}'.`,
            isError: false,
          };
        }
        const entry = si.memories.create(content, tags, "foreground");
        return { content: `created memory ${entry.id}`, isError: false };
      }

      if (action === "patch") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const content = typeof args.content === "string" ? args.content.trim() : "";
        if (!id || !content) return { content: "arguments 'id' and 'content' are required for patch", isError: true };
        const target = si.memories.findPrefix(id);
        if (!target) return { content: `memory not found: ${id}`, isError: true };
        const tags = readTags(args.tags);
        if (approvalOn) {
          const { id: pid } = si.pendingMemories.stage({
            kind: "patch",
            target: target.id,
            namespace: target.namespace,
            content,
            tags,
            snapshotUpdatedAt: target.updatedAt,
            reason: `staged by agent (${ctx.sessionId.slice(0, 8)})`,
          });
          return {
            content: `staged for approval (#${pid}, kind=patch ${target.id}).`,
            isError: false,
          };
        }
        try {
          const updated = si.memories.patch(target.id, content, tags, target.updatedAt);
          return { content: `patched ${target.id} -> ${updated?.id}`, isError: false };
        } catch (err) {
          return { content: `patch refused: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }

      if (action === "remove") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) return { content: "argument 'id' is required for remove", isError: true };
        const target = si.memories.findPrefix(id);
        if (!target) return { content: `memory not found: ${id}`, isError: true };
        if (approvalOn) {
          const { id: pid } = si.pendingMemories.stage({
            kind: "remove",
            target: target.id,
            namespace: target.namespace,
            snapshotUpdatedAt: target.updatedAt,
            reason: `staged by agent (${ctx.sessionId.slice(0, 8)})`,
          });
          return { content: `staged for approval (#${pid}, kind=remove ${target.id}).`, isError: false };
        }
        try {
          const ok = si.memories.remove(target.id, target.updatedAt);
          return { content: ok ? `removed ${target.id}` : "not found", isError: !ok };
        } catch (err) {
          return { content: `remove refused: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }

      return { content: `unknown action: ${action} (create|patch|remove|list)`, isError: true };
    },
  };
}

function readTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === "string").slice(0, 5);
}
