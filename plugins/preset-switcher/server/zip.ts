// Zero-dependency ZIP reader/writer for preset packs.
// Reader: parses the central directory, inflates deflate entries via node:zlib.
// Writer: store-format (no compression) — preset packs are small text files,
// and store keeps the writer trivial and deterministic.
//
// Not a general-purpose zip library: no ZIP64, no encryption, no multi-disk.
// Those never appear in hand-made preset packs; unsupported entries throw a
// clear error instead of producing garbage.

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  compressed: Buffer;
  method: number; // 0=store 8=deflate
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(buf: Buffer): number {
  // EOCD is at least 22 bytes from the end; scan backwards for its signature
  // (comment length is unbounded, cap the scan at 64 KiB + 22).
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("invalid zip: end-of-central-directory not found");
}

/** Parse the central directory into entry metadata (no decompression yet). */
export function listZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) {
      throw new Error(`invalid zip: bad central-directory record at ${off}`);
    }
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error(`unsupported zip entry "${name}": ZIP64 not supported`);
    }
    entries.push({ name, compressed: buf, method, compressedSize, uncompressedSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one entry, verifying size and CRC from its local header. */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const lo = entry.localHeaderOffset;
  if (buf.readUInt32LE(lo) !== LOC_SIG) {
    throw new Error(`invalid zip: bad local header for "${entry.name}"`);
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = inflateRawSync(raw);
  else throw new Error(`unsupported compression method ${entry.method} for "${entry.name}"`);
  if (data.length !== entry.uncompressedSize) {
    throw new Error(`zip entry "${entry.name}": size mismatch after inflate`);
  }
  const expectedCrc = buf.readUInt32LE(lo + 14);
  if (crc32(data) !== expectedCrc) {
    throw new Error(`zip entry "${entry.name}": CRC mismatch`);
  }
  return data;
}

/** Convenience: name → content map. Directory entries (trailing /) are skipped. */
export function extractZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of listZipEntries(buf)) {
    if (e.name.endsWith("/")) continue;
    out.set(e.name, readZipEntry(buf, e));
  }
  return out;
}

/** Build a store-format zip (no compression) from name → content. */
export function buildZip(files: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(LOC_SIG, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lh.writeUInt16LE(0, 8); // store
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(CEN_SIG, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8); // UTF-8 flag
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nb);

    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(files.size, 8);
  eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
