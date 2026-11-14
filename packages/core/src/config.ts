import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { log } from "./logger.js";
import { familiarHome, familiarPaths } from "./paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderAuth {
  /** Inline secret — discouraged; prefer api_key_file or env. */
  api_key?: string;
  /** Path to a token file (supports ~). Never committed, never logged. */
  api_key_file?: string;
  /** Environment variable name, or the literal "none" for key-less providers. */
  env?: string | null;
}

export type ProviderKind = "openai_compatible" | "anthropic" | "mock";

export interface ProviderConfig {
  kind: ProviderKind;
  base_url?: string;
  auth?: ProviderAuth;
  /** Model used when the caller does not specify one for this provider. */
  default_model?: string;
  /** Static model list; when set, remote /models listing is skipped. */
  models?: string[];
  /** Send `stream_options: { include_usage: true }` to get usage on the stream (tok/s in the GUI). Set `false` for servers that choke on it (auto-retried anyway). */
  stream_options?: boolean;
}

/**
 * Three tiers, checked in this order:
 *   deny  → hard block (never approvable, not even with --yolo)
 *   ask   → human approval (destructive / data-leaving commands)
 *   allow → runs without approval; with `mode: "allow"` this also covers
 *           anything that matches neither deny nor ask (the default)
 */
export interface BashPermissionConfig {
  /** "allow" (default): auto-run unless ask/deny matches. "ask": legacy. */
  mode: "allow" | "ask";
  /** fast-path allowlist (prefix or regular expression) */
  allow: string[];
  /** patterns that require human approval */
  ask: string[];
  /** patterns that are blocked outright */
  deny: string[];
  max_timeout_ms: number;
}

export interface DomainPermissionConfig {
  allow_domains: string[];
  deny_domains: string[];
}

export interface WebSearchConfig {
  /** "duckduckgo" needs no configuration; "searxng" uses base_url */
  provider: "duckduckgo" | "searxng";
  /** e.g. http://127.0.0.1:8080 — used by the searxng provider */
  base_url: string;
}

export interface MemoryConfig {
  write_approval: boolean;
  max_prompt_chars: number;
}

export interface SkillsConfig {
  write_approval: boolean;
  /**
   * Also read skills from the well-known global agent-skills directories
   * (~/.agents/skills, ~/.claude/skills, ~/.codex/skills, ~/.config/opencode/skills,
   * ~/.opencode/skills, ~/.cursor/skills, ~/.windsurf/skills). Read-only.
   */
  include_global: boolean;
  /**
   * Extra read-only directories to read skills from, applied in order
   * (the first directory holding a skill name wins).
   */
  paths: string[];
}

export interface SelfReviewConfig {
  enabled: boolean;
}

export interface CuratorConfig {
  enabled: boolean;
  /** hours between automatic Phase-1 runs on serve/desktop */
  interval_hours: number;
  /** idle time required before a run starts */
  min_idle_hours: number;
  stale_after_days: number;
  archive_after_days: number;
  /** opt-in Phase-2 LLM consolidation */
  consolidate: boolean;
}

/** M5: MCP stdio server connection (one child process per server). */
/** Overrides used when the server runs on an SSH host (proxy sessions). */
export interface RemoteSpawnConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** run a different command/args/env when spawning on an SSH host */
  remote?: RemoteSpawnConfig;
  /** per-request timeout (ms); default 30000 */
  timeout_ms?: number;
  /** read-only MCP tools stay usable in plan mode and skip approval */
  read_only?: boolean;
  disabled?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

/** M5: lifecycle shell hooks — JSON payload on stdin, 10s timeout, failures logged only. */
export interface HooksConfig {
  session_start?: string[];
  pre_tool_use?: string[];
  post_tool_use?: string[];
  turn_complete?: string[];
  [event: string]: string[] | undefined;
}

/** M5: scheduled prompts (serve process). every_minutes 0 = once at boot. */
export interface CronJob {
  name?: string;
  every_minutes: number;
  prompt: string;
  enabled?: boolean;
}

export interface CronConfig {
  jobs: CronJob[];
}

/** M6: language servers driven from the `lsp_diagnostics` tool (stdio). */
export interface LspServerConfig {
  command: string;
  args?: string[];
  /** file extensions (bare, no dot) routed to this server, e.g. ["ts", "tsx"] */
  extensions: string[];
  /** diagnostics wait per request; default 5000 */
  timeout_ms?: number;
  /** run a different command/args when the language server runs on an SSH host */
  remote?: RemoteSpawnConfig;
  disabled?: boolean;
}

export interface LspConfig {
  servers: Record<string, LspServerConfig>;
}

export interface BudgetConfig {
  /** max prompt+completion tokens per session (0 = off) */
  max_tokens_per_session: number;
  /** max tokens across all sessions per calendar day (0 = off) */
  max_tokens_per_day: number;
  /** warn once usage passes this fraction of a limit (0..1; 0 disables) */
  warn_ratio: number;
  /** true: refuse to start a new turn once a hard limit is exceeded */
  enforce: boolean;
}

export interface PermissionsConfig {
  bash: BashPermissionConfig;
  files: {
    /**
     * "cwd" (default): reads/writes are free inside the session folder and
     * gated outside it. "unrestricted": legacy — nothing is gated by location.
     */
    bounds: "cwd" | "unrestricted";
    /**
     * Policy for *reads* that fall outside `bounds` (read/glob/grep):
     * "ask" (default) prompts, "allow" lets them through, "deny" blocks.
     * Writes outside the bounds always go through approveWrite.
     */
    read: "ask" | "allow" | "deny";
  };
  webfetch: DomainPermissionConfig;
  websearch: WebSearchConfig;
}

export interface AuxiliarySlot {
  provider: string;
  model: string;
}

export interface CompactionConfig {
  /** drop: remove old messages / summarize: aux model writes a durable note */
  mode: "drop" | "summarize";
  /**
   * Trigger compaction once the prompt reaches this fraction of the model's
   * context window (0.9 = 90%). Ignored when the window is unknown — then
   * `token_soft_limit` (or the built-in fallback) decides.
   */
  ratio: number;
}

export interface ResolvedConfig {
  homeDir: string;
  default_provider: string;
  default_model?: string;
  providers: Record<string, ProviderConfig>;
  /** M2: failover chain as "provider" or "provider/model" */
  fallback: string[];
  auxiliary: Record<string, AuxiliarySlot>;
  profiles: Record<string, { system_prompt_file?: string }>;
  permissions: PermissionsConfig;
  /** token budget guard (all limits 0 = off) */
  budget: BudgetConfig;
  /** M3: self-improvement */
  memory: MemoryConfig;
  skills: SkillsConfig;
  self_review: SelfReviewConfig;
  curator: CuratorConfig;
  /** M5: MCP stdio servers exposing dynamic tools */
  mcp: McpConfig;
  /** M5: lifecycle shell hooks */
  hooks: HooksConfig;
  /** M5: scheduled prompts */
  cron: CronConfig;
  /** M6: language servers for the lsp_diagnostics tool */
  lsp: LspConfig;
  /** uploaded composer attachments (~/.familiar/uploads) */
  uploads: { retention_days: number };
  context: {
    /** absolute prompt-token cap that also triggers compaction (0 = off) */
    token_soft_limit: number;
    /** how many trailing messages survive a compaction */
    keep_last: number;
    compaction: CompactionConfig;
    /**
     * Hard ceiling for one turn's steps. Past the 25-step window the turn
     * continues on its own (a visible "auto-continue" note) instead of
     * stopping mid-work and waiting for the user to type 続けて.
     */
    max_turn_steps: number;
  };
  server: { port: number; bind: string; auth_token_file?: string };
  /** GUI-configured integrations (Jira / Confluence / Redmine connectors). */
  connectors?: Record<string, Record<string, unknown>>;
  /** the config file this configuration was loaded from (persist writes) */
  configFile?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: ResolvedConfig = {
  homeDir: familiarPaths.home(),
  default_provider: "openai",
  providers: {
    openai: {
      kind: "openai_compatible",
      base_url: "https://api.openai.com/v1",
      auth: { env: "OPENAI_API_KEY" },
      default_model: "gpt-6.1-sol",
    },
    google: {
      kind: "openai_compatible",
      base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
      auth: { env: "GEMINI_API_KEY" },
      default_model: "gemini-2.5-flash",
      models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    },
    anthropic: {
      kind: "anthropic",
      base_url: "https://api.anthropic.com/v1",
      auth: { env: "ANTHROPIC_API_KEY" },
      default_model: "claude-sonnet-4-6",
    },
    openrouter: {
      kind: "openai_compatible",
      base_url: "https://openrouter.ai/api/v1",
      auth: { env: "OPENROUTER_API_KEY" },
    },
    nvidia: {
      kind: "openai_compatible",
      base_url: "https://integrate.api.nvidia.com/v1",
      auth: { env: "NVIDIA_API_KEY" },
    },
    ollama: {
      kind: "openai_compatible",
      base_url: "http://127.0.0.1:11434/v1",
      auth: { env: "none" },
      stream_options: false,
    },
    // NOTE: the "mock" provider kind still exists for tests/smoke, but it is
    // no longer built in by default — add `mock: { kind: "mock" }` explicitly.
  },
  fallback: [],
  auxiliary: {},
  profiles: {},
  permissions: {
    bash: {
      mode: "allow",
      allow: [
        "^git (status|diff|log|show|branch|remote|tag|rev-parse|shortlog|worktree)( .*)?$",
        "^node --version$",
        "^npm --version$",
        "^python3 --version$",
      ],
      // Destructive or data-leaving commands ask the human. Everything else
      // runs straight away (mode: "allow"), so approvals stay rare.
      ask: [
        // destructive filesystem work
        "\\brm\\s+(-[a-zA-Z]+\\s+)*-[a-zA-Z]*[rR]",
        "\\brm\\s+(-[a-zA-Z]+\\s+)*-[a-zA-Z]*f",
        "\\bfind\\b[^|;&]*(?:-delete\\b|-exec\\s+(?:rm|rmdir|shred)\\b)",
        "\\bRemove-Item\\b[^|;&]*-[Rr]ecurse\\b",
        "\\bdd\\b",
        "^mkfs",
        "\\bshred\\b",
        "\\bchmod\\s+(-[a-zA-Z]+\\s+)*-R\\b",
        "\\bchown\\s+(-[a-zA-Z]+\\s+)*-R\\b",
        "\\bmv\\b.*\\s/(bin|boot|etc|lib|sbin|usr|var)(/|\\s|$)",
        ">\\s*/(etc|boot|usr|var|bin|sbin|lib)(/|\\s|$)",
        // system state
        "^\\s*(sudo|doas)\\b",
        "^\\s*(shutdown|reboot|poweroff|halt)\\b",
        "\\bsystemctl\\s+(stop|disable|mask|poweroff|reboot)\\b",
        "^\\s*(iptables|nft|ufw)\\b",
        "\\bcrontab\\b",
        "\\bkill\\s+(-[0-9]+\\s+)*-9\\b",
        "\\bpkill\\s+(-[0-9]+\\s+)*-9\\b",
        // package / container / git destructive
        "\\b(apt|apt-get|dnf|yum|pacman)\\s+(remove|purge|autoremove|upgrade|dist-upgrade)\\b",
        "\\bdocker\\s+(system\\s+prune|volume\\s+(rm|prune))\\b",
        "\\bgit\\s+(push\\b.*--force|reset\\s+--hard|clean\\s+-[a-zA-Z]*f)",
        // data leaving the machine
        "\\b(curl|wget)\\b[^|;]*(\\s-d\\s|--data|\\s-F\\s|--form|--upload-file)",
        "\\b(nc|ncat|netcat)\\b",
        "\\bscp\\b",
        "\\brsync\\b",
        "\\bssh\\b.*\\s-R\\b",
      ],
      // Only the truly unrecoverable stays blocked (approve-able commands
      // belong in `ask`). Wiping the filesystem — or the directory tree a
      // user's work lives in — is never approvable, not even with --yolo:
      // `rm -rf /`, a system directory itself, the home directory, a Windows
      // drive root, `find / ... -delete`, and raw writes to a disk device.
      deny: [
        ">\\s*/dev/(sd|vd|hd|nvme|mmcblk)",
        "\\bmkfs[^|;]*\\s/dev/(sd|vd|hd|nvme|mmcblk)",
        "\\bdd\\b[^|;&]*\\bof=/dev/(sd|vd|hd|nvme|mmcblk)",
        "\\brm\\b[^|;&]*--no-preserve-root",
        "\\brm\\s+(?:-[^\\s|;&]+\\s+)*['\"]?/(?:\\*|/)?['\"]?(?=\\s|['\"]|$|[|;&])",
        "\\brm\\s+(?:-[^\\s|;&]+\\s+)*['\"]?/(?:bin|boot|dev|etc|home|lib|lib64|mnt|opt|proc|root|run|sbin|srv|sys|usr|var)(?:\\*|/\\*?)?['\"]?(?=\\s|['\"]|$|[|;&])",
        "\\brm\\s+(?:-[^\\s|;&]+\\s+)*['\"]?(?:~|\\$HOME|\\$\\{HOME\\})(?:\\*|/\\*?)?['\"]?(?=\\s|['\"]|$|[|;&])",
        "\\brm\\s+(?:-[^\\s|;&]+\\s+)*['\"]?[A-Za-z]:[\\\\/](?:\\*)?['\"]?(?=\\s|['\"]|$|[|;&])",
        "\\brm\\s+(?:-[^\\s|;&]+\\s+)*['\"]?/\\{[^}]*\\}",
        "\\bfind\\s+['\"]?(?:/(?:\\*|/)?|~(?:\\*|/\\*?)?|\\$HOME(?:\\*|/\\*?)?|\\$\\{HOME\\}(?:\\*|/\\*?)?)['\"]?(?=\\s|$)[^|;&]*\\s(?:-delete\\b|-exec\\s+(?:rm|rmdir|shred)\\b)",
        // Windows (PowerShell / cmd): a drive root itself is never deletable
        "\\bRemove-Item\\b[^|;&]*['\"]?[A-Za-z]:[\\\\/]?['\"]?(?=\\s|['\"]|$|[|;&])",
        "\\b(del|rd|rmdir)\\b[^|;&]*['\"]?[A-Za-z]:[\\\\/]?['\"]?(?=\\s|['\"]|$|[|;&])",
      ],
      max_timeout_ms: 600_000,
    },
    files: { bounds: "cwd", read: "ask" },
    webfetch: {
      allow_domains: [],
      deny_domains: ["localhost", "127.*", "::1", "10.*", "192.168.*", "172.16.*", "172.17.*", "172.18.*", "172.19.*", "172.20.*", "172.21.*", "172.22.*", "172.23.*", "172.24.*", "172.25.*", "172.26.*", "172.27.*", "172.28.*", "172.29.*", "172.30.*", "172.31.*", "169.254.*", "0.0.0.0", "*.local"],
    },
    websearch: { provider: "duckduckgo", base_url: "" },
  },
  budget: { max_tokens_per_session: 0, max_tokens_per_day: 0, warn_ratio: 0.8, enforce: false },
  memory: { write_approval: true, max_prompt_chars: 4000 },
  skills: { write_approval: true, include_global: true, paths: [] },
  self_review: { enabled: true },
  curator: {
    enabled: true,
    interval_hours: 168,
    min_idle_hours: 2,
    stale_after_days: 14,
    archive_after_days: 30,
    consolidate: false,
  },
  mcp: { servers: {} },
  hooks: {},
  cron: { jobs: [] },
  lsp: { servers: {} },
  uploads: { retention_days: 30 },
  // Compaction fires at 90% of the model's context window by default;
  // token_soft_limit stays available as an absolute cap (0 = off).
  context: {
    token_soft_limit: 0,
    keep_last: 10,
    compaction: { mode: "summarize", ratio: 0.9 },
    max_turn_steps: 100,
  },
  server: { port: 46_210, bind: "127.0.0.1" },
};

const KNOWN_TOP_LEVEL = new Set([
  "version",
  "uploads",
  "default_provider",
  "default_model",
  "fallback",
  "providers",
  "auxiliary",
  "profiles",
  "permissions",
  "memory",
  "skills",
  "self_review",
  "curator",
  "mcp",
  "hooks",
  "cron",
  "lsp",
  "context",
  "server",
  "connectors",
]);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-copy plain objects/arrays so live configs never alias the defaults. */
function deepClone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = deepClone(val);
    return out as T;
  }
  return v;
}

/** Recursive merge: scalars/arrays win from `over`, objects merge. */
function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) {
    if (over === undefined) return deepClone(base);
    return deepClone(over) as T;
  }
  const out: Record<string, unknown> = deepClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : deepClone(v);
  }
  return out as T;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a provider secret in fixed priority: api_key → api_key_file → env.
 * Missing/none yields undefined. Values are never logged.
 */
export function resolveAuthSecret(auth: ProviderAuth | undefined): string | undefined {
  if (!auth) return undefined;
  if (auth.api_key) return auth.api_key;
  if (auth.api_key_file) {
    const file = expandHome(auth.api_key_file);
    try {
      const value = fs.readFileSync(file, "utf8").trim();
      return value === "" ? undefined : value;
    } catch {
      log.warn(`auth secret file not readable: ${file}`);
      return undefined;
    }
  }
  if (auth.env && auth.env !== "none") {
    const value = process.env[auth.env];
    return value === undefined || value === "" ? undefined : value;
  }
  return undefined;
}

export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Validate a reasoning-effort value coming from the CLI/GUI/session-store.
 * Accepts "low" | "medium" | "high"; "", "default", "off" and null clear it.
 * Anything else is undefined (provider default) — never throws.
 */
export function normalizeEffort(raw: string | null | undefined): ReasoningEffort | undefined {
  if (raw === null || raw === undefined) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "" || v === "default" || v === "off" || v === "none") return undefined;
  if (v === "low" || v === "medium" || v === "high") return v;
  return undefined;
}

/** Where a secret comes from (for sanitized diagnostics; never the value). */
export function describeAuthSource(
  auth: ProviderAuth | undefined,
): { source: string; resolved: boolean } {
  if (!auth) return { source: "none", resolved: false };
  if (auth.api_key) return { source: "inline", resolved: true };
  if (auth.api_key_file)
    return { source: `file:${expandHome(auth.api_key_file)}`, resolved: true };
  if (auth.env && auth.env !== "none")
    return { source: `env:${auth.env}`, resolved: !!resolveAuthSecret(auth) };
  return { source: "none", resolved: false };
}

/**
 * M2 server auth: read the bearer token from `server.auth_token_file`.
 * Fail-closed — a configured but unreadable file throws (never silently
 * expose an unauthenticated server). The value is never logged.
 */
export function resolveServerAuthToken(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const expanded = expandHome(file);
  if (!fs.existsSync(expanded)) {
    throw new Error(`server auth token file not found: ${expanded}`);
  }
  const value = fs.readFileSync(expanded, "utf8").trim();
  if (value === "") throw new Error(`server auth token file is empty: ${expanded}`);
  return value;
}

/** Default token file for `familiar token --write` when config doesn't set one. */
export function defaultAuthTokenFile(): string {
  return path.join(familiarHome(), "server.token");
}

/** Persist `server.auth_token_file` in config.yaml (opt-in auth). */
export function writeServerAuthConfig(
  authTokenFile: string | undefined,
  options: LoadConfigOptions = {},
): void {
  const file = configFilePath(options.configFile);
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = parseYaml(fs.readFileSync(file, "utf8"));
    if (parsed !== null && parsed !== undefined) {
      if (!isPlainObject(parsed)) throw new Error(`config file must be a YAML mapping: ${file}`);
      doc = parsed;
    }
  }
  const server = isPlainObject(doc["server"]) ? { ...(doc["server"] as Record<string, unknown>) } : {};
  if (authTokenFile) server["auth_token_file"] = authTokenFile;
  else delete server["auth_token_file"];
  doc["server"] = server;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, stringifyYaml(doc), { mode: 0o600 });
  fs.renameSync(tmp, file);
  log.info(`server.auth_token_file ${authTokenFile ? "set" : "cleared"} in ${file}`);
}

/** Persist the GUI-configured connectors into config.yaml (server section of
 * the file is preserved; YAML round-trip keeps every other key). */
export function writeConnectorsToDisk(
  connectors: Record<string, Record<string, unknown>>,
  options: LoadConfigOptions = {},
): void {
  const file = configFilePath(options.configFile);
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = parseYaml(fs.readFileSync(file, "utf8"));
    if (parsed !== null && parsed !== undefined) {
      if (!isPlainObject(parsed)) throw new Error(`config file must be a YAML mapping: ${file}`);
      doc = parsed;
    }
  }
  doc["connectors"] = connectors;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, stringifyYaml(doc), { mode: 0o600 });
  fs.renameSync(tmp, file);
  log.info(`connectors updated in ${file}`);
}

export interface LoadConfigOptions {
  configFile?: string;
  /** e.g. { default_provider } from CLI flags */
  overrides?: Partial<Pick<ResolvedConfig, "default_provider">>;
}

/** Patch applied to a provider entry via the GUI ("プロバイダー" settings). */
export interface ProviderPatch {
  name: string;
  kind?: ProviderKind;
  /** "" removes the base_url (fall back to the kind default). */
  base_url?: string;
  /** "" removes the default_model. */
  default_model?: string;
  /** Non-empty writes the key into secrets/<name>.key (0600) and wires api_key_file. */
  api_key?: string;
  /** Removes inline/file secrets; an `env:` reference is preserved. */
  clear_api_key?: boolean;
}

/**
 * Persist a provider patch to config.yaml. API keys are never written inline:
 * they land in `<familiar home>/secrets/<name>.key` with 0600 and the config
 * references them via api_key_file. Values are never logged.
 */
export function writeProviderToDisk(
  patch: ProviderPatch,
  options: LoadConfigOptions = {},
): ProviderConfig {
  const name = patch.name;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`invalid provider name: ${name}`);
  }
  const file = configFilePath(options.configFile);
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = parseYaml(fs.readFileSync(file, "utf8"));
    if (parsed !== null && parsed !== undefined) {
      if (!isPlainObject(parsed)) throw new Error(`config file must be a YAML mapping: ${file}`);
      doc = parsed;
    }
  }
  const providers = isPlainObject(doc["providers"])
    ? (doc["providers"] as Record<string, unknown>)
    : ((doc["providers"] = {}) as Record<string, unknown>);
  const existing = isPlainObject(providers[name]) ? { ...(providers[name] as Record<string, unknown>) } : {};

  const entry: Record<string, unknown> = { ...existing };
  if (patch.kind) entry["kind"] = patch.kind;
  else if (typeof entry["kind"] !== "string" || entry["kind"] === "") entry["kind"] = "openai_compatible";

  if (patch.base_url !== undefined) {
    if (patch.base_url === "") delete entry["base_url"];
    else entry["base_url"] = patch.base_url;
  }
  if (patch.default_model !== undefined) {
    if (patch.default_model === "") delete entry["default_model"];
    else entry["default_model"] = patch.default_model;
  }

  if (patch.clear_api_key) {
    const auth = isPlainObject(entry["auth"]) ? { ...(entry["auth"] as Record<string, unknown>) } : {};
    delete auth["api_key"]; // legacy inline secret (hidden from helpers) — remove if present
    delete auth["api_key_file"];
    const env = typeof auth["env"] === "string" ? (auth["env"] as string) : undefined;
    if (env && env !== "none") entry["auth"] = { env };
    else delete entry["auth"];
    // best effort: drop the stale key file
    try {
      if (typeof existing["auth"] === "object" && existing["auth"] !== null) {
        const oldFile = (existing["auth"] as Record<string, unknown>)["api_key_file"];
        if (typeof oldFile === "string") fs.rmSync(expandHome(oldFile), { force: true });
      }
    } catch {
      // ignore cleanup failure — the credential is already unreferenced
    }
  } else if (typeof patch.api_key === "string" && patch.api_key !== "") {
    const secretsDir = path.join(familiarHome(), "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const secretFile = path.join(secretsDir, `${name}.key`);
    fs.writeFileSync(secretFile, patch.api_key + "\n", { mode: 0o600 });
    entry["auth"] = { api_key_file: secretFile };
  }

  providers[name] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, stringifyYaml(doc), { mode: 0o600 });
  fs.renameSync(tmp, file);
  log.info(`provider config written: ${name}`);
  if (entry["kind"] !== "openai_compatible" && entry["kind"] !== "anthropic" && entry["kind"] !== "mock") {
    entry["kind"] = "openai_compatible";
  }
  return entry as unknown as ProviderConfig;
}

export function configFilePath(explicit?: string): string {
  if (explicit) return expandHome(explicit);
  return familiarPaths.config();
}

/**
 * Can this provider actually be called? A resolvable secret (key file /
 * api_key / env) or an explicitly keyless auth (`env: "none"`, or no auth
 * block at all on a plain-http endpoint = private/LAN deployment).
 */
function providerCallable(pc: ProviderConfig): boolean {
  const secret = resolveAuthSecret(pc.auth);
  if (secret !== undefined && secret !== "") return true;
  if (pc.auth?.env === "none") return true;
  if (pc.auth === undefined) return (pc.base_url ?? "").startsWith("http://");
  return false;
}

/** First callable provider that also has a usable default model.
 * User-added providers win over the built-ins (configured intentionally);
 * keyless endpoints win over keyed ones within the same tier. */
function pickUsableProvider(cfg: ResolvedConfig): { provider: string; model: string } | null {
  const builtIn = DEFAULT_CONFIG.providers;
  const order = [
    ...Object.entries(cfg.providers).filter(([id]) => !(id in builtIn)),
    ...Object.entries(cfg.providers).filter(([id]) => id in builtIn),
  ];
  let keyed: { provider: string; model: string } | null = null;
  for (const [id, pc] of order) {
    const model = pc.default_model ?? (pc.kind === "mock" ? "mock-fast" : undefined);
    if (!model || !providerCallable(pc)) continue;
    if (resolveAuthSecret(pc.auth) !== undefined) {
      keyed ??= { provider: id, model };
      continue;
    }
    return { provider: id, model }; // keyless endpoints take priority
  }
  return keyed;
}

export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const file = configFilePath(options.configFile);
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    const parsed = parseYaml(text);
    if (parsed !== null && parsed !== undefined) {
      if (!isPlainObject(parsed)) {
        throw new Error(`config file must be a YAML mapping: ${file}`);
      }
      doc = parsed;
    }
  } else if (options.configFile) {
    throw new Error(`config file not found: ${file}`);
  }

  for (const key of Object.keys(doc)) {
    if (!KNOWN_TOP_LEVEL.has(key)) log.warn(`unknown config key ignored: ${key}`);
  }

  const merged = deepMerge(DEFAULT_CONFIG, doc);
  const cfg = merged as ResolvedConfig;
  cfg.configFile = file;

  // Bash command policy: a list in the user's config is UNIONed with the
  // built-in one, never a replacement. Writing one custom `deny` pattern used
  // to drop the whole default set (including the filesystem-wipe guards) —
  // a silent way to weaken --yolo protection.
  {
    const builtin = DEFAULT_CONFIG.permissions.bash;
    const user = cfg.permissions.bash;
    const union = (a: string[], b: string[] | undefined): string[] => {
      const out = [...a];
      for (const p of b ?? []) if (!out.includes(p)) out.push(p);
      return out;
    };
    user.allow = union(builtin.allow, user.allow);
    user.ask = union(builtin.ask, user.ask);
    user.deny = union(builtin.deny, user.deny);
  }

  // Provider entries: kind defaults to openai_compatible when only base_url is given.
  for (const [id, pc] of Object.entries(cfg.providers)) {
    pc.kind = pc.kind ?? "openai_compatible";
  }
  if (cfg.default_provider && !(cfg.default_provider in cfg.providers)) {
    log.warn(`default_provider "${cfg.default_provider}" is not configured`);
  }

  // Fresh configs inherit openai/gpt-6.1-sol, which cannot be called without an
  // API key. Unless the user picked a default explicitly (yaml or CLI flag),
  // make the effective default the first provider that actually works so the
  // out-of-the-box experience is a model that responds.
  const explicitDefault =
    (typeof doc.default_provider === "string" && doc.default_provider !== "") ||
    options.overrides?.default_provider !== undefined;
  const currentPc = cfg.providers[cfg.default_provider];
  if (!explicitDefault && (currentPc === undefined || !providerCallable(currentPc))) {
    const fb = pickUsableProvider(cfg);
    if (fb && fb.provider !== cfg.default_provider) {
      log.warn(
        `default provider "${cfg.default_provider}" has no usable credentials — ` +
          `defaulting to "${fb.provider}" (${fb.model}); set default_provider/default_model to override`,
      );
      cfg.default_provider = fb.provider;
      cfg.default_model = fb.model;
    }
  }

  cfg.homeDir = familiarPaths.home();
  if (options.configFile) cfg.configFile = options.configFile;
  if (options.overrides?.default_provider) cfg.default_provider = options.overrides.default_provider;
  return cfg;
}

/**
 * Copy of the config safe to expose via `config.get` RPC: secret values are
 * replaced by their origin + resolution status.
 */
const CONNECTOR_SECRET_KEYS = new Set(["token", "api_key", "password", "secret"]);

export function sanitizeConfigForApi(cfg: ResolvedConfig): Record<string, unknown> {
  const clone = structuredClone(cfg) as unknown as Record<string, unknown>;
  const providers = clone["providers"] as Record<string, Record<string, unknown>>;
  for (const pc of Object.values(providers)) {
    const auth = pc["auth"] as ProviderAuth | undefined;
    pc["auth"] = describeAuthSource(auth);
  }
  // connector secrets are masked, but their presence is signalled so the GUI
  // can show "configured" without ever round-tripping the value
  const connectors = clone["connectors"] as Record<string, Record<string, unknown>> | undefined;
  if (connectors && typeof connectors === "object") {
    for (const kind of Object.keys(connectors)) {
      const c = connectors[kind] ?? {};
      for (const key of Object.keys(c)) {
        if (CONNECTOR_SECRET_KEYS.has(key) && typeof c[key] === "string" && c[key] !== "") {
          c[key] = "***";
        }
      }
    }
  }
  delete clone["homeDir"];
  delete clone["configFile"];
  return clone;}

// ---------------------------------------------------------------------------
// Template written by `familiar init`
// ---------------------------------------------------------------------------

export const CONFIG_TEMPLATE = `# Familiar configuration (~/.familiar/config.yaml)
# Never put tokens in this file — use auth: { env: ... } or api_key_file.

version: 1

default_provider: openai
default_model: gpt-6.1-sol

providers:
  openai:
    kind: openai_compatible
    base_url: https://api.openai.com/v1
    auth: { env: OPENAI_API_KEY }
    default_model: gpt-6.1-sol
  google:
    kind: openai_compatible
    base_url: https://generativelanguage.googleapis.com/v1beta/openai
    auth: { env: GEMINI_API_KEY }
    default_model: gemini-2.5-flash
    models: [gemini-2.5-flash, gemini-2.5-pro]
  anthropic:
    kind: anthropic
    base_url: https://api.anthropic.com/v1
    auth: { env: ANTHROPIC_API_KEY }
    default_model: claude-sonnet-4-6
  openrouter:
    kind: openai_compatible
    base_url: https://openrouter.ai/api/v1
  nvidia:
    kind: openai_compatible
    base_url: https://integrate.api.nvidia.com/v1
    auth: { env: NVIDIA_API_KEY }
  ollama:
    kind: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    auth: none

# Rendered as "provider" or "provider/model"; tried in order when the primary
# provider fails BEFORE streaming starts.
# fallback:
#   - "ollama/qwen2.5-coder:3b"

permissions:
  bash:
    # allow (default): run unless ask/deny matches. ask = approve every command
    mode: allow
    allow:
      - "^git (status|diff|log|show|branch|remote|tag|rev-parse|shortlog|worktree)( .*)?$"
    # ask  (approve, then run): rm -rf / rm -f, find -delete / -exec rm, sudo,
    #      dd, git push --force / reset --hard, docker prune, curl -d, scp, ...
    # deny (never runs, not even with --yolo): rm of / or a system directory /
    #      home / Windows drive root, --no-preserve-root, find / -delete,
    #      mkfs / dd / redirects on /dev/sd*, /dev/nvme*, ...
    # A list given here replaces the built-in one.
    max_timeout_ms: 600000
  files:
    # cwd (default): reads/writes are free inside the session folder.
    #   Reads OUTSIDE it follow "read" below; writes outside always ask.
    # unrestricted: legacy — location never gates anything.
    bounds: cwd
    # ask (default) | allow | deny : policy for reads (read/glob/grep) that
    # fall outside the bounds. Keeps ~/.familiar/secrets/*, ~/.ssh/*, ... visible.
    read: ask
  webfetch:
    allow_domains: []
    # internal addresses are denied by default (SSRF protection)
  websearch:
    provider: searxng
    base_url: ""    # e.g. http://127.0.0.1:8080

# Token budget guard (all limits 0 = off). Usage counts prompt+completion
# tokens per turn (the last step's prompt + completion), tracked per session
# and per calendar day.
budget:
  max_tokens_per_session: 0   # e.g. 2000000
  max_tokens_per_day: 0       # e.g. 10000000
  warn_ratio: 0.8             # warn once usage passes this fraction of a limit
  enforce: false              # true: refuse to start a turn past a hard limit

# M3: 自己改善
memory:
  write_approval: true      # false で memory_manage / self-review が直接反映
  max_prompt_chars: 4000    # 注入合計上限(超過分は新しめ順カット)
skills:
  write_approval: true     # false で skill_manage が直接反映(非推奨)
  include_global: true     # ~/.agents/skills 等の共有 skills も読む(読み取り専用)
  # paths:                 # 追加で読むディレクトリ(最初に見つかったものを採用)
  #   - ~/my-skills
self_review:
  enabled: true             # turn 完了後に reviewer を起動して staging 提案

# M4: curator(スキル園芸・serve 起動時の maintenance)
curator:
  enabled: true
  interval_hours: 168       # 前回実行からこの期間経過したら
  min_idle_hours: 2         # かつ少なくともこれだけアイドル
  stale_after_days: 14      # 未使用 → stale(表示のみ・復帰可)
  archive_after_days: 30    # 未使用 → .archive/ へ(削除しない・snapshot あり)
  consolidate: false        # opt-in: Phase-2 LLM 統合(提案は staging 経由)

# M5: MCP stdio サーバ(動的ツール mcp__<server>__<tool>)
# mcp:
#   servers:
#     fs:
#       command: npx
#       args: ["-y", "@modelcontextprotocol/server-filesystem", /data]
#       read_only: true     # plan モードでも使用可・承認省略

# M5: ライフサイクルフック(shell コマンド・stdin に JSON・失敗は記録のみ)
# hooks:
#   post_tool_use:
#     - node ~/.familiar/hooks/audit.js

# M5: 定期実行(serve プロセス内・every_minutes 0 は起動時に 1 回)
# cron:
#   jobs:
#     - name: daily-report
#       every_minutes: 1440
#       prompt: "昨日のセッションから学びを memory へ蓄積して"

# M6: LSP 診断(lsp_diagnostics ツール)。拡張子で言語サーバへ振り分け
# lsp:
#   servers:
#     typescript:
#       command: typescript-language-server
#       args: ["--stdio"]
#       extensions: [ts, tsx, js, jsx]

# M6: SOUL.md 多段ペルソナ(設定キーではなく以下のファイル群)
#   1. ~/.familiar/SOUL.md              … 全セッション共通(最も弱い)
#   2. ~/.familiar/profiles/<p>/SOUL.md … プロファイル個別
#   3. <cwd>/.familiar/SOUL.md          … プロジェクト固有(最も強い)
# 3つすべてが読める順に注入される(profiles.<p>.system_prompt_file で上書き可)。

context:
  token_soft_limit: 0            # 絶対上限で圧縮をかけたい場合のみ設定(0 = 無効)
  keep_last: 10
  compaction:  # M4: over the limit, ask the aux compactor to write a note (fall back to drop)
    mode: summarize              # summarize | drop
    ratio: 0.9                   # モデルのコンテキストウィンドウの 90% で圧縮
  max_turn_steps: 100            # 1ターンのステップ上限。25 ステップの窓を超えても
                                 # 自動継続し、この値で打ち切る(「続けて」不要)

server:
  port: 46210
  bind: 127.0.0.1
`;
