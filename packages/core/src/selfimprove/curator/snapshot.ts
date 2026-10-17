import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir } from "../../paths.js";

/**
 * Skills snapshot before any curator mutation (spec 04 §5: "必ず snapshot").
 * Ever snapshot lands as <home>/snapshots/<ts>-<id>/ — plain directory copy
 * of every skill directory; restoring is a reverse copy.
 */
export interface SnapshotRecord {
  id: string;
  dir: string;
  ts: number;
  files: number;
  reason: string;
}

export class SkillSnapshots {
  constructor(
    private readonly skillsRoot: string,
    private readonly home: string,
  ) {}

  private get root(): string {
    return path.join(this.home, "snapshots");
  }

  create(reason: string): SnapshotRecord | undefined {
    const skRoot = this.skillsRoot;
    if (!fs.existsSync(skRoot)) return undefined;
    const entries = fs
      .readdirSync(skRoot)
      .filter((n) => !n.startsWith(".") && fs.statSync(path.join(skRoot, n)).isDirectory());
    if (entries.length === 0) return undefined;

    ensureDir(this.root);
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 4)}`;
    const dir = path.join(this.root, id);
    ensureDir(dir);
    let files = 0;
    for (const name of entries) {
      copyDir(path.join(skRoot, name), path.join(dir, name));
      files += countFiles(path.join(skRoot, name));
    }
    fs.writeFileSync(
      path.join(dir, ".snapshot.json"),
      `${JSON.stringify({ id, ts: Date.now(), reason, files }, null, 2)}\n`,
    );
    return { id, dir, ts: Date.now(), files, reason };
  }

  list(): SnapshotRecord[] {
    if (!fs.existsSync(this.root)) return [];
    const out: SnapshotRecord[] = [];
    for (const name of fs.readdirSync(this.root).sort().reverse()) {
      const meta = path.join(this.root, name, ".snapshot.json");
      if (!fs.existsSync(meta)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(meta, "utf8")) as Partial<SnapshotRecord>;
        out.push({
          id: rec.id ?? name,
          dir: path.join(this.root, name),
          ts: rec.ts ?? fs.statSync(meta).mtimeMs,
          files: rec.files ?? 0,
          reason: rec.reason ?? "",
        });
      } catch {
        /* skip unreadable snapshot */
      }
    }
    return out;
  }

  /** Copy snapshot id back over the live skills root (session/exclusion dirs preserved). */
  restore(prefix: string): { restored?: string; message: string } {
    const found = this.list().find((s) => s.id === prefix || s.id.startsWith(prefix));
    if (!found) return { message: `no snapshot matching "${prefix}"` };
    const live = this.skillsRoot;
    for (const name of fs.readdirSync(found.dir)) {
      if (!fs.statSync(path.join(found.dir, name)).isDirectory()) continue;
      const target = path.join(live, name);
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      copyDir(path.join(found.dir, name), target);
    }
    return { restored: found.id, message: `restored snapshot ${found.id}` };
  }

  /** Delete snapshots older than N days. */
  prune(days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    let removed = 0;
    for (const rec of this.list()) {
      if (rec.ts < cutoff) {
        fs.rmSync(rec.dir, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

function copyDir(from: string, to: string): void {
  ensureDir(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    if (entry.isDirectory()) copyDir(s, path.join(to, entry.name));
    else fs.copyFileSync(s, path.join(to, entry.name));
  }
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? countFiles(p) : 1;
  }
  return n;
}
