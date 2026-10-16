import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { run } from './demo.mjs';
import { fixtureJobs, mountJobs } from '../tests/jobs-fixture.mjs';
import { commandArgs } from '../src/shared/job-detail.mjs';

export async function jobsShots() {
  const root=fileURLToPath(new URL('../..',import.meta.url)),out=path.join(root,'out','084b');
  await mkdir(out,{recursive:true});
  const shot=path.join(out,'frame-number.html');
  await writeFile(shot,`<!doctype html><html><head><meta charset="UTF-8"><style>html,body{margin:0}#stage{width:640px;height:360px;position:relative}#number{position:absolute;left:220px;top:120px;font:80px monospace;color:white}.bit{position:absolute;top:0;width:64px;height:64px}</style></head><body><div id="stage"><span id="number"></span>${Array.from({length:5},(_,i)=>`<div class="bit" style="left:${i*64}px"></div>`).join('')}</div><script>window.SHOT={duration:1,fps:30,render:t=>{const n=Math.min(29,Math.floor(t*30+1e-6));document.getElementById('stage').style.background='rgb('+n*7+',40,70)';document.getElementById('number').textContent=n;document.querySelectorAll('.bit').forEach((el,i)=>el.style.background=(n&(1<<i))?'white':'black');}};</script></body></html>`);
  const args=['render',shot,'--root',out,'--out',path.join(out,'frame-number.mp4'),'--job-dir',path.join(out,'jobs'),'--workers','1','--no-post','--no-hosted','--overwrite','--json'];
  const output=await run(process.execPath,['bin/multiplane',...args],{cwd:root});
  const originalEvents=output.trim().split('\n').map(JSON.parse),start=originalEvents.find(e=>e.type==='start'),result=originalEvents.at(-1);
  assert.equal(result.ok,true);assert.equal(result.data.frames,30);assert.equal(result.data.width,640);assert.equal(result.data.height,360);
  const repeated=await run(process.execPath,['bin/multiplane',...commandArgs({command:'render',shot,events:[start]}),'--json'],{cwd:root});
  const repeatEvents=repeated.trim().split('\n').map(JSON.parse),repeatStart=repeatEvents.find(e=>e.type==='start');
  const effective=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!['job-dir-exact','hosted-executor'].includes(k)).sort(([a],[b])=>a.localeCompare(b)));
  assert.deepEqual(effective(repeatStart.options),effective(start.options));
  const video=await readFile(result.data.output);
  const image=await sharp(Buffer.from('<svg width="640" height="360"><rect width="640" height="360" fill="#eeeeea"/><rect x="180" y="95" width="120" height="80" rx="8" fill="#555550"/><path d="M40 280H600" stroke="#aaa"/></svg>')).png().toBuffer();
  const diff=await sharp(Buffer.from('<svg width="640" height="360"><rect width="640" height="360" fill="#171717"/><rect x="180" y="95" width="120" height="80" fill="#e3695c"/></svg>')).png().toBuffer();
  const media=async file=>file.endsWith('.mp4')?{body:video,contentType:'video/mp4'}:{body:file.endsWith('diff.png')?diff:image,contentType:'image/png'};
  const browser=await chromium.launch();
  const evidence={screenshots:[],frames:[],commandRoundTrip:true};
  try {
    for(const [language,theme] of [['zh-CN','dark'],['zh-CN','light'],['en','dark']]) {
      const page=await browser.newPage();const {errors}=await mountJobs(page,{language,theme,media});
      const shots=[['running','preview'],['running','timeline'],['success','preview'],['success','summary'],['success','timeline'],['success','options'],['failed','summary'],['verify','preview'],['verify','viewer'],['stills','viewer']];
      for(const [job,tab] of shots) {
        await page.locator(`[data-job="${job}"]`).click();await page.locator(`[data-tab="${tab==='viewer'?'preview':tab}"]`).click();
        if(tab==='viewer'){await page.locator('#tab-content img').first().click();await page.waitForFunction(()=>document.querySelector('.lb-img img')?.naturalWidth>0);}
        else if(tab==='preview')await page.waitForFunction(()=>[...document.querySelectorAll('#tab-content img')].every(i=>i.complete&&i.naturalWidth>0));
        if(job==='success'&&tab==='preview')await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
        await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
        const name=`${language}-${theme}-${job}-${tab}.png`;await page.screenshot({path:path.join(out,name)});evidence.screenshots.push(name);
        if(tab==='viewer')await page.keyboard.press('Escape');
      }
      if(language==='en') {
        await page.locator('[data-job=success]').click();await page.locator('[data-tab=preview]').click();await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
        const check=async expected=>{
          await page.waitForFunction(()=>{const v=document.querySelector('video');return v.readyState>=2&&!v.seeking;});
          const actual=await page.evaluate(()=>{const v=document.querySelector('video'),c=document.createElement('canvas');c.width=640;c.height=360;const ctx=c.getContext('2d');ctx.drawImage(v,0,0);let n=0;for(let i=0;i<5;i++)if(ctx.getImageData(i*64+32,32,1,1).data[0]>128)n|=1<<i;return n;});
          assert.equal(actual,expected);evidence.frames.push({expected,actual});
        };
        await page.locator('[data-pl=start]').click();await check(0);
        for(let n=1;n<=5;n++){await page.locator('[data-pl=next]').click();await check(n);}
        await page.locator('[data-pl=prev]').click();await check(4);
        await page.locator('[data-scrub]').fill('17');await page.locator('[data-scrub]').dispatchEvent('input');await check(17);
        await page.locator('[data-pl=end]').click();await check(29);
        await page.locator('.player').focus();await page.keyboard.press('ArrowLeft');await check(28);
        await page.keyboard.press('[');await check(21);await page.keyboard.press('[');await check(12);
      }
      assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.faults),[]);await page.close();
    }
    await writeFile(path.join(out,'events.jsonl'),fixtureJobs()[1].events.map(e=>JSON.stringify(e)).join('\n')+'\n');
    await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence,null,2));
  } finally {await browser.close();}
}
