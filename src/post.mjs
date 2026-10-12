import { averageAlpha, resizeAlpha, clearHiddenColors } from './alpha.mjs';
import { MultiplaneError, invalidOption } from './errors.mjs';
import { number, validateScale } from './capture.mjs';
import { decodePNG, encodePNG } from './png.mjs';
import { createHash } from 'node:crypto';
import { decodeNativePNG } from './png-native.mjs';
import sharp from 'sharp';

export const postArgs = ['motion-blur', 'shutter', 'grain', 'no-post', 'adaptive-blur'];
export const scaleArgs = ['scale', 'render-scale', 'upscale'];
export const DEFAULT_ADAPTIVE_BLUR = 0.5;

export function resolveScale(options = {}) {
  const scale = number(options.scale ?? 1, '--scale', { positive: true });
  const renderScale = number(options['render-scale'] ?? scale, '--render-scale', { positive: true });
  if (renderScale > scale) throw invalidOption('--render-scale', '--render-scale must not exceed --scale.');
  const upscale = options.upscale ?? 'lanczos';
  if (!['neighbor', 'lanczos'].includes(upscale)) throw invalidOption('--upscale', '--upscale must be neighbor or lanczos.');
  return { scale, renderScale, upscale };
}

export function imageDifference(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new MultiplaneError('internal_error', 'Sample dimensions differ.');
  let sum = 0;
  if (a.data.byteOffset % 4 === 0 && b.data.byteOffset % 4 === 0) {
    const aa = new Uint32Array(a.data.buffer, a.data.byteOffset, a.data.length / 4);
    const bb = new Uint32Array(b.data.buffer, b.data.byteOffset, b.data.length / 4);
    for (let p = 0; p < aa.length; p++) {
      const x = aa[p], y = bb[p];
      if (x === y) continue;
      sum += Math.abs((x & 255) - (y & 255)) + Math.abs(((x >>> 8) & 255) - ((y >>> 8) & 255)) + Math.abs(((x >>> 16) & 255) - ((y >>> 16) & 255));
    }
    return sum / (a.width * a.height * 3);
  }
  for (let p = 0; p < a.data.length; p += 4) for (let c = 0; c < 3; c++) sum += Math.abs(a.data[p + c] - b.data[p + c]);
  return sum / (a.width * a.height * 3);
}

export async function resizeImage(image, width, height, upscale) {
  const data = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .resize(width, height, { kernel: upscale === 'neighbor' ? 'nearest' : 'lanczos3' }).raw().toBuffer();
  return { width, height, data };
}
export function resolvePost(options = {}, post = {}) {
  if (options['no-post']) return { motionBlur: 1, shutter: 0.5, grain: 0 };
  const motionBlur = number(options['motion-blur'] ?? post.motionBlur ?? 1, 'motionBlur', { positive: true });
  if (!Number.isSafeInteger(motionBlur)) throw invalidOption('motionBlur', 'motionBlur must be a positive integer.');
  return { motionBlur, shutter: number(options.shutter ?? post.shutter ?? 0.5, 'shutter'), grain: number(options.grain ?? post.grain ?? 0, 'grain') };
}

export function sampleTimes(t, fps, duration, cuts, { motionBlur, shutter }) {
  let lo = 0, hi = duration;
  for (const c of cuts) {
    if (t >= c) lo = Math.max(lo, c);
    else hi = Math.min(hi, Math.max(t, c - 1e-6));
  }
  return Array.from({ length: motionBlur }, (_, i) => Math.min(hi, Math.max(lo, t + ((i + 0.5) / motionBlur - 0.5) * shutter / fps)));
}

const linear = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
const transfer = v => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
const transferTable = Uint8Array.from({ length: 65537 }, (_, i) => transfer(i / 65536));
export function linearToByte(v) {
  const index = Math.floor(v * 65536), value = transferTable[index];
  return value === transferTable[index + 1] ? value : transfer(v);
}
export function averageLinear(images) {
  const { width, height } = images[0], data = Buffer.alloc(images[0].data.length);
  if (images.every(image => image.data.byteOffset % 4 === 0)) {
    const words = images.map(image => new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4));
    const output = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
    for (let pixel = 0; pixel < output.length; pixel++) {
      const first = words[0][pixel];
      let equal = true;
      for (let i = 1; i < words.length; i++) if (words[i][pixel] !== first) { equal = false; break; }
      if (equal) { output[pixel] = first; continue; }
      for (let c = 0; c < 4; c++) {
        const p = pixel * 4 + c;
        let sum = 0;
        for (const image of images) sum += c === 3 ? image.data[p] : linear[image.data[p]];
        const v = sum / images.length;
        data[p] = c === 3 ? Math.round(v) : linearToByte(v);
      }
    }
    return { width, height, data };
  }
  for (let p = 0; p < data.length; p++) {
    let sum = 0;
    for (const image of images) sum += p % 4 === 3 ? image.data[p] : linear[image.data[p]];
    const v = sum / images.length;
    data[p] = p % 4 === 3 ? Math.round(v) : linearToByte(v);
  }
  return { width, height, data };
}

const grainTables = new Map();
function grainTable(grain) {
  if (!(grain > 0 && grain <= 128)) return null;
  if (!grainTables.has(grain)) {
    if (grainTables.size === 4) grainTables.delete(grainTables.keys().next().value);
    grainTables.set(grain, Int16Array.from({ length: 65537 }, (_, i) => Math.round((i / 65536 - 0.5) * Math.sqrt(12) * grain)));
  }
  return grainTables.get(grain);
}

export function addGrain(image, grain, frame) {
  const data = Buffer.from(image.data);
  const table = grainTable(grain);
  let state = (frame >>> 0) ^ 0x9e3779b9;
  for (let p = 0; p < data.length; p += 4) {
    state = (state + 0x6d2b79f5) | 0;
    let r = Math.imul(state ^ (state >>> 15), 1 | state);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    const value = (r ^ (r >>> 14)) >>> 0, index = value >>> 16;
    const offset = table && table[index] === table[index + 1] ? table[index]
      : Math.round((value / 4294967296 - 0.5) * Math.sqrt(12) * grain);
    data[p] = Math.max(0, Math.min(255, data[p] + offset));
    data[p + 1] = Math.max(0, Math.min(255, data[p + 1] + offset));
    data[p + 2] = Math.max(0, Math.min(255, data[p + 2] + offset));
  }
  return { ...image, data };
}

export function createPostCapture(capture, options = {}, fps = capture.fps) {
  const alpha = options.alpha ?? capture.alpha ?? capture.post?.alpha ?? false;
  const average = alpha ? averageAlpha : averageLinear;
  const sizes = resolveScale(options);
  validateScale(capture.width, capture.height, sizes.scale);
  validateScale(capture.width, capture.height, sizes.renderScale, '--render-scale');
  const adaptive = number(options['adaptive-blur'] ?? DEFAULT_ADAPTIVE_BLUR, '--adaptive-blur');
  const post = resolvePost(options, capture.post), stats = { samples: 0, staticFrames: 0, adaptiveFrames: 0, hookFrames: 0, reusedDecodes: 0, frames: 0, captureMs: 0, decodeMs: 0, averageMs: 0, grainMs: 0, pngMs: 0, resizeMs: 0 };
  const timed = (key, fn) => { const start = performance.now(); const value = fn(); stats[key] += performance.now() - start; return value; };
  let decodedCache;
  const decode = async (png, reuse = false) => {
    if (reuse && decodedCache?.png.equals(png)) { stats.reusedDecodes++; return decodedCache.image; }
    const start = performance.now();
    let image = options.decoder === 'js' ? decodePNG(png) : await decodeNativePNG(png);
    stats.decodeMs += performance.now() - start;
    if (alpha && sizes.renderScale < 1) {
      const resizeStart = performance.now();
      image = resizeAlpha(image, capture.width * sizes.renderScale, capture.height * sizes.renderScale, sizes.upscale);
      stats.resizeMs += performance.now() - resizeStart;
    }
    if (reuse) decodedCache = { png: Buffer.from(png), image };
    return image;
  };
  const api = {
    post, stats,
    progress: () => `Samples: ${stats.samples}; static: ${stats.staticFrames}; adaptive: ${stats.adaptiveFrames}; hooks: ${stats.hookFrames}`,
    async frame(t, frame = Math.round(t * fps)) {
      let motionBlur = post.motionBlur;
      const hooked = motionBlur > 1 && typeof capture.blurAt === 'function';
      if (hooked) {
        const requested = await capture.blurAt(t);
        if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1) throw new MultiplaneError('shot_contract_invalid', 'SHOT.blurAt(t) must return a positive integer sample count.');
        motionBlur = Math.min(requested, motionBlur);
        stats.hookFrames++;
      }
      const times = sampleTimes(t, fps, capture.duration, capture.cuts, { ...post, motionBlur });
      const cache = new Map();
      const sample = async (time, reuse = false) => {
        if (!cache.has(time)) {
          const start = performance.now();
          const png = await capture.frame(time, { motionBlur });
          stats.captureMs += performance.now() - start;
          stats.samples++;
          cache.set(time, { png, image: post.motionBlur > 1 || post.grain > 0 ? await decode(png, reuse) : null });
        }
        return cache.get(time);
      };
      const sampleMany = async (sequence, reuse = false) => {
        const missing = [...new Set(sequence)].filter(time => !cache.has(time));
        if (!missing.length) return;
        if (!capture.beginFrame || options.pipeline === false) {
          for (const time of missing) await sample(time, reuse);
          return;
        }
        const begin = async time => {
          const start = performance.now(), pending = await capture.beginFrame(time, { motionBlur });
          const png = pending.png.then(buffer => { stats.captureMs += performance.now() - start; return buffer; });
          png.catch(() => {});
          return { png };
        };
        let pending = await begin(missing[0]);
        for (let i = 0; i < missing.length; i++) {
          const png = await pending.png;
          const next = i + 1 < missing.length ? await begin(missing[i + 1]) : null;
          stats.samples++;
          cache.set(missing[i], { png, image: await decode(png, reuse) });
          pending = next;
        }
      };
      let png, result;
      if (motionBlur === 1) ({ png, image: result } = await sample(t));
      else if (hooked) {
        await sampleMany(times);
        result = timed('averageMs', () => average(times.map(time => cache.get(time).image)));
      } else if (adaptive > 0) {
        await sampleMany([times[0], times.at(-1)], true);
        const first = cache.get(times[0]), last = cache.get(times.at(-1));
        const identical = first.image.data === last.image.data || first.image.data.equals(last.image.data);
        if (identical || (!alpha && imageDifference(first.image, last.image) < adaptive)) {
          png = first.png; result = first.image; stats.adaptiveFrames++;
          if (identical) stats.staticFrames++;
        } else {
          await sampleMany(times);
          result = timed('averageMs', () => average(times.map(time => cache.get(time).image)));
        }
      } else {
        await sampleMany([times[0], times.at(-1), t]);
        const first = cache.get(times[0]), last = cache.get(times.at(-1)), center = cache.get(t);
        if (first.image.data.equals(last.image.data) && first.image.data.equals(center.image.data)) {
          png = center.png; result = center.image; stats.staticFrames++;
        } else {
          await sampleMany(times);
          const images = times.map(time => cache.get(time).image);
          result = timed('averageMs', () => average(images));
        }
      }
      stats.frames++;
      if (sizes.renderScale !== sizes.scale) {
        result ??= await decode(png);
        const start = performance.now();
        result = await (alpha ? resizeAlpha : resizeImage)(result, capture.width * sizes.scale, capture.height * sizes.scale, sizes.upscale);
        stats.resizeMs += performance.now() - start;
        png = undefined;
      }
      if (post.grain > 0) result = timed('grainMs', () => addGrain(result, post.grain, frame));
      // Grain changes straight visible RGB only; never alpha or hidden output colors.
      if (alpha) { result = clearHiddenColors(result ?? await decode(png)); png = undefined; }
      if (options.verify) {
        const image = result ??= await decode(png);
        if (image.width !== capture.width * sizes.scale || image.height !== capture.height * sizes.scale) throw new MultiplaneError('internal_error', 'Pixel verification dimensions do not match output.');
        api.lastHash = createHash('sha256').update(image.data).digest('hex');
      }
      if (options.transport === 'raw') {
        const image = result ?? await decode(png);
        return image === decodedCache?.image ? Buffer.from(image.data) : image.data;
      }
      if (post.grain > 0) return timed('pngMs', () => encodePNG(result));
      return png ?? timed('pngMs', () => encodePNG(result));
    },
  };
  if (capture.retryFrame) {
    const frame = api.frame.bind(api);
    api.frame = (t, index) => capture.retryFrame(t, async () => {
      const before = { ...stats };
      try { return await frame(t, index); }
      catch (error) { Object.assign(stats, before); decodedCache = undefined; throw error; }
    });
  }
  return api;
}
