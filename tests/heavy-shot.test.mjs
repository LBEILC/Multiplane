import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { createRenderPool } from '../src/render-pool.mjs';
import { openShot } from '../src/capture.mjs';
import { createPostCapture } from '../src/post.mjs';
import { verifyShot } from '../src/verify.mjs';
import { fullTest } from './suite.mjs';

const out = createTempDirectory(path.resolve('out/tests/heavy-shot-'));
test('captured progress precedes audited delivery and counts repaired frames once', async () => {
  const shot = path.join(out, 'progress.html');
  await writeFile(shot, `<style>html,body{margin:0}#stage{width:16px;height:16px}</style><div id="stage"></div><script>
if(globalThis.__multiplaneStatic)globalThis.__multiplaneStatic.read=()=>false;
window.SHOT={duration:1,fps:20,render(t){document.querySelector('#stage').style.background=t<.1?'red':'blue'}};</script>`);
  const seen = []; let delivered = 0;
  const pool = createRenderPool(shot, { raster: 'software', transport: 'raw' }, 20, 1, { width: 16, height: 16 }, undefined, done => seen.push({ done, delivered }));
  try {
    for await (const item of pool.frames(0, 20)) { assert.ok(item.png); delivered++; }
    assert.deepEqual(seen.map(row => row.done), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(seen[0].delivered, 0); assert.equal(seen[1].delivered, 0);
    assert.equal(delivered, 20); assert.equal(pool.staticReuse.disabledReason, 'pixel_mismatch');
  } finally { await pool.close(); }
});

async function threeShot() {
  const shot = path.join(out, 'three.html');
  await writeFile(shot, `<style>html,body{margin:0}#stage{width:32px;height:24px}</style><div id="stage"></div>
<script type="importmap">{"imports":{"three":"/multiplane/vendor/three/build/three.module.js","three/addons/":"/multiplane/vendor/three/examples/jsm/"}}</script>
<script type="module">import {createThreeLayer,THREE} from '/multiplane/three.js';
const layer=window.layer=createThreeLayer({size:{w:32,h:24},samples:16,maxSamples:16,adaptiveSamples:false,aperture:.1});
const mesh=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),new THREE.MeshBasicMaterial({color:0xff8040}));layer.scene.add(mesh);
window.SHOT={duration:1,fps:8,post:{motionBlur:8},render(t){mesh.position.x=Math.sin(t*20);layer.render();}};</script>`);
  return shot;
}
test('three base context retains pixels across refinement and reduces spatial work', async () => {
  const shot = await threeShot(), capture = await openShot(shot, 1, { raster: 'software' });
  try {
    const a = await capture.frame(.25, { motionBlur: 8, motionBlurBase: 8 });
    assert.equal(capture.sampleContextUsed, false);
    assert.equal(await capture.page.evaluate(() => layer.stats.samples), 8);
    assert.deepEqual(await capture.frame(.25, { motionBlur: 64, motionBlurBase: 8 }), a);
    await capture.frame(.25, { motionBlur: 1 });
    assert.equal(await capture.page.evaluate(() => layer.stats.samples), 16);
    await capture.page.evaluate(() => { layer.sampling.rotateSamples = false; });
    await capture.frame(.25, { motionBlur: 8, motionBlurBase: 8 });
    assert.equal(await capture.page.evaluate(() => layer.stats.samples), 16);
    await capture.page.evaluate(() => { layer.sampling.rotateSamples = true; });
    await createPostCapture(capture, { shutter: 0 }).frame(.25);
    assert.equal(await capture.page.evaluate(() => layer.stats.samples), 16);
    const processed = createPostCapture(capture, { 'no-static-reuse': true });
    await processed.frame(.25);
    assert.ok(processed.stats.samples <= processed.lastBlurSamples + 3);
  } finally { await capture.close(); }
});
for (const quality of ['standard', 'high']) fullTest(`three ${quality} verifies reorder, reload and workers`, { timeout: 300000 }, async () => {
  const shot = await threeShot();
  const result = await verifyShot(shot, { quality, raster: 'software', at: '0.25,0.5', workers: 2, 'no-lint': true,
    'job-dir': path.join(out, 'jobs'), out: path.join(out, quality), onEvent() {} });
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const name of ['reorder', 'reload', 'workers:1', 'workers:2']) assert.ok(result.data.checks.some(c => c.name === name && c.passed), name);
});

