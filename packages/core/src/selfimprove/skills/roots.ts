import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillsConfig } from "../../config.js";

/** Well-known global agent-skills directories (see `npx skills add`). */
const GLOBAL_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".config/opencode/skills",
  ".opencode/skills",
  ".cursor/skills",
  ".windsurf/skills",
];

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the ordered, deduplicated list of read-only roots for external
 * skills (familiar's own ~/.familiar/skills is handled separately and wins on
 * name conflicts). Roots that are symlinks to the same place collapse.
 */
export function resolveSkillRoots(cfg: SkillsConfig): string[] {
  const home = os.homedir();
  const candidates: string[] = [];
  if (cfg.include_global) {
    for (const rel of GLOBAL_ROOTS) candidates.push(path.join(home, rel));
  }
  for (const p of cfg.paths ?? []) candidates.push(expandHome(p));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (!isDir(abs)) continue;
    let key: string;
    try {
      key = fs.realpathSync(abs);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}
