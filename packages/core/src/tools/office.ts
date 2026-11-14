import type { Tool, ToolContext } from "./registry.js";
import fs from "node:fs";
import path from "node:path";
import { unzip } from "./ooxml-read.js";
import { zipArchive, type ZipEntry } from "./zip.js";
import { OFFICE_EXT, resolveOfficeTemplate, type OfficeKind } from "./office-templates.js";
import { approveWrite } from "./fs-tools.js";
import { familiarPaths } from "../paths.js";

/**
 * office_create — build .docx / .xlsx / .pptx files from structured input.
 *
 * No third-party dependency: the OOXML packages are written directly as a
 * ZIP (word/ or xl/ or ppt/ parts + content types + relationships) using the
 * shared writer in zip.ts (built-in zlib deflate). A registered template can
 * supply the design (styles/theme/layouts) while the content stays ours.
 * The output opens in Word / Excel / PowerPoint, LibreOffice and Google Docs.
 */

const buildZip = zipArchive;

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colLetter(index: number): string {
  let n = index;
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

interface DocBlock {
  heading?: string;
  level?: number;
  text?: string;
  bullets?: string[];
  table?: string[][];
}

function docxParagraph(
  text: string,
  opts: { heading?: number; bullet?: boolean; numId?: number } = {},
): string {
  const runs = `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
  const bulletStyle =
    `<w:pStyle w:val="ListParagraph"/>` +
    `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${opts.numId ?? 1}"/></w:numPr>`;
  const style = opts.heading
    ? `<w:pStyle w:val="Heading${opts.heading}"/>`
    : opts.bullet
      ? bulletStyle
      : "";
  return `<w:p><w:pPr>${style}</w:pPr>${runs}</w:p>`;
}

function docxTable(rows: string[][]): string {
  const body = rows
    .map(
      (cells) =>
        `<w:tr>${cells
          .map(
            (c) =>
              `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${docxParagraph(String(c ?? ""))}</w:tc>`,
          )
          .join("")}</w:tr>`,
    )
    .join("");
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>` +
    `<w:tblGrid/>${body}</w:tbl>`
  );
}

/** Body XML for the given blocks (shared by the from-scratch and template paths). */
function docxBodyXml(blocks: DocBlock[], numId = 1): string {
  return blocks
    .map((b) => {
      if (b.table && b.table.length > 0) return docxTable(b.table);
      if (b.bullets && b.bullets.length > 0) {
        return b.bullets.map((t) => docxParagraph(String(t), { bullet: true, numId })).join("");
      }
      if (b.heading) {
        return docxParagraph(b.heading, { heading: Math.min(6, Math.max(1, b.level ?? 1)) });
      }
      return docxParagraph(String(b.text ?? ""));
    })
    .join("");
}

/** A bullet list definition (numId/abstractNumId picked so they do not clash). */
function docxBulletDefs(abstractId: number, numId: number): string {
  return (
    `<w:abstractNum w:abstractNumId="${abstractId}"><w:lvl w:ilvl="0"><w:start w:val="1"/>` +
    `<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>` +
    `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>` +
    `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`
  );
}

/** The numbering part used when there is no template (numId=1). */
function docxNumberingXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    docxBulletDefs(0, 1) +
    `</w:numbering>`
  );
}

/** Highest `attr="N"` seen on `<tag …>`; -1 when absent. */
function maxAttrValue(xml: string, tag: string, attr: string): number {
  let max = -1;
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="(\\d+)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) max = Math.max(max, Number(m[1]));
  return max;
}

/** The paragraph/table style definitions our content relies on. */
function docxStyleDefs(): { heading: string; list: string; table: string } {
  const heading = [1, 2, 3, 4, 5, 6]
    .map(
      (n) =>
        `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>` +
        `<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="${Math.max(24, 40 - n * 4)}"/></w:rPr></w:style>`,
    )
    .join("");
  const list = `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>`;
  const table =
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>` +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="999999"/>`)
      .join("") +
    `</w:tblBorders></w:tblPr></w:style>`;
  return { heading, list, table };
}

function docxStylesXml(): string {
  const defs = docxStyleDefs();
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    defs.heading + defs.list + defs.table +
    `</w:styles>`
  );
}

function docxDocumentXml(bodyXml: string, sectPr?: string): string {
  const sect = sectPr ?? `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyXml}${sect}</w:body></w:document>`
  );
}

function buildDocx(title: string, blocks: DocBlock[]): Buffer {
  const bodyXml = docxBodyXml(blocks);
  const documentXml = docxDocumentXml(bodyXml);
  const stylesXml = docxStylesXml();
  const numberingXml = docxNumberingXml();

  return buildZip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
          `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
          `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
          `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
          `</Types>`,
        "utf8",
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
          `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
          `</Relationships>`,
        "utf8",
      ),
    },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/styles.xml", data: Buffer.from(stylesXml, "utf8") },
    { name: "word/numbering.xml", data: Buffer.from(numberingXml, "utf8") },
    {
      name: "word/_rels/document.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
          `</Relationships>`,
        "utf8",
      ),
    },
    { name: "docProps/core.xml", data: Buffer.from(coreProps(title, "Familiar Harness"), "utf8") },
    { name: "docProps/app.xml", data: Buffer.from(appProps("Microsoft Office Word"), "utf8") },
  ]);
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

interface SheetInput {
  name?: string;
  headers?: string[];
  rows: (string | number)[][];
}

function cellXml(value: string | number, ref: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  const text = String(value ?? "");
  if (text === "") return `<c r="${ref}"/>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

function sheetXml(sheet: SheetInput): string {
  const rows: (string | number)[][] = [];
  if (sheet.headers && sheet.headers.length > 0) rows.push(sheet.headers.map((h) => String(h)));
  rows.push(...sheet.rows);
  const body = rows
    .map((row, r) => {
      const cells = row.map((v, c) => cellXml(v, `${colLetter(c)}${r + 1}`)).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const maxCols = Math.max(1, ...rows.map((r) => r.length));
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${colLetter(maxCols - 1)}${Math.max(1, rows.length)}"/>` +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

function buildXlsx(title: string, sheets: SheetInput[]): Buffer {
  const entries: ZipEntry[] = [];
  const sheetOverrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  entries.push({
    name: "[Content_Types].xml",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        sheetOverrides +
        `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
        `</Types>`,
      "utf8",
    ),
  });
  entries.push({
    name: "_rels/.rels",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
        `</Relationships>`,
      "utf8",
    ),
  });
  entries.push({
    name: "xl/workbook.xml",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>${sheets
          .map(
            (s, i) =>
              `<sheet name="${xmlEscape(s.name || `Sheet${i + 1}`)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
          )
          .join("")}</sheets></workbook>`,
      "utf8",
    ),
  });
  entries.push({
    name: "xl/_rels/workbook.xml.rels",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        `</Relationships>`,
      "utf8",
    ),
  });
  sheets.forEach((s, i) =>
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s), "utf8") }),
  );
  entries.push({ name: "docProps/core.xml", data: Buffer.from(coreProps(title, "Familiar Harness"), "utf8") });
  return buildZip(entries);
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

interface SlideInput {
  title?: string;
  bullets?: string[];
  notes?: string;
}

function buildPptx(title: string, slides: SlideInput[]): Buffer {
  const entries: ZipEntry[] = [];
  const slideOverrides = slides
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("");
  entries.push({
    name: "[Content_Types].xml",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
        `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
        `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
        `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
        slideOverrides +
        `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
        `</Types>`,
      "utf8",
    ),
  });
  entries.push({
    name: "_rels/.rels",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
        `</Relationships>`,
      "utf8",
    ),
  });
  entries.push({
    name: "ppt/presentation.xml",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
        `<p:sldIdLst>${slides
          .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
          .join("")}</p:sldIdLst>` +
        `<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/>` +
        `</p:presentation>`,
      "utf8",
    ),
  });
  entries.push({
    name: "ppt/_rels/presentation.xml.rels",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
        slides
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
          )
          .join("") +
        `</Relationships>`,
      "utf8",
    ),
  });
  entries.push({
    name: "ppt/theme/theme1.xml",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">` +
        `<a:themeElements><a:clrScheme name="Office">` +
        `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
        `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
        `<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>` +
        `<a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2>` +
        `<a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4>` +
        `<a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6>` +
        `<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>` +
        `</a:clrScheme><a:fontScheme name="Office">` +
        `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
        `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
        `</a:fontScheme><a:fmtScheme name="Office">` +
        `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
        `<a:lnStyleLst><a:ln w="9525" cap="flat"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
        `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
        `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
        `</a:fmtScheme></a:themeElements></a:theme>`,
      "utf8",
    ),
  });
  entries.push({
    name: "ppt/slideMasters/slideMaster1.xml",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
        `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
        `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
        `<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
      "utf8",
    ),
  });
  entries.push({
    name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
        `</Relationships>`,
      "utf8",
    ),
  });
  entries.push({
    name: "ppt/slideLayouts/slideLayout1.xml",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">` +
        `<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
        `<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sldLayout>`,
      "utf8",
    ),
  });
  entries.push({
    name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
        `</Relationships>`,
      "utf8",
    ),
  });

  slides.forEach((slide, i) => {
    const spTree = pptSpTree(slide);
    entries.push({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
          `<p:cSld><p:spTree>${spTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
        "utf8",
      ),
    });
    entries.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
          `</Relationships>`,
        "utf8",
      ),
    });
  });
  entries.push({ name: "docProps/core.xml", data: Buffer.from(coreProps(title, "Familiar Harness"), "utf8") });
  return buildZip(entries);
}

function pptSpTree(slide: SlideInput): string {
  const parts: string[] = [
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`,
  ];
  let id = 2;
  if (slide.title && slide.title.trim() !== "") {
    parts.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Title ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="900000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
        `<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>${xmlEscape(slide.title)}</a:t></a:r></a:p></p:txBody></p:sp>`,
    );
    id += 1;
  }
  const bullets = (slide.bullets ?? []).filter((b) => String(b).trim() !== "");
  if (bullets.length > 0) {
    const paras = bullets
      .map(
        (b, i) =>
          `<a:p><a:pPr lvl="0"${i === 0 ? "" : " marL=\"0\""}/><a:r><a:rPr lang="en-US" sz="2000"/><a:t>${xmlEscape(String(b))}</a:t></a:r></a:p>`,
      )
      .join("");
    parts.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Content ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="457200" y="1300000"/><a:ext cx="8229600" cy="4800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:buNone/></a:pPr></a:p>${paras}</p:txBody></p:sp>`,
    );
  }
  return parts.join("");
}

function coreProps(title: string, author: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xmlEscape(title)}</dc:title><dc:creator>${xmlEscape(author)}</dc:creator>` +
    `<cp:lastModifiedBy>${xmlEscape(author)}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
  );
}

function appProps(application: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>${xmlEscape(application)}</Application></Properties>`
  );
}

// ---------------------------------------------------------------------------
// tool
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// template application (keep the template's design, replace the content)
// ---------------------------------------------------------------------------

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

function zipOf(parts: Map<string, Buffer>): Buffer {
  return buildZip([...parts.entries()].map(([name, data]) => ({ name, data })), { compress: true });
}

/** Add `Override` entries that are missing (content types must cover every part). */
function ensureContentTypes(xml: string | undefined, overrides: Array<{ part: string; type: string }>): string {
  let out =
    xml && xml.trim() !== ""
      ? xml
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT_NS}">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/></Types>`;
  // drop overrides for parts we removed (e.g. template slides)
  for (const o of overrides) {
    if (out.includes(`PartName="${o.part}"`)) continue;
    out = out.replace("</Types>", `<Override PartName="${o.part}" ContentType="${o.type}"/></Types>`);
  }
  return out;
}

/** Drop `Override` entries whose PartName matches `pred`. */
function dropContentTypeOverrides(xml: string, pred: (part: string) => boolean): string {
  return xml.replace(/<Override\b[^>]*\/>/g, (tag) => {
    const part = /PartName="([^"]*)"/.exec(tag)?.[1] ?? "";
    return pred(part) ? "" : tag;
  });
}

/** Add a relationship when the same Type is not present yet. */
function ensureRel(xml: string | undefined, type: string, target: string, idHint: string): string {
  let out =
    xml && xml.trim() !== ""
      ? xml
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  if (out.includes(`Type="${type}"`)) return out;
  let id = idHint;
  let i = 1;
  while (out.includes(`Id="${id}"`)) id = `${idHint}${i++}`;
  return out.replace("</Relationships>", `<Relationship Id="${id}" Type="${type}" Target="${target}"/></Relationships>`);
}

function dropRels(xml: string, typeSuffix: string): string {
  return xml.replace(/<Relationship\b[^>]*\/>/g, (tag) =>
    (tag.includes(`Type="${REL_NS}/${typeSuffix}"`) ? "" : tag),
  );
}

// ---- DOCX ----------------------------------------------------------------

function mergeDocxStyles(
  existing: string | undefined,
  need: { headings: boolean; bullets: boolean; table: boolean },
): string {
  if (!existing || existing.trim() === "") return docxStylesXml();
  if (!/<\/w:styles>/.test(existing)) return existing;
  const defs = docxStyleDefs();
  let insert = "";
  if (!/w:styleId="Normal"/.test(existing)) {
    insert += `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`;
  }
  if (need.headings && !/w:styleId="Heading1"/.test(existing)) insert += defs.heading;
  if (need.bullets && !/w:styleId="ListParagraph"/.test(existing)) insert += defs.list;
  if (need.table && !/w:styleId="TableGrid"/.test(existing)) insert += defs.table;
  return insert === "" ? existing : existing.replace("</w:styles>", `${insert}</w:styles>`);
}

function buildDocxFromTemplate(template: Buffer, title: string, blocks: DocBlock[]): Buffer {
  const parts = unzip(template);
  const original = parts.get("word/document.xml")?.toString("utf8") ?? "";
  // keep the template's page setup (size, margins, headers) when present
  const sectPr = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(original)?.[0];
  const open = /^([\s\S]*?<w:document\b[^>]*>)/.exec(original)?.[1];

  const need = {
    headings: blocks.some((b) => typeof b.heading === "string" && b.heading !== ""),
    bullets: blocks.some((b) => (b.bullets?.length ?? 0) > 0),
    table: blocks.some((b) => (b.table?.length ?? 0) > 0),
  };

  // bullets: never reuse a numId the template already defines (it would render
  // as that list); append our own definition with free ids
  let numId = 1;
  const numXml = parts.get("word/numbering.xml")?.toString("utf8");
  if (need.bullets && numXml && /<\/w:numbering>/.test(numXml)) {
    const abstractId = maxAttrValue(numXml, "w:abstractNum", "w:abstractNumId") + 1;
    numId = maxAttrValue(numXml, "w:num", "w:numId") + 1;
    parts.set(
      "word/numbering.xml",
      Buffer.from(numXml.replace("</w:numbering>", `${docxBulletDefs(abstractId, numId)}</w:numbering>`), "utf8"),
    );
  } else if (need.bullets && !numXml) {
    parts.set("word/numbering.xml", Buffer.from(docxNumberingXml(), "utf8"));
  }

  const bodyXml = docxBodyXml(blocks, numId);
  const doc = open
    ? `${open}<w:body>${bodyXml}${sectPr ?? ""}</w:body></w:document>`
    : docxDocumentXml(bodyXml, sectPr);
  parts.set("word/document.xml", Buffer.from(doc, "utf8"));

  parts.set(
    "word/styles.xml",
    Buffer.from(mergeDocxStyles(parts.get("word/styles.xml")?.toString("utf8"), need), "utf8"),
  );

  let rels = parts.get("word/_rels/document.xml.rels")?.toString("utf8");
  rels = ensureRel(rels, `${REL_NS}/styles`, "styles.xml", "rIdFamiliarStyles");
  if (need.bullets) rels = ensureRel(rels, `${REL_NS}/numbering`, "numbering.xml", "rIdFamiliarNumbering");
  parts.set("word/_rels/document.xml.rels", Buffer.from(rels, "utf8"));

  const overrides = [
    { part: "/word/document.xml", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" },
    { part: "/word/styles.xml", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml" },
  ];
  if (need.bullets) {
    overrides.push({ part: "/word/numbering.xml", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml" });
  }
  parts.set("[Content_Types].xml", Buffer.from(ensureContentTypes(parts.get("[Content_Types].xml")?.toString("utf8"), overrides), "utf8"));

  // refresh the metadata title, keeping the rest of the properties
  const core = parts.get("docProps/core.xml")?.toString("utf8");
  if (core) parts.set("docProps/core.xml", Buffer.from(core.replace(/(<dc:title>)[\s\S]*?(<\/dc:title>)/, `$1${xmlEscape(title)}$2`), "utf8"));
  return zipOf(parts);
}

// ---- XLSX ----------------------------------------------------------------

/** Worksheet part paths, in workbook (tab) order. */
function workbookSheetParts(parts: Map<string, Buffer>): string[] {
  const wb = parts.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = parts.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const byId = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) byId.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }
  const out: string[] = [];
  let i = 0;
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    i += 1;
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const target = (rid ? byId.get(rid) : undefined) ?? `worksheets/sheet${i}.xml`;
    out.push(`xl/${target.replace(/^xl\//, "")}`);
  }
  return out;
}

/** Append the sheet's rows below the existing content, inheriting cell styles. */
function appendSheetRows(xml: string, sheet: SheetInput): string {
  const rows: (string | number)[][] = [];
  if (sheet.headers && sheet.headers.length > 0) rows.push(sheet.headers.map((h) => String(h)));
  rows.push(...sheet.rows);
  if (rows.length === 0) return xml;

  const rowTags = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"[\s\S]*?<\/row>/g)];
  const lastRow = rowTags.reduce((max, m) => Math.max(max, Number(m[1])), 0);
  const lastRowXml = rowTags.length > 0 ? rowTags[rowTags.length - 1]![0] : "";
  const style = /<c\b[^>]*\bs="(\d+)"/.exec(lastRowXml)?.[1];
  const start = lastRow + 1;

  const cellsXml = rows
    .map((row, i) => {
      const r = start + i;
      const cells = row
        .map((v, c) => {
          const ref = `${colLetter(c)}${r}`;
          const sAttr = style !== undefined ? ` s="${style}"` : "";
          if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
          const text = String(v ?? "");
          if (text === "") return `<c r="${ref}"${sAttr}/>`;
          return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r}">${cells}</row>`;
    })
    .join("");

  let out = xml;
  if (/<sheetData\s*\/>/.test(out)) out = out.replace(/<sheetData\s*\/>/, `<sheetData>${cellsXml}</sheetData>`);
  else if (out.includes("</sheetData>")) out = out.replace("</sheetData>", `${cellsXml}</sheetData>`);
  else out = out.replace("</worksheet>", `<sheetData>${cellsXml}</sheetData></worksheet>`);

  const maxCols = Math.max(1, ...rows.map((r) => r.length));
  const dim = `A1:${colLetter(maxCols - 1)}${start + rows.length - 1}`;
  if (/<dimension\b[^>]*\/>/.test(out)) out = out.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${dim}"/>`);
  else out = out.replace(/(<worksheet\b[^>]*>)/, `$1<dimension ref="${dim}"/>`);
  return out;
}

function buildXlsxFromTemplate(
  template: Buffer,
  title: string,
  sheets: SheetInput[],
  notes: string[],
): Buffer {
  const parts = unzip(template);
  const targets = workbookSheetParts(parts);
  sheets.forEach((sheet, i) => {
    const part = targets[i];
    if (!part) {
      // more input sheets than the template has worksheets: say so instead of
      // dropping data silently
      notes.push(`sheet "${sheet.name ?? i + 1}" was not written (the template has ${targets.length} worksheet(s))`);
      return;
    }
    const xml = parts.get(part)?.toString("utf8") ?? "";
    parts.set(part, Buffer.from(appendSheetRows(xml, sheet), "utf8"));
  });
  return zipOf(parts);
}

// ---- PPTX ----------------------------------------------------------------

interface PptxPlaceholder {
  type: string;
  idx?: string;
  spPr: string;
}

function pickPptxLayout(parts: Map<string, Buffer>): { path: string; target: string; xml: string } | undefined {
  const layouts = [...parts.keys()]
    .filter((k) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  let fallback: { path: string; target: string; xml: string } | undefined;
  for (const path of layouts) {
    const xml = parts.get(path)!.toString("utf8");
    const name = /<p:cSld\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] ?? "";
    const phCount = (xml.match(/<p:ph\b/g) ?? []).length;
    const entry = { path, target: path.replace(/^ppt\//, ""), xml };
    if (phCount >= 1 && /title.*content|content.*title|内容|コンテンツ|two content/i.test(name)) return entry;
    if (!fallback && phCount >= 2) fallback = entry;
  }
  if (fallback) return fallback;
  if (layouts[0]) {
    const path = layouts[0];
    return { path, target: path.replace(/^ppt\//, ""), xml: parts.get(path)!.toString("utf8") };
  }
  return undefined;
}

function layoutPlaceholders(layoutXml: string): PptxPlaceholder[] {
  const out: PptxPlaceholder[] = [];
  for (const m of layoutXml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    const sp = m[0];
    const ph = /<p:ph\b([^>]*)\/?>/.exec(sp);
    if (!ph) continue;
    const phAttrs = ph[1] ?? "";
    const type = /type="([^"]+)"/.exec(phAttrs)?.[1] ?? "body";
    const idx = /idx="([^"]+)"/.exec(phAttrs)?.[1];
    const spPr = /<p:spPr>[\s\S]*?<\/p:spPr>/.exec(sp)?.[0] ?? "<p:spPr/>";
    out.push({ type, idx, spPr });
  }
  return out;
}

function pptxSlideXml(placeholders: PptxPlaceholder[], slide: SlideInput, seq: number): string {
  const titlePh = placeholders.find((p) => p.type === "title" || p.type === "ctrTitle");
  const bodyPh = placeholders.find((p) => p.type === "body" || p.type === "subTitle" || p.type === "obj");
  const shapes: string[] = [];
  let id = 2;
  const mk = (ph: PptxPlaceholder, paras: string, name: string): string => {
    const idxAttr = ph.idx ? ` idx="${ph.idx}"` : "";
    return (
      `<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
      `<p:nvPr><p:ph type="${ph.type}"${idxAttr}/></p:nvPr></p:nvSpPr>${ph.spPr}` +
      `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`
    );
  };
  if (titlePh) {
    const text = xmlEscape(slide.title ?? "");
    shapes.push(mk(titlePh, `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`, `Title ${seq}`));
  }
  if (bodyPh) {
    const bullets = (slide.bullets ?? []).filter((b) => String(b).trim() !== "");
    const paras =
      bullets.length > 0
        ? bullets.map((b) => `<a:p><a:pPr lvl="0"/><a:r><a:t>${xmlEscape(String(b))}</a:t></a:r></a:p>`).join("")
        : `<a:p/>`;
    shapes.push(mk(bodyPh, paras, `Content ${seq}`));
  }
  if (shapes.length === 0) {
    // the layout had no placeholders: fall back to a plain centred text box
    shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="5851525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>` +
        (slide.title ? `<a:p><a:r><a:t>${xmlEscape(slide.title)}</a:t></a:r></a:p>` : "") +
        (slide.bullets ?? []).map((b) => `<a:p><a:r><a:t>${xmlEscape(String(b))}</a:t></a:r></a:p>`).join("") +
        `</p:txBody></p:sp>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="${REL_NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    shapes.join("") +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

function buildPptxFromTemplate(template: Buffer, title: string, slides: SlideInput[]): Buffer {
  const parts = unzip(template);
  const layout = pickPptxLayout(parts);
  if (!layout) throw new Error("the template has no slide layout to reuse");
  const placeholders = layoutPlaceholders(layout.xml);
  const layoutTarget = `../${layout.target.replace(/^ppt\//, "")}`; // from ppt/slides/

  // replace the template's slides with ours (the master/layouts/theme stay);
  // speaker notes belong to the old slides, so drop them too rather than
  // leaving parts nothing references
  for (const key of [...parts.keys()]) {
    if (
      /^ppt\/slides\/slide\d+\.xml$/.test(key) ||
      /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(key) ||
      /^ppt\/notesSlides\//.test(key)
    ) {
      parts.delete(key);
    }
  }

  const sldIds: string[] = [];
  slides.forEach((slide, i) => {
    const n = i + 1;
    parts.set(`ppt/slides/slide${n}.xml`, Buffer.from(pptxSlideXml(placeholders, slide, n), "utf8"));
    parts.set(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="${layoutTarget}"/></Relationships>`,
        "utf8",
      ),
    );
    sldIds.push(`<p:sldId id="${256 + i}" r:id="rIdFamiliarSlide${n}"/>`);
  });

  // presentation.xml: swap the slide list, keep the master list
  let pres = parts.get("ppt/presentation.xml")?.toString("utf8") ?? "";
  const list = `<p:sldIdLst>${sldIds.join("")}</p:sldIdLst>`;
  if (/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/.test(pres)) {
    pres = pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, list);
  } else if (/<p:sldIdLst\s*\/>/.test(pres)) {
    // a template with no slides yet keeps an empty self-closing list
    pres = pres.replace(/<p:sldIdLst\s*\/>/, list);
  } else if (/<p:sldMasterIdLst>[\s\S]*?<\/p:sldMasterIdLst>/.test(pres)) {
    pres = pres.replace(/(<p:sldMasterIdLst>[\s\S]*?<\/p:sldMasterIdLst>)/, `$1${list}`);
  } else {
    throw new Error("presentation.xml has no place for the slide list");
  }
  parts.set("ppt/presentation.xml", Buffer.from(pres, "utf8"));

  // presentation rels: drop old slide rels, add ours
  let presRels = dropRels(parts.get("ppt/_rels/presentation.xml.rels")?.toString("utf8") ?? "", "slide");
  slides.forEach((_, i) => {
    const n = i + 1;
    presRels = presRels.replace(
      "</Relationships>",
      `<Relationship Id="rIdFamiliarSlide${n}" Type="${REL_NS}/slide" Target="slides/slide${n}.xml"/></Relationships>`,
    );
  });
  parts.set("ppt/_rels/presentation.xml.rels", Buffer.from(presRels, "utf8"));

  // content types: drop old slide overrides, add ours
  let ct = dropContentTypeOverrides(parts.get("[Content_Types].xml")?.toString("utf8") ?? "", (part) =>
    /^\/ppt\/slides\/slide\d+\.xml$/.test(part) || /^\/ppt\/notesSlides\//.test(part),
  );
  ct = ensureContentTypes(
    ct,
    slides.map((_, i) => ({
      part: `/ppt/slides/slide${i + 1}.xml`,
      type: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
    })),
  );
  parts.set("[Content_Types].xml", Buffer.from(ct, "utf8"));

  const core = parts.get("docProps/core.xml")?.toString("utf8");
  if (core) parts.set("docProps/core.xml", Buffer.from(core.replace(/(<dc:title>)[\s\S]*?(<\/dc:title>)/, `$1${xmlEscape(title)}$2`), "utf8"));
  return zipOf(parts);
}

/** Build with the template's design, or undefined when the template is unusable. */
function buildFromTemplate(
  kind: OfficeKind,
  template: Buffer,
  title: string,
  input: { blocks?: DocBlock[]; sheets?: SheetInput[]; slides?: SlideInput[] },
  notes: string[],
): Buffer | undefined {
  try {
    if (kind === "docx") return buildDocxFromTemplate(template, title, input.blocks ?? []);
    if (kind === "xlsx") return buildXlsxFromTemplate(template, title, input.sheets ?? [], notes);
    return buildPptxFromTemplate(template, title, input.slides ?? []);
  } catch (err) {
    // any structural surprise → fall back to a plain document, but tell the user
    notes.push(`the template could not be applied (${err instanceof Error ? err.message : String(err)}) — wrote a plain ${kind}`);
    return undefined;
  }
}

const KIND_EXT: Record<string, string> = { docx: ".docx", xlsx: ".xlsx", pptx: ".pptx" };

export function createOfficeCreateTool(): Tool {
  return {
    name: "office_create",
    description:
      "Create a Microsoft Office file (.docx Word, .xlsx Excel, .pptx PowerPoint) from structured data. " +
      "kind=docx: blocks[] with {heading,text,bullets[],table[][]}. " +
      "kind=xlsx: sheets[] with {name,headers[],rows[][]}. " +
      "kind=pptx: slides[] with {title,bullets[]}. " +
      "Give a path ending in the right extension (or just a file name). " +
      "Pass `template` (a name registered in Settings → Templates) to inherit that file's design " +
      "(styles, theme, layouts, page setup); when a template named `default` exists it is used automatically. " +
      "Prefer this over writing OOXML by hand. The file is written to the working directory unless the permission mode allows otherwise.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["docx", "xlsx", "pptx"], description: "Output format" },
        path: { type: "string", description: "Target file path (extension .docx/.xlsx/.pptx)" },
        template: {
          type: "string",
          description:
            "Optional: name of a registered Office template (Settings → Templates) or a template file path. " +
            "Its design is reused. Defaults to a template named 'default' of the same kind when present.",
        },
        title: { type: "string", description: "Document title / authoring metadata" },
        blocks: {
          type: "array",
          description: "docx only: ordered content blocks",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              level: { type: "number" },
              text: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              table: { type: "array", items: { type: "array", items: { type: "string" } } },
            },
          },
        },
        sheets: {
          type: "array",
          description: "xlsx only: worksheets",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              headers: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array" } },
            },
            required: ["rows"],
          },
        },
        slides: {
          type: "array",
          description: "pptx only: slides",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      required: ["kind", "path"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const kind = String(args.kind ?? "").toLowerCase();
      const argPath = typeof args.path === "string" ? args.path : "";
      const title = typeof args.title === "string" && args.title.trim() !== "" ? args.title : "Familiar document";
      if (!KIND_EXT[kind]) {
        return { content: "kind must be docx | xlsx | pptx", isError: true };
      }
      if (!argPath) return { content: "argument 'path' is required", isError: true };

      // use the backend's path flavor: a Windows client driving an ssh (posix)
      // session must not resolve the target with the host path module
      const bp = ctx.backend.path;
      let absolute = bp.isAbsolute(argPath) ? bp.normalize(argPath) : bp.resolve(ctx.cwd, argPath);
      if (!absolute.toLowerCase().endsWith(KIND_EXT[kind]!)) {
        // keep the type and the extension in agreement
        absolute = absolute.replace(/\.(docx|xlsx|pptx)$/i, "") + KIND_EXT[kind];
      }

      // the same gate as write: worth an approval only outside cwd in ask mode
      const approved = await approveWrite(ctx, absolute, {
        tool: "office_create",
        summary: `write file: ${absolute}`,
      });
      if (!approved) return { content: "[denied by user]", isError: true };

      const kinds = kind as OfficeKind;
      const blocks = Array.isArray(args.blocks) ? (args.blocks as DocBlock[]) : [];
      const sheets = Array.isArray(args.sheets) ? (args.sheets as SheetInput[]) : [];
      const slides = Array.isArray(args.slides) ? (args.slides as SlideInput[]) : [];
      if (kinds === "docx" && blocks.length === 0) return { content: "docx needs a non-empty 'blocks' array", isError: true };
      if (kinds === "xlsx" && sheets.length === 0) return { content: "xlsx needs a non-empty 'sheets' array", isError: true };
      if (kinds === "pptx" && slides.length === 0) return { content: "pptx needs a non-empty 'slides' array", isError: true };

      // a registered template (explicit name, or an implicit `default.<ext>`)
      const home = ctx.config.homeDir || familiarPaths.home();
      const templateRef = typeof args.template === "string" ? args.template.trim() : "";
      const templatePath = resolveOfficeTemplate(home, templateRef === "" ? undefined : templateRef, kinds);
      if (templatePath === undefined && templateRef !== "") {
        // naming a template that does not exist is a mistake worth surfacing,
        // not something to paper over with a plain document
        return {
          content: `template not found: "${templateRef}" — register it in Settings → Templates (or pass a file path)`,
          isError: true,
        };
      }
      let usedTemplate: string | undefined;
      let templateBuf: Buffer | undefined;
      if (templatePath) {
        try {
          templateBuf = fs.readFileSync(templatePath);
          usedTemplate = path.basename(templatePath, path.extname(templatePath));
        } catch {
          templateBuf = undefined;
          if (templateRef !== "") return { content: `cannot read the template: ${templatePath}`, isError: true };
        }
      }

      const notes: string[] = [];
      let buf: Buffer;
      try {
        buf = templateBuf
          ? (buildFromTemplate(kinds, templateBuf, title, { blocks, sheets, slides }, notes) ??
             baseBuild(kinds, title, blocks, sheets, slides))
          : baseBuild(kinds, title, blocks, sheets, slides);
      } catch (err) {
        return {
          content: `failed to build the ${kind}: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      try {
        await ctx.backend.mkdirp(ctx.backend.path.dirname(absolute));
        await ctx.backend.writeFile(absolute, buf);
        return {
          content:
            `wrote ${absolute} (${kind}, ${buf.length} bytes)` +
            (usedTemplate ? ` using the template "${usedTemplate}"` : "") +
            (notes.length > 0 ? `\nnote: ${notes.join("; ")}` : ""),
          isError: false,
        };
      } catch (err) {
        return {
          content: `cannot write ${absolute}: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/** The from-scratch builders (used when no template applies or it is unusable). */
function baseBuild(kind: OfficeKind, title: string, blocks: DocBlock[], sheets: SheetInput[], slides: SlideInput[]): Buffer {
  if (kind === "docx") return buildDocx(title, blocks);
  if (kind === "xlsx") return buildXlsx(title, sheets);
  return buildPptx(title, slides);
}


