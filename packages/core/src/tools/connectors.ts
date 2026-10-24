import type { Tool } from "./registry.js";
import type { ResolvedConfig } from "../config.js";

/** The connectors block of the loaded config. */
function connectorsOf(ctx: { config: ResolvedConfig }): Record<string, Record<string, string>> {
  return (ctx.config.connectors ?? {}) as Record<string, Record<string, string>>;
}

const notConfigured = (kind: string): { content: string; isError: true } => ({
  content: `${kind} connector is not configured — set it up in the Web UI (設定 → コネクタ) or ~/.familiar/config.yaml under connectors.${kind}.`,
  isError: true,
});

/** Google: exchange the stored refresh token for a fresh access token. */
async function googleAccessToken(ctx: { config: ResolvedConfig }): Promise<string> {
  const g = connectorsOf(ctx).google ?? {};
  if (!g.refresh_token || !g.client_id || !g.client_secret) {
    throw new Error("google connector is not linked (no refresh token) — run the OAuth flow in the Web UI");
  }
  if (g.access_token && Number(g.expiry ?? 0) > Date.now() + 30_000) return g.access_token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: g.refresh_token,
      client_id: g.client_id,
      client_secret: g.client_secret,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tok = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!tok.access_token) throw new Error("google token refresh failed");
  return tok.access_token;
}

const header = (headers: Array<{ name: string; value: string }>, name: string): string =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/**
 * Agent tools backed by the configured connectors: the AI can read
 * Redmine issues, Discord channels/messages, Gmail and Calendar once the
 * corresponding connector is set up in the Web UI.
 */
export function createConnectorTools(): Tool[] {
  return [
    {
      name: "redmine_issues",
      description:
        "List or search Redmine issues for the configured Redmine connector. Returns id, subject, status, assignee and updated date.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Optional project id/key to filter" },
          assigned_to_id: { type: "string", description: "Optional 'me' or a user id to filter" },
          limit: { type: "number", description: "Number of issues (default 10, cap 50)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const c = connectorsOf(ctx).redmine;
        if (!c?.base_url || !c.api_key) return notConfigured("redmine");
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
        const qs = new URLSearchParams({ limit: String(limit), sort: "updated_on:desc" });
        if (typeof args.project_id === "string" && args.project_id) qs.set("project_id", args.project_id);
        if (typeof args.assigned_to_id === "string" && args.assigned_to_id) {
          qs.set("assigned_to_id", args.assigned_to_id);
        }
        const res = await fetch(`${c.base_url.replace(/\/+$/, "")}/issues.json?${qs}`, {
          headers: { "X-Redmine-API-Key": c.api_key },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { content: `Redmine error: HTTP ${res.status}`, isError: true };
        const data = (await res.json()) as {
          issues?: Array<{ id: number; subject?: string; status?: { name?: string }; assigned_to?: { name?: string }; updated_on?: string; priority?: { name?: string } }>;
        };
        const issues = data.issues ?? [];
        if (issues.length === 0) return { content: "(no issues)", isError: false };
        const lines = issues.map((i) => {
          const parts = [
            `#${i.id}`,
            i.subject ?? "(no subject)",
            i.status?.name ? `[${i.status.name}]` : "",
            i.assigned_to?.name ? `→ ${i.assigned_to.name}` : "",
            i.updated_on ? `(${i.updated_on.slice(0, 10)})` : "",
          ].filter(Boolean);
          return parts.join(" ");
        });
        return { content: lines.join("\n"), isError: false };
      },
    },
    {
      name: "discord_channels",
      description:
        "List the Discord servers (guilds) and text channels the configured bot can see. Use discord_messages to read a channel afterwards.",
      read_only: true,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const c = connectorsOf(ctx).discord;
        if (!c?.token) return notConfigured("discord");
        const auth = { Authorization: `Bot ${c.token}` };
        const gRes = await fetch("https://discord.com/api/v10/users/@me/guilds", { headers: auth, signal: AbortSignal.timeout(15_000) });
        if (!gRes.ok) return { content: `Discord error: HTTP ${gRes.status} (check the bot token)`, isError: true };
        const guilds = (await gRes.json()) as Array<{ id: string; name: string }>;
        const out: string[] = [];
        for (const g of guilds.slice(0, 10)) {
          out.push(`■ ${g.name}`);
          const cRes = await fetch(`https://discord.com/api/v10/guilds/${g.id}/channels`, { headers: auth, signal: AbortSignal.timeout(15_000) });
          if (!cRes.ok) continue;
          const chans = (await cRes.json()) as Array<{ id: string; name: string; type: number }>;
          for (const ch of chans.filter((x) => x.type === 0).slice(0, 30)) {
            out.push(`  #${ch.name} (${ch.id})`);
          }
        }
        return { content: out.join("\n") || "(no guilds)", isError: false };
      },
    },
    {
      name: "discord_messages",
      description:
        "Read recent messages from a Discord text channel (use discord_channels to find the channel id). Returns author, time and content.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Discord channel id" },
          limit: { type: "number", description: "Number of messages (default 10, cap 50)" },
        },
        required: ["channel_id"],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const c = connectorsOf(ctx).discord;
        if (!c?.token) return notConfigured("discord");
        const channelId = String(args.channel_id ?? "");
        if (!/^\d+$/.test(channelId)) return { content: "argument 'channel_id' must be a numeric Discord channel id", isError: true };
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
        const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`, {
          headers: { Authorization: `Bot ${c.token}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { content: `Discord error: HTTP ${res.status}`, isError: true };
        if (!res.ok) return { content: `Discord error: HTTP ${res.status}`, isError: true };
        const msgs = (await res.json()) as Array<{ author?: { username?: string }; content?: string; timestamp?: string }>;
        if (!Array.isArray(msgs) || msgs.length === 0) return { content: "(no messages)", isError: false };
        const lines = msgs.reverse().map((m) => `[${(m.timestamp ?? "").slice(0, 16)}] ${m.author?.username ?? "?"}: ${(m.content ?? "").slice(0, 300)}`);
        return { content: lines.join("\n"), isError: false };
      },
    },
    {
      name: "gmail_list",
      description:
        "List recent Gmail messages for the linked Google account (requires the Google connector to be linked via OAuth). Returns from/subject/date/snippet.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          max: { type: "number", description: "Number of messages (default 10, cap 25)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        let token: string;
        try {
          token = await googleAccessToken(ctx);
        } catch (err) {
          return { content: err instanceof Error ? err.message : String(err), isError: true };
        }
        const max = Math.min(25, Math.max(1, Number(args.max) || 10));
        const list = (await (
          await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          })
        ).json()) as { messages?: Array<{ id: string }> };
        const out: string[] = [];
        for (const m of (list.messages ?? []).slice(0, max)) {
          const meta = (await (
            await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
              { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
            )
          ).json()) as { snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } };
          out.push(
            `${header(meta.payload?.headers ?? [], "Subject") || "(no subject)"} — ${header(meta.payload?.headers ?? [], "From")} [${header(meta.payload?.headers ?? [], "Date")}] ${meta.snippet ?? ""}`.slice(0, 300),
          );
        }
        return { content: out.join("\n") || "(no messages)", isError: false };
      },
    },
    {
      name: "calendar_events",
      description:
        "List upcoming Google Calendar events for the linked Google account (requires the Google connector to be linked via OAuth).",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          max: { type: "number", description: "Number of events (default 10, cap 25)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        let token: string;
        try {
          token = await googleAccessToken(ctx);
        } catch (err) {
          return { content: err instanceof Error ? err.message : String(err), isError: true };
        }
        const max = Math.min(25, Math.max(1, Number(args.max) || 10));
        const timeMin = new Date().toISOString();
        const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&maxResults=${max}&singleEvents=true&orderBy=startTime`;
        const data = (await (
          await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
        ).json()) as { items?: Array<{ summary?: string; start?: { dateTime?: string; date?: string }; location?: string }> };
        const items = data.items ?? [];
        if (items.length === 0) return { content: "(no upcoming events)", isError: false };
        const lines = items.map((e) => {
          const when = e.start?.dateTime ?? e.start?.date ?? "";
          return `${when.slice(0, 16)} ${e.summary ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}`;
        });
        return { content: lines.join("\n"), isError: false };
      },
    },
  ];
}
