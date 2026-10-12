import path from 'node:path';
import { MultiplaneError, invalidOption } from './errors.mjs';
import { encoderArgs } from './encoder.mjs';

export function resolveFormat(options = {}) {
  const extension = path.extname(options.out ?? '').slice(1).toLowerCase();
  const formats = ['mp4', 'webm', 'mov'];
  const format = options.format ?? (formats.includes(extension) ? extension : 'mp4');
  if (!formats.includes(format)) throw invalidOption('--format', '--format must be mp4, webm or mov.');
  // TODO(design): Document rejection of unknown output extensions as well as conflicts.
  if (extension && extension !== format) throw invalidOption('--out', '--out extension must match --format.');
  if (format !== 'mp4' && options.encoder !== undefined) throw invalidOption('--encoder', '--encoder only applies to mp4; omit it for webm or mov.');
  // TODO(design): Define bitrate controls for the fixed-codec formats if needed.
  if (format !== 'mp4' && options['max-bitrate'] !== undefined) throw invalidOption('--max-bitrate', '--max-bitrate currently only applies to mp4.');
  if (format === 'mp4' && options.alpha) throw new MultiplaneError('invalid_option', 'MP4 does not support alpha.', { details: { option: '--alpha' }, hint: 'Use --format webm or --format mov and a matching --out extension.' });
  return format;
}

export function videoEncoding(options) {
  const { format, alpha } = options;
  if (format === 'webm') {
    // TODO(design): Document the fixed VP9 quality preset and audio codec.
    return { encoder: 'libvpx-vp9', args: ['-c:v', 'libvpx-vp9', '-crf', alpha ? '0' : '16', '-b:v', '0', '-auto-alt-ref', '0', ...(alpha ? ['-lossless', '1'] : [])], pixelFormat: alpha ? 'yuva420p' : 'yuv420p', mux: [], audio: ['-c:a', 'libopus', '-b:a', '320k', '-ac', '2'] };
  }
  if (format === 'mov') return { encoder: 'prores_ks', args: ['-c:v', 'prores_ks', '-profile:v', '4'], pixelFormat: alpha ? 'yuva444p10le' : 'yuv444p10le', mux: ['-movflags', '+faststart'], audio: ['-c:a', 'aac', '-b:a', '320k', '-ac', '2'] };
  return { encoder: options.encoder ?? 'x264', args: encoderArgs(options.encoder ?? 'x264', undefined, options['max-bitrate']), pixelFormat: 'yuv420p', mux: ['-movflags', '+faststart'], audio: ['-c:a', 'aac', '-b:a', '320k', '-ac', '2'] };
}
