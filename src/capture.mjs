import path from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { launchBrowser } from './environment.mjs';
import { MultiplaneError, invalidOption } from './errors.mjs';
import { startServer } from './server.mjs';

export function number(value, label, { positive = false } = {}) {
  const result = Number(value);
  if (!String(value).trim() || !Number.isFinite(result) || result < 0 || (positive && result === 0)) throw invalidOption(label, `${label} must be a finite ${positive ? 'positive' : 'nonnegative'} number.`);
  return result;
}

export function validateScale(width, height, scale, label = '--scale') {
  const valid = s => [width * s, height * s].every(v => Number.isSafeInteger(v) && v > 0 && v % 2 === 0);
  if (!valid(scale)) {
    const suggestions = [0.25, 0.4, 0.5, 1, 2, 4].filter(valid);
    throw new MultiplaneError('invalid_scale', undefined, { details: { option: label, width, height, scale }, hint: `Use ${label}: ${suggestions.join(', ') || 'a scale producing even integer dimensions'}.` });
  }
}

export async function openShot(shot, scale = 1, options = {}) {
  const raster = options.raster ?? 'gpu';
  if (!['software', 'gpu'].includes(raster)) throw invalidOption('--raster', '--raster must be software or gpu.');
  number(scale, '--scale', { positive: true });
  const root = path.resolve(options.root ?? process.cwd());
  const relative = path.relative(root, path.resolve(root, shot));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new MultiplaneError('shot_outside_root');
  if (path.extname(relative) !== '.html') throw invalidOption('shot', 'Shot must be an HTML file.');
  try { await access(path.resolve(root, shot)); } catch { throw new MultiplaneError('shot_not_found'); }
  const realRelative = path.relative(await realpath(root), await realpath(path.resolve(root, shot)));
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new MultiplaneError('shot_outside_root');
  const server = await startServer(0, root);
  let browser;
  try {
    browser = await launchBrowser(options);
    await options.onBrowser?.(browser);
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
    const errors = [];
    page.on('pageerror', error => errors.push(new MultiplaneError('shot_load_failed', undefined, { details: { reason: error.message } })));
    page.on('console', message => { if (['log', 'warning', 'error'].includes(message.type())) process.stderr.write(message.text() + '\n'); });
    page.on('response', response => { if (response.status() >= 400) errors.push(new MultiplaneError(response.headers()['x-multiplane-error'] === 'three_not_installed' ? 'three_not_installed' : 'resource_failed', undefined, { details: { status: response.status(), url: response.url() } })); });
    page.on('requestfailed', request => errors.push(new MultiplaneError('resource_failed', undefined, { details: { url: request.url() } })));
    const url = `${server.url}/${relative.split(path.sep).map(encodeURIComponent).join('/')}?mode=render`;
    const response = await page.goto(url).catch(cause => { throw new MultiplaneError('shot_load_failed', undefined, { cause }); });
    if (!response.ok()) throw new MultiplaneError('shot_load_failed');
    if (errors.length) throw errors[0];
    if (!await page.evaluate(() => typeof window.SHOT?.render === 'function')) throw new MultiplaneError('shot_contract_invalid');
    const metadata = await page.evaluate(async () => {
      await Promise.race([
        (async () => { await SHOT.ready; await document.fonts.ready; })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ready_timeout')), 30000)),
      ]);
      const stage = document.querySelector('#stage')?.getBoundingClientRect();
      if (!stage || ![stage.width, stage.height].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('stage_size_invalid');
      return { width: stage.width, height: stage.height, duration: SHOT.duration, fps: SHOT.fps ?? 30, cuts: SHOT.cuts ?? [], post: SHOT.post ?? {}, hasBlurAt: typeof SHOT.blurAt === 'function' };
    }).catch(cause => { throw new MultiplaneError(cause.message.includes('ready_timeout') ? 'ready_timeout' : cause.message.includes('stage_size_invalid') ? 'stage_size_invalid' : 'resource_failed', undefined, { cause }); });
    const { width, height } = metadata;
    if (width !== 1920 || height !== 1080) {
      await page.setViewportSize({ width, height });
      const size = await page.locator('#stage').evaluate(stage => {
        const rect = stage.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      if (size.width !== width || size.height !== height) throw new MultiplaneError('stage_size_invalid');
    }
    validateScale(width, height, scale, options['render-scale'] !== undefined ? '--render-scale' : '--scale');
    if (![metadata.duration, metadata.fps].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new MultiplaneError('shot_contract_invalid');
    if (!Array.isArray(metadata.cuts) || metadata.cuts.some(c => typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > metadata.duration)) throw new MultiplaneError('shot_contract_invalid');
    const check = () => { if (errors.length) throw errors[0]; };
    check();
    const cdp = (options.capture ?? 'cdp') === 'cdp' ? await page.context().newCDPSession(page) : null;
    const timings = { renderCallMs: 0, screenshotMs: 0 };
    const beginFrame = async (t, { motionBlur = 1 } = {}) => {
        const renderStart = performance.now();
        await page.evaluate(({ t, motionBlur }) => {
          const stage = document.querySelector('#stage');
          const display = stage.style.getPropertyValue('display');
          const priority = stage.style.getPropertyPriority('display');
          stage.style.setProperty('display', 'none', 'important');
          stage.getBoundingClientRect();
          if (display) stage.style.setProperty('display', display, priority);
          else stage.style.removeProperty('display');
          const previous = SHOT.sampleContext;
          SHOT.sampleContext = { time: t, motionBlur };
          try { SHOT.render(t); } finally {
            if (previous === undefined) delete SHOT.sampleContext;
            else SHOT.sampleContext = previous;
          }
          stage.getBoundingClientRect();
        }, { t, motionBlur }).catch(cause => { throw new MultiplaneError('render_threw', undefined, { cause, details: { t, reason: cause.message } }); });
        timings.renderCallMs += performance.now() - renderStart;
        check();
        const screenshotStart = performance.now();
        const png = cdp ? cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false,
            clip: { x: 0, y: 0, width, height, scale } }).then(({ data }) => {
          const png = Buffer.from(data, 'base64');
          if (png.readUInt32BE(16) !== width * scale || png.readUInt32BE(20) !== height * scale) throw new MultiplaneError('internal_error', 'CDP screenshot dimensions do not match output.');
          return png;
        }) : page.screenshot({ type: 'png', animations: 'allow' });
        const measured = png.then(buffer => { timings.screenshotMs += performance.now() - screenshotStart; return buffer; });
        measured.catch(() => {});
        return { png: measured };
    };
    return {
      page, browser, server, ...metadata, beginFrame, timings,
      ...(metadata.hasBlurAt ? { blurAt: t => page.evaluate(t => SHOT.blurAt(t), t).catch(cause => { throw new MultiplaneError('render_threw', undefined, { cause, details: { t, reason: cause.message } }); }) } : {}),
      async frame(t, context) { return (await beginFrame(t, context)).png; },
      async close() { try { await browser.close(); } finally { await server.close(); } },
    };
  } catch (error) { try { await browser?.close(); } finally { await server.close(); } throw error; }
}
