import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const SIZE = 128;
const OUT_DIR = path.resolve(process.cwd(), 'public/emojis');

// CRC32 table for valid PNG chunks
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width: number, height: number, rgba: Uint8Array): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

type RGBA = [number, number, number, number];

class Canvas {
  data = new Uint8Array(SIZE * SIZE * 4);

  blend(x: number, y: number, r: number, g: number, b: number, a: number) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE || a <= 0) return;
    const idx = (y * SIZE + x) * 4;
    const srcA = Math.min(1, a);
    const dstA = this.data[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;
    this.data[idx] = Math.round((r * srcA + this.data[idx] * dstA * (1 - srcA)) / outA);
    this.data[idx + 1] = Math.round((g * srcA + this.data[idx + 1] * dstA * (1 - srcA)) / outA);
    this.data[idx + 2] = Math.round((b * srcA + this.data[idx + 2] * dstA * (1 - srcA)) / outA);
    this.data[idx + 3] = Math.round(outA * 255);
  }

  samplePixel(fn: (nx: number, ny: number) => RGBA | null) {
    const samples = 3;
    const inv = 1 / samples;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let sy = 0; sy < samples; sy++) {
          for (let sx = 0; sx < samples; sx++) {
            const nx = ((x + (sx + 0.5) * inv) / SIZE) * 2 - 1;
            const ny = ((y + (sy + 0.5) * inv) / SIZE) * 2 - 1;
            const res = fn(nx, ny);
            if (res && res[3] > 0) {
              const a = res[3];
              sr += res[0] * a;
              sg += res[1] * a;
              sb += res[2] * a;
              sa += a;
            }
          }
        }
        const total = samples * samples;
        if (sa > 0) {
          this.blend(x, y, sr / sa, sg / sa, sb / sa, sa / total);
        }
      }
    }
  }
}

function clamp(v: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * clamp(t);
}

function distSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : clamp((wx * vx + wy * vy) / len2);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function faceBase(nx: number, ny: number, topCol: [number, number, number], botCol: [number, number, number]): RGBA | null {
  const r = Math.hypot(nx, ny);
  if (r > 0.86) return null;
  const t = clamp((ny + 0.86) / 1.72);
  let cr = mix(topCol[0], botCol[0], t);
  let cg = mix(topCol[1], botCol[1], t);
  let cb = mix(botCol[2] === botCol[2] ? topCol[2] : topCol[2], botCol[2], t);
  // Specular highlight top-left
  const hl = Math.exp(-((nx + 0.25) ** 2 + (ny + 0.35) ** 2) * 5.2) * 0.26;
  cr = Math.min(255, cr + hl * 255);
  cg = Math.min(255, cg + hl * 255);
  cb = Math.min(255, cb + hl * 255);
  // Subtle dark rim
  if (r > 0.81) {
    cr *= 0.82;
    cg *= 0.82;
    cb *= 0.82;
  }
  return [cr, cg, cb, 1];
}

const DARK_INK: RGBA = [24, 24, 34, 1];
const WARM_GOLD_TOP: [number, number, number] = [255, 224, 92];
const WARM_GOLD_BOT: [number, number, number] = [245, 165, 36];

function renderEmoji(name: string): Buffer {
  const c = new Canvas();

  if (name === 'laugh') {
    c.samplePixel((nx, ny) => {
      const base = faceBase(nx, ny, WARM_GOLD_TOP, WARM_GOLD_BOT);
      if (!base) return null;
      // Happy squinting arc eyes
      const leftEye = Math.abs(Math.hypot(nx + 0.28, ny + 0.08) - 0.14) < 0.042 && ny < -0.06;
      const rightEye = Math.abs(Math.hypot(nx - 0.28, ny + 0.08) - 0.14) < 0.042 && ny < -0.06;
      if (leftEye || rightEye) return DARK_INK;
      // Big open smile D shape
      if (ny > 0.12 && ny < 0.54 && Math.abs(nx) < 0.44 && nx * nx * 2.1 + (ny - 0.12) * (ny - 0.12) < 0.19) {
        if (ny < 0.21) return [255, 255, 255, 1];
        if (ny > 0.38 && Math.abs(nx) < 0.22) return [242, 92, 118, 1];
        return DARK_INK;
      }
      // Rosy cheeks
      if (Math.hypot(nx + 0.46, ny - 0.12) < 0.13 || Math.hypot(nx - 0.46, ny - 0.12) < 0.13) {
        return [248, 118, 102, 0.55];
      }
      return base;
    });
  } else if (name === 'heart') {
    c.samplePixel((nx, ny) => {
      const x = nx * 1.15;
      const y = -ny * 1.15 - 0.1;
      const eq = (x * x + y * y - 0.55) ** 3 - x * x * y * y * y * 1.65;
      if (eq <= 0) {
        const t = clamp((ny + 0.7) / 1.4);
        const hl = Math.exp(-((nx + 0.25) ** 2 + (ny + 0.3) ** 2) * 6) * 0.28;
        return [
          Math.min(255, mix(255, 212, t) + hl * 255),
          Math.min(255, mix(82, 34, t) + hl * 255),
          Math.min(255, mix(118, 68, t) + hl * 255),
          1,
        ];
      }
      return null;
    });
  } else if (name === 'fire') {
    c.samplePixel((nx, ny) => {
      const y = (ny + 0.15) * 0.9;
      const wave = Math.sin(ny * 4.5) * 0.08;
      const outer = Math.hypot((nx - wave) * 1.25, y - 0.15) < 0.62 * (1 - clamp((0.6 - ny) * 0.5, 0, 0.75)) && ny < 0.78 && ny > -0.82;
      if (!outer) return null;
      const inner = Math.hypot(nx * 1.35, ny - 0.26) < 0.32;
      if (inner) return [255, 232, 105, 1];
      const t = clamp((ny + 0.75) / 1.5);
      return [mix(255, 238, t), mix(155, 68, t), mix(40, 28, t), 1];
    });
  } else if (name === 'sparkles') {
    c.samplePixel((nx, ny) => {
      const star = (cx: number, cy: number, s: number) => {
        const dx = Math.abs(nx - cx) / s;
        const dy = Math.abs(ny - cy) / s;
        return Math.pow(dx, 0.55) + Math.pow(dy, 0.55) < 0.92;
      };
      if (star(-0.08, -0.05, 0.62)) {
        const t = clamp((ny + 0.6) / 1.2);
        return [255, mix(236, 178, t), mix(115, 48, t), 1];
      }
      if (star(0.48, -0.46, 0.28) || star(0.45, 0.44, 0.24)) {
        return [145, 185, 255, 1];
      }
      return null;
    });
  } else if (name === 'cool') {
    c.samplePixel((nx, ny) => {
      const base = faceBase(nx, ny, WARM_GOLD_TOP, WARM_GOLD_BOT);
      if (!base) return null;
      // Sunglasses frame & lenses
      const bar = Math.abs(ny + 0.14) < 0.04 && Math.abs(nx) < 0.66;
      const leftLens = nx > -0.58 && nx < -0.07 && ny > -0.18 && ny < 0.12 && Math.hypot((nx + 0.32) * 0.9, (ny + 0.04) * 1.4) < 0.27;
      const rightLens = nx > 0.07 && nx < 0.58 && ny > -0.18 && ny < 0.12 && Math.hypot((nx - 0.32) * 0.9, (ny + 0.04) * 1.4) < 0.27;
      if (leftLens || rightLens) {
        if (Math.abs((nx + ny) + 0.32) < 0.05 || Math.abs((nx + ny) - 0.22) < 0.05) return [85, 110, 165, 1];
        return [22, 24, 34, 1];
      }
      if (bar) return [28, 30, 42, 1];
      // Confident smirk
      const smirk = Math.abs(ny - (0.34 - nx * 0.16 + nx * nx * 0.35)) < 0.04 && nx > -0.24 && nx < 0.36;
      if (smirk) return DARK_INK;
      return base;
    });
  } else if (name === 'shock') {
    c.samplePixel((nx, ny) => {
      const base = faceBase(nx, ny, WARM_GOLD_TOP, WARM_GOLD_BOT);
      if (!base) return null;
      // Wide eyes
      if (Math.hypot(nx + 0.28, ny + 0.16) < 0.15 || Math.hypot(nx - 0.28, ny + 0.16) < 0.15) {
        if (Math.hypot(nx + 0.28, ny + 0.16) < 0.065 || Math.hypot(nx - 0.28, ny + 0.16) < 0.065) return DARK_INK;
        return [255, 255, 255, 1];
      }
      // Open O mouth
      if (Math.hypot(nx * 1.25, ny - 0.36) < 0.2) return DARK_INK;
      return base;
    });
  } else if (name === 'cry') {
    c.samplePixel((nx, ny) => {
      const base = faceBase(nx, ny, WARM_GOLD_TOP, WARM_GOLD_BOT);
      if (!base) return null;
      // Sad eyes
      if (Math.hypot(nx + 0.28, ny + 0.12) < 0.09 || Math.hypot(nx - 0.28, ny + 0.12) < 0.09) return DARK_INK;
      // Tear stream
      if (Math.abs(nx - 0.32) < 0.08 && ny > -0.02 && ny < 0.68) return [82, 178, 255, 0.92];
      // Frown arc
      const frown = Math.abs(Math.hypot(nx, ny - 0.56) - 0.24) < 0.042 && ny < 0.44;
      if (frown) return DARK_INK;
      return base;
    });
  } else if (name === 'thumbsup') {
    c.samplePixel((nx, ny) => {
      const palm = nx > -0.35 && nx < 0.45 && ny > -0.1 && ny < 0.65 && Math.hypot((nx - 0.05) * 0.95, (ny - 0.28) * 0.95) < 0.46;
      const thumb = Math.hypot((nx + 0.06 - (ny + 0.3) * 0.15) * 1.6, (ny + 0.35) * 0.9) < 0.32;
      const cuff = nx > -0.68 && nx < -0.3 && ny > 0.05 && ny < 0.62;
      if (cuff) return [91, 124, 250, 1];
      if (palm || thumb) {
        const t = clamp((ny + 0.6) / 1.2);
        return [mix(255, 240, t), mix(214, 168, t), mix(98, 42, t), 1];
      }
      return null;
    });
  } else if (name === 'rocket') {
    c.samplePixel((nx, ny) => {
      // Diagonal rocket pointing top-right
      const rx = (nx + ny) * 0.707;
      const ry = (ny - nx) * 0.707;
      if (Math.abs(rx) < 0.26 * (1 - clamp((-ry) * 0.6, -0.2, 0.85)) && ry > -0.78 && ry < 0.42) {
        if (ry < -0.38) return [239, 68, 68, 1];
        if (Math.hypot(rx, ry + 0.08) < 0.11) return [91, 165, 255, 1];
        return [240, 244, 252, 1];
      }
      // Fins
      if (ry > 0.16 && ry < 0.48 && Math.abs(rx) > 0.18 && Math.abs(rx) < 0.42) return [239, 68, 68, 1];
      // Exhaust flame
      if (ry >= 0.42 && ry < 0.85 && Math.abs(rx) < 0.22 * (1 - (ry - 0.42) / 0.46)) {
        return ry < 0.62 ? [255, 220, 75, 1] : [249, 115, 22, 1];
      }
      return null;
    });
  } else if (name === 'check') {
    c.samplePixel((nx, ny) => {
      const r = Math.hypot(nx, ny);
      if (r > 0.84) return null;
      const d1 = distSeg(nx, ny, -0.36, 0.02, -0.1, 0.28);
      const d2 = distSeg(nx, ny, -0.1, 0.28, 0.4, -0.28);
      if (d1 < 0.1 || d2 < 0.1) return [255, 255, 255, 1];
      const t = clamp((ny + 0.8) / 1.6);
      return [mix(42, 22, t), mix(212, 163, t), mix(118, 74, t), 1];
    });
  } else if (name === 'crown') {
    c.samplePixel((nx, ny) => {
      if (ny > 0.36 && ny < 0.56 && Math.abs(nx) < 0.68) return [245, 158, 11, 1];
      if (ny > -0.45 && ny <= 0.36 && Math.abs(nx) < 0.68) {
        const peakCenter = Math.max(
          1 - Math.abs(nx) * 2.1,
          1 - Math.abs(nx + 0.52) * 2.4,
          1 - Math.abs(nx - 0.52) * 2.4
        );
        if (ny > 0.36 - peakCenter * 0.78) {
          if (Math.hypot(nx, ny - 0.12) < 0.09) return [91, 124, 250, 1];
          return [255, 212, 64, 1];
        }
      }
      if (Math.hypot(nx, ny + 0.44) < 0.09 || Math.hypot(nx + 0.52, ny + 0.36) < 0.08 || Math.hypot(nx - 0.52, ny + 0.36) < 0.08) {
        return [255, 228, 112, 1];
      }
      return null;
    });
  } else if (name === 'wave') {
    c.samplePixel((nx, ny) => {
      const palm = Math.hypot((nx - 0.02) * 1.15, (ny - 0.18) * 0.95) < 0.44;
      const f1 = distSeg(nx, ny, -0.28, -0.05, -0.42, -0.52) < 0.095;
      const f2 = distSeg(nx, ny, -0.1, -0.12, -0.16, -0.64) < 0.095;
      const f3 = distSeg(nx, ny, 0.08, -0.12, 0.1, -0.62) < 0.095;
      const f4 = distSeg(nx, ny, 0.25, -0.04, 0.36, -0.46) < 0.09;
      const thumb = distSeg(nx, ny, 0.28, 0.22, 0.56, 0.02) < 0.095;
      if (palm || f1 || f2 || f3 || f4 || thumb) {
        const t = clamp((ny + 0.6) / 1.2);
        return [mix(255, 240, t), mix(218, 168, t), mix(98, 42, t), 1];
      }
      return null;
    });
  } else if (name === 'party') {
    c.samplePixel((nx, ny) => {
      // Party cone
      const cone = ny > -0.55 && ny < 0.62 && Math.abs(nx + (ny - 0.62) * 0.35) < (0.62 - ny) * 0.38;
      if (cone) {
        const stripe = Math.sin((nx + ny) * 14) > 0;
        return stripe ? [91, 124, 250, 1] : [255, 212, 64, 1];
      }
      // Confetti dots
      if (Math.hypot(nx - 0.42, ny + 0.45) < 0.09) return [244, 63, 94, 1];
      if (Math.hypot(nx - 0.54, ny + 0.08) < 0.08) return [34, 197, 94, 1];
      if (Math.hypot(nx + 0.44, ny + 0.36) < 0.08) return [168, 85, 247, 1];
      return null;
    });
  } else if (name === 'eyes') {
    c.samplePixel((nx, ny) => {
      const l = Math.hypot((nx + 0.34) * 1.35, ny * 0.88);
      const r = Math.hypot((nx - 0.34) * 1.35, ny * 0.88);
      if (l < 0.42) {
        if (Math.hypot(nx + 0.42, ny - 0.02) < 0.14) return DARK_INK;
        return [250, 252, 255, 1];
      }
      if (r < 0.42) {
        if (Math.hypot(nx - 0.26, ny - 0.02) < 0.14) return DARK_INK;
        return [250, 252, 255, 1];
      }
      return null;
    });
  } else if (name === '100') {
    c.samplePixel((nx, ny) => {
      // Bold stylized "100" badge
      const one = nx > -0.66 && nx < -0.5 && Math.abs(ny + 0.08) < 0.38;
      const z1 = Math.abs(Math.hypot((nx + 0.12) * 1.35, (ny + 0.08) * 0.85) - 0.23) < 0.08;
      const z2 = Math.abs(Math.hypot((nx - 0.42) * 1.35, (ny + 0.08) * 0.85) - 0.23) < 0.08;
      const u1 = distSeg(nx, ny, -0.64, 0.44, 0.62, 0.36) < 0.06;
      const u2 = distSeg(nx, ny, -0.58, 0.6, 0.56, 0.52) < 0.055;
      if (one || z1 || z2 || u1 || u2) return [239, 68, 68, 1];
      return null;
    });
  } else if (name === 'mindblown') {
    c.samplePixel((nx, ny) => {
      // Cloud burst on top
      if (ny < -0.16 && (Math.hypot(nx, ny + 0.42) < 0.32 || Math.hypot(nx + 0.32, ny + 0.32) < 0.22 || Math.hypot(nx - 0.32, ny + 0.32) < 0.22)) {
        return [251, 146, 60, 1];
      }
      if (ny > -0.18) {
        const base = faceBase(nx, ny, WARM_GOLD_TOP, WARM_GOLD_BOT);
        if (!base) return null;
        if (Math.hypot(nx + 0.26, ny - 0.05) < 0.09 || Math.hypot(nx - 0.26, ny - 0.05) < 0.09) return DARK_INK;
        if (Math.hypot(nx * 1.3, ny - 0.4) < 0.16) return DARK_INK;
        return base;
      }
      return null;
    });
  }

  return encodePNG(SIZE, SIZE, c.data);
}

const EMOJI_NAMES = [
  'laugh',
  'heart',
  'fire',
  'sparkles',
  'cool',
  'shock',
  'cry',
  'thumbsup',
  'rocket',
  'check',
  'crown',
  'wave',
  'party',
  'eyes',
  '100',
  'mindblown',
];

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const name of EMOJI_NAMES) {
  const png = renderEmoji(name);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), png);
}
console.log(`Generated ${EMOJI_NAMES.length} 128x128 transparent PNG emojis in ${OUT_DIR}`);
