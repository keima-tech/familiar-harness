import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Tool } from "./registry.js";

/** True for addresses that must never be reached from a public-page fetch. */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.replace(/^\[|\]$/g, "");
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
      (a === 198 && b !== undefined && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    if (/^::[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(lower)) {
      return isPrivateAddress(lower.slice(2)); // IPv4-compatible
    }
    return (
      lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") ||
      lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") ||
      lower.startsWith("feb") || lower.startsWith("2001:db8") ||
      lower.startsWith("2002:") || lower.startsWith("64:ff9b:")
    );
  }
  return true; // unknown address family: fail closed
}

interface PinnedAddress { ip: string; family: number }

/** Pick a public address to pin the connection to (defeats DNS rebinding). */
async function resolvePublic(
  host: string,
  allowExplicit: boolean,
): Promise<PinnedAddress | string> {
  const literal = host.replace(/^\[|\]$/g, "");
  if (net.isIP(literal)) {
    if (!allowExplicit && isPrivateAddress(literal)) return `${host} is a private address`;
    return { ip: literal, family: net.isIP(literal) };
  }
  try {
    const addresses = await lookup(host, { all: true });
    const usable = allowExplicit
      ? addresses
      : addresses.filter((entry) => !isPrivateAddress(entry.address));
    if (addresses.length === 0) return `could not resolve ${host}`;
    if (usable.length === 0) return `${host} resolves only to private addresses`;
    return { ip: usable[0]!.address, family: usable[0]!.family };
  } catch {
    return `could not resolve ${host}`;
  }
}

interface PinnedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** HTTP(S) GET pinned to the address we validated (no second DNS lookup). */
function fetchPinned(url: string, address: PinnedAddress): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(
      u,
      {
        lookup: (_host, _opts, cb) => cb(null, address.ip, address.family),
        servername: u.hostname,
        headers: { "user-agent": "familiar-harness/0.2 (+local agent)", host: u.host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          if (chunks.reduce((n, b) => n + b.length, 0) > 2_000_000) req.destroy(new Error("response too large"));
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
  });
}

/**
 * Fetch a URL and return readable text. HTML is crudely converted to text.
 * Domain policy from config plus resolved-IP checks (SSRF guard).
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
      // Follow redirects manually: every hop is re-checked, and the TCP
      // connection is pinned to the exact address we validated.
      let current = url;
      let res: PinnedResponse | undefined;
      try {
        for (let hop = 0; hop <= 5; hop++) {
          const hopHost = new URL(current).hostname;
          const hopPolicy = decideDomain(hopHost, webCfg);
          if (!hopPolicy.allowed) {
            return { content: `webfetch denied by policy: ${hopPolicy.reason}`, isError: true };
          }
          const explicit = matchesDomain(hopHost, webCfg.allow_domains);
          const address = await resolvePublic(hopHost, explicit);
          if (typeof address === "string") {
            return { content: `webfetch denied by IP policy: ${address}`, isError: true };
          }
          res = await fetchPinned(current, address);
          const rawLoc = res.headers["location"];
          const loc = Array.isArray(rawLoc) ? rawLoc[0] : rawLoc;
          if (res.status >= 300 && res.status < 400 && loc) {
            current = new URL(loc, current).toString();
            continue;
          }
          break;
        }
        if (!res) return { content: "too many redirects", isError: true };
      } catch (err) {
        return { content: `fetch failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      if (res.status >= 400) {
        return { content: `HTTP ${res.status} for ${url}`, isError: true };
      }
      const rawType = res.headers["content-type"];
      const contentType = Array.isArray(rawType) ? (rawType[0] ?? "") : (rawType ?? "");
      if (!/^(text\/|application\/json|application\/xhtml)/.test(contentType)) {
        return { content: `unsupported content-type: ${contentType || "unknown"} (binary refused)`, isError: true };
      }
      const text = new TextDecoder("utf8", { fatal: false }).decode(res.body.subarray(0, 1_000_000));
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
  // An explicit allowlist (e.g. a local dev server) overrides the default
  // deny patterns; otherwise the internal/SSRF deny list wins.
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
