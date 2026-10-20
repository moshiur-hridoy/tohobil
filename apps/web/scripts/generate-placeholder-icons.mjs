// Writes placeholder app icons (solid brand colour with a ring) into public/. No dependencies.
// The owner replaces these with real artwork; keep the file names and sizes.
//   node scripts/generate-placeholder-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BG = [0x1a, 0x5c, 0x3a];
const FG = [0xe6, 0xf0, 0xea];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param ringRadius outer radius of the ring as a fraction of the half-size (keep <= 0.7 for maskable safe zone) */
function png(size, ringRadius = 0.62) {
  const rows = [];
  const c = (size - 1) / 2;
  const outer = ringRadius * (size / 2);
  const inner = outer * 0.62;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const [r, g, b] = d <= outer && d >= inner ? FG : BG;
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A one-image ICO that embeds a PNG (supported by every current browser). */
function ico(pngBuf, size) {
  const header = Buffer.from([0, 0, 1, 0, 1, 0]);
  const entry = Buffer.alloc(16);
  entry[0] = size;
  entry[1] = size;
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(24, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12); // data offset: 6 + 16
  return Buffer.concat([header, entry, pngBuf]);
}

mkdirSync(join(publicDir, 'icons'), { recursive: true });
writeFileSync(join(publicDir, 'icons', 'icon-192.png'), png(192));
writeFileSync(join(publicDir, 'icons', 'icon-512.png'), png(512));
// Maskable icons are cropped to a circle/squircle: keep the artwork inside the central 80% safe zone.
writeFileSync(join(publicDir, 'icons', 'icon-512-maskable.png'), png(512, 0.55));
writeFileSync(join(publicDir, 'apple-touch-icon.png'), png(180));
writeFileSync(join(publicDir, 'favicon.ico'), ico(png(32), 32));
console.log('Placeholder icons written to', publicDir);
