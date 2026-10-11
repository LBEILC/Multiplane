import { invalidOption } from './errors.mjs';
export const encoders = ['x264', 'nvenc-h264', 'nvenc-hevc'];

export function encoderArgs(name = 'x264', quality, maxMbps) {
  if (!encoders.includes(name)) throw invalidOption('--encoder', '--encoder must be x264, nvenc-h264 or nvenc-hevc.');
  if (maxMbps !== undefined && !(Number.isFinite(maxMbps) && maxMbps > 0)) throw invalidOption('--max-bitrate', '--max-bitrate must be positive (Mbps).');
  const cap = maxMbps ? ['-maxrate', `${maxMbps}M`, '-bufsize', `${maxMbps * 2}M`] : [];
  if (name === 'x264') return ['-c:v', 'libx264', '-profile:v', 'high', '-crf', '16', ...cap];
  quality ??= name === 'nvenc-hevc' ? 20 : 21;
  if (!Number.isInteger(quality) || quality < 1 || quality > 51) throw invalidOption('NVENC', 'NVENC CQ must be an integer from 1 to 51.');
  return ['-c:v', name === 'nvenc-h264' ? 'h264_nvenc' : 'hevc_nvenc',
    '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', String(quality), '-b:v', '0',
    ...(maxMbps ? cap : ['-qmin', '0', '-qmax', String(Math.min(51, quality + 2))]),
    '-multipass', 'fullres', '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32', '-bf', '3',
    ...(name === 'nvenc-h264' ? ['-profile:v', 'high'] : ['-tag:v', 'hvc1'])];
}
