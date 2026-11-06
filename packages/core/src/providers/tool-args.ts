/**
 * Tool-call argument hygiene.
 *
 * Providers stream tool arguments as text fragments; a length limit, a dropped
 * SSE chunk or a proxy can truncate them, leaving an unterminated JSON string.
 * If that string is persisted it poisons the session — every later request
 * that replays the transcript is rejected (OpenAI-compatible servers answer
 * HTTP 400 "arguments ... is not valid JSON").
 *
 * `repairToolArguments` returns the input when it parses, closes an unbalanced
 * document when it can, and otherwise "{}" so the tool reports missing
 * arguments instead of breaking the conversation forever.
 */

/** Close an unterminated JSON document (string/bracket aware). */
export function closeTruncatedJson(text: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return undefined; // mismatched — not recoverable
    }
  }
  let out = text;
  if (escaped) out += "\\"; // a trailing backslash would escape our closing quote
  if (inString) out += '"';
  out = out.replace(/[,:]\s*$/, ""); // a dangling separator is not valid JSON
  while (stack.length > 0) out += stack.pop();
  return out;
}

/** `raw` when it is valid JSON, else a repaired or emptied variant. */
export function repairToolArguments(raw: string): string {
  const text = (raw ?? "").trim();
  if (text === "") return "{}";
  try {
    JSON.parse(text);
    return text;
  } catch {
    /* try to repair below */
  }
  const repaired = closeTruncatedJson(text);
  if (repaired !== undefined) {
    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      /* still broken */
    }
  }
  return "{}";
}
