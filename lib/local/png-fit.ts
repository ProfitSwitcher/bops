/**
 * Fit a screenshot to a fixed width before a vision model sees it.
 * Coordinates the model returns are in that image and scale back to the screen.
 */
import { deflateSync, inflateSync } from "node:zlib";

export const SENT_WIDTH = 1024;

export function scaleCoord(value: number | undefined, screen: number, sent: number): number | undefined {
  if (value == null || !Number.isFinite(value)) return value;
  if (!screen || !sent || screen === sent) return Math.round(value);
  return Math.round((value * screen) / sent);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** A solid RGB PNG, for tests. */
export function solidPng(width: number, height: number, rgb: [number, number, number] = [20, 40, 60]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  return encodePng(width, height, 2, Buffer.concat(rows));
}

function encodePng(width: number, height: number, color: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = color;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

type Decoded = { width: number; height: number; color: number; raw: Buffer };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(png: Buffer): Decoded | null {
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return null;
  let width = 0;
  let height = 0;
  let color = 2;
  let interlace = 0;
  const idat: Buffer[] = [];
  let o = 8;
  while (o + 8 <= png.length) {
    const len = png.readUInt32BE(o);
    const type = png.toString("ascii", o + 4, o + 8);
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) return null;
      color = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const channels = color === 6 ? 4 : color === 2 ? 3 : color === 0 ? 1 : 0;
  if (!width || !height || !channels || interlace) return null;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  const raw = Buffer.alloc(height * stride);
  let i = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[i++];
    const row = inflated.subarray(i, i + stride);
    i += stride;
    const prev = y ? raw.subarray((y - 1) * stride, y * stride) : null;
    const out = raw.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;
      const v = row[x];
      if (filter === 0) out[x] = v;
      else if (filter === 1) out[x] = (v + left) & 255;
      else if (filter === 2) out[x] = (v + up) & 255;
      else if (filter === 3) out[x] = (v + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) out[x] = (v + paeth(left, up, upLeft)) & 255;
      else return null;
    }
  }
  return { width, height, color, raw };
}

/** Shrink a PNG so its width is at most `maxWidth`, keeping the aspect ratio. */
export function fitPng(png: Buffer, maxWidth = SENT_WIDTH): { png: Buffer; screenW: number; screenH: number; sentW: number; sentH: number } | null {
  const src = decodePng(png);
  if (!src) return null;
  if (src.width <= maxWidth) return { png, screenW: src.width, screenH: src.height, sentW: src.width, sentH: src.height };
  const channels = src.color === 6 ? 4 : src.color === 2 ? 3 : 1;
  const sentW = maxWidth;
  const sentH = Math.max(1, Math.round((src.height * sentW) / src.width));
  const raw = Buffer.alloc(sentH * (1 + sentW * channels));
  for (let y = 0; y < sentH; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / sentH));
    const dest = raw.subarray(y * (1 + sentW * channels));
    dest[0] = 0;
    for (let x = 0; x < sentW; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / sentW));
      const from = (sy * src.width + sx) * channels;
      const to = 1 + x * channels;
      for (let c = 0; c < channels; c++) dest[to + c] = src.raw[from + c];
    }
  }
  return { png: encodePng(sentW, sentH, src.color, raw), screenW: src.width, screenH: src.height, sentW, sentH };
}
