import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fixtureJobs, mountJobs } from './jobs-fixture.mjs';
import { mkdir } from 'node:fs/promises';

test('resume UI shows refusals, links both directions, keeps list clicks independent and warns neutrally',async ctx=>{
 const browser=await chromium.launch();ctx.after(()=>browser.close());
 const image=await sharp({create:{width:640,height:360,channels:3,background:'#888'}}).png().toBuffer();
 await mkdir('out/087',{recursive:true});
 for(const [language,theme] of [['zh-CN','dark'],['en','light']]) {
  const page=await browser.newPage();const jobs=fixtureJobs();jobs[2].resume={available:true,framesDone:10,framesTotal:30};
  const {errors}=await mountJobs(page,{jobs,language,theme,reduced:true,media:async()=>({body:image,contentType:'image/png'})});
  await page.evaluate(()=>{window.resumed=[];window.multiplane.resume=async id=>window.resumed.push(id);});
  await page.locator('[data-job=failed] [data-resume]').click();assert.deepEqual(await page.evaluate(()=>window.resumed),['failed']);assert.equal(await page.locator('[data-job=running]').getAttribute('aria-selected'),'true');
  await page.locator('[data-job=failed] .name').click();await page.locator('#banner [data-resume]').waitFor();
  await page.screenshot({path:`out/087/${language}-${theme}-available.png`});
  jobs[2].resuming=true;await page.evaluate(jobs=>window.publish({jobs}),jobs);assert.equal(await page.locator('#banner [data-resume]').isDisabled(),true);
  for(const reason of ['inputs_changed','missing_manifest','running','environment_changed']) {
   jobs[2].resuming=false;jobs[2].resumeError={reason,changes:reason==='environment_changed'?['chromium','encoder']:['/examples/geometry/shot.html']};await page.evaluate(jobs=>window.publish({jobs}),jobs);
   assert.equal(await page.locator('#banner [data-resume]').count(),0);assert.equal(await page.locator('.resume-err').count(),1,JSON.stringify({reason,html:await page.locator('#detail').innerHTML(),faults:await page.evaluate(()=>window.faults)}));assert.ok((await page.locator('.resume-err b').innerText()).length>10);
   assert.equal(await page.locator('.resume-err [data-copy-command]').count(),reason==='running'?0:1);
   if(reason==='inputs_changed'&&language==='zh-CN')await page.screenshot({path:'out/087/zh-CN-dark-refused.png'});
  }
  delete jobs[2].resumeError;jobs[2].resumedBy='running';jobs[0].events=structuredClone(jobs[0].events);jobs[0].events[0].resumedFrom='failed';jobs[0].events[0].resume={segmentsReused:2,framesReused:10};jobs[0].events.push({type:'warning',code:'resume_renderer_changed',ts:jobs[0].updatedAt});
  await page.evaluate(jobs=>window.publish({jobs}),jobs);await page.locator('#banner [data-goto-job=running]').click();
  assert.equal(await page.locator('.d-from [data-goto-job=failed]').count(),1);
  if(language==='zh-CN')await page.screenshot({path:'out/087/zh-CN-dark-from.png'});
  await page.locator('[data-tab=timeline]').click();assert.equal(await page.locator('.tl-ev').filter({has:page.locator('.code', {hasText:'resume_renderer_changed'})}).getAttribute('class'),'tl-ev ');
  await page.locator('.d-from [data-goto-job=failed]').click();assert.ok(await page.locator('[data-job=failed] .tag').count());assert.equal(await page.locator('.d-from').count(),0);await page.locator('[data-tab=preview]').click();
  if(language==='zh-CN')await page.screenshot({path:'out/087/zh-CN-dark-resumed.png'});
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.faults),[]);await page.close();
 }
});
