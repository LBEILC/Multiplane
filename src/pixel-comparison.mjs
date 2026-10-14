// Calibration and boundaries: tools/reports/059-gpu-jitter-tolerance.md.
// Set between the largest measured GPU jitter (0.109) and the weakest real change (0.875), with similar margin both ways; see tools/reports/059.
export const GPU_JITTER_BLOCK_THRESHOLD = 0.3;
export const GPU_JITTER_CHANNEL_LIMIT = 32;

export function classifyPixelDifference(difference, raster = 'gpu') {
  if (difference.changedPixels === 0) return 'identical';
  return raster === 'gpu' && difference.maxBlockMeanDiff <= GPU_JITTER_BLOCK_THRESHOLD &&
    difference.maxChannelDiff <= GPU_JITTER_CHANNEL_LIMIT ? 'jitter' : 'different';
}

// Absolute differences are averaged per channel, never across channels.
export function pixelDifference(reference, actual, { distribution = false } = {}) {
  if (reference.width !== actual.width || reference.height !== actual.height ||
      reference.data.length !== reference.width * reference.height * 4 || actual.data.length !== reference.data.length) {
    throw new RangeError('RGBA image dimensions must match.');
  }
  const { width, height } = reference;
  let changedPixels = 0, maxChannelDiff = 0, maxBlockMeanDiff = 0;
  const blockMeans = distribution ? [] : undefined;
  if (!distribution && reference.data.equals(actual.data)) return { changedPixels, maxChannelDiff, maxBlockMeanDiff };
  for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) {
    const sums = [0, 0, 0, 0], w = Math.min(8, width - x), h = Math.min(8, height - y);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = ((y + j) * width + x + i) * 4;
      let changed = false;
      for (let c = 0; c < 4; c++) {
        const delta = Math.abs(reference.data[p + c] - actual.data[p + c]);
        sums[c] += delta;
        maxChannelDiff = Math.max(maxChannelDiff, delta);
        changed ||= delta > 0;
      }
      if (changed) changedPixels++;
    }
    for (let c = 0; c < 4; c++) {
      const mean = sums[c] / (w * h);
      maxBlockMeanDiff = Math.max(maxBlockMeanDiff, mean);
      // Opaque alpha has no encoding error and is excluded from RGB statistics.
      if (distribution && c < 3) blockMeans.push(mean);
    }
  }
  return { changedPixels, maxChannelDiff, maxBlockMeanDiff, ...(distribution ? { blockMeans } : {}) };
}
