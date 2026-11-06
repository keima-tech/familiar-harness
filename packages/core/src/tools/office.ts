import type { Tool, ToolContext } from "./registry.js";
import path from "node:path";

/**
 * office_create — build .docx / .xlsx / .pptx files from structured input.
 *
 * No third-party dependency: the OOXML packages are written directly as a
 * ZIP (word/ or xl/ or ppt/ parts + content types + relationships) using the
 * built-in zlib deflate. The output opens in Word / Excel / PowerPoint, in
 * LibreOffice and in Google Docs.
 */

// ---------------------------------------------------------------------------
// minimal ZIP writer (deflate via zlib, CRC32 computed here)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Build a ZIP archive (no compression; STORE) from the entries. */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // relative offset of local header
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + entry.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

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

function docxParagraph(text: string, opts: { heading?: number; bullet?: boolean } = {}): string {
  const runs = `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
  const style = opts.heading ? `<w:pStyle w:val="Heading${opts.heading}"/>` : opts.bullet ? `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` : "";
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

function buildDocx(title: string, blocks: DocBlock[]): Buffer {
  const bodyXml = blocks
    .map((b) => {
      if (b.table && b.table.length > 0) return docxTable(b.table);
      if (b.bullets && b.bullets.length > 0) {
        return b.bullets.map((t) => docxParagraph(String(t), { bullet: true })).join("");
      }
      if (b.heading) {
        return docxParagraph(b.heading, { heading: Math.min(6, Math.max(1, b.level ?? 1)) });
      }
      return docxParagraph(String(b.text ?? ""));
    })
    .join("");

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    [1, 2, 3, 4, 5, 6]
      .map(
        (n) =>
          `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>` +
          `<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
          `<w:rPr><w:b/><w:sz w:val="${Math.max(24, 40 - n * 4)}"/></w:rPr></w:style>`,
      )
      .join("") +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>` +
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>` +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="999999"/>`)
      .join("") +
    `</w:tblBorders></w:tblPr></w:style></w:styles>`;

  const numberingXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
    `<w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

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
      "Prefer this over writing OOXML by hand. The file is written to the working directory unless the permission mode allows otherwise.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["docx", "xlsx", "pptx"], description: "Output format" },
        path: { type: "string", description: "Target file path (extension .docx/.xlsx/.pptx)" },
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

      let absolute = path.isAbsolute(argPath) ? path.normalize(argPath) : path.resolve(ctx.cwd, argPath);
      if (!absolute.toLowerCase().endsWith(KIND_EXT[kind]!)) {
        // keep the type and the extension in agreement
        absolute = absolute.replace(/\.(docx|xlsx|pptx)$/i, "") + KIND_EXT[kind];
      }

      // the same gate as write: worth an approval only outside cwd in ask mode
      const approved = await approveOfficeWrite(ctx, absolute);
      if (!approved) return { content: "[denied by user]", isError: true };

      let buf: Buffer;
      try {
        if (kind === "docx") {
          const blocks = Array.isArray(args.blocks) ? (args.blocks as DocBlock[]) : [];
          if (blocks.length === 0) return { content: "docx needs a non-empty 'blocks' array", isError: true };
          buf = buildDocx(title, blocks);
        } else if (kind === "xlsx") {
          const sheets = Array.isArray(args.sheets) ? (args.sheets as SheetInput[]) : [];
          if (sheets.length === 0) return { content: "xlsx needs a non-empty 'sheets' array", isError: true };
          buf = buildXlsx(title, sheets);
        } else {
          const slides = Array.isArray(args.slides) ? (args.slides as SlideInput[]) : [];
          if (slides.length === 0) return { content: "pptx needs a non-empty 'slides' array", isError: true };
          buf = buildPptx(title, slides);
        }
      } catch (err) {
        return {
          content: `failed to build the ${kind}: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      try {
        await ctx.backend.mkdirp(path.dirname(absolute));
        await ctx.backend.writeFile(absolute, buf);
        return {
          content: `wrote ${absolute} (${kind}, ${buf.length} bytes)`,
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

/** Write-approval gate shared with the write tool (kept local to avoid a cycle). */
async function approveOfficeWrite(ctx: ToolContext, absolute: string): Promise<boolean> {
  const mode = ctx.permissionMode;
  if (mode === "yolo" || mode === "edit" || ctx.yolo) return true;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = norm(ctx.cwd);
  const target = norm(absolute);
  const inside = target === root || target.startsWith(`${root}/`);
  if (inside) return true;
  return ctx.approval.request({ tool: "office_create", summary: `write file: ${absolute}` });
}
