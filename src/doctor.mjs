import { runCommand } from './events.mjs';
import { launchBrowser, environment, warnGpuFallback } from './environment.mjs';
import { inspectFFmpeg, ffmpegOutput } from './ffmpeg.mjs';
import { MultiplaneError } from './errors.mjs';

export const doctor = (options = {}) => runCommand('doctor', null, options, async events => {
  options = events.options;
  const checks = [];
  let failure, browser, info, ffmpeg;
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 24;
  checks.push({ name: 'node', ok: nodeOk, detail: `Node ${process.version}; version 24 or newer is required.` });
  if (!nodeOk) failure = new MultiplaneError('unsupported_node', 'Node 24 or newer is required.');
  try {
    browser = await launchBrowser(options);
    checks.push({ name: 'browser', ok: true, detail: `Chromium ${browser.version()} is available.` });
    info = await environment(browser);
    checks.push({ name: 'gpu', ok: info.gpu.hardware, detail: `GPU renderer: ${info.gpu.renderer}.` });
    warnGpuFallback(events, info, options);
  } catch (error) {
    failure ??= error;
    checks.push({ name: 'browser', ok: false, detail: error.message }, { name: 'gpu', ok: false, detail: 'GPU could not be inspected.' });
  } finally { await browser?.close(); }
  try {
    ffmpeg = await inspectFFmpeg(options.ffmpeg);
    checks.push({ name: 'ffmpeg', ok: true, detail: ffmpeg.version });
    const x264 = /\blibx264\b/.test(await ffmpegOutput(ffmpeg.path, ['-encoders']));
    checks.push({ name: 'libx264', ok: x264, detail: x264 ? 'libx264 is available.' : 'libx264 is unavailable.' });
    if (!x264) failure ??= new MultiplaneError('ffmpeg_unusable', undefined, { hint: 'Install an FFmpeg build with libx264.' });
  } catch (error) {
    failure ??= error;
    checks.push({ name: 'ffmpeg', ok: false, detail: error.message }, { name: 'libx264', ok: false, detail: 'Encoder list could not be inspected.' });
  }
  if (info) events.emit('environment', { ...info, ffmpeg: ffmpeg ?? null });
  try { await import('three'); checks.push({ name: 'three', ok: true, detail: 'Optional three.js is available.' }); }
  catch { checks.push({ name: 'three', ok: false, detail: 'Optional three.js is not installed.' }); }
  if (failure) { failure.result = { data: { checks, config: events.config } }; throw failure; }
  return { checks, config: events.config };
}, false);
