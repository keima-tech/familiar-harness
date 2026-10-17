import fs from "node:fs";
import path from "node:path";
import type { SkillCatalogEntry } from "@familiar/protocol";
import { log } from "../../logger.js";
import { ensureDir, familiarPaths } from "../../paths.js";
import type { ProviderRegistry } from "../../providers/index.js";
import type { ResolvedConfig } from "../../config.js";
import type { SelfImproveContext } from "../context.js";
import { extractJsonObject } from "../review/prompt.js";
import { CuratorLedger, hashDir } from "./ledger.js";
import { SkillSnapshots } from "./snapshot.js";

/**
 * Curator (spec 04 §5): background skill gardening.
 *  - Phase 1 (deterministic, always on): stale marking and archival based on
 *    last-used time. Never deletes; archives to `.archive/` after a snapshot.
 *  - Phase 2 (opt-in via `curator.consolidate`): one aux call reviewing the
 *    skill set; every proposal is STAGED in the pending-skills store so the
 *    normal write_approval flow applies.
 */
export interface CuratorStatus {
  enabled: boolean;
  paused: boolean;
  consolidate: boolean;
  lastRunAt?: number;
  nextDueAt?: number;
  stale: string[];
  archived: string[];
  snapshots: number;
}

export interface CuratorPhase1Result {
  staled: string[];
  archived: string[];
  unstaled: string[];
  snapshotId?: string;
  dryRun: boolean;
}

export interface ConsolidationOutcome {
  proposals: {
    kind: "create" | "patch" | "remove";
    name: string;
    reason: string;
  }[];
  staged: number;
  provider: string;
  skipped: boolean;
  note?: string;
}

const DAY = 86_400_000;

export class CuratorRunner {
  readonly ledger: CuratorLedger;
  readonly snapshots: SkillSnapshots;
  private readonly home: string;

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly providers: ProviderRegistry,
    private readonly si: SelfImproveContext,
  ) {
    this.home = cfg.homeDir || familiarPaths.home();
    this.ledger = new CuratorLedger(this.home);
    // skills root = <home>/skills (dirOf("") joins to <home>/skills)
    this.snapshots = new SkillSnapshots(path.join(this.home, "skills"), this.home);
  }

  // ---------------------------------------------------------------------------
  // state (pause / last run)
  // ---------------------------------------------------------------------------

  private get stateFile(): string {
    return path.join(this.home, "curator", "state.json");
  }

  readState(): { lastRunAt?: number; paused?: boolean } {
    if (!fs.existsSync(this.stateFile)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as {
        lastRunAt?: number;
        paused?: boolean;
      };
      return { lastRunAt: raw.lastRunAt, paused: raw.paused === true };
    } catch {
      return {};
    }
  }

  private writeState(patch: { lastRunAt?: number; paused?: boolean }): void {
    ensureDir(path.dirname(this.stateFile));
    const cur = fs.existsSync(this.stateFile)
      ? (JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Record<string, unknown>)
      : {};
    fs.writeFileSync(this.stateFile, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`);
  }

  pause(): void {
    this.writeState({ paused: true });
    this.ledger.append({ actor: "user", action: "pause", detail: "curator paused" });
  }

  resume(): void {
    this.writeState({ paused: false });
    this.ledger.append({ actor: "user", action: "resume", detail: "curator resumed" });
  }

  status(): CuratorStatus {
    const state = this.readState();
    const cfg = this.cfg.curator;
    const usage = this.si.skills.readUsage();
    const stale = Object.entries(usage)
      .filter(([, u]) => u.staleAt !== undefined)
      .map(([name]) => name)
      .sort();
    return {
      enabled: cfg.enabled !== false,
      paused: state.paused === true,
      consolidate: cfg.consolidate === true,
      lastRunAt: state.lastRunAt,
      nextDueAt:
        state.lastRunAt !== undefined
          ? state.lastRunAt + (cfg.interval_hours ?? 168) * 3_600_000
          : undefined,
      stale,
      archived: this.si.skills.listArchived(),
      snapshots: this.snapshots.list().length,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1 — deterministic lifecycles
  // ---------------------------------------------------------------------------

  runPhase1(opts: { dryRun?: boolean; observation?: boolean } = {}): CuratorPhase1Result {
    const cfgC = this.cfg.curator;
    const staleAfter = (cfgC.stale_after_days ?? 14) * DAY;
    const archiveAfter = (cfgC.archive_after_days ?? 30) * DAY;
    const now = Date.now();

    const usage = this.si.skills.readUsage();
    const catalog: SkillCatalogEntry[] = this.si.skills.list();
    const result: CuratorPhase1Result = {
      staled: [],
      archived: [],
      unstaled: [],
      dryRun: opts.dryRun === true,
    };

    const snapshot = opts.dryRun !== true ? this.snapshots.create("curator phase-1") : undefined;
    result.snapshotId = snapshot?.id;

    for (const entry of catalog) {
      const u = usage[entry.name];
      if (u?.pinned === true) continue;

      const created = u?.createdMs ?? entry.createdAt ?? now;
      const reference = u?.lastUsedMs ?? created;
      const idle = now - reference;
      const age = now - created;
      const neverUsed = (u?.useCount ?? 0) === 0;

      if (neverUsed && age < staleAfter) continue; // too fresh to be judged

      if (idle >= archiveAfter) {
        if (opts.dryRun === true) {
          result.archived.push(entry.name);
          continue;
        }
        const before = hashDir(this.si.skills.dirOf(entry.name));
        const ok = this.si.skills.archive(entry.name);
        if (ok) {
          this.ledger.append({
            actor: "curator",
            action: "archive",
            skill: entry.name,
            beforeHash: before,
            detail: `unused for ${Math.round(idle / DAY)}d (>= archive_after_days ${cfgC.archive_after_days ?? 30})`,
          });
          result.archived.push(entry.name);
        }
        continue;
      }

      if (idle >= staleAfter && u?.staleAt === undefined) {
        if (opts.dryRun === true) {
          result.staled.push(entry.name);
          continue;
        }
        this.si.skills.markStale(entry.name);
        this.ledger.append({
          actor: "curator",
          action: "stale",
          skill: entry.name,
          afterHash: hashDir(this.si.skills.dirOf(entry.name)),
          detail: `unused for ${Math.round(idle / DAY)}d (>= stale_after_days ${cfgC.stale_after_days ?? 14})`,
        });
        result.staled.push(entry.name);
        continue;
      }

      // idle back below the stale threshold → revive (stale → active)
      if (u?.staleAt !== undefined && idle < staleAfter) {
        if (opts.dryRun === true) {
          result.unstaled.push(entry.name);
          continue;
        }
        this.si.skills.clearStale(entry.name);
        this.ledger.append({
          actor: "curator",
          action: "unstale",
          skill: entry.name,
          detail: "used again — back to active",
        });
        result.unstaled.push(entry.name);
      }
    }

    if (opts.dryRun !== true || opts.observation === true) {
      // observation: record the start point but act on nothing (first run).
      this.writeState({ lastRunAt: now });
      if (result.staled.length + result.archived.length > 0) {
        log.info(
          `curator phase-1: staled ${result.staled.length}, archived ${result.archived.length}`,
        );
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — opt-in LLM consolidation (writes staged through write_approval)
  // ---------------------------------------------------------------------------

  async runConsolidation(opts: { dryRun?: boolean } = {}): Promise<ConsolidationOutcome> {
    const slot = this.cfg.auxiliary?.["curator"];
    const providerId = slot?.provider ?? this.cfg.default_provider;
    const model = slot?.model ?? this.cfg.default_model;
    const outcome: ConsolidationOutcome = {
      proposals: [],
      staged: 0,
      provider: providerId,
      skipped: false,
    };

    const catalog = this.si.skills.list();
    if (catalog.length === 0) {
      outcome.note = "no skills to consolidate";
      outcome.skipped = true;
      return outcome;
    }

    let text: string;
    try {
      // Prefer stale / low-use entries; cap bodies so one sweep stays bounded.
      const ranked = [...catalog].sort(
        (a, b) => a.useCount - b.useCount || (a.name < b.name ? -1 : 1),
      );
      const candidates = ranked.slice(0, 10);
      const sections = candidates.map((s) => {
        const full = this.si.skills.get(s.name);
        return `## ${s.name} (used ${s.useCount}x)\n${s.description}\n---\n${full ? full.body.slice(0, 4000) : ""}`;
      });
      const prompt =
        "# Skill consolidation request (familiar)\n" +
        'You are the curator. Review these skills and propose consolidation. Output a single JSON object, nothing else:\n{"proposals":[\n' +
        '  {"kind":"umbrella","targets":["a","b"],"name":"new-kebab-name","description":"...","body":"<merged SKILL.md body>"},\n' +
        '  {"kind":"patch","target":"a","body":"<corrected body>","reason":"..."},\n' +
        '  {"kind":"absorb","target":"c","into":"d","reason":"c duplicates d"}]}\n' +
        "Rules:\n" +
        "- Prefer keeping skills; only merge when they cover the same procedure.\n" +
        '- Max 3 proposals. Silence is fine: {"proposals":[]}\n' +
        "- umbrella creates ONE new skill from several; the absorbed ones will be archived on approval (absorbed_into is recorded).\n\n" +
        sections.join("\n\n");

      const parts: string[] = [];
      await this.providers
        .get(providerId)
        .chat(
          {
            model: model ?? "",
            messages: [
              { id: `curator-${Date.now()}`, role: "user", content: prompt, createdAt: Date.now() },
            ],
            tools: [],
            signal: AbortSignal.timeout(60_000),
          },
          (chunk) => {
            if (chunk.type === "text") parts.push(chunk.text);
          },
        );
      text = parts.join("");
    } catch (err) {
      outcome.note = `consolidation skipped: ${err instanceof Error ? err.message : String(err)}`;
      outcome.skipped = true;
      return outcome;
    }

    const parsed = extractJsonObject(text);
    const proposals =
      parsed && typeof parsed === "object"
        ? ((parsed as { proposals?: unknown })["proposals"] as unknown[] | undefined)
        : undefined;
    if (!Array.isArray(proposals)) {
      outcome.note = "consolidation: no parseable proposals";
      outcome.skipped = true;
      return outcome;
    }

    if (opts.dryRun === true) {
      for (const raw of proposals.slice(0, 3)) {
        const p = (raw ?? {}) as Record<string, unknown>;
        outcome.proposals.push({
          kind: strKind(p["kind"]),
          name: typeof p["name"] === "string" ? p["name"] : String(p["target"] ?? "?"),
          reason: typeof p["reason"] === "string" ? p["reason"] : "",
        });
      }
      return outcome;
    }

    // Snapshot before staging anything.
    this.snapshots.create("curator consolidation");
    for (const raw of proposals.slice(0, 3)) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const reasonPrefix = "curator consolidation";
      const reason = typeof p["reason"] === "string" ? `${reasonPrefix}: ${p["reason"]}` : reasonPrefix;
      try {
        if (p["kind"] === "umbrella") {
          const name = slugOf(p["name"]);
          const targets = Array.isArray(p["targets"])
            ? (p["targets"] as unknown[]).map((t) => String(t))
            : [];
          if (!name || typeof p["body"] !== "string") continue;
          const desc = `${String(p["description"] ?? "")} (absorbs: ${targets.join(", ")})`;
          const staged = this.si.pendingSkills.stage({
            name,
            kind: "create",
            description: desc,
            body: p["body"],
            reason,
          });
          this.ledger.append({
            actor: "curator",
            action: "stage-umbrella",
            skill: name,
            detail: `proposal over [${targets.join(", ")}] → pending #${staged.id}`,
          });
          outcome.proposals.push({ kind: "create", name, reason });
          outcome.staged += 1;
        } else if (p["kind"] === "patch") {
          const target = slugOf(p["target"]);
          const existing = target ? this.si.skills.get(target) : undefined;
          if (!existing || typeof p["body"] !== "string") continue;
          const staged = this.si.pendingSkills.stage({
            name: existing.name,
            kind: "patch",
            description: existing.description,
            body: p["body"],
            snapshotBodyHash: this.si.skills.bodyHash(existing.name),
            reason,
          });
          this.ledger.append({
            actor: "curator",
            action: "stage-patch",
            skill: existing.name,
            detail: `pending #${staged.id}`,
          });
          outcome.proposals.push({ kind: "patch", name: existing.name, reason });
          outcome.staged += 1;
        } else if (p["kind"] === "absorb") {
          const target = slugOf(p["target"]);
          const into = typeof p["into"] === "string" ? p["into"] : "";
          const existing = target ? this.si.skills.get(target) : undefined;
          if (!existing) continue;
          const staged = this.si.pendingSkills.stage({
            name: existing.name,
            kind: "remove",
            snapshotBodyHash: this.si.skills.bodyHash(existing.name),
            reason: `absorbed_into=${into || "sibling"}; ${reason}`,
          });
          this.ledger.append({
            actor: "curator",
            action: "stage-absorb",
            skill: existing.name,
            detail: `absorbed_into=${into} pending #${staged.id}`,
          });
          outcome.proposals.push({ kind: "remove", name: existing.name, reason });
          outcome.staged += 1;
        }
      } catch (err) {
        log.debug(`curator proposal failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return outcome;
  }

  // ---------------------------------------------------------------------------
  // manual operations
  // ---------------------------------------------------------------------------

  pin(name: string, pinned: boolean): { ok: boolean; message: string } {
    if (this.si.skills.get(name) === undefined) {
      return { ok: false, message: `skill not found: ${name}` };
    }
    this.si.skills.setPinned(name, pinned);
    this.ledger.append({ actor: "user", action: pinned ? "pin" : "unpin", skill: name });
    return { ok: true, message: `${pinned ? "pinned" : "unpinned"} ${name}` };
  }

  restore(name: string): { ok: boolean; message: string } {
    const archiveDir = path.join(this.si.skills.dirOf(name), "..", ".archive", name);
    if (!fs.existsSync(archiveDir)) return { ok: false, message: `not archived: ${name}` };
    let target = this.si.skills.dirOf(name);
    let i = 1;
    while (fs.existsSync(target)) {
      target = `${this.si.skills.dirOf(name)}-${i}`;
      i += 1;
    }
    fs.renameSync(archiveDir, target);
    this.si.skills.clearStale(name);
    this.ledger.append({ actor: "user", action: "restore", skill: name });
    return { ok: true, message: `restored ${name}` };
  }

  backup(reason = "manual backup"): string | undefined {
    const rec = this.snapshots.create(reason);
    if (rec) {
      this.ledger.append({ actor: "user", action: "backup", detail: rec.id });
    }
    return rec?.id;
  }

  rollback(prefix: string): { ok: boolean; message: string } {
    const res = this.snapshots.restore(prefix);
    if (res.restored === undefined) return { ok: false, message: res.message };
    this.ledger.append({ actor: "user", action: "rollback", detail: res.restored });
    return { ok: true, message: `rolled back to ${res.restored}` };
  }

  pruneSnapshots(days: number): number {
    const n = this.snapshots.prune(days);
    if (n > 0) {
      this.ledger.append({
        actor: "user",
        action: "prune",
        detail: `${n} snapshots older than ${days}d`,
      });
    }
    return n;
  }
}

function strKind(v: unknown): "create" | "patch" | "remove" {
  return v === "patch" ? "patch" : v === "absorb" ? "remove" : "create";
}

function slugOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const slug = v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return /^[a-z][a-z0-9-]*$/.test(slug) ? slug : undefined;
}
