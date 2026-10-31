// Minimal ZIP reader (enough for .pptx): parses the central directory and
// inflates stored/deflated entries with node:zlib. No external dependencies.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEocd(buf) {
  // EOCD is at least 22 bytes; comment may be up to 65535 bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('Not a ZIP file (end of central directory not found)');
}

export function readZip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CDH_SIG) throw new Error('Corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lp = e.localOffset;
      if (buf.readUInt32LE(lp) !== LFH_SIG) throw new Error(`Corrupt local header for ${name}`);
      const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported ZIP compression method ${e.method}`);
    },
    readText(name) {
      const b = this.read(name);
      return b ? b.toString('utf8') : null;
    },
  };
}
