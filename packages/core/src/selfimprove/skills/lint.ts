/**
 * Skill linter (warnings only — never blocks the write), Hermes-style:
 *  - incident-log-shape: body is dominated by PR / issue references
 *  - oversized-body:     SKILL.md body > ~24k chars
 *  - references-sprawl:  references/ holds > 60 files
 * Principle: "lessons, not logs" — generalizable rules + one-sentence why.
 */
export function lintSkillBody(args: { body: string; refFileCount?: number }): string[] {
  const warnings: string[] = [];
  if (args.body.length > 24_000) {
    warnings.push("oversized-body: SKILL.md body exceeds ~24k chars — consider splitting");
  }
  const refs = countRefPatterns(args.body);
  if (refs >= 5) {
    warnings.push(
      `incident-log-shape: ${refs} PR/issue references — write lessons, not logs (drop PR numbers/quotes)`,
    );
  }
  if (args.refFileCount !== undefined && args.refFileCount > 60) {
    warnings.push(`references-sprawl: ${args.refFileCount} files in references/ (>60)`);
  }
  return warnings;
}

function countRefPatterns(body: string): number {
  const patterns = [
    /#\d{2,}/g, // issue/PR numbers like #123
    /\b(pull|pr)\s*#?\d{2,}/gi,
    /\b(published|deployed|shipped)\s+\d{4}-\d{2}-\d{2}/gi, // log-style dates
    /\bcommit\s+[0-9a-f]{7,}\b/gi,
  ];
  let n = 0;
  for (const p of patterns) {
    const m = body.match(p);
    n += m ? m.length : 0;
  }
  return n;
}
