/**
 * Packs the shipped files into plugin.zip (deflate, no dependencies) and
 * prints its SHA-256, like the official plugin starter's pack script.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';

const FILES = ['manifest.json', 'index.html', 'icon.svg'];

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function zipEntry(name, data, { time, date }) {
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data) >>> 0;
  const compressed = deflateRawSync(data, { level: 9 });
  const useDeflate = compressed.length < data.length;
  const payload = useDeflate ? compressed : data;
  const method = useDeflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);

  return {
    localHeader: Buffer.concat([local, nameBytes]),
    central: Buffer.concat([central, nameBytes]),
    payload,
  };
}

const now = dosDateTime(new Date());
const locals = [];
const centrals = [];
let offset = 0;
for (const name of FILES) {
  const entry = zipEntry(name, readFileSync(name), now);
  locals.push(entry.localHeader, entry.payload);
  entry.central.writeUInt32LE(offset, 42);
  centrals.push(entry.central);
  offset += entry.localHeader.length + entry.payload.length;
}

const centralDir = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(FILES.length, 8);
eocd.writeUInt16LE(FILES.length, 10);
eocd.writeUInt32LE(centralDir.length, 12);
eocd.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...locals, centralDir, eocd]);
writeFileSync('plugin.zip', zip);

const sha256 = createHash('sha256').update(zip).digest('hex');
console.log(`plugin.zip (${FILES.length} files, ${zip.length} bytes)`);
console.log(`sha256: ${sha256}`);
