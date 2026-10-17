import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mountJobs } from './jobs-fixture.mjs';

// Compare glyph ranges, not slot boxes: an aligned box can still paint shifted text.
async function alignment(page) {
  return page.locator('[data-roll]').evaluateAll(roots=>roots.flatMap(root=>{
    if(!root.getBoundingClientRect().width)return [];
    const rangeRect=el=>{const range=document.createRange();range.selectNodeContents(el);return range.getBoundingClientRect();};
    const faces=[...root.querySelectorAll('.rn-face')];
    const actual=(faces.length?faces:[root.querySelector('.rn-value')]).map(face=>({text:face.textContent,top:rangeRect(face).top,bottom:rangeRect(face).bottom}));
    // Native text in the exact same inline context supplies the expected baseline.
    const plain=document.createElement('span');plain.textContent=root.querySelector('.rn-value').textContent;
    root.replaceWith(plain);const expected=rangeRect(plain);plain.replaceWith(root);
    return actual.map(a=>({key:root.dataset.roll,...a,delta:Math.max(Math.abs(a.top-expected.top),Math.abs(a.bottom-expected.bottom))}));
  }));
}

test('settled rolling glyphs match native text baselines in jobs and tray',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());
  const image=await sharp({create:{width:32,height:18,channels:3,background:'#ccc'}}).png().toBuffer();
  for(const tray of [false,true])for(const language of ['zh-CN','en']) {
    const page=await browser.newPage();
    const {jobs,errors}=await mountJobs(page,{tray,language,media:async()=>({body:image,contentType:'image/png'})});
    // First update enhances the native value; subsequent updates actually roll existing columns.
    for(const [done,left] of [[1554,564000],[1555,563000],[999,599000],[1000,600000]]) {
      jobs[0].done=done;jobs[0].total=2000;jobs[0].fps=done/100;jobs[0].etaMs=left;
      jobs[0].startedAt=new Date(Date.now()-44000).toISOString();jobs[0].previewFrame=done-1;
      await page.evaluate(jobs=>window.publish({jobs}),jobs);
      await page.waitForTimeout(100);
      const clips=await page.locator('.rn-slot[data-rn-wheel]').evaluateAll(slots=>slots.map(slot=>({
        overflow:getComputedStyle(slot).overflowY,height:slot.getBoundingClientRect().height,
        rootHeight:slot.closest('.rn-root').getBoundingClientRect().height,
      })));
      for(const clip of clips){assert.ok(['clip','hidden'].includes(clip.overflow));assert.ok(clip.height<=clip.rootHeight+1);}
      await page.waitForTimeout(600);
      if(done!==1554)assert.ok(await page.locator('.rn-face').count()>0,'updates must exercise enhanced rolling columns');
      const samples=await alignment(page);
      assert.ok(samples.length>=3);
      for(const s of samples)assert.ok(s.delta<=1,JSON.stringify({tray,language,...s}));
    }
    assert.deepEqual(errors,[]);await page.close();
  }
});
