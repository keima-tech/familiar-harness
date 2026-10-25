import type { Tool } from "./registry.js";

/**
 * Fetch a URL and return readable text. HTML is crudely converted to text.
 * Domain policy from config (internal addresses denied by default — SSRF guard).
 */
export function createWebFetchTool(): Tool {
  return {
    name: "webfetch",
    description:
      "Fetch a web page and return readable text (HTML converted, capped). " +
      "Internal/private network addresses are denied by config policy.",
    read_only: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL", minLength: 1 },
        max_chars: { type: "number", description: "Max characters returned (default 20000, cap 100000)" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) {
        return { content: "url must be an absolute http(s) URL", isError: true };
      }
      const maxChars = Math.min(
        100_000,
        Math.max(200, Number.isFinite(args.max_chars) ? Number(args.max_chars) : 20_000),
      );
      let host;
      try {
        host = new URL(url).hostname;
      } catch {
        return { content: `invalid URL: ${url}`, isError: true };
      }
      const webCfg = ctx.config.permissions.webfetch;
      const policy = decideDomain(host, webCfg);
      if (!policy.allowed) {
        return { content: `webfetch denied by policy: ${policy.reason}`, isError: true };
      }

      // Follow redirects manually: every hop is re-checked against the domain
      // policy, otherwise a public host could redirect us into the LAN.
      let current = url;
      let res: Response | undefined;
      try {
        for (let hop = 0; hop <= 5; hop++) {
          const hopHost = new URL(current).hostname;
          const hopPolicy = decideDomain(hopHost, webCfg);
          if (!hopPolicy.allowed) {
            return { content: `webfetch denied by policy: ${hopPolicy.reason}`, isError: true };
          }
          res = await fetch(current, {
            redirect: "manual",
            headers: { "user-agent": "familiar-harness/0.2 (+local agent)" },
            signal: AbortSignal.timeout(30_000),
          });
          const loc = res.headers.get("location");
          if (res.status >= 300 && res.status < 400 && loc) {
            res.body?.cancel().catch(() => undefined);
            current = new URL(loc, current).toString();
            continue;
          }
          break;
        }
        if (!res) return { content: "too many redirects", isError: true };
      } catch (err) {
        return { content: `fetch failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      if (!res.ok) {
        return { content: `HTTP ${res.status} for ${url}`, isError: true };
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!/^(text\/|application\/json|application\/xhtml)/.test(contentType)) {
        return { content: `unsupported content-type: ${contentType || "unknown"} (binary refused)`, isError: true };
      }
      const limited = await res.arrayBuffer().catch(() => null);
      if (!limited) return { content: "failed to read response body", isError: true };
      const text = new TextDecoder("utf8", { fatal: false }).decode(limited.slice(0, 1_000_000));
      const body = contentType.includes("html") || /<\s*[a-z!]/i.test(text) ? htmlToText(text) : text;
      const trimmed = body.length > maxChars ? `${body.slice(0, maxChars)}\n[familiar: truncated at ${maxChars} chars]` : body;
      return { content: trimmed.trim() || "(empty page)", isError: false };
    },
  };
}

export function decideDomain(
  host: string,
  cfg: { allow_domains: string[]; deny_domains: string[] },
): { allowed: boolean; reason: string } {
  if (matchesDomain(host, cfg.allow_domains)) return { allowed: true, reason: "allowlist" };
  if (matchesDomain(host, cfg.deny_domains)) {
    return { allowed: false, reason: `${host} matches deny_domains (internal/SSRF guard)` };
  }
  return { allowed: true, reason: "default-open" };
}

function matchesDomain(host: string, patterns: string[]): boolean {
  // URL.hostname keeps the brackets around IPv6 literals ("[::1]")
  const normalized = host.toLowerCase().replace(/[\[\]]/g, "").replace(/\.+$/, "");
  for (const rawPattern of patterns) {
    const pattern = rawPattern.toLowerCase().replace(/\./g, "\\.").replace(/\*/g, "[a-z0-9.-]*");
    // subdomains match, one extra prepended character does not
    if (new RegExp(`^(.+\\.)?${pattern}$`, "i").test(normalized) || normalized === rawPattern.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/** Minimal HTML→text: drop scripts/styles, strip tags, unwrap common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
