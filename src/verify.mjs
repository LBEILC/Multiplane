import { reuseEnabled, reuseReport, reuseState } from './static-reuse.mjs';
import { pixelDifference, classifyPixelDifference } from './pixel-comparison.mjs';
import { recoveryBudget } from './browser-recovery.mjs';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openShot, number } from './capture.mjs';
import { createPostCapture, resolveScale, blurSampleReport } from './post.mjs';
import { createRenderPool } from './render-pool.mjs';
import { decodePNG, encodePNG } from './png.mjs';
import { runCommand } from './events.mjs';
import { loaded, observeBrowser } from './environment.mjs';
import { MultiplaneError, invalidOption } from './errors.mjs';
import { writeArtifact } from './artifacts.mjs';

export async function verifyShot(shot, options = {}) {
  return runCommand('verify', shot, options, async events => {
    options = { ...events.options };
    delete options.onEvent;
    const compareReuse = reuseEnabled(options, false);
    options['static-reuse'] = false;
    options['no-static-reuse'] = true;
    reuseState(options);
    options._browserRecovery = recoveryBudget();
    const out = path.resolve(options.out ?? path.join(events.directory, 'verify'));
    let capture, pool, referenceDirectory;
    events.onCancel(() => pool?.cancel());
    try {
      events.check();
      capture = await openShot(shot, resolveScale(options).renderScale, { ...options, onWarning: events.warning, check: events.check, onBrowser: observeBrowser(events) });
      options.alpha = capture.alpha;
      await loaded(events, capture);
      const fps = number(options.fps ?? capture.fps, '--fps', { positive: true });
      const workers = number(options.workers ?? 2, '--workers', { positive: true });
      if (!Number.isSafeInteger(workers)) throw invalidOption('--workers', '--workers must be a positive integer.');
      events.resources.setWorkers(workers);
      const times = options.at === undefined ? [...new Set([0, 0.25, 0.5, 0.75].map(k => Math.floor(k * capture.duration * fps) / fps))]
        : options.at.split(',').map(t => number(t, '--at'));
      if (times.some(t => t >= capture.duration || Math.abs(t * fps - Math.round(t * fps)) > 1e-7)) throw invalidOption('--at', 'Verification times must be inside the shot and aligned to frames.');
      const data = { staticReuse: reuseReport(options), format: 'png', alpha: capture.alpha, passed: true, times, workers, checks: [], findings: 0 };
      const processed = createPostCapture(capture, { ...options, transport: 'png' }, fps);
      const references = new Map(), hashes = [], rangeReferences = new Map();
      if (compareReuse) referenceDirectory = await mkdtemp(path.join(tmpdir(), 'multiplane-verify-static-'));
      await mkdir(out, { recursive: true });
      const histogram = {}, dofHistogram = {};
      const jitterChecks = new Set();
      let errors = 0, totalChangedPixels = 0;
      for (const t of times) {
        events.check(); references.set(t, decodePNG(await processed.frame(t)));
        dofHistogram[processed.lastDofSamples] = (dofHistogram[processed.lastDofSamples] ?? 0) + 1;
        histogram[processed.lastBlurSamples] = (histogram[processed.lastBlurSamples] ?? 0) + 1;
      }
      data.post = { ...processed.post, adaptiveBlur: Number(options['adaptive-blur'] ?? 0.5) };
      data.blurSamples = blurSampleReport(histogram);
      data.dofSamples = blurSampleReport(dofHistogram);
      const check = async (t, actual, name, reference = references.get(t)) => {
        events.check();
        if (reference.file) reference = { ...reference, data: await readFile(reference.file) };
        events.progress('compare', Math.round(t * fps), Math.ceil(captureDuration * fps));
        actual = Buffer.from(actual);
        if (reference.data.equals(actual)) return;
        const difference = pixelDifference(reference, { ...reference, data: actual });
        totalChangedPixels += difference.changedPixels;
        if (classifyPixelDifference(difference, options.raster) === 'jitter') {
          data.findings++;
          jitterChecks.add(name);
          events.emit('finding', { code: 'gpu_raster_jitter', severity: 'warning', message: 'Minor GPU raster differences detected.',
            location: { t, frame: Math.round(t * fps) }, details: { check: name, ...difference } });
          return;
        }
        let changedPixels = 0, maxChannelDiff = 0, x0 = reference.width, y0 = reference.height, x1 = -1, y1 = -1;
        const diff = Buffer.alloc(reference.data.length);
        for (let p = 0; p < actual.length; p += 4) {
          let changed = false;
          for (let c = 0; c < 4; c++) {
            const delta = Math.abs(reference.data[p + c] - actual[p + c]);
            maxChannelDiff = Math.max(maxChannelDiff, delta); changed ||= delta > 0;
          }
          diff[p + 3] = 255;
          if (changed) {
            changedPixels++;
            const x = p / 4 % reference.width, y = Math.floor(p / 4 / reference.width);
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
            for (let c = 0; c < 3; c++) diff[p + c] = Math.max(32, Math.min(255, Math.abs(reference.data[p + c] - actual[p + c]) * 8));
          }
        }
        data.findings++;
        errors++;
        const images = {};
        for (const [role, pixels] of Object.entries({ reference: reference.data, actual, diff })) {
          const file = path.join(out, 'finding-' + data.findings + '-' + role + '.png');
          await writeArtifact(file, encodePNG({ ...reference, data: pixels }));
          images[role] = file; events.artifact(file, 'diff-image');
        }
        events.emit('finding', { code: 'nondeterministic_output', severity: 'error', message: 'Frame pixels differ.',
          hint: 'Make render(t) depend only on t and seeded inputs.', location: { t, frame: Math.round(t * fps) },
          details: { check: name, changedPixels, maxChannelDiff, bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, images } });
      };
      const finishCheck = name => {
        data.checks.push({ name, passed: errors === 0, ...(jitterChecks.has(name) ? { jitter: true } : {}) });
        if (errors) { data.passed = false; throw new MultiplaneError('nondeterministic_output', undefined, { result: { data } }); }
      };
      const captureDuration = capture.duration;
      for (const t of [...times].reverse().concat(times)) await check(t, decodePNG(await processed.frame(t)).data, 'reorder');
      finishCheck('reorder');
      await capture.retryFrame(undefined, async () => {
        await capture.page.reload();
        await capture.page.evaluate(async () => { await SHOT.ready; await document.fonts.ready; });
      });
      const reloaded = createPostCapture(capture, { ...options, transport: 'png' }, fps);
      for (const t of times) await check(t, decodePNG(await reloaded.frame(t)).data, 'reload');
      finishCheck('reload');
      const size = { width: capture.width, height: capture.height };
      await capture.close(); capture = undefined;
      for (const count of new Set([1, workers])) {
        pool = createRenderPool(shot, { ...options, transport: 'raw' }, fps, count, size, events.warning);
        const name = 'workers:' + count;
        for (const t of times) {
          const index = Math.round(t * fps);
          for await (const frame of pool.frames(index, index + 1)) await check(t, frame.png, name);
        }
        finishCheck(name);
        for await (const frame of pool.frames(0, compareReuse ? Math.ceil(fps * captureDuration) : Math.min(Math.ceil(fps * captureDuration), Math.max(2, Math.ceil(fps))))) {
          events.check();
          const pixels = Buffer.from(frame.png);
          if (count === 1) {
            const reference = { width: size.width * resolveScale(options).scale, height: size.height * resolveScale(options).scale };
            if (referenceDirectory) {
              reference.file = path.join(referenceDirectory, String(frame.frame));
              await writeFile(reference.file, pixels);
            } else reference.data = Buffer.from(pixels);
            rangeReferences.set(frame.frame, reference);
          }
          else await check(frame.frame / fps, pixels, 'range', rangeReferences.get(frame.frame));
          hashes.push({ workers: count, frame: frame.frame, sha256: createHash('sha256').update(frame.png).digest('hex') });
        }
        await pool.close(); pool = undefined;
        if (count !== 1) finishCheck('range');
      }
      if (compareReuse) {
        const reuseOptions = { ...options, 'static-reuse': true, 'no-static-reuse': false, transport: 'raw' };
        for (const count of new Set([1, workers])) {
          pool = createRenderPool(shot, reuseOptions, fps, count, size, events.warning);
          const name = 'static-reuse:workers:' + count;
          for await (const frame of pool.frames(0, Math.ceil(fps * captureDuration))) {
            await check(frame.frame / fps, frame.png, name, rangeReferences.get(frame.frame));
          }
          data.staticReuse = pool.staticReuse;
          finishCheck(name);
          await pool.close(); pool = undefined;
        }
      }
      const report = path.join(out, 'report.json');
      await writeArtifact(report, JSON.stringify({ ...data, changedPixels: totalChangedPixels, hashes }, null, 2));
      events.artifact(report, 'report');
      return data;
    } finally {
      try { await capture?.close(); }
      finally { try { await pool?.close(); } finally { if (referenceDirectory) await rm(referenceDirectory, { recursive: true, force: true }); } }
    }
  });
}
