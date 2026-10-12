import { invalidOption } from './errors.mjs';

// Encoding time only: capture and post-processing must keep the requested fps.
// Snap NTSC shorthand within 0.0001 fps of n * 1000 / 1001. Otherwise round
// to six decimal places (at most 0.0000005 fps error) and reduce the fraction.
// FFmpeg's AVRational stores both terms as signed 32-bit integers.
export function frameRate(fps) {
  if (!Number.isFinite(fps) || fps <= 0) throw invalidOption('--fps', '--fps must be positive and finite.');
  const nominal = Math.round(fps * 1001 / 1000);
  let numerator, denominator;
  if (nominal > 0 && Math.abs(fps - nominal * 1000 / 1001) <= 0.0001) {
    numerator = nominal * 1000;
    denominator = 1001;
  } else {
    numerator = Math.round(fps * 1e6);
    denominator = 1e6;
  }
  if (!Number.isSafeInteger(numerator) || numerator <= 0) throw invalidOption('--fps', 'Frame rate cannot be represented at micro-fps precision.');
  let a = numerator, b = denominator;
  while (b) [a, b] = [b, a % b];
  numerator /= a; denominator /= a;
  if (numerator > 2147483647) throw invalidOption('--fps', 'Frame rate exceeds FFmpeg rational precision.');
  return {
    numerator, denominator, argument: `${numerator}/${denominator}`,
    fps: numerator / denominator,
    seconds: frames => frames * denominator / numerator,
  };
}
