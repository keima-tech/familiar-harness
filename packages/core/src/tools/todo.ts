import crypto from "node:crypto";
import type { TodoItem, TodoStatus } from "@familiar/protocol";
import type { Tool } from "./registry.js";

function isValidStatus(s: unknown): s is TodoStatus {
  return s === "pending" || s === "in_progress" || s === "done";
}

function renderTodoList(items: TodoItem[]): string {
  const order = { in_progress: 0, pending: 1, done: 2 };
  const sorted = [...items].sort((a, b) => order[a.status] - order[b.status]);
  const lines = sorted.map(
    (t) => `- [${t.status === "done" ? "x" : " "}] #${t.id} (${t.status}) ${t.title}`,
  );
  return lines.length > 0 ? lines.join("\n") : "(no todos — use action=add to create)";
}

/**
 * Session todo list. Backed by the server's TodoStore and mirrored into the
 * system prompt each step ("# Current todo state").
 */
export function createTodoTool(): Tool {
  return {
    name: "todo",
    description:
      "Maintain this session's todo list (plan/track multi-step work). " +
      "Actions: set (replace list), add, update, remove. The list is shown to you every step — keep it accurate.",
    read_only: false,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "add", "update", "remove"], description: "Operation" },
        items: {
          type: "array",
          description: "For set: list of {title, status?}",
        },
        id: { type: "string", description: "Todo id for update/remove" },
        title: { type: "string", description: "Title for add/update" },
        status: { type: "string", enum: ["pending", "in_progress", "done"], description: "Status for add/update" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const store = ctx.todos;
      if (!store) return { content: "todo store unavailable in this context", isError: true };
      const list = store.get(ctx.sessionId);
      const action = String(args.action);

      if (action === "set") {
        const raw = Array.isArray(args.items) ? (args.items as unknown[]) : [];
        const items: TodoItem[] = raw.slice(0, 50).map((entry, i) => {
          const obj = (entry ?? {}) as Record<string, unknown>;
          const status = isValidStatus(obj.status) ? obj.status : "pending";
          return {
            id: crypto.randomUUID().slice(0, 4),
            title: String(obj.title ?? `(item ${i + 1})`),
            status,
            createdAt: Date.now(),
          };
        });
        store.set(ctx.sessionId, items);
        return { content: `todo list replaced (${items.length} items):\n${renderTodoList(items)}`, isError: false };
      }

      if (action === "add") {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) return { content: "argument 'title' is required for add", isError: true };
        const item: TodoItem = {
          id: crypto.randomUUID().slice(0, 4),
          title,
          status: isValidStatus(args.status) ? args.status : "pending",
          createdAt: Date.now(),
        };
        store.set(ctx.sessionId, [...list, item]);
        return { content: `added #${item.id}:\n${renderTodoList(store.get(ctx.sessionId))}`, isError: false };
      }

      if (action === "update") {
        const id = String(args.id ?? "");
        const target = list.find((t) => t.id === id);
        if (!target) {
          return { content: `todo not found: ${id}\n${renderTodoList(list)}`, isError: true };
        }
        const updated: TodoItem = {
          ...target,
          title: typeof args.title === "string" && args.title.trim() !== "" ? args.title.trim() : target.title,
          status: isValidStatus(args.status) ? args.status : target.status,
        };
        store.set(ctx.sessionId, list.map((t) => (t.id === id ? updated : t)));
        return { content: `updated #${id}:\n${renderTodoList(store.get(ctx.sessionId))}`, isError: false };
      }

      if (action === "remove") {
        const id = String(args.id ?? "");
        const remaining = list.filter((t) => t.id !== id);
        if (remaining.length === list.length) {
          return { content: `todo not found: ${id}\n${renderTodoList(list)}`, isError: true };
        }
        store.set(ctx.sessionId, remaining);
        return { content: `removed #${id}:\n${renderTodoList(remaining)}`, isError: false };
      }

      return { content: `unknown action: ${action} (set|add|update|remove)`, isError: true };
    },
  };
}
