import { MultiplaneError } from './errors.mjs';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

export function decodePNG(png) {
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new MultiplaneError('internal_error', 'Invalid PNG.');
  let width, height, channels;
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) throw new MultiplaneError('internal_error', 'Only non-interlaced 8-bit RGB/RGBA PNG is supported.');
      channels = data[9] === 2 ? 3 : 4;
    }
    if (type === 'IDAT') chunks.push(data);
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new MultiplaneError('internal_error', 'PNG data length mismatch.');
  const line = stride + 1;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * line];
    if (filter > 4) throw new MultiplaneError('internal_error', 'Invalid PNG row filter.');
    const row = y * line + 1;
    if (filter === 0) continue;
    if (filter === 1 || (filter === 4 && y === 0)) {
      for (let x = channels; x < stride; x++) raw[row + x] += raw[row + x - channels];
      continue;
    }
    if (filter === 2) {
      if (y) for (let x = 0; x < stride; x++) raw[row + x] += raw[row + x - line];
      continue;
    }
    if (filter === 3) {
      for (let x = 0; x < stride; x++) raw[row + x] += ((x >= channels ? raw[row + x - channels] : 0) + (y ? raw[row + x - line] : 0)) >>> 1;
      continue;
    }
    for (let x = 0; x < stride; x++) {
      const p = row + x;
      const a = x >= channels ? raw[p - channels] : 0;
      const b = raw[p - line];
      const c = x >= channels ? raw[p - line - channels] : 0;
      const predictor = a + b - c;
      const pa = Math.abs(predictor - a), pb = Math.abs(predictor - b), pc = Math.abs(predictor - c);
      const correction = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[p] += correction;
    }
  }
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * line + 1;
    if (channels === 4) { raw.copy(data, y * stride, row, row + stride); continue; }
    for (let x = 0, j = y * width * 4; x < stride; x += 3, j += 4) {
      data[j] = raw[row + x]; data[j + 1] = raw[row + x + 1]; data[j + 2] = raw[row + x + 2]; data[j + 3] = 255;
    }
  }
  return { width, height, data };
}

function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(type, 4, 'ascii'); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

export function encodePNG({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
