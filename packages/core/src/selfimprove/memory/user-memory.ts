/**
 * Human-owned memory files: `<familiar home>/MEMORY.md` (all sessions) and
 * `<cwd>/.familiar/MEMORY.md` (that project only). Unlike the JSON memory
 * store these are never written by the agent — the user owns them, so they
 * can be edited in any editor or via Settings → Memory without approval
 * staging or CAS bookkeeping.
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../../logger.js";

export const USER_MEMORY_FILENAME = "MEMORY.md";
/** Default injection cap; the files themselves may be larger. */
export const USER_MEMORY_MAX_PROMPT_CHARS = 8000;
/** Hard cap for a file written through the RPC (64 KiB). */
export const USER_MEMORY_MAX_FILE_BYTES = 64 * 1024;

export interface UserMemoryPaths {
  global: string;
  project: string;
}

export function userMemoryPaths(homeDir: string, cwd: string): UserMemoryPaths {
  return {
    global: path.join(homeDir, USER_MEMORY_FILENAME),
    project: path.join(cwd, ".familiar", USER_MEMORY_FILENAME),
  };
}

/** Read a user memory file; missing/unreadable files are simply empty. */
export function readUserMemoryFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return "";
  }
}

/** Atomically replace the global user memory file (0600, tmp + rename). */
export function writeUserMemoryFile(homeDir: string, content: string): string {
  const file = path.join(homeDir, USER_MEMORY_FILENAME);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > USER_MEMORY_MAX_FILE_BYTES) {
    throw new Error(`MEMORY.md exceeds ${USER_MEMORY_MAX_FILE_BYTES} bytes`);
  }
  fs.mkdirSync(homeDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Build the prompt section injected on every step of every turn.
 * The full text is included (no relevance ranking) up to `capChars`; the
 * project layer comes last so it wins when the two disagree.
 */
export function userMemorySection(
  homeDir: string,
  cwd: string,
  capChars = USER_MEMORY_MAX_PROMPT_CHARS,
): { text: string; truncated: boolean } {
  const { global, project } = userMemoryPaths(homeDir, cwd);
  const layers: { label: string; content: string }[] = [];
  for (const [label, file] of [["User memory", global], ["Project user memory", project]] as const) {
    const content = readUserMemoryFile(file).trim();
    if (content !== "") layers.push({ label, content });
  }
  if (layers.length === 0) return { text: "", truncated: false };

  const cap = Math.max(500, capChars);
  const full = layers
    .map((layer) => `# ${layer.label}\n${layer.content}`)
    .join("\n\n");
  let text = full;
  let truncated = false;
  if (full.length > cap) {
    text = full.slice(0, cap);
    truncated = true;
  }
  const header = "# User-provided memory (edit these files directly — the agent does not overwrite them)\n";
  return {
    text: header + text + (truncated ? `\n\n[truncated at ${cap} characters]` : ""),
    truncated,
  };
}
