// Renders the app icons in public/ from the owner's artwork (public/icon.svg).
//   node scripts/generate-icons.mjs
// sharp comes from the api workspace. The maskable icon is full-bleed (Android crops it to its own shape).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sharp = createRequire(join(here, '..', '..', 'api', 'package.json'))('sharp');
const publicDir = join(here, '..', 'public');
const rounded = readFileSync(join(publicDir, 'icon.svg'));
const square = Buffer.from(rounded.toString().replace(' rx="32"', ''));

const render = (svg, size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

mkdirSync(join(publicDir, 'icons'), { recursive: true });
writeFileSync(join(publicDir, 'icons', 'icon-192.png'), await render(rounded, 192));
writeFileSync(join(publicDir, 'icons', 'icon-512.png'), await render(rounded, 512));
writeFileSync(join(publicDir, 'icons', 'icon-512-maskable.png'), await render(square, 512));
// iOS rounds the corners itself, so it gets the square version
writeFileSync(join(publicDir, 'apple-touch-icon.png'), await render(square, 180));

// favicon.ico: an ICO container holding one 48x48 PNG
const png = await render(rounded, 48);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // one image
header[6] = 48;
header[7] = 48;
header.writeUInt16LE(1, 10); // colour planes
header.writeUInt16LE(32, 12); // bits per pixel
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18); // image offset
writeFileSync(join(publicDir, 'favicon.ico'), Buffer.concat([header, png]));
console.log('Wrote icons to', publicDir);
