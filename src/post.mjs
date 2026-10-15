import { reuseEnabled, reuseState, reuseReport, REUSE_INTERVAL } from './static-reuse.mjs';
import { pixelDifference, classifyPixelDifference } from './pixel-comparison.mjs';
import { averageAlpha, resizeAlpha, clearHiddenColors } from './alpha.mjs';
import { MultiplaneError, invalidOption } from './errors.mjs';
import { number, validateScale } from './capture.mjs';
import { decodePNG, encodePNG } from './png.mjs';
import { createHash } from 'node:crypto';
import { decodeNativePNG } from './png-native.mjs';
import sharp from 'sharp';

export const postArgs = ['quality', 'motion-blur', 'max-motion-blur', 'shutter', 'grain', 'no-post', 'adaptive-blur'];
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
export function resolveQuality(options = {}) {
  const quality = options.quality ?? (options.draft ? 'draft' : 'standard');
  if (!['draft', 'fast', 'standard', 'high'].includes(quality) || (options.draft && quality !== 'draft')) throw invalidOption('--quality', 'Quality must be draft, fast, standard or high, and agree with --draft.');
  return quality;
}

export function resolvePost(options = {}, post = {}) {
  const quality = resolveQuality(options);
  if (options['no-post']) return { motionBlur: 1, maxMotionBlur: 1, shutter: 0.5, grain: 0 };
  let motionBlur = number(options['motion-blur'] ?? post.motionBlur ?? 1, 'motionBlur', { positive: true });
  if (!Number.isSafeInteger(motionBlur)) throw invalidOption('motionBlur', 'motionBlur must be a positive integer.');
  const maxMotionBlur = number(quality === 'draft' ? 1 : options['max-motion-blur'] ?? post.maxMotionBlur ?? (quality === 'high' ? 256 : quality === 'fast' ? 16 : 32), 'maxMotionBlur', { positive: true });
  if (!Number.isSafeInteger(maxMotionBlur)) throw invalidOption('maxMotionBlur', 'maxMotionBlur must be a positive integer.');
  // Preserve explicit bases and fixed sampling before applying the preset cap.
  if ((quality === 'standard' || quality === 'fast') && options['motion-blur'] == null && maxMotionBlur > motionBlur) motionBlur = Math.min(motionBlur, 4);
  // TODO(design): Document max <= base as disabling upward adaptation, including draft overrides.
  return { motionBlur, maxMotionBlur, shutter: number(options.shutter ?? post.shutter ?? 0.5, 'shutter'), grain: number(options.grain ?? post.grain ?? 0, 'grain') };
}

// Local temporal change divided by spatial edge strength estimates displacement.
// Edge normalization avoids treating dense text as faster than a single straight edge.
export function localMotionDifference(a, b, alpha = false, stopAbove = Infinity) {
  if (a.width !== b.width || a.height !== b.height) throw new MultiplaneError('internal_error', 'Sample dimensions differ.');
  let maximum = 0;
  const channels = alpha ? 4 : 3;
  const value = (image, p, c) => image.data[p + c] * (alpha && c < 3 ? image.data[p + 3] / 255 : 1);
  for (let y = 0; y < a.height; y += 8) for (let x = 0; x < a.width; x += 8) {
    const right = Math.min(x + 8, a.width), bottom = Math.min(y + 8, a.height);
    let changed = false;
    for (let yy = y; yy < bottom && !changed; yy++) for (let xx = x; xx < right && !changed; xx++) {
      const p = (yy * a.width + xx) * 4;
      for (let c = 0; c < channels; c++) if (value(a, p, c) !== value(b, p, c)) { changed = true; break; }
    }
    if (!changed) continue;
    const sums = [0, 0, 0, 0], edgesA = [0, 0, 0, 0], edgesB = [0, 0, 0, 0];
    for (let yy = y; yy < bottom; yy++) for (let xx = x; xx < right; xx++) {
      const p = (yy * a.width + xx) * 4;
      for (let c = 0; c < channels; c++) {
        const av = value(a, p, c), bv = value(b, p, c);
        sums[c] += Math.abs(av - bv);
        if (xx > 0) {
          edgesA[c] += Math.abs(av - value(a, p - 4, c));
          edgesB[c] += Math.abs(bv - value(b, p - 4, c));
        }
        if (yy > 0) {
          edgesA[c] += Math.abs(av - value(a, p - a.width * 4, c));
          edgesB[c] += Math.abs(bv - value(b, p - b.width * 4, c));
        }
      }
    }
    // A byte-scale floor bounds division in flat or nearly flat blocks.
    for (let c = 0; c < channels; c++) maximum = Math.max(maximum, sums[c] / Math.max(16, edgesA[c], edgesB[c]));
    if (maximum > stopAbove) return maximum;
  }
  return maximum;
}

export function blurSampleReport(histogram) {
  const entries = Object.entries(histogram).map(([n, count]) => [Number(n), count]).filter(([, count]) => count > 0).sort((a, b) => a[0] - b[0]);
  const frames = entries.reduce((sum, [, count]) => sum + count, 0);
  return { min: entries[0]?.[0] ?? 0, max: entries.at(-1)?.[0] ?? 0,
    mean: frames ? entries.reduce((sum, [n, count]) => sum + n * count, 0) / frames : 0, histogram: Object.fromEntries(entries) };
}

export function sampleTimes(t, fps, duration, cuts, { motionBlur, shutter }) {
  let lo = 0, hi = duration;
  for (const c of cuts) {
    if (t >= c) lo = Math.max(lo, c);
    else hi = Math.min(hi, Math.max(t, c - 1e-6));
  }
  return Array.from({ length: motionBlur }, (_, i) => Math.min(hi, Math.max(lo, t + ((i + 0.5) / motionBlur - 0.5) * shutter / fps)));
}

// Work backwards from the final midpoint grid. Mirrored pairs keep the
// centroid at zero; each smaller level chooses evenly spaced remaining pairs.
export function nestedSampleGrids(t, fps, duration, cuts, post) {
  const counts = [post.motionBlur];
  while (counts.at(-1) < post.maxMotionBlur) counts.push(Math.min(post.maxMotionBlur, counts.at(-1) * 2));
  const maximum = counts.at(-1);
  let pairs = Array.from({ length: Math.floor(maximum / 2) }, (_, i) => (i + 0.5) / maximum - 0.5);
  const grids = new Map();
  for (const count of [...counts].reverse()) {
    const size = Math.floor(count / 2);
    let first = 0;
    pairs = Array.from({ length: size }, (_, i) => {
      const target = (i + 0.5) / count - 0.5;
      let best = first;
      for (let j = first + 1; j <= pairs.length - (size - i); j++) {
        if (Math.abs(pairs[j] - target) < Math.abs(pairs[best] - target)) best = j;
      }
      first = best + 1;
      return pairs[best];
    });
    const offsets = [...pairs, ...(count % 2 ? [0] : []), ...pairs.map(x => -x)].sort((a, b) => a - b);
    // Reuse the existing clipping rules, including the cut epsilon.
    const bounds = sampleTimes(t, fps, duration, cuts, { motionBlur: 2, shutter: post.shutter * 2 });
    grids.set(count, offsets.map(x => Math.min(bounds[1], Math.max(bounds[0], t + x * post.shutter / fps))));
  }
  return grids;
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
  const post = resolvePost(options, capture.post), stats = { samples: 0, staticFrames: 0, adaptiveFrames: 0, hookFrames: 0, reusedDecodes: 0, frames: 0, observeMs: 0, auditMs: 0, captureMs: 0, decodeMs: 0, averageMs: 0, grainMs: 0, pngMs: 0, resizeMs: 0 };
  const timed = (key, fn) => { const start = performance.now(); const value = fn(); stats[key] += performance.now() - start; return value; };
  let decodedCache, previousRaw;
  const state = reuseState(options);
  const enabled = reuseEnabled(options) && !!capture.observe;
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
    get staticReuse() { return reuseReport(options); },
    progress: () => `Samples: ${stats.samples}; static: ${stats.staticFrames}; adaptive: ${stats.adaptiveFrames}; hooks: ${stats.hookFrames}`,
    async frame(t, frame = Math.round(t * fps), audit = false) {
      let motionBlur = post.motionBlur;
      const hooked = motionBlur > 1 && typeof capture.blurAt === 'function';
      if (hooked) {
        const requested = await capture.blurAt(t);
        if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1) throw new MultiplaneError('shot_contract_invalid', 'SHOT.blurAt(t) must return a positive integer sample count.');
        motionBlur = Math.min(requested, motionBlur);
        stats.hookFrames++;
      }
      // Explicit shot hooks retain their existing authority over sampling.
      // TODO(design): Document that blurAt bypasses upward adaptation.
      const upward = !hooked && motionBlur > 1 && post.maxMotionBlur > motionBlur;
      const initialMotionBlur = motionBlur;
      const grids = upward ? nestedSampleGrids(t, fps, capture.duration, capture.cuts, post) : null;
      const endpoints = sampleTimes(t, fps, capture.duration, capture.cuts, { motionBlur: 2, shutter: post.shutter * 2 });
      const times = sampleTimes(t, fps, capture.duration, capture.cuts, { ...post, motionBlur: upward ? Math.max(2, motionBlur) : motionBlur });
      // Clipped or zero-width shutters may contain fewer unique temporal samples.
      const motionBlurBase = new Set(upward ? grids.get(motionBlur) : times).size;
      let candidate = false, uniform = motionBlur === 1, observedTime;
      if (enabled && !Atomics.load(state, 0)) {
        const probes = [...new Set(motionBlur === 1 && !upward ? [t] : [...endpoints, ...times, t])].sort((a, b) => a - b);
        const changes = [];
        const observeStart = performance.now();
        for (const time of probes) {
          changes.push(await capture.observe(time, { motionBlur, motionBlurBase }));
          observedTime = time;
          if (changes.at(-1)) break;
        }
        stats.observeMs += performance.now() - observeStart;
        uniform = !changes.some(Boolean);
        const nearCut = capture.cuts.some(c => Math.abs(t - c) <= 1 / fps + 1e-9 || (previousRaw && c > previousRaw.t && c <= t));
        candidate = !!previousRaw && previousRaw.uniform && previousRaw.motionBlur === motionBlur
          && frame === previousRaw.frame + 1 && t > previousRaw.t && !nearCut && !changes.some(Boolean);
      }
      const verifyReuse = candidate && (audit || previousRaw.run === 0 || frame % REUSE_INTERVAL === 0);
      const cache = new Map();
      let contextUsed = false, motionProbeUsed = false;
      let finalCapture = hooked || motionBlur === 1;
      let selectedTimes = times;
      let dofMotionSamples = new Set(times).size;
      const context = observed => ({ motionBlur, motionBlurBase, observed,
        motionProbeTime: finalCapture ? undefined : t,
        dofMotionSamples: finalCapture ? dofMotionSamples : undefined });
      const sample = async (time, reuse = false) => {
        if (!cache.has(time)) {
          const start = performance.now();
          const observed = time === observedTime && !(motionBlur > 1 && capture.motionProbeUsed);
          observedTime = undefined;
          const png = await capture.frame(time, context(observed));
          contextUsed ||= capture.sampleContextUsed === true;
          motionProbeUsed ||= capture.motionProbeUsed === true;
          stats.captureMs += performance.now() - start;
          stats.samples++;
          cache.set(time, { png, dofSamples: capture.dofSamples ?? 0, probe: capture.motionProbeUsed === true && !finalCapture, image: post.motionBlur > 1 || upward || post.grain > 0 ? await decode(png, reuse) : null });
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
          const start = performance.now(), observed = time === observedTime && !(motionBlur > 1 && capture.motionProbeUsed);
          observedTime = undefined;
          const pending = await capture.beginFrame(time, context(observed));
          contextUsed ||= capture.sampleContextUsed === true;
          motionProbeUsed ||= capture.motionProbeUsed === true;
          const png = pending.png.then(buffer => { stats.captureMs += performance.now() - start; return buffer; });
          png.catch(() => {});
          return { png, dofSamples: capture.dofSamples ?? 0, probe: capture.motionProbeUsed === true && !finalCapture };
        };
        let pending = await begin(missing[0]);
        for (let i = 0; i < missing.length; i++) {
          const png = await pending.png;
          const { dofSamples, probe } = pending;
          const next = i + 1 < missing.length ? await begin(missing[i + 1]) : null;
          stats.samples++;
          cache.set(missing[i], { png, dofSamples, probe, image: await decode(png, reuse) });
          pending = next;
        }
      };
      const auditStart = performance.now();
      let png, result, usedSamples = motionBlur;
      if (candidate && !verifyReuse) { ({ png, image: result, usedSamples } = previousRaw); }
      else if (upward) {
        // Calibrated in capture raster pixels: about 2px for fast/standard, 1px for high.
        const threshold = resolveQuality(options) === 'high' ? 1 : 2;
        await sampleMany([...endpoints, t], true);
        const centerProbe = cache.get(t);
        const still = endpoints.every(time => cache.get(time).image.data.equals(centerProbe.image.data));
        let legacy = contextUsed;
        let grid = legacy ? times : grids.get(motionBlur);
        if (still) {
          png = centerProbe.png; result = centerProbe.image; usedSamples = 1; selectedTimes = [t];
          stats.staticFrames++; stats.adaptiveFrames++;
        } else {
          if (legacy) cache.clear();
          while (true) {
            await sampleMany([...grid, t], true);
            // A conditional read discovered after the probes restarts the frame
            // on the old grids. No image from a different sample context survives.
            if (contextUsed && !legacy) {
              legacy = true; motionBlur = initialMotionBlur;
              cache.clear(); observedTime = undefined; grid = times; continue;
            }
            const images = grid.map(time => cache.get(time).image), center = cache.get(t);
            const identical = images.every(image => image.data.equals(center.image.data));
            if (identical) {
              png = center.png; result = center.image; usedSamples = 1; selectedTimes = [t];
              stats.staticFrames++; stats.adaptiveFrames++; break;
            }
            let difference = 0;
            for (let i = 1; i < images.length && difference <= threshold; i++) {
              // All decision images share the output frame's fixed lens phase.
              difference = Math.max(difference, localMotionDifference(images[i - 1], images[i], alpha, threshold));
            }
            if (difference <= threshold || motionBlur >= post.maxMotionBlur) {
              usedSamples = motionBlur; selectedTimes = grid;
              result = timed('averageMs', () => average(images)); break;
            }
            motionBlur = Math.min(post.maxMotionBlur, motionBlur * 2);
            if (legacy) cache.clear();
            observedTime = undefined;
            grid = legacy ? sampleTimes(t, fps, capture.duration, capture.cuts, { ...post, motionBlur }) : grids.get(motionBlur);
          }
        }
      } else if (motionBlur === 1) { selectedTimes = [t]; ({ png, image: result } = await sample(t)); }
      else if (hooked) {
        await sampleMany(times);
        result = timed('averageMs', () => average(times.map(time => cache.get(time).image)));
      } else if (adaptive > 0) {
        await sampleMany([times[0], times.at(-1)], true);
        const first = cache.get(times[0]), last = cache.get(times.at(-1));
        const identical = first.image.data === last.image.data || first.image.data.equals(last.image.data);
        if (identical || (!alpha && imageDifference(first.image, last.image) < adaptive)) {
          png = first.png; result = first.image; usedSamples = 1; selectedTimes = [times[0]]; stats.adaptiveFrames++;
          if (identical) stats.staticFrames++;
        } else {
          await sampleMany(times);
          result = timed('averageMs', () => average(times.map(time => cache.get(time).image)));
        }
      } else {
        await sampleMany([times[0], times.at(-1), t]);
        const first = cache.get(times[0]), last = cache.get(times.at(-1)), center = cache.get(t);
        if (first.image.data.equals(last.image.data) && first.image.data.equals(center.image.data)) {
          png = center.png; result = center.image; usedSamples = 1; selectedTimes = [t]; stats.staticFrames++;
        } else {
          await sampleMany(times);
          const images = times.map(time => cache.get(time).image);
          result = timed('averageMs', () => average(images));
        }
      }
      let usedDofSamples = previousRaw?.usedDofSamples ?? 0;
      if (!(candidate && !verifyReuse)) {
        // Only lens-dependent probe captures need replacing. DOM captures and
        // final hook captures remain reusable at the same time and context.
        if (motionProbeUsed && !finalCapture) {
          finalCapture = true;
          dofMotionSamples = new Set(selectedTimes).size;
          for (const [time, item] of cache) if (item.probe) cache.delete(time);
          observedTime = undefined;
          await sampleMany(selectedTimes, true);
          const images = selectedTimes.map(time => cache.get(time).image);
          png = selectedTimes.length === 1 ? cache.get(selectedTimes[0]).png : undefined;
          result = selectedTimes.length === 1 ? images[0] : timed('averageMs', () => average(images));
        }
        usedDofSamples = [...new Set(selectedTimes)].reduce((sum, time) => sum + (cache.get(time)?.dofSamples ?? 0), 0);
      }
      if (verifyReuse) {
        stats.auditMs += performance.now() - auditStart;
        Atomics.add(state, 2, 1);
        const actual = result ??= await decode(png), expected = previousRaw.image ??= await decode(previousRaw.png);
        if (classifyPixelDifference(pixelDifference(expected, actual), options.raster) === 'different') {
          if (Atomics.compareExchange(state, 0, 0, 1) === 0) {
            Atomics.store(state, 3, frame);
            options.onWarning?.({ code: 'static_reuse_disabled', message: 'Static reuse disabled after a pixel mismatch; frames will be recaptured.', details: { frame, t } });
          }
          candidate = false;
        }
      }
      if (candidate && !verifyReuse) Atomics.add(state, 1, 1);
      // Keep a decoded raw reference as well; never retain a transferable output buffer.
      if (enabled && options.transport === 'raw') result ??= await decode(png);
      previousRaw = { t, frame, motionBlur, uniform, png, image: result, usedSamples, usedDofSamples, run: candidate ? previousRaw.run + 1 : 0 };
      // Contributing temporal samples, excluding probes and failed attempts.
      api.lastBlurSamples = usedSamples;
      api.lastDofSamples = usedDofSamples;
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
        return image === decodedCache?.image || image === previousRaw?.image ? Buffer.from(image.data) : image.data;
      }
      if (post.grain > 0) return timed('pngMs', () => encodePNG(result));
      return png ?? timed('pngMs', () => encodePNG(result));
    },
  };
  if (capture.retryFrame) {
    const frame = api.frame.bind(api);
    api.frame = (t, index, audit) => capture.retryFrame(t, async () => {
      const before = { ...stats };
      try { return await frame(t, index, audit); }
      catch (error) { Object.assign(stats, before); decodedCache = previousRaw = undefined; throw error; }
    });
  }
  return api;
}
