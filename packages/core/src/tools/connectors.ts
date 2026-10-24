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
    {
      name: "github_issues",
      description:
        "List issues via the configured GitHub connector. With 'repo' (owner/name) lists that repository's issues, otherwise lists issues assigned to the authenticated user. Returns number, title, state, author and updated date.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Optional repository as owner/name (e.g. octocat/hello-world)" },
          state: { type: "string", description: "open | closed | all (default open)" },
          limit: { type: "number", description: "Number of issues (default 10, cap 50)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const c = connectorsOf(ctx).github;
        if (!c?.token) return notConfigured("github");
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
        const state = ["open", "closed", "all"].includes(String(args.state)) ? String(args.state) : "open";
        const repo = typeof args.repo === "string" ? args.repo.trim() : "";
        const url = repo
          ? `https://api.github.com/repos/${repo}/issues?state=${state}&per_page=${limit}&sort=updated&direction=desc`
          : `https://api.github.com/issues?filter=assigned&state=${state}&per_page=${limit}`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${c.token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "familiar-harness",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { content: `GitHub error: HTTP ${res.status} (check the token and repo)`, isError: true };
        const issues = (await res.json()) as Array<{
          number: number;
          title?: string;
          state?: string;
          user?: { login?: string };
          updated_at?: string;
          pull_request?: unknown;
        }>;
        if (issues.length === 0) return { content: "(no issues)", isError: false };
        const lines = issues.map((i) => {
          const parts = [
            i.pull_request ? "[PR]" : "",
            `#${i.number}`,
            i.title ?? "(no title)",
            i.state ? `[${i.state}]` : "",
            i.user?.login ? `(${i.user.login})` : "",
            i.updated_at ? `updated ${i.updated_at.slice(0, 10)}` : "",
          ].filter(Boolean);
          return parts.join(" ");
        });
        return { content: lines.join("\n"), isError: false };
      },
    },
    {
      name: "gitlab_issues",
      description:
        "List issues via the configured GitLab connector. With 'project' (path or id) lists that project's issues, otherwise lists issues assigned to the authenticated user. Returns iid, title, state, assignee and updated date.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Optional project path (group/project) or numeric id" },
          state: { type: "string", description: "opened | closed | all (default opened)" },
          limit: { type: "number", description: "Number of issues (default 10, cap 50)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const c = connectorsOf(ctx).gitlab;
        if (!c?.token) return notConfigured("gitlab");
        const base = (c.base_url || "https://gitlab.com").replace(/\/+$/, "");
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
        const state = ["opened", "closed", "all"].includes(String(args.state)) ? String(args.state) : "opened";
        const project = typeof args.project === "string" ? args.project.trim() : "";
        const url = project
          ? `${base}/api/v4/projects/${encodeURIComponent(project)}/issues?state=${state}&per_page=${limit}&order_by=updated_at`
          : `${base}/api/v4/issues?scope=assigned_to_me&state=${state}&per_page=${limit}&order_by=updated_at`;
        const res = await fetch(url, { headers: { "PRIVATE-TOKEN": c.token }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return { content: `GitLab error: HTTP ${res.status} (check the token and project)`, isError: true };
        const issues = (await res.json()) as Array<{
          iid: number;
          title?: string;
          state?: string;
          assignee?: { name?: string } | null;
          updated_at?: string;
        }>;
        if (issues.length === 0) return { content: "(no issues)", isError: false };
        const lines = issues.map((i) => {
          const parts = [
            `!${i.iid}`,
            i.title ?? "(no title)",
            i.state ? `[${i.state}]` : "",
            i.assignee?.name ? `→ ${i.assignee.name}` : "",
            i.updated_at ? `updated ${i.updated_at.slice(0, 10)}` : "",
          ].filter(Boolean);
          return parts.join(" ");
        });
        return { content: lines.join("\n"), isError: false };
      },
    },
    {
      name: "backlog_issues",
      description:
        "List issues via the configured Backlog connector. Returns issue key, summary, status, assignee and updated date. Optionally filter by projectId.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Optional Backlog project id to filter" },
          limit: { type: "number", description: "Number of issues (default 10, cap 50)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const c = connectorsOf(ctx).backlog;
        if (!c?.base_url || !c.api_key) return notConfigured("backlog");
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
        const qs = new URLSearchParams({ apiKey: c.api_key, count: String(limit), sort: "updated", order: "desc" });
        if (typeof args.project_id === "string" && args.project_id) qs.set("projectId[]", args.project_id);
        const res = await fetch(`${c.base_url.replace(/\/+$/, "")}/api/v2/issues?${qs}`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return { content: `Backlog error: HTTP ${res.status} (check the space URL and API key)`, isError: true };
        const issues = (await res.json()) as Array<{
          issueKey?: string;
          summary?: string;
          status?: { name?: string };
          assignee?: { name?: string } | null;
          updated?: string;
        }>;
        if (!Array.isArray(issues) || issues.length === 0) return { content: "(no issues)", isError: false };
        const lines = issues.map((i) => {
          const parts = [
            i.issueKey ?? "?",
            i.summary ?? "(no summary)",
            i.status?.name ? `[${i.status.name}]` : "",
            i.assignee?.name ? `→ ${i.assignee.name}` : "",
            i.updated ? `updated ${String(i.updated).slice(0, 10)}` : "",
          ].filter(Boolean);
          return parts.join(" ");
        });
        return { content: lines.join("\n"), isError: false };
      },
    },
    {
      name: "notion_search",
      description:
        "Search pages and databases via the configured Notion connector (requires the integration to be shared with the target pages). Returns title, type and URL.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional search text (empty lists everything the integration can see)" },
          limit: { type: "number", description: "Number of results (default 10, cap 25)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const c = connectorsOf(ctx).notion;
        if (!c?.token) return notConfigured("notion");
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        const body: Record<string, unknown> = { page_size: limit, sort: { direction: "descending", timestamp: "last_edited_time" } };
        if (typeof args.query === "string" && args.query.trim()) body.query = args.query.trim();
        const res = await fetch("https://api.notion.com/v1/search", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { content: `Notion error: HTTP ${res.status} (check the integration token)`, isError: true };
        const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
        const results = data.results ?? [];
        if (results.length === 0) return { content: "(no results)", isError: false };
        const plain = (arr: unknown): string =>
          Array.isArray(arr)
            ? arr.map((x) => (x as { plain_text?: string }).plain_text ?? "").join("")
            : "";
        const titleOf = (item: Record<string, unknown>): string => {
          if (item.object === "database") return plain(item.title) || "(untitled)";
          const props = (item.properties ?? {}) as Record<string, { type?: string; title?: unknown }>;
          for (const p of Object.values(props)) {
            if (p?.type === "title") return plain(p.title) || "(untitled)";
          }
          return "(untitled)";
        };
        const lines = results.map((r) => {
          const id = String(r.id ?? "").replace(/-/g, "");
          return `${r.object === "database" ? "🗄" : "📄"} ${titleOf(r)} — https://www.notion.so/${id}`;
        });
        return { content: lines.join("\n"), isError: false };
      },
    },
    {
      name: "slack_channels",
      description:
        "List public and private channels the configured Slack bot can see. Returns name and id (use slack_history to read a channel).",
      read_only: true,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const c = connectorsOf(ctx).slack;
        if (!c?.token) return notConfigured("slack");
        const res = await fetch("https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200", {
          headers: { Authorization: `Bearer ${c.token}` },
          signal: AbortSignal.timeout(15_000),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string; channels?: Array<{ id: string; name?: string; is_private?: boolean; num_members?: number }> };
        if (!data.ok) return { content: `Slack error: ${data.error ?? `HTTP ${res.status}`}`, isError: true };
        const channels = data.channels ?? [];
        if (channels.length === 0) return { content: "(no channels — is the bot invited?)", isError: false };
        const lines = channels.map((ch) => `${ch.is_private ? "🔒" : "#"} ${ch.name ?? "?"} (${ch.id})${ch.num_members !== undefined ? ` · ${ch.num_members} members` : ""}`);
        return { content: lines.join("\n"), isError: false };
      },
    },
    {
      name: "slack_history",
      description:
        "Read recent messages from a Slack channel (accepts a channel id or name; use slack_channels to list them). Returns time, user id and text.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel id (C…) or name (#general / general)" },
          limit: { type: "number", description: "Number of messages (default 10, cap 50)" },
        },
        required: ["channel"],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const c = connectorsOf(ctx).slack;
        if (!c?.token) return notConfigured("slack");
        const auth = { Authorization: `Bearer ${c.token}` };
        let channel = String(args.channel ?? "").trim().replace(/^#/, "");
        if (!/^[CGD][A-Z0-9]+$/.test(channel)) {
          const listRes = await fetch("https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=400", {
            headers: auth,
            signal: AbortSignal.timeout(15_000),
          });
          const list = (await listRes.json()) as { ok?: boolean; channels?: Array<{ id: string; name?: string }> };
          const hit = (list.channels ?? []).find((ch) => ch.name === channel);
          if (!hit) return { content: `Slack channel not found: ${args.channel} (see slack_channels)`, isError: true };
          channel = hit.id;
        }
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
        const res = await fetch(`https://slack.com/api/conversations.history?channel=${channel}&limit=${limit}`, {
          headers: auth,
          signal: AbortSignal.timeout(15_000),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string; messages?: Array<{ user?: string; bot_id?: string; text?: string; ts?: string }> };
        if (!data.ok) return { content: `Slack error: ${data.error ?? `HTTP ${res.status}`} (invite the bot to the channel)`, isError: true };
        const msgs = (data.messages ?? []).slice().reverse();
        if (msgs.length === 0) return { content: "(no messages)", isError: false };
        const lines = msgs.map((m) => {
          const when = m.ts ? new Date(Number(m.ts) * 1000).toISOString().slice(0, 16) : "";
          const who = m.user ?? m.bot_id ?? "?";
          return `[${when}] ${who}: ${(m.text ?? "").slice(0, 300)}`;
        });
        return { content: lines.join("\n"), isError: false };
      },
    },
    {
      name: "teams_channels",
      description:
        "List Microsoft Teams the user is a member of and their channels via the configured Teams (Graph) connector. With 'team_id' lists that team's channels only.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          team_id: { type: "string", description: "Optional team id (from a previous call)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const c = connectorsOf(ctx).teams;
        if (!c?.token) return notConfigured("teams");
        const auth = { Authorization: `Bearer ${c.token}` };
        const teamId = typeof args.team_id === "string" ? args.team_id.trim() : "";
        if (teamId) {
          const res = await fetch(`https://graph.microsoft.com/v1.0/teams/${teamId}/channels`, { headers: auth, signal: AbortSignal.timeout(15_000) });
          if (!res.ok) return { content: `Teams error: HTTP ${res.status} (check the token permissions)`, isError: true };
          const data = (await res.json()) as { value?: Array<{ id: string; displayName?: string; description?: string }> };
          const out = (data.value ?? []).map((ch) => `  #${ch.displayName ?? "?"} (${ch.id})`);
          return { content: out.join("\n") || "(no channels)", isError: false };
        }
        const res = await fetch("https://graph.microsoft.com/v1.0/me/joinedTeams", { headers: auth, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return { content: `Teams error: HTTP ${res.status} (check the token permissions)`, isError: true };
        const data = (await res.json()) as { value?: Array<{ id: string; displayName?: string; description?: string }> };
        const teams = data.value ?? [];
        if (teams.length === 0) return { content: "(no teams)", isError: false };
        const out: string[] = [];
        for (const t of teams.slice(0, 10)) {
          out.push(`■ ${t.displayName ?? "?"} (${t.id})`);
          const cRes = await fetch(`https://graph.microsoft.com/v1.0/teams/${t.id}/channels`, { headers: auth, signal: AbortSignal.timeout(15_000) });
          if (!cRes.ok) continue;
          const chans = (await cRes.json()) as { value?: Array<{ id: string; displayName?: string }> };
          for (const ch of (chans.value ?? []).slice(0, 30)) out.push(`  #${ch.displayName ?? "?"} (${ch.id})`);
        }
        return { content: out.join("\n"), isError: false };
      },
    },
    {
      name: "jira_issues",
      description:
        "Search Jira issues via the configured Jira connector (JQL). Defaults to the connector's project (or the most recently updated issues). Returns key, summary, status, assignee and updated date.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          jql: { type: "string", description: "Optional JQL query (e.g. 'status = \"In Progress\" ORDER BY updated DESC')" },
          limit: { type: "number", description: "Number of issues (default 10, cap 50)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const c = connectorsOf(ctx).jira;
        if (!c?.base_url || !c.token) return notConfigured("jira");
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
        let jql = typeof args.jql === "string" ? args.jql.trim() : "";
        if (!jql) {
          jql = c.project ? `project = "${c.project.replace(/"/g, '\\"')}" ORDER BY updated DESC` : "ORDER BY updated DESC";
        }
        const qs = new URLSearchParams({ jql, maxResults: String(limit), fields: "summary,status,assignee,updated" });
        const res = await fetch(`${c.base_url.replace(/\/+$/, "")}/rest/api/3/search?${qs}`, {
          headers: { Authorization: `Basic ${Buffer.from(`${c.email ?? ""}:${c.token}`).toString("base64")}`, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { content: `Jira error: HTTP ${res.status} (check the URL, email and token)`, isError: true };
        const data = (await res.json()) as {
          issues?: Array<{
            key: string;
            fields?: { summary?: string; status?: { name?: string }; assignee?: { displayName?: string } | null; updated?: string };
          }>;
        };
        const issues = data.issues ?? [];
        if (issues.length === 0) return { content: "(no issues)", isError: false };
        const lines = issues.map((i) => {
          const f = i.fields ?? {};
          const parts = [
            i.key,
            f.summary ?? "(no summary)",
            f.status?.name ? `[${f.status.name}]` : "",
            f.assignee?.displayName ? `→ ${f.assignee.displayName}` : "",
            f.updated ? `updated ${f.updated.slice(0, 10)}` : "",
          ].filter(Boolean);
          return parts.join(" ");
        });
        return { content: lines.join("\n"), isError: false };
      },
    },
    {
      name: "confluence_search",
      description:
        "Search Confluence pages via the configured Confluence connector (CQL). A plain 'query' becomes a text search; pass 'cql' for full control. Returns title, type and URL.",
      read_only: true,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for" },
          cql: { type: "string", description: "Optional raw CQL (overrides query)" },
          limit: { type: "number", description: "Number of results (default 10, cap 25)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const c = connectorsOf(ctx).confluence;
        if (!c?.base_url || !c.token) return notConfigured("confluence");
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        let cql = typeof args.cql === "string" ? args.cql.trim() : "";
        if (!cql) {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          cql = query ? `text ~ "${query.replace(/"/g, '\\"')}"` : "type=page order by lastmodified desc";
        }
        const base = c.base_url.replace(/\/+$/, "");
        const res = await fetch(`${base}/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`, {
          headers: { Authorization: `Basic ${Buffer.from(`${c.email ?? ""}:${c.token}`).toString("base64")}`, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { content: `Confluence error: HTTP ${res.status} (check the URL, email and token)`, isError: true };
        const data = (await res.json()) as {
          results?: Array<{ content?: { title?: string; type?: string; _links?: { webui?: string } }; title?: string; url?: string }>;
        };
        const results = data.results ?? [];
        if (results.length === 0) return { content: "(no results)", isError: false };
        const lines = results.map((r) => {
          const title = r.content?.title ?? r.title ?? "(untitled)";
          const type = r.content?.type ?? "page";
          const web = r.content?._links?.webui ?? r.url ?? "";
          const url = web.startsWith("http") ? web : `${base}${web}`;
          return `📄 ${title} [${type}]${web ? ` — ${url}` : ""}`;
        });
        return { content: lines.join("\n"), isError: false };
      },
    },
  ];
}
