import { installStaticObserver, reuseEnabled, reuseState, observationReasons } from './static-reuse.mjs';
import path from 'node:path';
import { browserClosed, crashedError, recoveryBudget, MAX_BROWSER_RESTARTS } from './browser-recovery.mjs';
import { access } from 'node:fs/promises';
import { launchBrowser } from './environment.mjs';
import { MultiplaneError, invalidOption } from './errors.mjs';
import { startServer } from './server.mjs';
import { normalizeResourcePath, isInsideResourceRoot } from './resource-path.mjs';

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

async function openShotOnce(shot, scale = 1, options = {}) {
  const raster = options.raster ?? 'gpu';
  if (!['software', 'gpu'].includes(raster)) throw invalidOption('--raster', '--raster must be software or gpu.');
  number(scale, '--scale', { positive: true });
  const inputRoot = path.resolve(options.root ?? process.cwd());
  const root = await normalizeResourcePath(inputRoot);
  const entry = path.resolve(inputRoot, shot);
  if (!await isInsideResourceRoot(root, entry)) throw new MultiplaneError('shot_outside_root');
  // Preserve the requested URL for in-root symlinks and their relative resources.
  let relative = path.relative(inputRoot, entry);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    relative = path.relative(root, await normalizeResourcePath(entry));
  }
  if (path.extname(relative).toLowerCase() !== '.html') throw invalidOption('shot', 'Shot must be an HTML file.');
  if (relative.split(path.sep).includes('node_modules')) throw new MultiplaneError('shot_outside_root', undefined, {
    details: { path: relative },
    hint: 'Files under node_modules are not served. Use --root to point to the package directory (for example, --root node_modules/multiplane).',
  });
  try { await access(entry); } catch { throw new MultiplaneError('shot_not_found'); }
  const server = await startServer(0, root);
  let browser, page, crashed = false;
  try {
    browser = await launchBrowser(options);
    await options.onBrowser?.(browser);
    page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
    if (reuseEnabled(options)) await page.addInitScript(installStaticObserver, { platform: process.platform });
    page.on('crash', () => { crashed = true; });
    const errors = [];
    const observerProbe = request => {
      const headers = request.headers();
      return headers['x-multiplane-image-probe'] === '1'
        || headers['access-control-request-headers']?.toLowerCase().split(',').some(name => name.trim() === 'x-multiplane-image-probe');
    };
    page.on('pageerror', error => errors.push(new MultiplaneError('shot_load_failed', undefined, { details: { reason: error.message } })));
    page.on('console', message => { if (['log', 'warning', 'error'].includes(message.type())) process.stderr.write(message.text() + '\n'); });
    // Optional image inspection may fail CORS/CSP even when the actual image
    // loads. Its failure means no reuse, not a shot resource failure.
    page.on('response', response => { if (response.status() >= 400 && !observerProbe(response.request())) errors.push(new MultiplaneError(response.headers()['x-multiplane-error'] === 'three_not_installed' ? 'three_not_installed' : 'resource_failed', undefined, { details: { status: response.status(), url: response.url() } })); });
    page.on('requestfailed', request => { if (!observerProbe(request)) errors.push(new MultiplaneError('resource_failed', undefined, { details: { url: request.url() } })); });
    const url = `${server.url}/${relative.split(path.sep).map(encodeURIComponent).join('/')}?mode=render`;
    const response = await page.goto(url).catch(cause => {
      const failedResponse = errors.find(error => error.details?.url === url && error.details.status);
      throw new MultiplaneError('shot_load_failed', undefined, { cause,
        details: { path: relative, url, status: failedResponse?.details.status ?? null, reason: cause.message } });
    });
    if (!response?.ok()) throw new MultiplaneError('shot_load_failed', undefined, { details: { path: relative, url, status: response?.status() ?? null } });
    if (errors.length) throw errors[0];
    if (!await page.evaluate(() => typeof window.SHOT?.render === 'function')) throw new MultiplaneError('shot_contract_invalid');
    const metadata = await page.evaluate(async () => {
      await Promise.race([
        (async () => { await SHOT.ready; await document.fonts.ready; })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ready_timeout')), 30000)),
      ]);
      const stage = document.querySelector('#stage')?.getBoundingClientRect();
      if (!stage || ![stage.width, stage.height].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('stage_size_invalid');
      let meta;
      try {
        const json = JSON.stringify(SHOT.meta === undefined ? null : SHOT.meta);
        if (typeof json !== 'string' || new TextEncoder().encode(json).length > 1024 * 1024) throw new Error('Invalid metadata.');
        meta = JSON.parse(json);
      } catch { throw new Error('shot_contract_invalid'); }
      return { width: stage.width, height: stage.height, duration: SHOT.duration, fps: SHOT.fps ?? 30, cuts: SHOT.cuts ?? [], post: SHOT.post ?? {}, hasBlurAt: typeof SHOT.blurAt === 'function', meta };
    }).catch(cause => { throw new MultiplaneError(['ready_timeout', 'stage_size_invalid', 'shot_contract_invalid'].find(code => cause.message.includes(code)) ?? 'resource_failed', undefined, { cause }); });
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
    if (reuseEnabled(options)) {
      const inspection = cdp ?? await page.context().newCDPSession(page);
      try {
        // Include closed declarative shadow roots, which page JavaScript cannot inspect.
        const { root } = await inspection.send('DOM.getDocument', { depth: -1, pierce: true });
        const shadowed = node => node.shadowRoots?.some(root => root.shadowRootType !== 'user-agent') || node.children?.some(shadowed);
        if (shadowed(root)) await page.evaluate(() => globalThis.__multiplaneStatic?.disqualify());
      } catch {
        await page.evaluate(() => globalThis.__multiplaneStatic?.disqualify());
      } finally { if (!cdp) await inspection.detach(); }
    }
    const alpha = options.alpha ?? metadata.post.alpha ?? false;
    if (typeof alpha !== 'boolean') throw invalidOption('--alpha', 'alpha must be a boolean.');
    if (alpha && scale < 1) {
      // Defer downsampling to the linear-light premultiplied post path.
      const metrics = cdp ?? await page.context().newCDPSession(page);
      await metrics.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    }
    if (alpha && cdp) await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const timings = { renderCallMs: 0, screenshotMs: 0 };
    let closing, sampleContextUsed = false, motionProbeUsed = false, dofSamples = 0;
    const draw = async (t, { motionBlur = 1, motionBlurBase = motionBlur, motionProbeTime, dofMotionSamples, dofMotionIndex } = {}) => {
        const renderStart = performance.now();
        const changed = await page.evaluate(({ t, motionBlur, motionBlurBase, motionProbeTime, dofMotionSamples, dofMotionIndex, alpha }) => {
          globalThis.__multiplaneStatic?.suspend();
          if (alpha) document.documentElement.style.setProperty('--multiplane-page-background', 'transparent');
          const stage = document.querySelector('#stage');
          const display = stage.style.getPropertyValue('display');
          const priority = stage.style.getPropertyPriority('display');
          stage.style.setProperty('display', 'none', 'important');
          stage.getBoundingClientRect();
          if (display) stage.style.setProperty('display', display, priority);
          else stage.style.removeProperty('display');
          globalThis.__multiplaneStatic?.resume();
          const previous = SHOT.sampleContext;
          let contextUsed = false;
          // TODO(design): Document motionBlurBase, stable across nested refinements.
          SHOT.sampleContext = { time: t, motionBlurBase, get motionBlur() { contextUsed = true; return motionBlur; } };
          let failure;
          // Private renderer/layer handshake; never part of the shot contract.
          const probe = globalThis.__multiplaneMotionProbe = { time: motionProbeTime, used: false, motionSamples: dofMotionSamples, motionIndex: dofMotionIndex, samples: 0 };
          try { SHOT.render(t); } catch (error) { failure = String(error?.message ?? error); } finally {
            delete globalThis.__multiplaneMotionProbe;
            if (previous === undefined) delete SHOT.sampleContext;
            else SHOT.sampleContext = previous;
          }
          stage.getBoundingClientRect();
          const changed = globalThis.__multiplaneStatic?.read() ?? true;
          return { failure, contextUsed, probeUsed: probe.used, dofSamples: probe.samples, changed, reason: globalThis.__multiplaneStatic?.reason };
        }, { t, motionBlur, motionBlurBase, motionProbeTime, dofMotionSamples, dofMotionIndex, alpha }).then(({ failure, changed, contextUsed, probeUsed, dofSamples: count, reason }) => {
          sampleContextUsed = contextUsed;
          motionProbeUsed = probeUsed;
          dofSamples = count;
          const index = observationReasons.indexOf(reason);
          if (index >= 0) Atomics.add(reuseState(options), index + 4, 1);
          if (failure !== undefined) throw new MultiplaneError('render_threw', undefined, { details: { t, reason: failure } });
          return changed;
        });
        timings.renderCallMs += performance.now() - renderStart;
        check();
        return changed;
    };
    const beginFrame = async (t, context) => {
        if (!context?.observed) await draw(t, context);
        const screenshotStart = performance.now();
        const png = cdp ? cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false,
            clip: { x: 0, y: 0, width, height, scale: alpha ? Math.max(1, scale) : scale } }).then(({ data }) => {
          const png = Buffer.from(data, 'base64');
          if (png.readUInt32BE(16) !== width * (alpha ? Math.max(1, scale) : scale) || png.readUInt32BE(20) !== height * (alpha ? Math.max(1, scale) : scale)) throw new MultiplaneError('internal_error', 'CDP screenshot dimensions do not match output.');
          return png;
        }) : page.screenshot({ type: 'png', animations: 'allow', ...(alpha ? { omitBackground: true } : {}) });
        const measured = png.then(buffer => { timings.screenshotMs += performance.now() - screenshotStart; return buffer; });
        measured.catch(() => {});
        return { png: measured };
    };
    return {
      page, browser, server, ...metadata, alpha, beginFrame, timings, _inspectSample: draw,
      get sampleContextUsed() { return sampleContextUsed; },
      get motionProbeUsed() { return motionProbeUsed; },
      get dofSamples() { return dofSamples; },
      ...(reuseEnabled(options) ? { observe: draw } : {}),
      isCrash: error => browserClosed(error, browser, page, crashed),
      ...(metadata.hasBlurAt ? { blurAt: async t => {
        const result = await page.evaluate(t => { try { return { value: SHOT.blurAt(t) }; } catch (error) { return { reason: String(error?.message ?? error) }; } }, t);
        if ('reason' in result) throw new MultiplaneError('render_threw', undefined, { details: { t, reason: result.reason } });
        return result.value;
      } } : {}),
      async frame(t, context) { return (await beginFrame(t, context)).png; },
      close() { return closing ??= (async () => { try { await browser.close(); } finally { await server.close(); } })(); },
    };
  } catch (error) { const failure = browserClosed(error, browser, page, crashed) ? crashedError(error) : error; try { await browser?.close(); } finally { await server.close(); } throw failure; }
}

// Recovery belongs to a complete output frame, never to an individual blur sample.
export async function openShot(shot, scale = 1, options = {}) {
  const budget = options._browserRecovery ?? recoveryBudget();
  let current, closed = false, stalled;
  const recover = async (error, t, stallAttempt) => {
    options.check?.();
    if (closed) throw error;
    const failure = crashedError(error, t);
    if (!stallAttempt && Atomics.load(budget, 0) >= MAX_BROWSER_RESTARTS) throw failure;
    const attempt = stallAttempt ?? Atomics.add(budget, 0, 1) + 1;
    if (attempt > MAX_BROWSER_RESTARTS) throw failure;
    await current?.close().catch(() => {});
    try { current = await openShotOnce(shot, scale, options); }
    catch (restartError) {
      options.check?.();
      const restarted = crashedError(restartError, t);
      restarted.details = { ...failure.details, ...restarted.details };
      throw restarted;
    }
    if (!stallAttempt) options.onWarning?.({ code: 'browser_restarted', message: 'Browser restarted; retrying the affected frame.', details: { ...failure.details, attempt } });
    options.onRecovered?.();
  };
  try { current = await openShotOnce(shot, scale, options); }
  catch (error) { if (error.code !== 'browser_crashed') throw error; await recover(error); }
  const api = {
    ...current,
    get page() { return current.page; },
    get browser() { return current.browser; },
    get sampleContextUsed() { return current.sampleContextUsed; },
    get motionProbeUsed() { return current.motionProbeUsed; },
    get dofSamples() { return current.dofSamples; },
    ...(current.observe ? { observe: (...args) => current.observe(...args) } : {}),
    beginFrame: (...args) => current.beginFrame(...args),
    _inspectSample: (...args) => current._inspectSample(...args),
    frame: (...args) => current.frame(...args),
    ...(current.blurAt ? { blurAt: (...args) => current.blurAt(...args) } : {}),
    // Closing the owned browser interrupts a blocked evaluate/CDP screenshot.
    // Let the complete post frame unwind before retrying any of its samples.
    async stall(details) {
      if (closed || stalled) return;
      stalled = new MultiplaneError('browser_crashed', 'Rendering worker stopped delivering frames.', { details });
      await current.close();
    },
    async retryFrame(t, operation) {
      let stallAttempts = 0;
      for (;;) {
        try { return await operation(); }
        catch (error) {
          options.check?.();
          if (!closed && stalled) {
            const failure = stalled; stalled = undefined;
            if (stallAttempts >= MAX_BROWSER_RESTARTS) throw failure;
            await recover(failure, t, ++stallAttempts);
            continue;
          }
          if (closed || !current.isCrash(error)) throw error;
          await recover(error, t);
        }
      }
    },
    async close() { closed = true; await current.close(); },
  };
  return api;
}
