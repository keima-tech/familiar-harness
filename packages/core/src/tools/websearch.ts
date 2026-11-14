import type { Tool } from "./registry.js";

/** Strip tags + decode the few entities DDG snippets use. */
function cleanText(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&") // last, so &amp;lt; does not become "<"
    .trim();
}

/** DuckDuckGo HTML results (no API key, works out of the box). */
async function ddgSearch(query: string, count: number): Promise<{ content: string; isError?: boolean }> {
  let res: Response;
  try {
    res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 familiar-harness/0.2",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { content: `web search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
  if (!res.ok) {
    return { content: `web search error: HTTP ${res.status} from DuckDuckGo`, isError: true };
  }
  const html = await res.text();
  // result blocks: anchor.result__a (title + redirect href) followed by snippet
  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => cleanText(m[1] ?? ""));
  if (links.length === 0) {
    return { content: "(no results — DuckDuckGo may be rate-limiting; try again or configure SearXNG)", isError: false };
  }
  const results = links.slice(0, count).map((m, i) => {
    const rawUrl = m[1] ?? "";
    let url = rawUrl;
    const uddg = /[?&]uddg=([^&]+)/.exec(rawUrl);
    if (uddg?.[1]) url = decodeURIComponent(uddg[1]!);
    if (url.startsWith("//")) url = `https:${url}`;
    return { title: cleanText(m[2] ?? ""), url, snippet: snippets[i] ?? "" };
  });
  const lines = results.map((r, i) => {
    const title = r.title || "(untitled)";
    return `${i + 1}. ${title}${r.url ? ` — ${r.url}` : ""}${r.snippet ? `\n   ${r.snippet}` : ""}`;
  });
  return { content: lines.join("\n"), isError: false };
}

/**
 * Search the web: DuckDuckGo out of the box, or a SearXNG instance via
 * permissions.websearch.base_url.
 */
export function createWebSearchTool(): Tool {
  return {
    name: "websearch",
    description:
      "Search the web and return title/URL/snippet results. Uses DuckDuckGo by default (no configuration) or the configured SearXNG instance.",
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
      const provider = ctx.config.permissions.websearch.provider ?? "duckduckgo";
      const base = (ctx.config.permissions.websearch.base_url ?? "").replace(/\/+$/, "");
      if (provider === "duckduckgo" || base === "") {
        if (provider === "searxng" && base === "") {
          return {
            content:
              "websearch provider is searxng but base_url is empty. Set permissions.websearch.base_url " +
              "in ~/.familiar/config.yaml or switch provider to duckduckgo.",
            isError: true,
          };
        }
        return ddgSearch(query, count);
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
