import type { MemoryEntry } from "@familiar/protocol";
import type { SkillCatalogEntry } from "@familiar/protocol";

/**
 * Build the "# Long-term memory" prompt section.
 * Newest first, capped by total characters; returns how many entries were
 * dropped so the loop can emit a memory.truncation event.
 */
export function memorySection(
  entries: MemoryEntry[],
  capChars: number,
): { text: string; dropped: number } {
  if (entries.length === 0) return { text: "", dropped: 0 };
  const ordered = [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
  const lines: string[] = [];
  let dropped = 0;
  let used = 0;
  for (const e of ordered) {
    const stamp = new Date(e.updatedAt).toISOString().slice(0, 10);
    const tag = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
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
