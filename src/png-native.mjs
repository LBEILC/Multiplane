import { MultiplaneError } from './errors.mjs';
import sharp from 'sharp';

sharp.concurrency(1);
sharp.cache(false);

export async function decodeNativePNG(png) {
  if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || png[24] !== 8 || ![2, 6].includes(png[25]) || png[26] || png[27] || png[28]) throw new MultiplaneError('internal_error', 'Only non-interlaced 8-bit RGB/RGBA PNG is supported.');
  const { data, info } = await sharp(png, { ignoreIcc: true }).ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || data.length !== info.width * info.height * 4) throw new MultiplaneError('internal_error', 'Native PNG decoder returned an invalid format.');
  return { width: info.width, height: info.height, data };
}
