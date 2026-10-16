import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { log } from "./logger.js";
import { familiarPaths } from "./paths.js";

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
  /** Send `stream_options: { include_usage: true }` (needed by OpenAI, some compat providers reject it). */
  stream_options?: boolean;
}

export interface BashPermissionConfig {
  allow: string[];
  deny: string[];
  max_timeout_ms: number;
}

export interface PermissionsConfig {
  bash: BashPermissionConfig;
  files: { bounds: "cwd" | "unrestricted" };
}

export interface AuxiliarySlot {
  provider: string;
  model: string;
}

export interface ResolvedConfig {
  homeDir: string;
  default_provider: string;
  default_model?: string;
  providers: Record<string, ProviderConfig>;
  auxiliary: Record<string, AuxiliarySlot>;
  profiles: Record<string, { system_prompt_file?: string }>;
  permissions: PermissionsConfig;
  context: { token_soft_limit: number; keep_last: number };
  server: { port: number; bind: string; auth_token_file?: string };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: ResolvedConfig = {
  homeDir: familiarPaths.home(),
  default_provider: "mock",
  providers: {
    openai: {
      kind: "openai_compatible",
      base_url: "https://api.openai.com/v1",
      auth: { env: "OPENAI_API_KEY" },
      default_model: "gpt-5.2",
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
    ollama: {
      kind: "openai_compatible",
      base_url: "http://127.0.0.1:11434/v1",
      auth: { env: "none" },
      stream_options: false,
    },
    mock: { kind: "mock" },
  },
  auxiliary: {},
  profiles: {},
  permissions: {
    bash: {
      allow: [
        "^git (status|diff|log|show|branch|remote|tag|rev-parse|shortlog)( .*)?$",
        "^node --version$",
        "^npm --version$",
        "^python3 --version$",
      ],
      deny: ["^sudo\\b", "\\brm\\s+(-[a-z]+\\s+)*-[rf]r?f?", ">\\s*/dev/(sd|nvme)"],
      max_timeout_ms: 600_000,
    },
    files: { bounds: "cwd" },
  },
  context: { token_soft_limit: 81_920, keep_last: 10 },
  server: { port: 46_210, bind: "127.0.0.1" },
};

const KNOWN_TOP_LEVEL = new Set([
  "version",
  "default_provider",
  "default_model",
  "providers",
  "auxiliary",
  "profiles",
  "permissions",
  "context",
  "server",
]);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursive merge: scalars/arrays win from `over`, objects merge. */
function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) {
    if (over === undefined) return base;
    return over as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
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

/** Where a secret comes from (for sanitized diagnostics; never the value). */
export function describeAuthSource(
  auth: ProviderAuth | undefined,
): { source: string; resolved: boolean } {
  if (!auth) return { source: "none", resolved: false };
  if (auth.api_key) return { source: "inline", resolved: true };
  if (auth.api_key_file)
    return { source: `file:${expandHome(auth.api_key_file)}`, resolved: true };
  if (auth.env) return { source: `env:${auth.env}`, resolved: !!resolveAuthSecret(auth) };
  return { source: "none", resolved: false };
}

export interface LoadConfigOptions {
  configFile?: string;
  /** e.g. { default_provider } from CLI flags */
  overrides?: Partial<Pick<ResolvedConfig, "default_provider">>;
}

export function configFilePath(explicit?: string): string {
  if (explicit) return expandHome(explicit);
  return familiarPaths.config();
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

  // Provider entries: kind defaults to openai_compatible when only base_url is given.
  for (const [id, pc] of Object.entries(cfg.providers)) {
    pc.kind = pc.kind ?? "openai_compatible";
  }
  if (cfg.default_provider && !(cfg.default_provider in cfg.providers)) {
    log.warn(`default_provider "${cfg.default_provider}" is not configured`);
  }

  cfg.homeDir = familiarPaths.home();
  if (options.overrides?.default_provider) cfg.default_provider = options.overrides.default_provider;
  return cfg;
}

/**
 * Copy of the config safe to expose via `config.get` RPC: secret values are
 * replaced by their origin + resolution status.
 */
export function sanitizeConfigForApi(cfg: ResolvedConfig): Record<string, unknown> {
  const clone = structuredClone(cfg) as unknown as Record<string, unknown>;
  const providers = clone["providers"] as Record<string, Record<string, unknown>>;
  for (const pc of Object.values(providers)) {
    const auth = pc["auth"] as ProviderAuth | undefined;
    pc["auth"] = describeAuthSource(auth);
  }
  delete clone["homeDir"];
  return clone;}

// ---------------------------------------------------------------------------
// Template written by `familiar init`
// ---------------------------------------------------------------------------

export const CONFIG_TEMPLATE = `# Familiar configuration (~/.familiar/config.yaml)
# Never put tokens in this file — use auth: { env: ... } or api_key_file.

version: 1

default_provider: openai
default_model: gpt-5.2

providers:
  openai:
    kind: openai_compatible
    base_url: https://api.openai.com/v1
    auth: { env: OPENAI_API_KEY }
    default_model: gpt-5.2
  anthropic:
    kind: anthropic
    base_url: https://api.anthropic.com/v1
    auth: { env: ANTHROPIC_API_KEY }
    default_model: claude-sonnet-4-6
  openrouter:
    kind: openai_compatible
    base_url: https://openrouter.ai/api/v1
    auth: { env: OPENROUTER_API_KEY }
  ollama:
    kind: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    auth: none
  mock:
    kind: mock

permissions:
  bash:
    allow:
      - "^git (status|diff|log|show|branch|remote|tag|rev-parse|shortlog)( .*)?$"
    deny:
      - "^sudo\\\\b"
      - "\\\\brm\\\\s+(-[a-z]+\\\\s+)*-[rf]r?f?"
    max_timeout_ms: 600000

context:
  token_soft_limit: 81920
  keep_last: 10

server:
  port: 46210
  bind: 127.0.0.1
`;
