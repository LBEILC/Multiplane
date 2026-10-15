import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openShot } from '../src/capture.mjs';
import { verifyShot } from '../src/verify.mjs';
import { decodePNG } from '../src/png.mjs';
import { createTempDirectory } from './helpers.mjs';
import { cardFixture } from './three-card-fixture.mjs';

const root = createTempDirectory();
test('plain transparent cards retain alpha while annotated and explicitly styled cards have backgrounds', async () => {
  const capture = await openShot(await cardFixture(root, 'alpha.html', { mode:'transparency' }), 1, { root, raster:'software' });
  try {
    const image = decodePNG(await capture.frame(0));
    const pixel = (x,y) => [...image.data.subarray((y*640+x)*4,(y*640+x)*4+3)];
    assert.deepEqual(pixel(180,160), [52,124,164]);
    assert.deepEqual(pixel(280,160), [232,223,202]);
    assert.deepEqual(pixel(390,160), [136,187,102]);
  } finally { await capture.close(); }
});

test('LOD bias is per material, preserves zero, rejects non-finite values and changes sampled pixels', async () => {
  const capture = await openShot(await cardFixture(root, 'lod.html'), 1, { root, raster:'software' });
  try {
    const original = decodePNG(await capture.frame(0)).data;
    const result = await capture.page.evaluate(async () => {
      const initial=cards[0]; initial.visible=false;
      const zero=layer.card({src:'./lod.png',width:9.4,height:4.7,lodBias:0});
      const sharp=layer.card({src:'./lod.png',width:9.4,height:4.7,lodBias:-1}); sharp.visible=false;
      await layer.ready;
      window.zero=zero;window.sharp=sharp;
      const invalid=[NaN,Infinity,-Infinity,'-1',null].every(lodBias=>{try{layer.card({lodBias});return false;}catch(e){return e.code==='shot_contract_invalid';}});
      return {invalid,shared:zero.userData.material.map===sharp.userData.material.map};
    });
    assert.equal(result.invalid,true); assert.equal(result.shared,true);
    assert.deepEqual(decodePNG(await capture.frame(0)).data,original);
    await capture.page.evaluate(()=>{zero.visible=false;sharp.visible=true;});
    assert.notDeepEqual(decodePNG(await capture.frame(0)).data,original);
  } finally { await capture.close(); }
});

test('far telephoto border does not occlude the card interior', async () => {
  const capture=await openShot(await cardFixture(root,'border.html',{mode:'border'}),1,{root,raster:'software'});
  try {
    const bordered=decodePNG(await capture.frame(0));
    await capture.page.evaluate(()=>{cards[0].children[1].visible=false;});
    const plain=decodePNG(await capture.frame(0));
    for(let y=120;y<240;y++) for(let x=200;x<440;x++) {
      const p=(y*640+x)*4;
      assert.deepEqual(bordered.data.subarray(p,p+4),plain.data.subarray(p,p+4));
    }
  } finally {await capture.close();}
});

test('standard three cards with LOD bias pass reorder, reload and one/two workers', {timeout:120000}, async()=>{
  const shot=await cardFixture(root,'verify.html',{lodBias:-1});
  const result=await verifyShot(shot,{root,raster:'software',at:'0,0.5',workers:2,out:path.join(root,'verify'),'job-dir':path.join(root,'jobs'),onEvent(){}});
  assert.equal(result.data.post.maxMotionBlur,32);
  assert.equal(result.data.passed,true);
  assert.ok(result.data.checks.every(check=>check.passed&&!check.jitter));
  assert.deepEqual(result.data.checks.map(check=>check.name),['reorder','reload','workers:1','workers:2','range']);
});
