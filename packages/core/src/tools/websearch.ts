import type { Tool } from "./registry.js";

/**
 * Search the web via a SearXNG instance (JSON API).
 * Configure `permissions.websearch.base_url` (e.g. a local SearXNG).
 */
export function createWebSearchTool(): Tool {
  return {
    name: "websearch",
    description:
      "Search the web using the configured SearXNG instance and return title/URL/snippet results.",
    read_only: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query", minLength: 1 },
        count: { type: "number", description: "Number of results (default 5, cap 20)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { content: "argument 'query' is required", isError: true };
      const count = Math.min(
        20,
        Math.max(1, Number.isFinite(args.count) && args.count !== undefined ? Number(args.count) : 5),
      );
      const base = ctx.config.permissions.websearch.base_url.replace(/\/+$/, "");
      if (!base) {
        return {
          content:
            "websearch is not configured. Set permissions.websearch.base_url in ~/.familiar/config.yaml " +
            "(e.g. local SearXNG: http://127.0.0.1:8080). See docs/spec/05-config.md.",
          isError: true,
        };
      }
      let res: Response;
      try {
        const searchUrl = `${base}/search?${new URLSearchParams({ q: query, format: "json" }).toString()}`;
        res = await fetch(searchUrl, {
          headers: { "user-agent": "familiar-harness/0.2 (+local agent)" },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        return {
          content: `search backend unreachable (${base}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      if (!res.ok) {
        return {
          content: `search backend error: HTTP ${res.status} from ${base}. Check base_url and SearXNG JSON output (format=json must be allowed).`,
          isError: true,
        };
      }
      let data: { results?: { title?: string; url?: string; content?: string; engine?: string }[] };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        return { content: "search backend returned non-JSON (is format=json enabled?)", isError: true };
      }
      const results = (data.results ?? []).slice(0, count);
      if (results.length === 0) return { content: "(no results)", isError: false };
      const lines = results.map((r, i) => {
        const title = r.title ?? "(untitled)";
        const url = r.url ?? "";
        const snippet = (r.content ?? "").slice(0, 200);
        return `${i + 1}. ${title}${url ? ` — ${url}` : ""}${snippet ? `\n   ${snippet}` : ""}`;
      });
      return { content: lines.join("\n"), isError: false };
    },
  };
}
