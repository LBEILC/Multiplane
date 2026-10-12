// All weighted operations use linear-light, premultiplied RGBA.
const linear = Float64Array.from({ length: 256 }, (_, i) => {
  const x = i / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
});
const clamp = x => Math.max(0, Math.min(1, x));
const srgb = x => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
function premultiply(image) {
  const data = new Float64Array(image.data.length);
  for (let p = 0; p < data.length; p += 4) {
    const a = image.data[p + 3] / 255;
    for (let c = 0; c < 3; c++) data[p + c] = linear[image.data[p + c]] * a;
    data[p + 3] = a;
  }
  return data;
}
function finish(data, width, height) {
  const bytes = Buffer.alloc(data.length);
  for (let p = 0; p < data.length; p += 4) {
    const a = data[p + 3];
    bytes[p + 3] = Math.round(clamp(a) * 255);
    // Unpremultiply with the unquantized, unclamped weight, including ringing.
    if (bytes[p + 3]) for (let c = 0; c < 3; c++) bytes[p + c] = srgb(clamp(data[p + c] / a));
  }
  return { width, height, data: bytes };
}
export function averageAlpha(images) {
  const data = new Float64Array(images[0].data.length);
  for (const image of images) {
    for (let p = 0; p < data.length; p += 4) {
      const a = image.data[p + 3] / 255;
      for (let c = 0; c < 3; c++) data[p + c] += linear[image.data[p + c]] * a / images.length;
      data[p + 3] += a / images.length;
    }
  }
  return finish(data, images[0].width, images[0].height);
}
export function clearHiddenColors(image) {
  const data = Buffer.from(image.data);
  for (let p = 0; p < data.length; p += 4) if (!data[p + 3]) data.fill(0, p, p + 3);
  return { ...image, data };
}
const sinc = x => x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
function weights(input, output, kernel) {
  const ratio = input / output, support = Math.max(1, ratio);
  return Array.from({ length: output }, (_, i) => {
    const center = (i + 0.5) * ratio - 0.5;
    if (kernel === 'neighbor') return [[Math.max(0, Math.min(input - 1, Math.round(center))), 1]];
    const result = []; let total = 0;
    for (let j = Math.ceil(center - 3 * support); j <= Math.floor(center + 3 * support); j++) {
      const distance = (j - center) / support;
      const weight = Math.abs(distance) < 3 ? sinc(distance) * sinc(distance / 3) : 0;
      result.push([Math.max(0, Math.min(input - 1, j)), weight]); total += weight;
    }
    return result.map(([j, weight]) => [j, weight / total]);
  });
}
export function resizeAlpha(image, width, height, kernel = 'lanczos') {
  const input = premultiply(image), horizontal = new Float64Array(width * image.height * 4);
  const output = new Float64Array(width * height * 4);
  const wx = weights(image.width, width, kernel), wy = weights(image.height, height, kernel);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < width; x++) {
    for (const [source, weight] of wx[x]) for (let c = 0; c < 4; c++) horizontal[(y * width + x) * 4 + c] += input[(y * image.width + source) * 4 + c] * weight;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    for (const [source, weight] of wy[y]) for (let c = 0; c < 4; c++) output[(y * width + x) * 4 + c] += horizontal[(source * width + x) * 4 + c] * weight;
  }
  return finish(output, width, height);
}
