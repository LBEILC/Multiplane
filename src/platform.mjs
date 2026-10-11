import path from 'node:path';
import os from 'node:os';

// Keep platform-specific Chromium switches isolated from capture logic.
export function browserOptions(raster = 'gpu', options = {}, platform = process.platform) {
  const gpu = raster === 'gpu';
  return { headless: true, ...(gpu ? { channel: 'chromium' } : {}), args: [
    '--disable-partial-raster',
    ...(options.rasterThreads ? [`--num-raster-threads=${options.rasterThreads}`] : []),
    ...(gpu ? ['--enable-gpu-rasterization', ...(platform === 'win32' ? ['--use-angle=d3d11'] : platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=gl']),
      '--force-high-performance-gpu', '--ignore-gpu-blocklist'] : []),
    ...(!gpu && platform !== 'win32' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
  ] };
}

export const ffmpegName = (platform = process.platform) => platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
export const ffmpegHint = (platform = process.platform) => `${platform === 'darwin' ? 'Run brew install ffmpeg' : platform === 'linux' ? 'Install FFmpeg with libx264 using your distribution package manager (for example: sudo apt-get install ffmpeg)' : 'Get FFmpeg with libx264 from https://ffmpeg.org/download.html'} and set --ffmpeg, MULTIPLANE_FFMPEG or PATH.`;
export const browserHint = (missing, platform = process.platform) => missing ? 'Run npx playwright install chromium.'
  : platform === 'linux' ? 'Run npx playwright install-deps chromium, then npx playwright install chromium.' : 'Run npx playwright install chromium.';

export const stopSignals = (platform = process.platform) => platform === 'win32'
  ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
export function userHome(env = process.env, platform = process.platform, home = os.homedir()) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (env.MULTIPLANE_HOME) return paths.resolve(env.MULTIPLANE_HOME);
  const base = platform === 'win32' ? (env.APPDATA || paths.join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
      : (env.XDG_CONFIG_HOME || paths.join(home, '.config'));
  return paths.join(base, 'multiplane');
}
