import { createTempDirectory } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { captureFailure } from '../tools/smoke-diagnostics.mjs';

test('element timeout evidence includes accessible names and a screenshot masking only the config path', async t => {
  const out = createTempDirectory('multiplane-diagnostics-');
  t.after(() => rm(out, { recursive: true, force: true }));
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<html data-platform="darwin" data-theme="dark"><body>
    <button data-page="设置" aria-current="page">设置</button><h1 id="heading">设置</h1>
    <div class="path-value"><span class="mono">/Users/test/config.json</span><button aria-label="在访达中显示"><i aria-hidden="true">icon</i>Reveal</button></div>
    <span id="name">关联名称</span><button aria-labelledby="name">Wrong text</button>
    <button disabled>禁用按钮</button><button role="switch" aria-label="作业结束通知" aria-checked="false">关闭</button>
  </body></html>`);
  let timeout;
  try { await page.getByRole('button', { name: '不存在', exact: true }).waitFor({ timeout: 50 }); }
  catch (error) { timeout = error; }
  assert.ok(timeout);
  const failure = await captureFailure(page, out, timeout);
  await writeFile(path.join(out, 'evidence.json'), JSON.stringify({ failure }));
  const evidence = JSON.parse(await readFile(path.join(out, 'evidence.json'), 'utf8'));
  assert.match(evidence.failure.message, /Timeout/);
  assert.equal(failure.page, '设置'); assert.equal(failure.heading, '设置');
  assert.deepEqual(failure.dataset, { platform: 'darwin', theme: 'dark' });
  assert.deepEqual(new Set(failure.buttons.map(button => JSON.stringify(button))), new Set([
    { role: 'button', name: '设置' }, { role: 'button', name: '在访达中显示' },
    { role: 'button', name: '关联名称' }, { role: 'button', name: '禁用按钮' },
    { role: 'switch', name: '作业结束通知' }
  ].map(button => JSON.stringify(button))));
  assert.equal(failure.diagnosticError, undefined); assert.equal(failure.screenshotError, undefined);
  const { data, info } = await sharp(path.join(out, failure.screenshot)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = async selector => {
    const rect = await page.locator(selector).boundingBox();
    const at = (Math.floor(rect.y + rect.height / 2) * info.width + Math.floor(rect.x + rect.width / 2)) * info.channels;
    return [...data.subarray(at, at + 3)];
  };
  assert.deepEqual(await pixel('.path-value > .mono'), [255, 0, 255]);
  assert.notDeepEqual(await pixel('.path-value > button'), [255, 0, 255]);
});

test('diagnostics preserve the original failure when no page is available', async () => {
  assert.deepEqual(await captureFailure(undefined, '.', Error('launch failed')), {
    message: 'launch failed', diagnosticError: 'No live renderer page'
  });
});
