import fs from "node:fs";
import { unifiedDiff } from "./diff.js";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./registry.js";
import type { ToolContext, ToolOutput } from "./registry.js";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
]);

const READ_SIZE_CAP = 256 * 1024;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveInCwd(argsPath: string, ctx: ToolContext): string {
  return path.isAbsolute(argsPath) ? path.normalize(argsPath) : path.resolve(ctx.cwd, argsPath);
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 1024));
  return head.includes(0);
}

/** Iterative file walker skipping build/vendor/hidden directories. */
export async function* walkFiles(
  root: string,
  extraSkip?: string,
): AsyncGenerator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable/unmountable
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith(".") || SKIP_DIR_NAMES.has(ent.name) || ent.name === extraSkip) {
          continue;
        }
        stack.push(full);
      } else if (ent.isFile()) {
        yield full;
      }
    }
  }
}

/** Mini-glob → RegExp (*, **, ?, [class]; '/' = separator on every OS). */
export function globToRegExp(pattern: string): RegExp {
  const out: string[] = ["^"];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === undefined) break;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out.push("(?:.*/)?");
          i += 3;
          continue;
        }
        out.push(".*");
        i += 2;
        continue;
      }
      out.push("[^/]*");
    } else if (c === "?") {
      out.push("[^/]");
    } else if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) out.push("\\[");
      else {
        out.push(pattern.slice(i, close + 1));
        i = close;
      }
    } else {
      out.push(c.replace(/[.+^${}()|\\]/g, "\\$&"));
    }
    i += 1;
  }
  out.push("$");
  return new RegExp(out.join(""));
}

export function relativePosix(root: string, full: string): string {
  const rel = path.relative(root, full);
  return rel.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export function createReadTool(): Tool {
  return {
    name: "read",
    description:
      "Read a text file from disk. Returns numbered lines. Use offset/limit for large files; binary files are rejected.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute, or relative to working directory)" },
        offset: { type: "number", description: "1-based line number to start from" },
        limit: { type: "number", description: "Maximum number of lines to return (default 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const argPath = typeof args.path === "string" ? args.path : "";
      if (!argPath) return { content: "argument 'path' is required", isError: true };
      const absolute = resolveInCwd(argPath, ctx);

      try {
        const buf = await fsp.readFile(absolute);
        if (isBinary(buf)) {
          return { content: `{binary file, not shown: ${absolute}}`, isError: true };
        }
        const all = buf.toString("utf8").split("\n");
        if (all.length > 0 && all[all.length - 1] === "") all.pop();
        const offset = Math.max(1, Number.isFinite(args.offset) ? Number(args.offset) : 1);
        const limit = Math.min(
          10_000,
          Math.max(1, Number.isFinite(args.limit) ? Number(args.limit) : 2000),
        );
        const slice = all.slice(offset - 1, offset - 1 + limit);
        if (slice.length === 0) {
          return { content: `(empty or offset beyond EOF: ${absolute})`, isError: false };
        }
        let out = "";
        for (let i = 0; i < slice.length; i++) {
          const lineNo = offset + i;
          const line = slice[i] ?? "";
          out += `${lineNo}\t${line.length > 2000 ? line.slice(0, 2000) + "…" : line}\n`;
        }
        if (buf.length > READ_SIZE_CAP) {
          out += `\n(file truncated at ~${Math.floor(READ_SIZE_CAP / 1024)}KB)\n`;
        }
        return { content: out, isError: false };
      } catch (err) {
        return { content: `cannot read ${absolute}: ${describeErr(err)}`, isError: true };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// write / edit
// ---------------------------------------------------------------------------

function pathApprovalSummary(absolute: string): string {
  return `write file: ${absolute}`;
}

export function createWriteTool(): Tool {
  return {
    name: "write",
    description:
      "Create or overwrite a file with the full content. Parent directories are created automatically. Only use for new files or full rewrites; prefer edit for modifications.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target file path (absolute or relative to cwd)" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const argPath = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!argPath) return { content: "argument 'path' is required", isError: true };
      const absolute = resolveInCwd(argPath, ctx);
      if (!ctx.yolo && !isInside(ctx.cwd, absolute)) {
        const approved = await ctx.approval.request({
          tool: "write",
          summary: pathApprovalSummary(absolute),
        });
        if (!approved) return { content: "[denied by user]", isError: true };
      }
      try {
        await fsp.mkdir(path.dirname(absolute), { recursive: true });
        let before = "";
        try {
          const prev = await fsp.readFile(absolute);
          if (!isBinary(prev)) before = prev.toString("utf8");
        } catch {
          /* new file */
        }
        await fsp.writeFile(absolute, content, "utf8");
        const diff = isBinary(Buffer.from(content, "utf8")) ? "" : unifiedDiff(before, content);
        return {
          content: `wrote ${absolute} (${Buffer.byteLength(content, "utf8")} bytes)`,
          isError: false,
          ...(diff ? { diff } : {}),
        };
      } catch (err) {
        return { content: `cannot write ${absolute}: ${describeErr(err)}`, isError: true };
      }
    },
  };
}

export function createEditTool(): Tool {
  return {
    name: "edit",
    description:
      "Replace an exact text occurrence in a file. old_string must match once, or set replace_all=true. Read the file first to build enough surrounding context for uniqueness.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target file path" },
        old_string: { type: "string", description: "Exact text to find (must be unique unless replace_all)" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const argPath = typeof args.path === "string" ? args.path : "";
      const oldString = typeof args.old_string === "string" ? args.old_string : "";
      const newString = typeof args.new_string === "string" ? args.new_string : "";
      const replaceAll = args.replace_all === true;
      if (!argPath || oldString === "") {
        return { content: "arguments 'path' and 'old_string' (non-empty) are required", isError: true };
      }
      if (oldString === newString) {
        return { content: "old_string and new_string are identical", isError: true };
      }
      const absolute = resolveInCwd(argPath, ctx);
      if (!ctx.yolo && !isInside(ctx.cwd, absolute)) {
        const approved = await ctx.approval.request({
          tool: "edit",
          summary: `edit file: ${absolute}`,
        });
        if (!approved) return { content: "[denied by user]", isError: true };
      }
      try {
        const buf = await fsp.readFile(absolute);
        if (isBinary(buf)) return { content: `{binary file, refused: ${absolute}}`, isError: true };
        const text = buf.toString("utf8");
        let count = 0;
        let idx = text.indexOf(oldString);
        while (idx !== -1) {
          count += 1;
          idx = text.indexOf(oldString, idx + Math.max(1, oldString.length));
        }
        if (count === 0) {
          return {
            content:
              `old_string not found in ${argPath}. Re-read the file and use enough unique context. ` +
              "Watch for invisible whitespace differences.",
            isError: true,
          };
        }
        if (count > 1 && !replaceAll) {
          return {
            content:
              `old_string matches ${count} locations in ${argPath}. ` +
              "Extend it with surrounding lines to make it unique, or use replace_all=true.",
            isError: true,
          };
        }
        const updated = replaceAll
          ? text.split(oldString).join(newString)
          : text.replace(oldString, newString);
        await fsp.writeFile(absolute, updated, "utf8");
        return {
          content: `edited ${absolute} (${count} replacement${count === 1 ? "" : "s"})`,
          isError: false,
          diff: unifiedDiff(text, updated),
        };
      } catch (err) {
        return { content: `cannot edit ${absolute}: ${describeErr(err)}`, isError: true };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// glob / grep
// ---------------------------------------------------------------------------

export function createGlobTool(): Tool {
  return {
    name: "glob",
    description:
      "List files matching a glob pattern (**, *, ?, [class]). Skips node_modules/.git/dist and hidden directories. Results sorted by modification time, newest first.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts'" },
        path: { type: "string", description: "Directory to search (default: working directory)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      if (!pattern) return { content: "argument 'pattern' is required", isError: true };
      const rootDir =
        typeof args.path === "string" && args.path !== ""
          ? resolveInCwd(args.path, ctx)
          : ctx.cwd;

      const re = globToRegExp(pattern);
      const hits: { rel: string; full: string; mtime: number }[] = [];
      try {
        for await (const full of walkFiles(rootDir)) {
          const rel = relativePosix(rootDir, full);
          if (!re.test(rel)) continue;
          let mtime = 0;
          try {
            if (fs.existsSync(full)) mtime = fs.statSync(full).mtimeMs;
          } catch {
            /* stat raced away */
          }
          hits.push({ rel, full, mtime });
          if (hits.length >= 2000) break;
        }
      } catch (err) {
        return { content: `glob failed: ${describeErr(err)}`, isError: true };
      }
      hits.sort((a, b) => b.mtime - a.mtime);
      if (hits.length === 0) return { content: "(no matches)", isError: false };
      return {
        content:
          hits.slice(0, 200).map((h) => h.rel).join("\n") +
          (hits.length > 200 ? `\n(+${hits.length - 200} more)` : ""),
        isError: false,
      };
    },
  };
}

export function createGrepTool(): Tool {
  return {
    name: "grep",
    description:
      "Search file contents with a regular expression (JS syntax). Returns 'path:line: match' lines. Skips binaries, node_modules, .git and hidden directories.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression (or literal text when literal=true)" },
        path: { type: "string", description: "Directory or file to search (default: working directory)" },
        include: { type: "string", description: "Filename glob filter, e.g. '*.ts'" },
        case_sensitive: { type: "boolean", description: "Default true" },
        literal: { type: "boolean", description: "Treat pattern as literal text" },
        max_results: { type: "number", description: "Maximum matches (default 100, hard cap 500)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      if (!pattern) return { content: "argument 'pattern' is required", isError: true };
      const maxResults = Math.min(
        500,
        Math.max(1, Number.isFinite(args.max_results) ? Number(args.max_results) : 100),
      );
      let rootDir = ctx.cwd;
      let singleFile: string | undefined;
      if (typeof args.path === "string" && args.path !== "") {
        const p = resolveInCwd(args.path, ctx);
        let st: fs.Stats | null = null;
        try {
          st = await fsp.stat(p);
        } catch {
          st = null;
        }
        if (!st) return { content: `path not found: ${p}`, isError: true };
        if (st.isFile()) singleFile = p;
        else rootDir = p;
      }

      const flags = args.case_sensitive === false ? "gim" : "gm";
      let regex: RegExp;
      try {
        regex = new RegExp(args.literal === true ? escapeRegex(pattern) : pattern, flags);
      } catch (err) {
        return { content: `invalid regex: ${describeErr(err)}`, isError: true };
      }
      const includeRe =
        typeof args.include === "string" && args.include !== ""
          ? globToRegExp(args.include)
          : null;

      const lines: string[] = [];
      const files = singleFile ? [singleFile] : [];
      if (!singleFile) {
        for await (const full of walkFiles(rootDir)) {
          files.push(full);
        }
      }
      for (const full of files) {
        if (lines.length >= maxResults) break;
        if (includeRe && !includeRe.test(path.posix.basename(relativePosix(rootDir, full)))) continue;
        let text: string;
        try {
          const buf = await fsp.readFile(full);
          if (isBinary(buf)) continue;
          text = buf.toString("utf8", 0, Math.min(buf.length, 1024 * 1024));
        } catch {
          continue;
        }
        const rel = relativePosix(ctx.cwd, full) || path.basename(full);
        const srcLines = text.split("\n");
        for (let i = 0; i < srcLines.length && lines.length < maxResults; i++) {
          regex.lastIndex = 0;
          const line = srcLines[i] ?? "";
          if (regex.test(line)) {
            const preview = line.length > 240 ? line.slice(0, 240) + "…" : line;
            lines.push(`${rel}:${i + 1}: ${preview}`);
          }
        }
      }
      if (lines.length === 0) return { content: "(no matches)", isError: false };
      return { content: lines.join("\n"), isError: false };
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeErr(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "file not found";
  if (code === "EACCES") return "permission denied";
  return String(err);
}
