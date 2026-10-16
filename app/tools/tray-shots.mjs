import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixtureJobs } from '../tests/jobs-fixture.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const out=path.join(root,'out/086');await mkdir(out,{recursive:true});
const browser=await chromium.launch();
const evidence=[];
try {
  for(const [language,theme,idle] of [['zh-CN','dark',false],['zh-CN','light',false],['en','dark',false],['zh-CN','dark',true]]) {
    const jobs=fixtureJobs().slice(0,3);
    jobs[0]={...jobs[0],done:552,total:1200,etaMs:83000};
    for(let i=0;i<4;i++)jobs.push({...jobs[0],jobId:'queued-'+i,shot:'/examples/geometry/scene-'+i+'.html',state:'queued',queuePosition:i+1});
    const snapshot={language,theme,hosted:true,jobs:idle?[]:jobs,runningCount:idle?0:1};
    const page=await browser.newPage({viewport:{width:300,height:480},reducedMotion:'reduce'}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(value=>{
      window.actions=[];window.trayBridge={snapshot:async()=>value,subscribe:fn=>{window.accept=fn;return()=>{};},visibility:fn=>{window.visibility=fn;},height:n=>{window.contentHeight=n;},action:(...args)=>window.actions.push(args)};
    },snapshot);
    await page.goto(pathToFileURL(path.join(root,'app/dist/tray.html')).href);
    await page.locator('.tr-open').waitFor();await page.evaluate(()=>document.fonts.ready);
    if(!idle){
      await page.evaluate(()=>{window.originalRoll=document.querySelector('[data-roll="d-running"]');});
      await page.evaluate(value=>{value.jobs[0].done=600;window.accept(value);},snapshot);
      assert.equal(await page.evaluate(()=>window.originalRoll===document.querySelector('[data-roll="d-running"]')),true);
      assert.equal(await page.locator('[data-roll="d-running"]').getAttribute('data-value'),'600');
      await page.locator('[data-job=running]').click();
      assert.deepEqual(await page.evaluate(()=>window.actions.pop()),['open','running']);
    }
    await page.locator('[data-action=settings]').click();assert.deepEqual(await page.evaluate(()=>window.actions.pop()),['settings',undefined]);
    await page.keyboard.press('Escape');assert.deepEqual(await page.evaluate(()=>window.actions.pop()),['close']);
    await page.evaluate(()=>document.activeElement?.blur());
    const height=await page.locator('#content').evaluate(el=>Math.ceil(el.getBoundingClientRect().height));
    assert.ok(height<=480);await page.setViewportSize({width:300,height});
    const name=`${language}-${theme}${idle?'-idle':''}.png`;
    await page.screenshot({path:path.join(out,name),omitBackground:true});assert.deepEqual(errors,[]);
    evidence.push({name,height,errors});await page.close();
  }
  await writeFile(path.join(out,'shots.json'),JSON.stringify(evidence,null,2));console.log(evidence);
} finally {await browser.close();}
