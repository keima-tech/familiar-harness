import type { ResolvedConfig } from "../../config.js";
import type { ProviderRegistry } from "../../providers/index.js";
import { log } from "../../logger.js";
import { extractJsonObject, buildReviewPrompt } from "./prompt.js";
import type { SelfImproveContext } from "../context.js";
import { approveStagedMemory } from "../memory/approval.js";
import { approveStagedSkill } from "../skills/approval.js";
import { slugifyName } from "../skills/store.js";

export interface ReviewInputs {
  sessionId: string;
  provider: string;
  model?: string;
  transcript: string;
  /** called once with counts when staging finished (best-effort event sink) */
  onStaged?: (memoryCount: number, skillCount: number) => void;
}

export interface ReviewOutcome {
  memoryCount: number;
  skillCount: number;
  skipped: boolean;
  notes: string[];
}

const REVIEW_TIMEOUT_MS = 60_000;

/**
 * Background self-review (spec 04 §3):
 * run right after a turn completes, in a tool-less one-shot chat.
 * Everything it produces is STAGED — never applied directly.
 * Any failure is swallowed (the main conversation must never break).
 */
export async function postTurnReview(
  cfg: ResolvedConfig,
  providers: ProviderRegistry,
  si: SelfImproveContext,
  inputs: ReviewInputs,
): Promise<ReviewOutcome> {
  const disabled = { memoryCount: 0, skillCount: 0, skipped: true, notes: [] as string[] };
  if (cfg.self_review?.enabled === false) return disabled;

  // Resolve the reviewer model: auxiliary.reviewer slot, else the main chat model.
  const slot = cfg.auxiliary?.["reviewer"];
  const providerId = slot?.provider ?? inputs.provider;
  const model = slot?.model ?? inputs.model;
  if (!cfg.providers[providerId]) {
    log.debug(`self-review skipped: provider ${providerId} not configured`);
    return disabled;
  }

  // Reviewer context: transcript + both catalogs
  const prompt = buildReviewPrompt({
    transcript: inputs.transcript.slice(0, 10_000),
    memories: si.memories.list(),
    skills: si.skills.list(),
  });

  let text: string | undefined;
  try {
    const provider = providers.getPrimary(providerId);
    const parts: string[] = [];
    const result = await Promise.race([
      provider.chat(
        {
          model: model ?? "",
          messages: [{ id: "review", role: "user", content: prompt, createdAt: Date.now() }],
          tools: [],
          signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
        },
        (chunk) => {
          if (chunk.type === "text") parts.push(chunk.text);
        },
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("review timeout")), REVIEW_TIMEOUT_MS).unref(),
      ),
    ]);
    void result;
    text = parts.join("");
  } catch (err) {
    log.debug(`self-review skipped: ${err instanceof Error ? err.message : String(err)}`);
    return disabled;
  }

  const parsed = extractJsonObject(text ?? "");
  if (!parsed || typeof parsed !== "object") {
    log.debug("self-review: no JSON proposals parsed — skipped");
    return disabled;
  }
  const proposals = (parsed as { proposals?: unknown[] })["proposals"];
  if (!Array.isArray(proposals)) {
    log.debug("self-review: proposals field missing — skipped");
    return disabled;
  }

  let memoryCount = 0;
  let skillCount = 0;
  const notes: string[] = [];

  for (const raw of proposals.slice(0, 3)) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const kind = typeof p["kind"] === "string" ? p["kind"] : "";
    const reason = typeof p["reason"] === "string" ? p["reason"] : undefined;
    const by = `review of session ${inputs.sessionId.slice(0, 8)}`;
    try {
      switch (kind) {
        case "memory.create": {
          const content = str(p["content"]);
          if (!content) break;
          const staged = si.pendingMemories.stage({
            kind: "create",
            namespace: "default",
            content,
            tags: strArray(p["tags"]).slice(0, 3),
            reason: reason ? `${by}: ${reason}` : by,
          });
          memoryCount += 1;
          notes.push(`memory staged #${staged.id}`);
          break;
        }
        case "memory.patch": {
          const target = str(p["target"]);
          const content = str(p["content"]);
          const targetEntry = target !== "" ? si.memories.findPrefix(target) : undefined;
          if (!targetEntry || !content) break;
          const staged = si.pendingMemories.stage({
            kind: "patch",
            target: targetEntry.id,
            namespace: targetEntry.namespace,
            content,
            tags: targetEntry.tags,
            snapshotUpdatedAt: targetEntry.updatedAt,
            reason: reason ? `${by}: ${reason}` : by,
          });
          memoryCount += 1;
          notes.push(`memory patch staged #${staged.id}`);
          break;
        }
        case "memory.remove": {
          const target = str(p["target"]);
          const targetEntry = target !== "" ? si.memories.findPrefix(target) : undefined;
          if (!targetEntry) break;
          const staged = si.pendingMemories.stage({
            kind: "remove",
            target: targetEntry.id,
            namespace: targetEntry.namespace,
            snapshotUpdatedAt: targetEntry.updatedAt,
            reason: reason ? `${by}: ${reason}` : by,
          });
          memoryCount += 1;
          notes.push(`memory remove staged #${staged.id}`);
          break;
        }
        case "skill.create": {
          const name = slugifyName(str(p["name"]) ?? "");
          const description = str(p["description"]);
          const body = str(p["body"]);
          if (!name || !description || !body || si.skills.get(name)) break;
          const staged = si.pendingSkills.stage({
            name,
            kind: "create",
            description,
            body,
            reason: reason ? `${by}: ${reason}` : by,
            warnings: [],
          });
          skillCount += 1;
          notes.push(`skill staged #${staged.id}`);
          break;
        }
        case "skill.patch": {
          const target = str(p["target"]);
          const body = str(p["body"]);
          const name = slugifyName(target);
          const existing = name !== undefined ? si.skills.get(name) : undefined;
          if (!existing || !body) break;
          const staged = si.pendingSkills.stage({
            name: existing.name,
            kind: "patch",
            description: existing.description,
            body,
            snapshotBodyHash: si.skills.bodyHash(existing.name),
            reason: reason ? `${by}: ${reason}` : by,
            warnings: [],
          });
          skillCount += 1;
          notes.push(`skill patch staged #${staged.id}`);
          break;
        }
        default:
          break; // unknown kind — ignored
      }
    } catch (err) {
      log.debug(`self-review proposal failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Auto-approval mode: when the user turned the gate off, apply and report.
  const memApproval = si.settings.get("memory_write_approval") ?? cfg.memory.write_approval !== false;
  const skillApproval = si.settings.get("skills_write_approval") ?? cfg.skills.write_approval !== false;
  if (!memApproval) {
    for (const item of si.pendingMemories.list()) {
      const res = approveStagedMemory(si.pendingMemories, si.memories, item.id);
      if (res.approved) notes.push(`memory auto-applied: ${res.message}`);
    }
    memoryCount = 0; // nothing left pending
  }
  if (!skillApproval) {
    for (const item of si.pendingSkills.list()) {
      const res = approveStagedSkill(si.pendingSkills, si.skills, item.id);
      if (res.approved) notes.push(`skill auto-applied: ${res.message}`);
    }
    skillCount = 0;
  }

  if (memoryCount + skillCount > 0) {
    inputs.onStaged?.(memoryCount, skillCount);
  }
  return { memoryCount, skillCount, skipped: false, notes };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === "string");
}
