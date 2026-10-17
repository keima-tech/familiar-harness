import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MemoryEntry, MemorySource } from "@familiar/protocol";
import { ensureDir } from "../../paths.js";

/**
 * JSON-file memory store. Layout per spec 04:
 *   <familiars>/memories/<namespace>.json
 * Entries are small durable facts always visible to the model.
 */
export class MemoryStore {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = path.join(home, "memories");
  }

  /** All entries across namespaces. */
  list(): MemoryEntry[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: MemoryEntry[] = [];
    for (const file of fs.readdirSync(this.dir).sort()) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      const ns = file.slice(0, -".json".length);
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as {
          entries?: MemoryEntry[];
        };
        for (const entry of parsed.entries ?? []) {
          if (typeof entry?.id === "string" && typeof entry?.content === "string") {
            out.push({ ...entry, namespace: entry.namespace ?? ns });
          }
        }
      } catch {
        /* unreadable namespace file is skipped, never fatal */
      }
    }
    return out;
  }

  get(id: string): MemoryEntry | undefined {
    return this.list().find((e) => e.id === id);
  }

  findPrefix(prefix: string): MemoryEntry | undefined {
    const exact = this.list().find((e) => e.id === prefix);
    if (exact) return exact;
    const matches = this.list().filter((e) => e.id.startsWith(prefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  create(content: string, tags: string[], source: MemorySource, namespace = "default"): MemoryEntry {
    ensureDir(this.dir);
    const now = Date.now();
    const entry: MemoryEntry = {
      id: nanoid(),
      namespace,
      content,
      tags,
      createdAt: now,
      updatedAt: now,
      source,
    };
    const file = path.join(this.dir, `${namespace}.json`);
    const data = readNamespace(file);
    data.entries.push(entry);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    return entry;
  }

  patch(
    id: string,
    content: string,
    tags: string[] | undefined,
    expectedUpdatedAt?: number,
  ): MemoryEntry | undefined {
    const entry = this.get(id);
    if (!entry) return undefined;
    if (expectedUpdatedAt !== undefined && entry.updatedAt !== expectedUpdatedAt) {
      throw new Error(
        `memory ${id} changed since the snapshot was taken (CAS); re-read and retry`,
      );
    }
    const file = path.join(this.dir, `${entry.namespace}.json`);
    const data = readNamespace(file);
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx === -1) return undefined;
    const updated: MemoryEntry = {
      ...entry,
      content,
      tags: tags ?? entry.tags,
      updatedAt: Date.now(),
    };
    data.entries[idx] = updated;
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    return updated;
  }

  remove(id: string, expectedUpdatedAt?: number): boolean {
    const entry = this.get(id);
    if (!entry) return false;
    if (expectedUpdatedAt !== undefined && entry.updatedAt !== expectedUpdatedAt) {
      throw new Error(
        `memory ${id} changed since the snapshot was taken (CAS); re-read and retry`,
      );
    }
    const file = path.join(this.dir, `${entry.namespace}.json`);
    const data = readNamespace(file);
    const next = data.entries.filter((e) => e.id !== id);
    if (next.length === data.entries.length) return false;
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...data, entries: next }, null, 2)}\n`,
    );
    return true;
  }

  count(): number {
    return this.list().length;
  }
}

function readNamespace(file: string): { entries: MemoryEntry[] } {
  if (!fs.existsSync(file)) return { entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: MemoryEntry[] };
    return { entries: parsed.entries ?? [] };
  } catch {
    return { entries: [] };
  }
}

function nanoid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
