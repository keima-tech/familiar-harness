import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { PendingWrite } from "@familiar/protocol";
import { ensureDir } from "../../paths.js";
import type { MemoryStore } from "./store.js";

/**
 * Staged memory writes (~/.familiar/pending/memory/*.json).
 * Background self-review and the memory_manage tool both stage here when
 * write_approval is on; `approve` applies them with CAS against the snapshot.
 */
export interface StagedMemory {
  id: string;
  kind: "create" | "patch" | "remove";
  /** only for patch/remove */
  target?: string;
  namespace: string;
  content?: string;
  tags?: string[];
  reason?: string;
  /** CAS: updatedAt of the target entry captured at staging time */
  snapshotUpdatedAt?: number;
  createdAt: number;
}

export class PendingMemoryStore {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = path.join(home, "pending", "memory");
  }

  list(): (StagedMemory & { summary: string })[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: (StagedMemory & { summary: string })[] = [];
    for (const file of fs.readdirSync(this.dir).sort()) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as StagedMemory;
        if (rec.kind) {
          out.push({ ...rec, summary: describeMemory(rec) });
        }
      } catch {
        /* skip unreadable
         */
      }
    }
    return out;
  }

  count(): number {
    return this.list().length;
  }

  stage(rec: Omit<StagedMemory, "id" | "createdAt">): { id: string } {
    ensureDir(this.dir);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const full: StagedMemory = { ...rec, id, createdAt: Date.now() };
    fs.writeFileSync(
      path.join(this.dir, `${full.id}.json`),
      `${JSON.stringify(full, null, 2)}\n`,
    );
    return { id: full.id };
  }

  /** Resolve an 8-char prefix (or full id) to a pending record + file path. */
  findByPrefix(prefix: string): { rec: StagedMemory; file: string } | undefined {
    for (const file of fs.existsSync(this.dir) ? fs.readdirSync(this.dir).sort() : []) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      const id = file.slice(0, -".json".length);
      if (id === prefix || id.startsWith(prefix)) {
        return {
          rec: JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as StagedMemory,
          file: `${this.dir}/${file}`,
        };
      }
    }
    return undefined;
  }

  removeFile(file: string): void {
    fs.rmSync(file, { force: true });
  }

  toApi(list: (StagedMemory & { summary: string })[]): PendingWrite[] {
    return list.map((m) => ({
      id: m.id,
      kind: m.kind,
      target: m.target,
      summary: m.summary,
      reason: m.reason,
      createdAt: m.createdAt,
    }));
  }
}

function describeMemory(rec: StagedMemory): string {
  if (rec.kind === "create") return `create memory: ${truncate(rec.content)}`;
  if (rec.kind === "patch") return `patch ${rec.target}: ${truncate(rec.content)}`;
  return `remove ${rec.target ?? ""}`;
}

function truncate(s: string | undefined): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

/**
 * Apply a staged memory write. CAS failures throw; callers surface them.
 */
export function approveStagedMemory(
  store: PendingMemoryStore,
  memories: MemoryStore,
  prefix: string,
): { approved: boolean; message: string } {
  const found = store.findByPrefix(prefix);
  if (!found) return { approved: false, message: `no pending memory matching "${prefix}"` };
  const { rec, file } = found;
  try {
    if (rec.kind === "create") {
      const entry = memories.create(rec.content ?? "", rec.tags ?? [], "background");
      store.removeFile(file);
      return { approved: true, message: `approved #${rec.id}: created memory ${entry.id}` };
    }
    if (rec.kind === "patch") {
      const updated = memories.patch(rec.target ?? "", rec.content ?? "", rec.tags, rec.snapshotUpdatedAt);
      if (!updated) {
        return { approved: false, message: `target memory not found: ${rec.target}` };
      }
      store.removeFile(file);
      return { approved: true, message: `approved #${rec.id}: patched ${updated.id}` };
    }
    // remove
    if (rec.snapshotUpdatedAt !== undefined) {
      memories.remove(rec.target ?? "", rec.snapshotUpdatedAt); // throws on CAS mismatch
    } else {
      memories.remove(rec.target ?? "");
    }
    store.removeFile(file);
    return { approved: true, message: `approved #${rec.id}: removed ${rec.target}` };
  } catch (err) {
    return {
      approved: false,
      message: `CAS refused #${rec.id}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function rejectStagedMemory(
  store: PendingMemoryStore,
  prefix: string,
): { rejected: boolean; message: string } {
  const found = store.findByPrefix(prefix);
  if (!found) return { rejected: false, message: `no pending memory matching "${prefix}"` };
  store.removeFile(found.file);
  return { rejected: true, message: `rejected #${found.rec.id}` };
}
