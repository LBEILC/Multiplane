import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mountJobs } from './jobs-fixture.mjs';

test('job numbers keep one text footprint before, during and after updates with motion on or off', async t => {
  const browser=await chromium.launch(); t.after(()=>browser.close());
  for(const reduced of [false,true]) {
    const page=await browser.newPage();
    const image=await sharp({create:{width:32,height:18,channels:3,background:'#ccc'}}).png().toBuffer();
    const {jobs,errors}=await mountJobs(page,{reduced,media:async()=>({body:image,contentType:'image/png'})});
    const check=async()=>{
      const samples=await page.locator('#list .rn-root, .progress-card .rn-root').evaluateAll(roots=>roots.map(root=>{
        const value=root.querySelector('.rn-value'), visual=root.querySelector('.rn-visual');
        const v=getComputedStyle(value), a=getComputedStyle(visual);
        return {width:root.getBoundingClientRect().width, single:a.display==='none'||(a.position==='absolute'&&v.color==='rgba(0, 0, 0, 0)'),font:getComputedStyle(root).fontSize,parentFont:getComputedStyle(root.parentElement).fontSize};
      }));
      assert.ok(samples.length>=5);
      for(const sample of samples){assert.ok(sample.single,JSON.stringify(sample));assert.ok(sample.width>0);assert.equal(sample.font,sample.parentFont);}
    };
    await check();
    jobs[0].done=19;jobs[0].fps=17.5;jobs[0].etaMs=94000;
    await page.evaluate(jobs=>window.publish({jobs}),jobs);
    await check();
    await page.waitForTimeout(550);
    await check();
    assert.equal(await page.locator('[data-roll="row-running"] .rn-value').textContent(),'19');
    assert.deepEqual(errors,[]);await page.close();
  }
});

test('an open preview loads a fresh version with an unescaped file query parameter',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();
  const image=await sharp({create:{width:32,height:18,channels:3,background:'#ccc'}}).png().toBuffer();
  const requested=[];
  const {jobs,errors}=await mountJobs(page,{reduced:true,media:async file=>{requested.push(file);return {body:image,contentType:'image/png'};}});
  await page.locator('[data-tab=preview]').click();
  await page.locator('img.preview').evaluate(img=>img.decode());
  await page.evaluate(()=>window.originalPreview=document.querySelector('img.preview'));
  jobs[0].previewVersion='2';jobs[0].previewFrame=18;
  const responsePromise=page.waitForResponse(r=>new URL(r.url()).searchParams.get('v')==='2');
  await page.evaluate(jobs=>window.publish({jobs}),jobs);
  const response=await responsePromise;
  assert.equal(response.status(),200);
  const details=await page.locator('img.preview').evaluate(async img=>{await img.decode();return {src:img.src,width:img.naturalWidth,same:img===window.originalPreview};});
  assert.equal(new URL(details.src).searchParams.get('file'),jobs[0].jobDir+'/preview.png');
  assert.equal(details.width,32);assert.ok(details.same);assert.equal(requested.length,2);
  assert.deepEqual(errors,[]);
});
