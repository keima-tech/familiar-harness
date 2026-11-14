import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { SkillCatalogEntry } from "@familiar/protocol";
import { ensureDir } from "../../paths.js";
import { lintSkillBody } from "./lint.js";

export interface SkillUsage {
  useCount: number;
  lastUsedMs?: number;
  createdMs?: number;
  pinned?: boolean;
  /** curator phase-1 marker: ms timestamp when the entry became stale */
  staleAt?: number;
}

export interface SkillView {
  name: string;
  description: string;
  body: string;
  warnings: string[];
  /** absolute directory holding SKILL.md — skills reference files relative to it */
  dir: string;
}

/**
 * Familiar's own skills live at <home>/skills/<name>/SKILL.md with frontmatter
 * (name, description); usage counters in <home>/skills/.usage.json.
 *
 * Additional read-only roots may be supplied (global agent-skills directories
 * and user-configured paths). Familiar's own store wins on name conflicts; the
 * external roots are never written to.
 */
export class SkillStore {
  private readonly root: string;
  private readonly extraRoots: readonly string[];

  constructor(home: string, opts: { extraRoots?: string[] } = {}) {
    this.root = path.join(home, "skills");
    this.extraRoots = (opts.extraRoots ?? []).filter((r) => r.trim() !== "");
  }

  /** Roots in read order: ours first (wins on name conflicts), then externals. */
  private allRoots(): readonly string[] {
    return [this.root, ...this.extraRoots];
  }

  /** Locate a skill directory across all roots (familiar first). */
  private findDir(name: string): { dir: string; source: string } | undefined {
    // `name` reaches here from the model (skill_view) as well as the GUI: never
    // let it climb out of a root (…/.. or an absolute path).
    if (name === "" || name === "." || name === ".." || /[\\/]/.test(name)) return undefined;
    for (const root of this.allRoots()) {
      const dir = path.join(root, name);
      const rel = path.relative(root, dir);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      try {
        if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "SKILL.md"))) {
          return { dir, source: root === this.root ? "familiar" : root };
        }
      } catch {
        /* try the next root */
      }
    }
    return undefined;
  }

  dirOf(name: string): string {
    return path.join(this.root, name);
  }

  list(): SkillCatalogEntry[] {
    const usage = this.readUsage();
    const out: SkillCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const root of this.allRoots()) {
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root)) {
        if (seen.has(name)) continue;
        if (name.startsWith(".")) continue;
        const dir = path.join(root, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(dir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        const skill = parseSkillFile(path.join(dir, "SKILL.md"));
        if (!skill) continue;
        seen.add(name);
        const u: SkillUsage = usage[name] ?? { useCount: 0 };
        out.push({
          name,
          description: skill.description,
          bodyChars: skill.body.length,
          useCount: u.useCount ?? 0,
          lastUsedAt: u.lastUsedMs,
          createdAt: u.createdMs,
          source: root === this.root ? "familiar" : root,
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Load the full SKILL.md body and bump the usage counter. */
  view(name: string): SkillView | undefined {
    const found = this.findDir(name);
    if (!found) return undefined;
    const skill = parseSkillFile(path.join(found.dir, "SKILL.md"));
    if (!skill) return undefined;
    const fileCount = countReferenceFiles(found.dir);
    const warnings = lintSkillBody({ body: skill.body, refFileCount: fileCount });
    this.bumpUsage(name);
    return { name, description: skill.description, body: skill.body, warnings, dir: found.dir };
  }

  get(name: string): { name: string; description: string; body: string } | undefined {
    const found = this.findDir(name);
    if (!found) return undefined;
    const skill = parseSkillFile(path.join(found.dir, "SKILL.md"));
    return skill ? { name, ...skill } : undefined;
  }

  bodyHash(name: string): string | undefined {
    const skill = this.get(name);
    return skill ? sha256(skill.body) : undefined;
  }

  /** Create or overwrite the skill directory. Returns warnings. */
  write(
    name: string,
    description: string,
    body: string,
  ): { warnings: string[] } {
    ensureDir(this.dirOf(name));
    fs.writeFileSync(
      path.join(this.dirOf(name), "SKILL.md"),
      renderSkillFile(name, description, body),
    );
    const usage = this.readUsage();
    const got: SkillUsage | undefined = usage[name];
    if (got === undefined) {
      usage[name] = { useCount: 0, createdMs: Date.now() };
    } else if (got.createdMs === undefined) {
      got.createdMs = Date.now();
    }
    this.writeUsage(usage);
    const warnings = lintSkillBody({ body, refFileCount: countReferenceFiles(this.dirOf(name)) });
    return { warnings };
  }

  /** Archive (never hard-delete) a skill: move to .archive/<name>. */
  archive(name: string): boolean {
    const dir = this.dirOf(name);
    if (!fs.existsSync(dir)) return false;
    const archiveRoot = path.join(this.root, ".archive");
    let target = path.join(archiveRoot, name);
    let i = 1;
    while (fs.existsSync(target)) {
      target = path.join(archiveRoot, `${name}-${i}`);
      i += 1;
    }
    ensureDir(archiveRoot);
    fs.renameSync(dir, target);
    return true;
  }

  readUsage(): Record<string, SkillUsage> {
    const file = path.join(this.root, ".usage.json");
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, SkillUsage>;
    } catch {
      return {};
    }
  }

  private writeUsage(data: Record<string, SkillUsage>): void {
    ensureDir(this.root);
    fs.writeFileSync(path.join(this.root, ".usage.json"), `${JSON.stringify(data, null, 2)}\n`);
  }

  bumpUsage(name: string): void {
    const usage = this.readUsage();
    const u = usage[name] ?? { useCount: 0 };
    usage[name] = { ...u, useCount: (u.useCount ?? 0) + 1, lastUsedMs: Date.now(), staleAt: undefined };
    this.writeUsage(usage);
  }

  /** curator helpers: stale marker + pin flag persist in .usage.json */
  markStale(name: string): void {
    const usage = this.readUsage();
    const u = usage[name] ?? { useCount: 0, createdMs: Date.now() };
    usage[name] = { ...u, staleAt: Date.now() };
    this.writeUsage(usage);
  }

  clearStale(name: string): void {
    const usage = this.readUsage();
    const u = usage[name];
    if (!u) return;
    const { staleAt: _dropped, ...rest } = u;
    usage[name] = { ...rest };
    this.writeUsage(usage);
  }

  setPinned(name: string, pinned: boolean): void {
    const usage = this.readUsage();
    const u = usage[name] ?? { useCount: 0, createdMs: Date.now() };
    usage[name] = { ...u, pinned };
    this.writeUsage(usage);
  }

  isPinned(name: string): boolean {
    return this.readUsage()[name]?.pinned === true;
  }

  listArchived(): string[] {
    const dir = path.join(this.root, ".archive");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => !n.startsWith(".") && fs.statSync(path.join(dir, n)).isDirectory())
      .sort();
  }
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function slugifyName(raw: string): string | undefined {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return /^[a-z][a-z0-9-]*$/.test(slug) ? slug : undefined;
}

export function parseSkillFile(
  file: string,
): { description: string; body: string } | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    let description = "";
    let body = text;
    if (m) {
      const front = m[1] ?? "";
      body = text.slice((m.index ?? 0) + m[0].length);
      description = parseFrontmatter(front);
    }
    return { description, body: body.trim() };
  } catch {
    return undefined;
  }
}

/** YAML frontmatter, tolerating the folded style used by global skills. */
function parseFrontmatter(front: string): string {
  try {
    const fm = parseYaml(front) as Record<string, unknown> | null | undefined;
    const desc = fm && typeof fm === "object" ? fm["description"] : undefined;
    if (typeof desc === "string") return desc.trim();
  } catch {
    // fall through: keep a naive single-line read for odd frontmatter
    const d = front.match(/^description:\s*(.+)$/m);
    if (d) return (d[1] ?? "").trim();
  }
  return "";
}

/** Compose a SKILL.md with frontmatter from description + body. */
export function renderSkillFile(name: string, description: string, body: string): string {
  const safeDesc = description.replace(/\n/g, " ").trim();
  return `---\nname: ${name}\ndescription: ${safeDesc}\n---\n\n${body.trim()}\n`;
}

function countReferenceFiles(dir: string): number {
  const ref = path.join(dir, "references");
  if (!fs.existsSync(ref)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(ref, { recursive: true })) {
    if (typeof f === "string" && !f.includes("/")) n += 1;
  }
  return n;
}
