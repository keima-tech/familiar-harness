import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir } from "../../paths.js";

/**
 * Append-only audit log for every curator mutation (spec 04 §5):
 * { ts, actor, action, skill?, beforeHash?, afterHash?, detail? }
 * One JSON object per line at <home>/curator/ledger.jsonl.
 */
export interface LedgerEntry {
  ts: number;
  actor: "curator" | "user" | "agent";
  action: string;
  skill?: string;
  beforeHash?: string;
  afterHash?: string;
  detail?: string;
}

export class CuratorLedger {
  private readonly file: string;

  constructor(home: string) {
    this.file = path.join(home, "curator", "ledger.jsonl");
  }

  append(entry: Omit<LedgerEntry, "ts">): LedgerEntry {
    ensureDir(path.dirname(this.file));
    const full: LedgerEntry = { ...entry, ts: Date.now() };
    fs.appendFileSync(this.file, `${JSON.stringify(full)}\n`);
    return full;
  }

  /** Newest first. */
  list(filter?: { skill?: string; limit?: number }): LedgerEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const out: LedgerEntry[] = [];
    try {
      const lines = fs.readFileSync(this.file, "utf8").split("\n").reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as LedgerEntry;
          if (filter?.skill && e.skill && e.skill !== filter.skill) continue;
          out.push(e);
          if (filter?.limit !== undefined && out.length >= filter.limit) break;
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* unreadable ledger is non-fatal */
    }
    return out;
  }
}

export function hashDir(dir: string): string {
  if (!fs.existsSync(dir)) return "gone";
  let h = crypto.createHash("sha256");
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) h = h.update(f).update(fs.readFileSync(p).subarray(0, 4096));
  }
  return h.digest("hex").slice(0, 12);
}
