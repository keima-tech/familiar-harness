import type { MemoryEntry, SkillCatalogEntry } from "@familiar/protocol";

/**
 * Prompt for the background self-review agent. Runs OUTSIDE the main loop
 * context (separate model call, tool-less) right after a turn completes.
 */
export function buildReviewPrompt(opts: {
  transcript: string;
  memories: MemoryEntry[];
  skills: SkillCatalogEntry[];
}): string {
  const memoryLines = opts.memories
    .filter((m) => m.namespace !== "")
    .slice(-60)
    .map((m) => `- (${m.id}) ${m.content}`)
    .join("\n");
  const skillLines = opts.skills
    .slice(-40)
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");

  return `You are the background self-review agent of an agent harness. Your ONLY job: decide what durable lessons from the last turn are worth remembering for future turns.

STRICT OUTPUT: a single JSON object, nothing else (no markdown fences, no commentary):
{"proposals": [...]}

Each proposal is one of:
{"kind":"memory.create","content":"<one generalizable fact>","tags":["...","..."],"reason":"<why this is durable>"}
{"kind":"memory.patch","target":"<memory id>","content":"<corrected fact>","reason":"<what was wrong>"}
{"kind":"memory.remove","target":"<memory id>","reason":"<no longer true>"}
{"kind":"skill.create","name":"<kebab-name>","description":"<catalog one-liner>","body":"<full SKILL.md body: when to use / procedure / why it works>"}
{"kind":"skill.patch","target":"<skill name>","body":"<full corrected body>","reason":"<what repeats>"}

Rules:
- Propose NOTHING unless there is a genuine, reusable lesson (user correction, revealed procedure, repeated mistake). Silence is an acceptable output: {"proposals":[]}
- lessons, not logs: generalizable rules, never PR numbers, dates, quotes, or secrets.
- Deduplicate against the catalogs below — patch an existing entry instead of creating a near-duplicate.
- Keep memories under ~300 chars. Skills are for procedures that will recur; bodies are markdown.
- Max 3 proposals total.

# LAST TURN (transcript)
${opts.transcript}

# EXISTING MEMORY CATALOG
${memoryLines || "(empty)"}

# EXISTING SKILL CATALOG
${skillLines || "(empty)"}`;
}

/**
 * Extract the first parseable JSON object from model output that may be
 * wrapped in reasoning prose and/or a code fence (lfm2.5-style: thinking,
 * then ```json ... ```), tolerant of braces inside strings.
 */
export function extractJsonObject(text: string): unknown {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1]);
  candidates.push(text);

  for (const candidate of candidates) {
    // Try every '{' up to a few attempts; accept the first that parses.
    let from = candidate.indexOf("{");
    let attempts = 0;
    while (from !== -1 && attempts < 8) {
      const slice = balancedObject(candidate, from);
      if (slice !== undefined) {
        try {
          return JSON.parse(slice) as unknown;
        } catch {
          /* fall through to the next '{' */
        }
      }
      attempts += 1;
      from = candidate.indexOf("{", from + 1);
    }
  }
  return undefined;
}

/** Slice the first balanced {...} object starting at `start` (string-aware). */
function balancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
