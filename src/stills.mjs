import { recoveryBudget } from './browser-recovery.mjs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openShot, number } from './capture.mjs';
import { createPostCapture, resolveScale } from './post.mjs';
import { runCommand } from './events.mjs';
import { loaded, observeBrowser } from './environment.mjs';
import { invalidOption } from './errors.mjs';
import { requireNewOutput, writeArtifact } from './artifacts.mjs';
import { checkStill } from './output-check.mjs';

export async function stillsShot(shot, options = {}) {
  return runCommand('stills', shot, options, async events => {
    options = { ...events.options };
    delete options.onEvent;
    options._browserRecovery = recoveryBudget();
    let result;

    let capture, cleaning;
    const cleanup = () => cleaning ??= (async () => { await capture?.close(); })();

    try {
      const out = path.resolve(options.out ?? path.join(events.directory, 'stills'));
      events.check();
      events.progress('load');
      if (options.at !== undefined && options.every !== undefined) throw invalidOption('--at', '--at and --every are mutually exclusive.');
      capture = await openShot(shot, resolveScale(options).renderScale, { ...options, onWarning: events.warning, check: events.check, onBrowser: observeBrowser(events) });
      options.alpha = capture.alpha;
      await loaded(events, capture);
      const fps = number(options.fps ?? capture.fps, '--fps', { positive: true });
      const processed = createPostCapture(capture, options, fps);
      let times;
      if (options.at !== undefined) times = options.at.split(',').map(t => number(t, '--at'));
      else {
        const interval = number(options.every ?? 1, '--every', { positive: true });
        times = Array.from({ length: Math.ceil(capture.duration / interval) }, (_, i) => i * interval);
      }
      if (times.some(t => t > capture.duration)) throw invalidOption('--at', 'Still time exceeds shot duration.');
      if (new Set(times.map(t => t.toFixed(2))).size !== times.length) throw invalidOption('--at', 'Still filenames collide at two decimal places.');
      const { scale } = resolveScale(options);
      events.progress('capture', 0, times.length);
      await mkdir(out, { recursive: true });
      for (const file of [...times.map(t => `t-${t.toFixed(2)}.png`), '_sheet.png']) await requireNewOutput(path.join(out, file));
      const frames = [];
      for (const t of times) {
        events.check();
        const buffer = await processed.frame(t);
        await writeArtifact(path.join(out, `t-${t.toFixed(2)}.png`), buffer);
        await checkStill(path.join(out, `t-${t.toFixed(2)}.png`), { width: capture.width * scale, height: capture.height * scale });
        frames.push({ time: t.toFixed(2), image: buffer.toString('base64') });
        events.artifact(path.join(out, `t-${t.toFixed(2)}.png`), 'still');
        events.progress('capture', frames.length, times.length);
      }
      const thumbnailHeight = 480 * capture.height / capture.width;
      const rowHeight = thumbnailHeight + 40;
      const sheetPNG = await capture.retryFrame(undefined, async () => {
      const sheet = await capture.browser.newPage({ viewport: { width: 1920, height: Math.ceil(Math.ceil(frames.length / 4) * rowHeight) }, deviceScaleFactor: 1 });
      await sheet.setContent(`<html><head><style>body{margin:0;background:#222;color:#fff;font:24px sans-serif}main{display:grid;grid-template-columns:repeat(4,480px)}figure{margin:0;width:480px;height:${rowHeight}px}img{${options.alpha ? 'background:conic-gradient(#bbb 25%,#eee 0 50%,#bbb 0 75%,#eee 0) 0 0/24px 24px;' : ''}display:block;width:480px;height:${thumbnailHeight}px}figcaption{height:40px;line-height:40px;text-align:center}</style></head><body><main>${frames.map(f => `<figure><img src="data:image/png;base64,${f.image}"><figcaption>t = ${f.time} s</figcaption></figure>`).join('')}</main></body></html>`);
      await sheet.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode())); });
      try { return await sheet.screenshot({ fullPage: true }); } finally { await sheet.close().catch(() => {}); }
      });
      await writeArtifact(path.join(out, '_sheet.png'), sheetPNG);
      await checkStill(path.join(out, '_sheet.png'), { width: 1920, height: Math.ceil(Math.ceil(frames.length / 4) * rowHeight) });
      events.artifact(path.join(out, '_sheet.png'), 'contact-sheet');
      result = { format: 'png', alpha: capture.alpha, stills: times.map(t => ({ t, frame: Math.round(t * fps), path: path.join(out, `t-${t.toFixed(2)}.png`) })), contactSheet: path.join(out, '_sheet.png') };
    } finally { await cleanup(); }

    return options.draft ? { ...result, draft: true } : result;
  });
}
