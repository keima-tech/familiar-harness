import fs from "node:fs";
import path from "node:path";

/**
 * User-registered Office templates (~/.familiar/templates/<name>.docx|xlsx|pptx).
 *
 * A template is an ordinary Office file; office_create reads it as the base
 * package so the output keeps its styles, theme, layouts and so on. These
 * helpers only manage the directory (import / list / delete / resolve) — the
 * generation lives in office.ts.
 */

export type OfficeKind = "docx" | "xlsx" | "pptx";

export const OFFICE_KINDS: readonly OfficeKind[] = ["docx", "xlsx", "pptx"];
export const OFFICE_EXT: Record<OfficeKind, string> = {
  docx: ".docx",
  xlsx: ".xlsx",
  pptx: ".pptx",
};
/** .dotx/.xltx/.potx are accepted too — they are the same package. */
const TEMPLATE_EXT: Record<string, OfficeKind> = {
  ".docx": "docx",
  ".dotx": "docx",
  ".xlsx": "xlsx",
  ".xltx": "xlsx",
  ".pptx": "pptx",
  ".potx": "pptx",
};

export interface OfficeTemplate {
  name: string;
  kind: OfficeKind;
  file: string;
  size: number;
}

/** Refuse absurd uploads before they reach the disk (also bounds the RPC body). */
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;

export function templatesDir(home: string): string {
  return path.join(home, "templates");
}

export function officeKindOf(file: string): OfficeKind | undefined {
  return TEMPLATE_EXT[path.extname(file).toLowerCase()];
}

/** Sanitize a display name into a safe file stem (no traversal, no dots). */
export function templateStem(raw: string): string | undefined {
  const base = path.basename(raw).replace(/\.[A-Za-z0-9]+$/, "");
  const slug = base
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 64)
    .trim();
  return slug === "" ? undefined : slug;
}

export function listOfficeTemplates(home: string): OfficeTemplate[] {
  const dir = templatesDir(home);
  if (!fs.existsSync(dir)) return [];
  const out: OfficeTemplate[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const file = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const kind = officeKindOf(entry);
    if (!kind) continue;
    out.push({ name: entry.replace(/\.[A-Za-z0-9]+$/, ""), kind, file, size: stat.size });
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/**
 * Register a template. `source` is either a local file path or the raw bytes
 * (the browser sends bytes; the desktop can hand over a path). Returns the
 * stored template. Throws a human-readable Error on bad input.
 */
export function importOfficeTemplate(
  home: string,
  source: { path?: string; dataBase64?: string; name?: string },
): OfficeTemplate {
  let bytes: Buffer;
  let stem: string | undefined;
  let kind: OfficeKind | undefined;

  if (typeof source.dataBase64 === "string" && source.dataBase64 !== "") {
    const b64 = source.dataBase64.includes(",")
      ? source.dataBase64.slice(source.dataBase64.indexOf(",") + 1)
      : source.dataBase64;
    bytes = Buffer.from(b64, "base64");
    kind = source.name ? officeKindOf(source.name) : undefined;
    stem = source.name ? templateStem(source.name) : undefined;
  } else if (typeof source.path === "string" && source.path.trim() !== "") {
    const from = path.resolve(source.path.trim());
    if (!fs.existsSync(from)) throw new Error(`template not found: ${from}`);
    const stat = fs.statSync(from);
    if (!stat.isFile()) throw new Error(`not a file: ${from}`);
    if (stat.size > MAX_TEMPLATE_BYTES) {
      throw new Error(`template is too large (${Math.round(stat.size / 1_048_576)} MB; limit ${MAX_TEMPLATE_BYTES / 1_048_576} MB)`);
    }
    kind = officeKindOf(from);
    stem = templateStem(source.name ?? from);
    const buf = fs.readFileSync(from);
    // a template can only be a real OOXML package — reject anything else early
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
      throw new Error(`not an Office file (zip): ${from}`);
    }
    bytes = buf;
  } else {
    throw new Error("provide a file path or the file contents");
  }

  if (!kind) {
    throw new Error("template extension must be .docx/.dotx, .xlsx/.xltx or .pptx/.potx");
  }
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("not an Office file (zip)");
  }
  if (bytes.length > MAX_TEMPLATE_BYTES) {
    throw new Error(`template is too large (${Math.round(bytes.length / 1_048_576)} MB; limit ${MAX_TEMPLATE_BYTES / 1_048_576} MB)`);
  }
  if (!stem) throw new Error("template name is required");

  const dir = templatesDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stem}${OFFICE_EXT[kind]}`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { name: stem, kind, file, size: bytes.length };
}

export function deleteOfficeTemplate(home: string, name: string): boolean {
  const stem = templateStem(name);
  if (!stem) return false;
  const dir = templatesDir(home);
  let removed = false;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    if (entry.replace(/\.[A-Za-z0-9]+$/, "") !== stem) continue;
    try {
      fs.rmSync(path.join(dir, entry));
      removed = true;
    } catch {
      /* keep going */
    }
  }
  return removed;
}

/**
 * Resolve what office_create should use: an explicit absolute/relative path,
 * a template name, or the conventional `default.<ext>` fallback. Returns the
 * absolute file path or undefined when there is nothing to use.
 */
export function resolveOfficeTemplate(
  home: string | undefined,
  ref: string | undefined,
  kind: OfficeKind,
): string | undefined {
  if (!home) return undefined;
  if (ref !== undefined && ref.trim() !== "") {
    const trimmed = ref.trim();
    // an absolute path, or one that exists relative to cwd-ish usage
    if (path.isAbsolute(trimmed)) {
      try {
        if (fs.statSync(trimmed).isFile()) return trimmed;
      } catch {
        /* fall through to the templates dir */
      }
    }
    const stem = templateStem(trimmed) ?? trimmed;
    const candidate = path.join(templatesDir(home), `${stem}${OFFICE_EXT[kind]}`);
    if (fs.existsSync(candidate)) return candidate;
    // accept a different template extension for the same kind
    for (const ext of Object.keys(TEMPLATE_EXT)) {
      if (TEMPLATE_EXT[ext] !== kind) continue;
      const alt = path.join(templatesDir(home), `${stem}${ext}`);
      if (fs.existsSync(alt)) return alt;
    }
    // finally: if the name itself points at an existing file
    try {
      if (fs.statSync(trimmed).isFile()) return path.resolve(trimmed);
    } catch {
      /* not a file */
    }
    return undefined;
  }
  const fallback = path.join(templatesDir(home), `default${OFFICE_EXT[kind]}`);
  return fs.existsSync(fallback) ? fallback : undefined;
}
