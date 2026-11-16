import type { Tool, ToolOutput } from "./registry.js";

/**
 * result_read / result_search — pull slices back out of a compressed tool
 * result. Large tool results are stored whole and replaced in the prompt by a
 * head/tail digest plus a short handle; these tools let the model read any
 * slice or find matching lines without re-sending the entire text.
 *
 * Inspired by "recursive/compressed context" harnesses: nothing is thrown
 * away, the model just fetches what it needs.
 */

const READ_CAP = 20_000; // chars returned in one result_read
const SEARCH_MAX = 60; // matching lines returned by result_search

const NO_STORE: ToolOutput = {
  content: "no compressed tool results are available in this context",
  isError: true,
};

export function createResultReadTool(): Tool {
  return {
    name: "result_read",
    description:
      "Read a slice of a compressed tool result by its handle. Use when a tool result was elided (shown as a head/tail digest). offset and limit are character positions.",
    read_only: true,
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Handle shown in the compressed tool result header" },
        offset: { type: "number", description: "0-based character offset to start from (default 0)" },
        limit: { type: "number", description: `Maximum characters to return (default 4000, cap ${READ_CAP})` },
      },
      required: ["handle"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const handle = typeof args.handle === "string" ? args.handle.trim() : "";
      if (!handle) return { content: "argument 'handle' is required", isError: true };
      const store = ctx.resultStore;
      if (!store) return NO_STORE;
      const rec = store.get(handle);
      if (!rec) return { content: `unknown handle: ${handle}`, isError: true };
      const offset = Math.max(0, Number.isFinite(args.offset) ? Math.floor(Number(args.offset)) : 0);
      const limit = Math.min(
        READ_CAP,
        Math.max(1, Number.isFinite(args.limit) ? Math.floor(Number(args.limit)) : 4000),
      );
      if (offset >= rec.content.length) {
        return { content: `(offset ${offset} is beyond the end: ${rec.content.length} chars)`, isError: false };
      }
      const slice = rec.content.slice(offset, offset + limit);
      const end = offset + slice.length;
      const more = end < rec.content.length;
      return {
        content:
          `[${rec.name} · ${offset}..${end} of ${rec.content.length} chars${more ? " (more available)" : ""}]\n` +
          slice,
        isError: false,
      };
    },
  };
}

export function createResultSearchTool(): Tool {
  return {
    name: "result_search",
    description:
      "Search inside a compressed tool result by its handle. Returns matching lines with their character offsets so a follow-up result_read can fetch context.",
    read_only: true,
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Handle shown in the compressed tool result header" },
        pattern: { type: "string", description: "Regular expression (JS syntax) or literal text" },
        literal: { type: "boolean", description: "Treat pattern as literal text (default false)" },
        case_sensitive: { type: "boolean", description: "Default true" },
        max_results: { type: "number", description: `Maximum matches (default 20, cap ${SEARCH_MAX})` },
      },
      required: ["handle", "pattern"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const handle = typeof args.handle === "string" ? args.handle.trim() : "";
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      if (!handle || !pattern) {
        return { content: "arguments 'handle' and 'pattern' are required", isError: true };
      }
      const store = ctx.resultStore;
      if (!store) return NO_STORE;
      const rec = store.get(handle);
      if (!rec) return { content: `unknown handle: ${handle}`, isError: true };
      const flags = args.case_sensitive === false ? "i" : "";
      let re: RegExp;
      try {
        re = new RegExp(args.literal === true ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, flags);
      } catch (err) {
        return { content: `invalid regex: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      const max = Math.min(
        SEARCH_MAX,
        Math.max(1, Number.isFinite(args.max_results) ? Math.floor(Number(args.max_results)) : 20),
      );
      const out: string[] = [];
      let offset = 0;
      let total = 0;
      for (const line of rec.content.split("\n")) {
        if (re.test(line)) {
          total += 1;
          if (out.length < max) {
            const preview = line.length > 240 ? `${line.slice(0, 240)}…` : line;
            out.push(`@${offset}: ${preview}`);
          }
        }
        offset += line.length + 1; // + newline
      }
      if (out.length === 0) return { content: "(no matches)", isError: false };
      return {
        content:
          out.join("\n") + (total > out.length ? `\n(+${total - out.length} more matches)` : ""),
        isError: false,
      };
    },
  };
}
