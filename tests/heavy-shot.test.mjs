import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { createRenderPool } from '../src/render-pool.mjs';
import { openShot } from '../src/capture.mjs';
import { createPostCapture, localMotionDifference, nestedSampleGrids } from '../src/post.mjs';
import { decodePNG } from '../src/png.mjs';
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

async function threeShot(wide = false) {
  const shot = path.join(out, 'three.html');
  await writeFile(shot, `<style>html,body{margin:0}#stage{width:32px;height:24px}</style><div id="stage"></div>
<script type="importmap">{"imports":{"three":"/multiplane/vendor/three/build/three.module.js","three/addons/":"/multiplane/vendor/three/examples/jsm/"}}</script>
<script type="module">import {createThreeLayer,THREE} from '/multiplane/three.js';
const layer=window.layer=createThreeLayer({size:{w:32,h:24},samples:16,maxSamples:${wide ? 64 : 16},adaptiveSamples:${wide},aperture:${wide ? 1 : .1},focusDistance:${wide ? 2 : 10}});
const mesh=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),new THREE.MeshBasicMaterial({color:0xff8040}));layer.scene.add(mesh);
window.SHOT={duration:1,fps:8,post:{motionBlur:8},render(t){mesh.position.x=Math.sin(t*20);layer.render();}};</script>`);
  return shot;
}
test('three probes keep the base pattern and final captures use the selected divisor', async () => {
  const shot = await threeShot(), capture = await openShot(shot, 1, { raster: 'software' });
  try {
    const a = await capture.frame(.25, { motionBlur: 8, motionBlurBase: 8 });
    assert.equal(capture.sampleContextUsed, false);
    assert.equal(await capture.page.evaluate(() => layer.stats.samples), 2);
    assert.deepEqual(await capture.frame(.25, { motionBlur: 64, motionBlurBase: 8 }), a);
    assert.equal(capture.motionProbeUsed, true);
    await capture.frame(.25, { motionBlur: 8, motionBlurBase: 8, dofMotionSamples: 4 });
    assert.equal(capture.dofSamples, 4);
    await capture.frame(.25, { motionBlur: 8, motionBlurBase: 8, dofMotionSamples: 16 });
    assert.equal(capture.dofSamples, 2);
    await capture.frame(.3, { motionBlur: 8, motionProbeTime: .25 });
    const fixedRotation = await capture.page.evaluate(() => layer.stats.rotation);
    await capture.frame(.4, { motionBlur: 8, motionProbeTime: .25 });
    assert.equal(await capture.page.evaluate(() => layer.stats.rotation), fixedRotation);
    assert.equal(await capture.page.evaluate(() => '__multiplaneMotionProbe' in globalThis), false);
    assert.deepEqual(await capture.frame(.25, { motionBlur: 8 }), a);
    await capture.frame(.25, { motionBlur: 1 });
    assert.equal(await capture.page.evaluate(() => layer.stats.samples), 16);
    await capture.page.evaluate(() => { layer.sampling.rotateSamples = false; });
    await capture.frame(.25, { motionBlur: 8, motionBlurBase: 8 });
    assert.equal(await capture.page.evaluate(() => layer.stats.samples), 16);
    assert.equal(capture.motionProbeUsed, false);
    await capture.page.evaluate(() => { layer.sampling.rotateSamples = true; });
    await createPostCapture(capture, { shutter: 0 }).frame(.25);
    assert.equal(await capture.page.evaluate(() => layer.stats.samples), 16);
    const processed = createPostCapture(capture, { 'no-static-reuse': true });
    await processed.frame(.25);
    assert.ok(processed.stats.samples <= processed.lastBlurSamples * 2 + 3);
  } finally { await capture.close(); }
});
test('wide defocus shares its budget and frozen geometry uses one full-budget capture', async () => {
  const shot = await threeShot(), capture = await openShot(shot, 1, { raster: 'software' });
  try {
    await capture.page.evaluate(() => {
      SHOT.render = t => layer.render({ t, focusDistance: 2, aperture: 1, samples: 16, maxSamples: 64, adaptiveSamples: true });
    });
    await capture.frame(.25, { motionBlur: 8 });
    assert.equal(await capture.page.evaluate(() => layer.stats.samples), 8);
    const a = await capture.frame(.2, { motionBlur: 8, motionProbeTime: .25 });
    assert.equal(await capture.page.evaluate(() => layer.stats.samples), 8);
    assert.deepEqual(await capture.frame(.3, { motionBlur: 8, motionProbeTime: .25 }), a);
    const processed = createPostCapture(capture, { 'no-static-reuse': true });
    await processed.frame(.25);
    assert.equal(processed.lastBlurSamples, 1);
    assert.equal(processed.lastDofSamples, 64);
  } finally { await capture.close(); }
});
test('fixed-phase probes still detect motion under wide defocus', async () => {
  const shot = path.join(out, 'lens-underestimate.html');
  await writeFile(shot, `<style>body{margin:0}#stage{width:32px;height:24px;background:#000}</style><div id="stage"></div>
<script type="importmap">{"imports":{"three":"/multiplane/vendor/three/build/three.module.js","three/addons/":"/multiplane/vendor/three/examples/jsm/"}}</script>
<script type="module">import {createThreeLayer,THREE} from '/multiplane/three.js';
const layer=createThreeLayer({size:{w:32,h:24},samples:16,maxSamples:64,adaptiveSamples:true,aperture:1,focusDistance:2});
const mesh=new THREE.Mesh(new THREE.PlaneGeometry(20,20),new THREE.MeshBasicMaterial({color:0xffffff}));layer.scene.add(mesh);
window.SHOT={duration:2,fps:60,post:{motionBlur:8,maxMotionBlur:64},render(t){mesh.position.x=10+(t-1)*360;layer.render({t});}};</script>`);
  const capture = await openShot(shot, 1, { raster: 'software' });
  try {
    const grid = nestedSampleGrids(1, 60, 2, [], { motionBlur: 8, maxMotionBlur: 64, shutter: .5 }).get(8);
    const fixed = [];
    for (const t of grid) {
      fixed.push(decodePNG(await capture.frame(t, { motionBlur: 8, motionBlurBase: 8, motionProbeTime: 1 })));
    }
    const maximum = images => Math.max(...images.slice(1).map((image, i) => localMotionDifference(images[i], image)));
    // Motion detection must use its stable spatial budget, not the final divisor.
    assert.ok(maximum(fixed) > 2, `fixed: ${maximum(fixed)}`);
    const processed = createPostCapture(capture, { 'no-static-reuse': true, 'motion-blur': 8 });
    await processed.frame(1);
    assert.ok(processed.lastBlurSamples > 8, `Fixed-phase motion must still refine the time grid: ${processed.lastBlurSamples}.`);
  } finally { await capture.close(); }
});

for (const quality of ['fast', 'standard', 'high']) fullTest(`three ${quality} verifies reorder, reload and workers`, { timeout: 300000 }, async () => {
  const shot = await threeShot(true);
  const result = await verifyShot(shot, { quality, raster: 'software', at: '0.25,0.5', workers: 2, 'no-lint': true,
    'job-dir': path.join(out, 'jobs'), out: path.join(out, quality), onEvent() {} });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.data.dofSamples.min > 0);
  assert.equal(result.data.quality, quality);
  assert.equal(result.data.post.motionBlur, quality === 'high' ? 8 : 4);
  assert.equal(result.data.post.maxMotionBlur, quality === 'high' ? 256 : quality === 'fast' ? 16 : 32);
  for (const name of ['reorder', 'reload', 'workers:1', 'workers:2']) assert.ok(result.data.checks.some(c => c.name === name && c.passed), name);
});


// Inspect actual camera/projection samples in a small, original scene.
test('final lens samples partition the full pattern and jitter regardless of capture order', async () => {
  const capture = await openShot(await threeShot(), 1, { raster: 'software' });
  try {
    await capture.page.evaluate(async () => {
      SHOT.render = () => layer.render();
      const draw = layer.renderer.render.bind(layer.renderer);
      window.lensPoints = [];
      layer.renderer.render = (scene, camera) => {
        if (scene === layer.scene) lensPoints.push([...camera.position.toArray(), ...camera.projectionMatrix.elements]);
        return draw(scene, camera);
      };
      const { FullScreenQuad } = await import('/multiplane/vendor/three/examples/jsm/postprocessing/Pass.js');
      const sum = FullScreenQuad.prototype.render;
      window.blurScales = [];
      FullScreenQuad.prototype.render = function(renderer) {
        if (this.material.uniforms?.blurScale) blurScales.push(this.material.uniforms.blurScale.value);
        return sum.call(this, renderer);
      };
    });
    for (const n of [4, 6, 16]) {
      const actual = Math.max(2, Math.ceil(16 / n)), total = actual * n;
      await capture.page.evaluate(total => { layer.sampling.samples = layer.sampling.maxSamples = total; lensPoints = []; blurScales = []; }, total);
      await capture.frame(.25, { motionBlur: 1 });
      const full = await capture.page.evaluate(() => ({ points: lensPoints, scales: blurScales }));
      await capture.page.evaluate(() => { layer.sampling.samples = layer.sampling.maxSamples = 16; });
      const images = new Map(), union = [];
      for (const k of Array.from({ length: n }, (_, k) => k)) {
        await capture.page.evaluate(() => { lensPoints = []; blurScales = []; });
        images.set(k, decodePNG(await capture.frame(.25, { motionBlur: n, dofMotionSamples: n, dofMotionIndex: k })).data);
        const part = await capture.page.evaluate(() => ({ points: lensPoints, scales: blurScales, rotation: layer.stats.rotation }));
        assert.equal(part.rotation, 0);
        assert.deepEqual(part.points, full.points.filter((_, i) => i % n === k));
        assert.deepEqual(part.scales, Array(actual).fill(full.scales[0]));
        union.push(...part.points.map(point => JSON.stringify(point)));
      }
      assert.equal(new Set(union).size, total);
      for (let k = n - 1; k >= 0; k--) {
        assert.deepEqual(decodePNG(await capture.frame(.25, { motionBlur: n, dofMotionSamples: n, dofMotionIndex: k })).data, images.get(k));
      }
    }
  } finally { await capture.close(); }
});

test('zero aperture retains interleaved projection jitter and cannot reuse a fixed-phase probe', async () => {
  const capture = await openShot(await threeShot(), 1, { raster: 'software' });
  try {
    await capture.page.evaluate(() => { SHOT.render = () => layer.render({ aperture: 0, adaptiveSamples: false }); });
    const probe = decodePNG(await capture.frame(.25, { motionBlur: 4, motionBlurBase: 4, motionProbeTime: .25 }));
    assert.equal(capture.motionProbeUsed, true);
    const finalContext = { motionBlur: 4, motionBlurBase: 4, dofMotionSamples: 4, dofMotionIndex: 0 };
    const final = decodePNG(await capture.frame(.25, finalContext));
    assert.notDeepEqual(final.data, probe.data);
    assert.deepEqual(decodePNG(await capture.frame(.25, finalContext)).data, final.data);
  } finally { await capture.close(); }
});
