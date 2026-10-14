import { runCommand } from './events.mjs';
import { launchBrowser, environment, warnGpuFallback } from './environment.mjs';
import { inspectFFmpeg, ffmpegOutput } from './ffmpeg.mjs';
import { MultiplaneError } from './errors.mjs';

export const doctor = (options = {}) => runCommand('doctor', null, options, async events => {
  options = events.options;
  const moved = events.migration.migrated.filter(item => ['config.json', 'jobs.jsonl'].includes(item.name));
  const checks = [{ name: 'home', ok: true, detail: `User directory: ${events.config.path.slice(0, -'config.json'.length)}.` + (moved.length ? ` Copied from the previous location: ${moved.map(item => item.source).join(', ')}; original files were retained.` : '') }];
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
    const encoderList = await ffmpegOutput(ffmpeg.path, ['-encoders']);
    const x264 = /\blibx264\b/.test(encoderList);
    for (const name of ['libvpx-vp9', 'prores_ks']) checks.push({ name, ok: new RegExp('\\b' + name + '\\b').test(encoderList), detail: name + ' is optional; required only for its video format, including transparent output.' });
    checks.push({ name: 'libx264', ok: x264, detail: x264 ? 'libx264 is available.' : 'libx264 is unavailable.' });
    if (!x264) failure ??= new MultiplaneError('ffmpeg_unusable', undefined, { hint: 'Install an FFmpeg build with libx264.' });
  } catch (error) {
    failure ??= error;
    checks.push({ name: 'ffmpeg', ok: false, detail: error.message }, { name: 'libx264', ok: false, detail: 'Encoder list could not be inspected.' });
    for (const name of ['libvpx-vp9', 'prores_ks']) checks.push({ name, ok: false, detail: `${name} is optional; encoder availability could not be inspected.` });
  }
  if (info) events.emit('environment', { ...info, ffmpeg: ffmpeg ?? null });
  try { await import('three'); checks.push({ name: 'three', ok: true, detail: 'Optional three.js is available.' }); }
  catch { checks.push({ name: 'three', ok: false, detail: 'Optional three.js is not installed.' }); }
  if (failure && checks.some(c => ['ffmpeg', 'libx264'].includes(c.name) && !c.ok)) failure.hint = (failure.hint ? failure.hint + ' ' : '') + 'Run multiplane config set ffmpeg <path> to save an FFmpeg executable.';
  if (failure) { failure.result = { data: { checks, config: events.config } }; throw failure; }
  return { checks, config: events.config };
}, false);
