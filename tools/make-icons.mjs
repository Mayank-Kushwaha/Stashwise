// One-off icon generator (Node built-ins only). Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const T = new Uint32Array(256).map((_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc = b => { let c = ~0; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };

function png(n) {
  const raw = Buffer.alloc(n * (n * 4 + 1)), S = 3;
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < S * S; i++) {
        const u = (x + (i % S + .5) / S) / n, v = (y + (Math.floor(i / S) + .5) / S) / n;
        const dx = Math.max(Math.abs(u - .5) - (.5 - .22), 0), dy = Math.max(Math.abs(v - .5) - (.5 - .22), 0);
        if (dx * dx + dy * dy > .22 * .22) continue;
        const rib = u > .3 && u < .7 && v > .2 && v < .65 + Math.abs(u - .5) * .75;
        const t = (u + v) / 2;
        r += rib ? 255 : 79 + 60 * t; g += rib ? 255 : 70 + 20 * t; b += rib ? 255 : 229 + 12 * t; a += 255;
      }
      const o = y * (n * 4 + 1) + 1 + x * 4, c = S * S;
      raw[o] = r / c * (c / (a / 255 || 1)) | 0; raw[o + 1] = g / c * (c / (a / 255 || 1)) | 0; raw[o + 2] = b / c * (c / (a / 255 || 1)) | 0; raw[o + 3] = a / c | 0;
    }
  }
  const h = Buffer.alloc(13); h.writeUInt32BE(n, 0); h.writeUInt32BE(n, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('icons', { recursive: true });
for (const n of [16, 32, 48, 128, 192, 512]) writeFileSync(`icons/icon${n}.png`, png(n));
