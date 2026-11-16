import type { MemoryEntry } from "@familiar/protocol";
import type { SkillCatalogEntry } from "@familiar/protocol";

export interface MemorySectionOptions {
  /** the current instruction — used to rank entries by relevance */
  query?: string;
  /** "relevance" (default) ranks by the query; "recent" is newest-first */
  ranking?: "relevance" | "recent";
}

/** Tokens for relevance scoring: latin words + CJK bigrams (substring match). */
function memoryTokens(text: string): Set<string> {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) {
    if (m[0].length >= 2) out.add(m[0]);
  }
  for (const run of lower.match(/[\u3040-\u30ff\u3400-\u9fff]+/g) ?? []) {
    if (run.length <= 2) out.add(run);
    else for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** How well an entry matches the query (keyword overlap). */
function relevanceScore(entry: MemoryEntry, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const tags = Array.isArray(entry.tags) ? entry.tags.join(" ") : "";
  const hay = `${entry.content} ${tags}`.toLowerCase();
  let score = 0;
  for (const tok of queryTokens) if (hay.includes(tok)) score += 1;
  return score;
}

/**
 * Build the "# Long-term memory" prompt section.
 * Entries are ranked (relevance to the instruction first, then newest) and
 * capped by total characters; returns how many were dropped so the loop can
 * emit a memory.truncation event.
 */
export function memorySection(
  entries: MemoryEntry[],
  capChars: number,
  opts: MemorySectionOptions = {},
): { text: string; dropped: number } {
  if (entries.length === 0) return { text: "", dropped: 0 };
  const ranking = opts.ranking ?? "relevance";
  const query = (opts.query ?? "").trim();
  const ordered = [...entries];
  if (ranking === "relevance" && query !== "") {
    const queryTokens = memoryTokens(query);
    ordered.sort((a, b) => {
      const diff = relevanceScore(b, queryTokens) - relevanceScore(a, queryTokens);
      return diff !== 0 ? diff : b.updatedAt - a.updatedAt;
    });
  } else {
    ordered.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const lines: string[] = [];
  let dropped = 0;
  let used = 0;
  for (const e of ordered) {
    const stamp = new Date(e.updatedAt).toISOString().slice(0, 10);
    // entries are read from disk and may lack tags (hand-written / legacy) —
    // a throw here would fail the whole turn before the first model call
    const tags = Array.isArray(e.tags) ? e.tags : [];
    const tag = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    const line = `- (${e.id}, ${stamp}${tag}) ${e.content}`;
    if (used + line.length > capChars) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return { text: "", dropped: ordered.length };
  return {
    text: "# Long-term memory\n" + lines.join("\n") + "\nThese are durable facts. Keep them consistent; use memory_manage to correct or extend them.",
    dropped,
  };
}

/** Build the "# Skills" catalog section (name + description only). */
export function skillsSection(catalog: SkillCatalogEntry[]): string {
  if (catalog.length === 0) return "";
  const lines = catalog.map((s) => `- ${s.name}: ${s.description}`);
  return (
    "# Skills\n" +
    lines.join("\n") +
    "\nWhen a task matches a skill, load its full procedure with skill_view before acting."
  );
}
