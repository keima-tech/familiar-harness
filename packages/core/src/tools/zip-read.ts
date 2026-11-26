/**
 * Bounded, read-only ZIP reader for attachments. Unlike the OOXML reader this
 * never expands the whole archive into memory: entries are listed from the
 * central directory and only the requested entry is inflated, with hard caps
 * so a hostile attachment cannot exhaust the process.
 */
import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export const ZIP_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 5_000;
export const ZIP_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export interface ZipEntryInfo {
  name: string;
  method: number;
  compressed: number;
  size: number;
  dir: boolean;
  /** Absolute offset of the local header inside the buffer (SFX-safe). */
  localOffset: number;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** List entries from the central directory (no decompression). */
export function listZip(buf: Buffer): ZipEntryInfo[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // A prepended stub (self-extracting archive) shifts every stored offset.
  const cdStart = eocd - cdSize;
  const delta = cdStart - cdOffset;
  let off = cdStart;
  if (cdStart < 0 || cdStart + cdSize > buf.length) throw new Error("corrupt zip central directory");
  const out: ZipEntryInfo[] = [];
  for (let i = 0; i < count; i++) {
    if (out.length >= ZIP_MAX_ENTRIES) throw new Error(`zip has more than ${ZIP_MAX_ENTRIES} entries`);
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL_SIG) {
      throw new Error("corrupt zip central directory");
    }
    const method = buf.readUInt16LE(off + 10);
    const compressed = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    let localOffset = buf.readUInt32LE(off + 42) + delta;
    if (localOffset < 0 || localOffset + 30 > buf.length) throw new Error("corrupt zip local header offset");
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    if (name !== "") out.push({ name, method, compressed, size, dir: name.endsWith("/"), localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Inflate one exact entry name. STORE and DEFLATE are supported. */
export function readZipEntry(buf: Buffer, name: string): Buffer {
  if (!name) throw new Error("entry name is required");
  const info = listZip(buf).find((entry) => entry.name === name);
  if (!info) throw new Error(`no such entry in zip: ${name}`);
  if (info.dir) throw new Error(`entry is a directory: ${name}`);
  if (info.size > ZIP_MAX_ENTRY_BYTES) {
    throw new Error(`entry exceeds ${ZIP_MAX_ENTRY_BYTES} bytes: ${name}`);
  }
  // Seek directly through the central directory's local-header offset. This
  // handles data-descriptor archives (local sizes are zero there) and SFX
  // archives with a prepended stub; no local-header walking is needed.
  const off = info.localOffset;
  if (buf.readUInt32LE(off) !== LOCAL_SIG) throw new Error("corrupt zip: bad local header signature");
  const flags = buf.readUInt16LE(off + 6);
  const method = buf.readUInt16LE(off + 8);
  const lnameLen = buf.readUInt16LE(off + 26);
  const lextraLen = buf.readUInt16LE(off + 28);
  const lname = buf.subarray(off + 30, off + 30 + lnameLen).toString("utf8");
  if (lname !== name) throw new Error("corrupt zip: central and local entry names disagree");
  if (method !== info.method) throw new Error("corrupt zip: central and local compression methods disagree");
  // Bit 3: sizes live in a trailing data descriptor, so trust the central
  // directory's sizes instead of the zeroed local header.
  if ((flags & 0x08) === 0) {
    const localComp = buf.readUInt32LE(off + 18);
    if (localComp !== info.compressed) throw new Error("corrupt zip: entry sizes disagree");
  }
  const start = off + 30 + lnameLen + lextraLen;
  if (start + info.compressed > buf.length) throw new Error("corrupt zip: truncated entry");
  const raw = buf.subarray(start, start + info.compressed);
  if (info.method === 0) return raw.subarray(0, ZIP_MAX_ENTRY_BYTES);
  if (info.method !== 8) throw new Error(`unsupported zip compression method: ${info.method}`);
  const inflated = zlib.inflateRawSync(raw, { maxOutputLength: ZIP_MAX_ENTRY_BYTES });
  if (inflated.length > info.size) {
    throw new Error("zip entry declared size does not match inflated data");
  }
  return inflated;
}
