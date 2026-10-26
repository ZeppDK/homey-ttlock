'use strict';

// Writes placeholder PNGs (flat colour + simple padlock) using only Node built-ins.
// Usage: node scripts/make-placeholders.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// bg/fg: [r, g, b]. Padlock drawn in the centre, sized to the shorter side.
function png(width, height, bg, fg) {
  const unit = Math.min(width, height) / 10;
  const cx = width / 2;
  const cy = height / 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filter byte 0 + RGB
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / unit;
      const dy = (y - cy) / unit;
      const body = Math.abs(dx) <= 2.5 && dy >= -0.5 && dy <= 3;
      const r = Math.hypot(dx, dy + 0.5);
      const shackle = dy <= -0.5 && r <= 1.9 && r >= 1.1;
      const color = body || shackle ? fg : bg;
      row[1 + x * 3] = color[0];
      row[2 + x * 3] = color[1];
      row[3 + x * 3] = color[2];
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = path.join(__dirname, '..');
const targets = [
  ['assets/images/small.png', 250, 175, [30, 94, 255], [255, 255, 255]],
  ['assets/images/large.png', 500, 350, [30, 94, 255], [255, 255, 255]],
  ['assets/images/xlarge.png', 1000, 700, [30, 94, 255], [255, 255, 255]],
];
for (const driver of ['lock', 'gateway', 'door_sensor']) {
  targets.push(
    [`drivers/${driver}/assets/images/small.png`, 75, 75, [255, 255, 255], [30, 94, 255]],
    [`drivers/${driver}/assets/images/large.png`, 500, 500, [255, 255, 255], [30, 94, 255]],
    [`drivers/${driver}/assets/images/xlarge.png`, 1000, 1000, [255, 255, 255], [30, 94, 255]],
  );
}
for (const [file, w, h, bg, fg] of targets) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), png(w, h, bg, fg));
  console.log(`wrote ${file} (${w}x${h})`);
}
