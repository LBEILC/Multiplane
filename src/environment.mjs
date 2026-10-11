import { chromium } from 'playwright';
import { browserOptions, browserHint } from './platform.mjs';
import { MultiplaneError } from './errors.mjs';
export async function launchBrowser(options = {}, launcher = chromium, platform = process.platform) {
  let browser;
  try {
    try {
      browser = await launcher.launch(browserOptions(options.raster ?? 'gpu', options, platform));
      if (platform !== 'linux' || options.raster === 'software' || (await environment(browser)).gpu.hardware) return browser;
      await browser.close(); browser = undefined;
    } catch (error) {
      await browser?.close(); browser = undefined;
      if (platform !== 'linux' || options.raster === 'software' || /Executable doesn't exist/.test(error.message)) throw error;
    }
    // ANGLE can launch without a working GL device on a headless Linux host.
    // Relaunch with SwiftShader so WebGL shots remain usable and repeatable.
    return await launcher.launch(browserOptions('software', options, platform));
  } catch (cause) { throw new MultiplaneError(/Executable doesn't exist/.test(cause.message) ? 'browser_not_installed' : 'browser_launch_failed', undefined,
    { cause, hint: browserHint(/Executable doesn't exist/.test(cause.message), platform), details: { reason: cause.message.split(/\r?\n/)[0] } }); }
}
export async function environment(browser, ffmpeg = null) {
  const session = await browser.newBrowserCDPSession();
  try {
    const { gpu } = await session.send('SystemInfo.getInfo');
    const renderer = gpu.auxAttributes?.glRenderer ?? gpu.devices?.[0]?.deviceString ?? 'unknown';
    return { node: process.version, platform: process.platform, chromium: browser.version(),
      gpu: { renderer, hardware: !/swiftshader|llvmpipe|software|unknown/i.test(renderer) }, ffmpeg };
  } finally { await session.detach(); }
}
export async function loaded(events, capture, ffmpeg = null) {
  const { width, height, duration, fps, cuts, post } = capture;
  events.emit('shot', { width, height, duration, fps, cuts, post });
  events.check();
}

export function warnGpuFallback(events, info, options = {}) {
  if ((options.raster ?? 'gpu') === 'gpu' && !info.gpu.hardware) {
    events.emit('warning', { code: 'gpu_software_fallback', message: 'Hardware GPU rasterization is unavailable.' });
  }
}

export const observeBrowser = (events, ffmpeg = null) => async browser => {
  events.onCancel(() => browser.close());
  events.check();
  const info = await environment(browser, ffmpeg);
  events.emit('environment', info);
  warnGpuFallback(events, info, events.options);
};
