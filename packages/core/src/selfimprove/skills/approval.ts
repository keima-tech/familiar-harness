import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { PendingWrite } from "@familiar/protocol";
import { ensureDir } from "../../paths.js";
import type { SkillStore } from "./store.js";
import { lintSkillBody } from "./lint.js";

/**
 * Staged skill writes (~/.familiar/pending/skills/<id>.json where id is short).
 * Staging captures a snapshot (body hash) so approval can CAS-guard changes
 * made outside the review pipeline.
 */
export interface StagedSkill {
  id: string;
  name: string;
  kind: "create" | "patch" | "remove";
  description?: string;
  body?: string;
  reason?: string;
  warnings?: string[];
  /** CAS: sha256 of the target body at staging time (patch/remove) */
  snapshotBodyHash?: string;
  createdAt: number;
}

export class PendingSkillStore {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = path.join(home, "pending", "skills");
  }

  list(): (StagedSkill & { summary: string })[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: (StagedSkill & { summary: string })[] = [];
    for (const file of fs.readdirSync(this.dir).sort()) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as StagedSkill;
        out.push({ ...rec, summary: describeSkill(rec) });
      } catch {
        /* skip unreadable pending file */
      }
    }
    return out;
  }

  count(): number {
    return this.list().length;
  }

  findByPrefix(prefix: string): { rec: StagedSkill; file: string } | undefined {
    if (!fs.existsSync(this.dir)) return undefined;
    for (const file of fs.readdirSync(this.dir).sort()) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      if (id === prefix || id.startsWith(prefix)) {
        return {
          rec: JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as StagedSkill,
          file: path.join(this.dir, file),
        };
      }
    }
    return undefined;
  }

  stage(rec: Omit<StagedSkill, "id" | "createdAt">): { id: string } {
    ensureDir(this.dir);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const full: StagedSkill = {
      ...rec,
      id,
      warnings: rec.warnings ?? (rec.body !== undefined ? lintSkillBody({ body: rec.body }) : []),
      createdAt: Date.now(),
    };
    fs.writeFileSync(
      path.join(this.dir, `${full.id}.json`),
      `${JSON.stringify(full, null, 2)}\n`,
    );
    return { id: full.id };
  }

  removeFile(file: string): void {
    fs.rmSync(file, { force: true });
  }

  toApi(list: (StagedSkill & { summary: string })[]): PendingWrite[] {
    return list.map((s) => ({
      id: s.id,
      kind: s.kind,
      target: s.name,
      summary: s.summary,
      reason: s.reason,
      warnings: s.warnings,
      createdAt: s.createdAt,
    }));
  }
}

function describeSkill(rec: StagedSkill): string {
  if (rec.kind === "create") {
    return `create skill ${rec.name}: ${truncate(rec.description)}`;
  }
  if (rec.kind === "patch") {
    return `patch skill ${rec.name}: ${truncate(rec.reason ?? rec.description ?? rec.body)}`;
  }
  return `remove skill ${rec.name}`;
}

function truncate(s: string | undefined): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

/**
 * Apply a staged skill write with CAS (patch/remove must match the snapshot
 * hash). Removal archives the directory (never hard-deletes).
 */
export function approveStagedSkill(
  store: PendingSkillStore,
  skills: SkillStore,
  prefix: string,
): { approved: boolean; message: string } {
  const found = store.findByPrefix(prefix);
  if (!found) return { approved: false, message: `no pending skill matching "${prefix}"` };
  const { rec, file } = found;

  if (rec.kind === "patch" || rec.kind === "remove") {
    const currentHash = skills.bodyHash(rec.name);
    if (currentHash === undefined) {
      return { approved: false, message: `skill not found: ${rec.name}` };
    }
    if (rec.snapshotBodyHash && currentHash !== rec.snapshotBodyHash) {
      return {
        approved: false,
        message: `CAS refused: skill ${rec.name} changed since staging — re-run the review or edit manually`,
      };
    }
  }

  try {
    if (rec.kind === "create" || rec.kind === "patch") {
      skills.write(rec.name, rec.description ?? "", rec.body ?? "");
      store.removeFile(file);
      const warnText = (rec.warnings ?? []).length > 0 ? ` (warns: ${rec.warnings?.join("; ")})` : "";
      return { approved: true, message: `approved #${rec.id}: ${rec.kind}d skill ${rec.name}${warnText}` };
    }
    // remove → archive
    skills.archive(rec.name);
    store.removeFile(file);
    return { approved: true, message: `approved #${rec.id}: archived skill ${rec.name}` };
  } catch (err) {
    return {
      approved: false,
      message: `failed to apply #${rec.id}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function rejectStagedSkill(
  store: PendingSkillStore,
  prefix: string,
): { rejected: boolean; message: string } {
  const found = store.findByPrefix(prefix);
  if (!found) return { rejected: false, message: `no pending skill matching "${prefix}"` };
  store.removeFile(found.file);
  return { rejected: true, message: `rejected #${found.rec.name}` };
}
