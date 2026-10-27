#!/usr/bin/env node
// 生成扩展图标（PNG），零依赖。
// 用法：node scripts/make-icons.mjs
//
// 图标设计：深色圆角方块 + 蓝色「爪」标记，呼应 NetBrowserClaw 的名字。

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'extension', 'icons');

// ---- 最小 PNG 编码器 -------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 原始扫描行：每行前加一个 filter 字节 0
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 绘制 -------------------------------------------------------------------
/** 圆角矩形 + 三道「爪痕」弧线。 */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const na = a / 255;
    px[i] = Math.round(px[i] * (1 - na) + r * na);
    px[i + 1] = Math.round(px[i + 1] * (1 - na) + g * na);
    px[i + 2] = Math.round(px[i + 2] * (1 - na) + b * na);
    px[i + 3] = Math.max(px[i + 3], a);
  };

  const radius = size * 0.22;
  const bg = [0x16, 0x1a, 0x24];
  const fg = [0x6e, 0xa8, 0xfe];

  // 圆角方块背景
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(x, size - 1 - x);
      const cy = Math.min(y, size - 1 - y);
      let inside = true;
      if (cx < radius && cy < radius) {
        const dx = radius - cx;
        const dy = radius - cy;
        inside = dx * dx + dy * dy <= radius * radius;
      }
      if (inside) set(x, y, bg[0], bg[1], bg[2], 255);
    }
  }

  // 三条斜向爪痕
  const strokes = 3;
  for (let s = 0; s < strokes; s++) {
    const offset = size * (0.26 + s * 0.17);
    const thickness = Math.max(1.5, size * 0.075);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // 主对角线方向
        const d = Math.abs((y - offset) - (x - offset) * 0.35);
        if (d < thickness && x > size * 0.18 && x < size * 0.86 && y > size * 0.16 && y < size * 0.88) {
          // 端点圆角
          set(x, y, fg[0], fg[1], fg[2], 255);
        }
      }
    }
  }

  return px;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, drawIcon(size));
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png);
  process.stdout.write(`生成 ${file} (${png.length} bytes)\n`);
}
