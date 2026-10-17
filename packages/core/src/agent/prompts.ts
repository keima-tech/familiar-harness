import fs from "node:fs";
import path from "node:path";
import type { ResolvedConfig } from "../config.js";

const AGENTS_FILE = "AGENTS.md";
const AGENTS_TOTAL_CAP = 16_000;

/**
 * Base persona (English; tools descriptions are English as well).
 * Kept short — project context is injected separately.
 */
export function basePersona(): string {
  return `You are Familiar, an agent that works on the user's machine to read, write, run and verify code.
Rules:
- Prefer the fastest safe path. Before destructive or irreversible actions, explain and get approval.
- Use the provided tools instead of describing actions. Read files before editing them.
- After completing multi-step work, briefly state what changed and how to verify it.
- Be honest about uncertainty; never invent file contents or command output.
- When you hit an error, diagnose with logs/output and retry with a concrete fix rather than guessing.
- The working directory is shared with the user; keep it clean (no stray scripts).
You may run on Windows or Linux; the bash tool already handles OS differences.`;
}

/**
 * AGENTS.md files discovered from cwd up to the filesystem root (nearest wins,
 * all included in nearest-first order until the cap).
 */
export function projectAgentsFiles(cwd: string): { file: string; content: string }[] {
  const found: { file: string; content: string; dirDepth: number }[] = [];
  let dir = path.resolve(cwd);
  let depth = 0;
  while (dir !== path.dirname(dir) && depth < 32) {
    const candidate = path.join(dir, AGENTS_FILE);
    try {
      if (fs.statSync(candidate).isFile()) {
        const text = fs.readFileSync(candidate, "utf8");
        if (text.trim() !== "") found.push({ file: candidate, content: text, dirDepth: depth });
      }
    } catch {
      /* not readable — ignore */
    }
    dir = path.dirname(dir);
    depth += 1;
  }
  found.sort((a, b) => a.dirDepth - b.dirDepth); // nearest (deepest) first
  const out: { file: string; content: string }[] = [];
  let total = 0;
  for (const f of found) {
    if (total + f.content.length > AGENTS_TOTAL_CAP) {
      out.push({ file: f.file, content: `(AGENTS.md truncated: ${f.file})` });
      break;
    }
    out.push({ file: f.file, content: f.content });
    total += f.content.length;
  }
  return out;
}

/** Read a trimmed persona file; null when missing/empty/unreadable. */
function readPersonaFile(p: string): string | null {
  try {
    if (fs.statSync(p).isFile()) {
      const text = fs.readFileSync(p, "utf8").trim();
      return text === "" ? null : text;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * M6: global persona layer — `<familiarHome>/SOUL.md`, applied to every session
 * regardless of profile. Lowest precedence soul file.
 */
export function globalSoulPrompt(cfg: ResolvedConfig): string | null {
  return readPersonaFile(path.join(cfg.homeDir, "SOUL.md"));
}

/**
 * M6: project persona layer — `<cwd>/.familiar/SOUL.md`, applied when running in
 * that project. Higher precedence than the global layer.
 */
export function projectSoulPrompt(cwd: string): string | null {
  return readPersonaFile(path.join(cwd, ".familiar", "SOUL.md"));
}

/** Optional profile persona (M2): explicit system_prompt_file or a per-profile SOUL.md. */
export function profileSystemPrompt(cfg: ResolvedConfig, profile?: string): string | null {
  if (!profile) return null;
  const explicitPath = cfg.profiles[profile]?.system_prompt_file;
  const candidates = [
    explicitPath,
    path.join(cfg.homeDir, "profiles", profile, "SOUL.md"),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    const content = readPersonaFile(c);
    if (content !== null) return content;
  }
  return null;
}

/** Assemble the full system prompt for a turn. */
export function buildSystemPrompt(
  cfg: ResolvedConfig,
  opts: {
    cwd: string;
    profile?: string;
    toolNames: string[];
    /** M2: plan mode guidance */
    plan?: boolean;
    /** M2: injected sections (todo state; memory in M3) */
    extraSystem?: string[];
  },
): string {
  const parts: string[] = [basePersona()];

  // M6: layered persona (SOUL.md) — global → profile → project, in that order.
  const globalSoul = globalSoulPrompt(cfg);
  if (globalSoul) parts.push(`# Persona instructions\n\n${globalSoul}`);

  const soul = profileSystemPrompt(cfg, opts.profile);
  if (soul) parts.push(`# Profile instructions\n\n${soul}`);

  const projectSoul = projectSoulPrompt(opts.cwd);
  if (projectSoul) parts.push(`# Project persona\n\n${projectSoul}`);

  for (const agents of projectAgentsFiles(opts.cwd)) {
    parts.push(`# Project instructions (${agents.file})\n\n${agents.content}`);
  }

  if (opts.plan) {
    parts.push(
      "# Plan mode active\n" +
        "You are in PLAN MODE: research and design only.\n" +
        "- Allowed tools: read-only ones (read / glob / grep / webfetch / websearch). No file edits, no commands.\n" +
        "- Produce a concrete, step-by-step implementation plan (files to touch, approach, risks) and wait for the user to approve execution.\n" +
        "- If information is missing, ask focused questions instead of guessing.",
    );
  }

  for (const extra of opts.extraSystem ?? []) {
    if (extra.trim() !== "") parts.push(extra);
  }

  parts.push(
    `# Guidelines\n` +
      `- cwd: ${opts.cwd}\n` +
      `- available tools: ${opts.toolNames.join(", ")}\n` +
      `- keep responses concise; markdown allowed.`,
  );
  return parts.join("\n\n---\n\n");
}

/** Serialize the session todo list for prompt injection (M2). */
export function todoSection(items: { id: string; title: string; status: string }[]): string {
  if (items.length === 0) return "";
  const lines = items.map((t) => `- (#${t.id}, ${t.status}) ${t.title}`);
  return (
    "# Current todo state\n" +
    lines.join("\n") +
    "\nKeep this list current with the todo tool as you work."
  );
}
