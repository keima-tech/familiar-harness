import zlib from "node:zlib";

/**
 * Read-only OOXML support for the GUI file preview.
 *
 * An .docx/.xlsx/.pptx is a ZIP of XML parts. This module unzips the few parts
 * we care about (with the built-in zlib — no dependency) and pulls the text
 * out, mirroring the shape `office_create` accepts so the preview can reuse
 * the same renderer.
 */

// ---------------------------------------------------------------------------
// minimal ZIP reader (STORE + DEFLATE)
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

function findEocd(buf: Buffer): number {
  // the end-of-central-directory record sits near the end (comment ≤ 64KB)
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** All entries of a zip archive, decompressed. Throws when it is not a zip. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    if (localOff + 30 <= buf.length) {
      const lnameLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnameLen + lextraLen;
      const raw = buf.subarray(start, start + compSize);
      try {
        out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
      } catch {
        /* a broken part is skipped — the preview shows the rest */
      }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// tiny XML helpers
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Concatenate the text of every `<x:t>`-ish element inside a fragment. */
function textOf(fragment: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let out = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) out += decodeEntities(m[1] ?? "");
  return out;
}

function tagAttr(fragment: string, tag: string, attr: string): string | undefined {
  const el = new RegExp(`<${tag}\\b([^>]*)>`).exec(fragment);
  if (!el) return undefined;
  const a = new RegExp(`${attr}="([^"]*)"`).exec(el[1] ?? "");
  return a ? decodeEntities(a[1] ?? "") : undefined;
}

// ---------------------------------------------------------------------------
// public shapes (mirror office_create input)
// ---------------------------------------------------------------------------

export interface DocxBlock {
  heading?: string;
  level?: number;
  text?: string;
  bullets?: string[];
  table?: string[][];
}

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

export interface PptxSlide {
  title?: string;
  bullets: string[];
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

export function readDocx(buf: Buffer): DocxBlock[] {
  const zip = unzip(buf);
  const doc = zip.get("word/document.xml");
  if (!doc) throw new Error("word/document.xml is missing");
  const xml = doc.toString("utf8");
  const bodyMatch = /<w:body>([\s\S]*)<\/w:body>/.exec(xml);
  const body = bodyMatch ? bodyMatch[1]! : xml;

  const blocks: DocxBlock[] = [];
  // walk top-level paragraphs and tables in document order
  const topRe = /<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g;
  let m: RegExpExecArray | null;
  while ((m = topRe.exec(body)) !== null) {
    const node = m[0];
    if (node.startsWith("<w:tbl")) {
      const table: string[][] = [];
      const rowRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      let r: RegExpExecArray | null;
      while ((r = rowRe.exec(node)) !== null) {
        const cells: string[] = [];
        const cellRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
        let c: RegExpExecArray | null;
        while ((c = cellRe.exec(r[0])) !== null) cells.push(textOf(c[0], "w:t"));
        table.push(cells);
      }
      if (table.length > 0) blocks.push({ table });
      continue;
    }
    const text = textOf(node, "w:t");
    if (text.trim() === "") continue;
    const style = tagAttr(node, "w:pStyle", "w:val");
    const heading = style?.match(/^Heading(\d)$/);
    if (heading) {
      blocks.push({ heading: text, level: Number(heading[1]) });
    } else if (/<w:numPr>/.test(node)) {
      const last = blocks[blocks.length - 1];
      if (last?.bullets) last.bullets.push(text);
      else blocks.push({ bullets: [text] });
    } else {
      blocks.push({ text });
    }
  }
  // also surface table content as trailing blocks? no — already inline
  return blocks;
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

function sharedStrings(zip: Map<string, Buffer>): string[] {
  const b = zip.get("xl/sharedStrings.xml");
  if (!b) return [];
  const xml = b.toString("utf8");
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) out.push(textOf(m[0], "t"));
  return out;
}

/** "C7" → 2 (zero-based column index). */
function colIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(buf: Buffer): XlsxSheet[] {
  const zip = unzip(buf);
  const shared = sharedStrings(zip);
  // sheet name → worksheet part (via workbook rels)
  const wb = zip.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = zip.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const relTarget = new Map<string, string>();
  {
    const re = /<Relationship\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rels)) !== null) {
      const id = tagAttr(m[0], "Relationship", "Id");
      const target = tagAttr(m[0], "Relationship", "Target");
      if (id && target) relTarget.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
    }
  }
  const sheets: XlsxSheet[] = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let sm: RegExpExecArray | null;
  let idx = 0;
  while ((sm = sheetRe.exec(wb)) !== null) {
    idx += 1;
    const name = tagAttr(sm[0], "sheet", "name") ?? `Sheet${idx}`;
    const rid = tagAttr(sm[0], "sheet", "r:id") ?? tagAttr(sm[0], "sheet", "r:Id");
    const target = (rid ? relTarget.get(rid) : undefined) ?? `worksheets/sheet${idx}.xml`;
    const part = zip.get(`xl/${target.replace(/^xl\//, "")}`) ?? zip.get(`xl/worksheets/sheet${idx}.xml`);
    if (!part) continue;
    sheets.push({ name, rows: readSheetRows(part.toString("utf8"), shared) });
  }
  if (sheets.length === 0) {
    // fall back to any worksheet parts in the archive
    for (const [key, value] of zip) {
      const m = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(key);
      if (m) sheets.push({ name: `Sheet${m[1]}`, rows: readSheetRows(value.toString("utf8"), shared) });
    }
  }
  return sheets;
}

function readSheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[\s\S]*?<\/row>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(xml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[0])) !== null) {
      const attrs = c[1] ?? "";
      const inner = c[2] ?? "";
      const ref = new RegExp(`r="([A-Z]+\\d+)"`).exec(attrs)?.[1];
      const col = ref ? colIndex(ref) : cells.length;
      const type = new RegExp(`t="([^"]+)"`).exec(attrs)?.[1];
      let value = "";
      if (type === "s") {
        const i = Number(textOf(inner, "v"));
        value = shared[i] ?? "";
      } else if (type === "inlineStr") {
        value = textOf(inner, "t");
      } else {
        value = textOf(inner, "v");
      }
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

export function readPptx(buf: Buffer): PptxSlide[] {
  const zip = unzip(buf);
  const slideNames = [...zip.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = Number(/slide(\d+)\.xml$/.exec(a)?.[1] ?? 0);
      const nb = Number(/slide(\d+)\.xml$/.exec(b)?.[1] ?? 0);
      return na - nb;
    });
  const slides: PptxSlide[] = [];
  for (const name of slideNames) {
    const xml = zip.get(name)!.toString("utf8");
    const texts: string[] = [];
    const pRe = /<a:p>([\s\S]*?)<\/a:p>/g;
    let m: RegExpExecArray | null;
    while ((m = pRe.exec(xml)) !== null) {
      const t = textOf(m[0], "a:t");
      if (t.trim() !== "") texts.push(t);
    }
    // the first paragraph is the title placeholder (see office_create output)
    const title = texts.length > 0 ? texts[0] : undefined;
    const bullets = texts.slice(1);
    slides.push(title !== undefined ? { title, bullets } : { bullets });
  }
  return slides;
}
