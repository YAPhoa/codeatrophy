// A minimal zip writer and reader — just enough for bundles.
//
// The writer stores entries uncompressed. The reader handles stored and
// deflated entries (the latter through the platform's DecompressionStream),
// which covers archives produced by ordinary zip tools.

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/** Thrown when bytes are not a readable zip archive. */
export class ZipError extends Error {}

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
// 1 January 2026, 00:00 in DOS date/time encoding. A fixed stamp keeps output reproducible.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

export function writeZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const names = entries.map((e) => encoder.encode(e.path));
  const dataSize = entries.reduce((n, e, i) => n + 30 + names[i]!.length + e.data.length, 0);
  const centralSize = names.reduce((n, name) => n + 46 + name.length, 0);
  const out = new Uint8Array(dataSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  const crcs: number[] = [];
  let at = 0;

  entries.forEach((entry, i) => {
    const name = names[i]!;
    const crc = crc32(entry.data);
    offsets.push(at);
    crcs.push(crc);
    view.setUint32(at, LOCAL_SIG, true);
    view.setUint16(at + 4, 20, true); // version needed
    view.setUint16(at + 6, UTF8_FLAG, true);
    view.setUint16(at + 8, 0, true); // method: stored
    view.setUint16(at + 10, DOS_TIME, true);
    view.setUint16(at + 12, DOS_DATE, true);
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, entry.data.length, true);
    view.setUint32(at + 22, entry.data.length, true);
    view.setUint16(at + 26, name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(name, at + 30);
    out.set(entry.data, at + 30 + name.length);
    at += 30 + name.length + entry.data.length;
  });

  const centralStart = at;
  entries.forEach((entry, i) => {
    const name = names[i]!;
    view.setUint32(at, CENTRAL_SIG, true);
    view.setUint16(at + 4, 20, true); // version made by
    view.setUint16(at + 6, 20, true); // version needed
    view.setUint16(at + 8, UTF8_FLAG, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, DOS_TIME, true);
    view.setUint16(at + 14, DOS_DATE, true);
    view.setUint32(at + 16, crcs[i]!, true);
    view.setUint32(at + 20, entry.data.length, true);
    view.setUint32(at + 24, entry.data.length, true);
    view.setUint16(at + 28, name.length, true);
    // extra length, comment length, disk number, internal and external attributes: all zero
    view.setUint32(at + 42, offsets[i]!, true);
    out.set(name, at + 46);
    at += 46 + name.length;
  });

  view.setUint32(at, END_SIG, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('this environment cannot read compressed zip entries');
  }
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ZipError('a compressed entry is corrupt');
  }
}

/** Read every file entry of a zip archive. Directory entries are skipped. */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits at the very end, before an optional comment.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('not a zip archive');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_SIG) {
      throw new ZipError('the zip central directory is corrupt');
    }
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith('/')) continue;

    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new ZipError(`the zip entry "${path}" is corrupt`);
    }
    const dataStart =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.push({ path, data: raw.slice() });
    else if (method === 8) entries.push({ path, data: await inflateRaw(raw) });
    else throw new ZipError(`the zip entry "${path}" uses an unsupported compression method`);
  }
  return entries;
}
