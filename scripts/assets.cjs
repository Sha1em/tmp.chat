'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, crc]); }
function distance(x, y, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); }
function icon(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const outline = [[7,5],[17,5],[20,8],[20,15],[17,18],[10,18],[5,21],[5,16],[3,13],[3,9],[7,5]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let samples = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = (x + (sx + .5) / 4) * 24 / size, py = (y + (sy + .5) / 4) * 24 / size;
      const line = outline.some((p, i) => i && distance(px, py, outline[i - 1], p) < 1);
      const dots = [8,12,16].some(cx => Math.hypot(px - cx, py - 11.5) < .85);
      samples += line || dots ? 1 : 0;
    }
    const at = y * (size * 4 + 1) + 1 + x * 4;
    pixels[at] = 73; pixels[at + 1] = 103; pixels[at + 2] = 220; pixels[at + 3] = Math.round(samples / 16 * 255);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
fs.mkdirSync(path.join(root, 'icons'), { recursive: true });
for (const size of [16,32,48,128]) fs.writeFileSync(path.join(root, 'icons', `${size}.png`), icon(size));
console.log('Generated four extension icons.');
