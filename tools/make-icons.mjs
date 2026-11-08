// アプリアイコン（180 / 192 / 512px）を生成する。外部パッケージは使わない。
//   node tools/make-icons.mjs
// 差し替えたいときは icons/ の PNG を好きな画像で上書きすればよい。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'icons');

// ---- PNG 書き出し（RGB・8bit） ----

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function writePng(path, size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor (RGB)
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  // 各行の先頭にフィルタ種別 0 を付ける
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const dst = y * (size * 3 + 1);
    raw[dst] = 0;
    rgb.copy(raw, dst + 1, y * size * 3, (y + 1) * size * 3);
  }

  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

// ---- 絵柄（黒地に「読むライン」の黄色い三角と 3 行の原稿） ----

const BG = [0, 0, 0];
const YELLOW = [0xff, 0xd6, 0x0a];
const WHITE = [0xff, 0xff, 0xff];
const DIM = [0x73, 0x73, 0x73];   // 白 45% を黒地に重ねた色

// 正規化座標（0〜1）。中心 y=0.5 が現在行。
const BARS = [
  { y: 0.295, x0: 0.30, x1: 0.74, color: DIM },
  { y: 0.500, x0: 0.30, x1: 0.86, color: YELLOW },
  { y: 0.705, x0: 0.30, x1: 0.78, color: WHITE }
];
const BAR_H = 0.062;
const MARK = { x0: 0.135, x1: 0.235, y: 0.500, half: 0.078 };

function inRoundRect(x, y, x0, x1, yc, h) {
  const y0 = yc - h / 2, y1 = yc + h / 2;
  const r = h / 2;
  if (y < y0 || y > y1) return false;
  if (x < x0 || x > x1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const dy = y - yc;
  if (x >= x0 + r && x <= x1 - r) return true;
  const dx = x - cx;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(x, y, t) {
  if (x < t.x0 || x > t.x1) return false;
  // 左辺が垂直、右へ向かって尖る二等辺三角形
  const k = (x - t.x0) / (t.x1 - t.x0);     // 0 → 1
  const half = t.half * (1 - k);
  return Math.abs(y - t.y) <= half;
}

function colorAt(x, y) {
  if (inTriangle(x, y, MARK)) return YELLOW;
  for (const b of BARS) {
    if (inRoundRect(x, y, b.x0, b.x1, b.y, BAR_H)) return b.color;
  }
  return null;
}

function render(size) {
  const SS = 3;                    // 3x3 のスーパーサンプリングで輪郭をなめらかにする
  const rgb = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const c = colorAt(x, y) || BG;
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS;
      const o = (py * size + px) * 3;
      rgb[o] = Math.round(r / n);
      rgb[o + 1] = Math.round(g / n);
      rgb[o + 2] = Math.round(b / n);
    }
  }
  return rgb;
}

mkdirSync(OUT, { recursive: true });
for (const size of [180, 192, 512]) {
  const path = join(OUT, `icon-${size}.png`);
  writePng(path, size, render(size));
  console.log(`icons/icon-${size}.png`);
}
console.log('アイコンを生成しました。差し替えるときは icons/ の PNG を上書きしてください。');
