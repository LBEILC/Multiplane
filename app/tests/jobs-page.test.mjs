import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { fixtureJobs, mountJobs } from './jobs-fixture.mjs';
import { phaseTimes, mergedEvents, projectPath, commandArgs, commandText, quoteArgument, gpuName, ffmpegVersion, warnings, optionGroups } from '../src/shared/job-detail.mjs';
import en from '../src/shared/copy/jobs-en.mjs';
import zh from '../src/shared/copy/jobs-zh-CN.mjs';
import { loadUserConfig } from '../../src/user-home.mjs';
import { createTempDirectory } from '../../tests/helpers.mjs';

test('events.jsonl projection retains first phase timestamps, latest progress, finding and terminal outcomes',async()=>{
  const events=(await readFile(new URL('fixtures/job-events.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(phaseTimes(events).map(p=>[p.phase,p.durationMs]),[['launch',1000],['load',500],['capture',1800],['encode',400],['finalize',300]]);
  const capture=mergedEvents(events).find(e=>e.phase==='capture');assert.equal(capture.done,30);assert.equal(capture.ts,events.find(e=>e.phase==='capture').ts);
  assert.equal(phaseTimes(events.slice(0,8)).at(-1).durationMs,null);
  assert.equal(projectPath({shot:'C:\\demo\\project\\shot.html',events:[{type:'start',options:{root:'.'}}]}),'C:/demo/project');
  assert.equal(projectPath({shot:'/demo/project/shots/shot.html',events:[{type:'start',options:{root:'..'}}]}),'/demo/project');
  assert.equal(gpuName(events.find(e=>e.type==='environment').gpu.renderer),'NVIDIA GeForce RTX 4070');
  assert.equal(ffmpegVersion('ffmpeg version 8.0.1 Copyright (c)'),'8.0.1');
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/renderer/jobDetail.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm'});
  const detail=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const jobs=fixtureJobs();
  for(const code of warnings){const view=detail.eventView({type:'warning',code,message:'renderer message'},jobs[0]);assert.equal(view.title,en['w_'+code]);assert.equal(view.detail,en['w_'+code+'H']);assert.equal(view.cls,'warn');assert.ok(zh['w_'+code]);}
  assert.equal(detail.eventView({type:'warning',code:'future',message:'Original'},jobs[0]).title,'Original');
  assert.equal(detail.eventView(jobs[3].events.find(e=>e.type==='finding'),jobs[3]).cls,'fail');
  assert.equal(detail.eventView(jobs[2].result,jobs[2]).title,en.ev_fail);
  assert.equal(detail.eventView(jobs[5].result,jobs[5]).title,en.ev_cancel);
});

test('copied argv is accepted by the CLI parser, excludes internals and preserves all public option types',async()=>{
  const cli=await readFile(new URL('../../bin/multiplane',import.meta.url),'utf8');
  const metadata=cli.slice(cli.indexOf('const postArgs'),cli.indexOf('// Internal flags'));
  const parser=cli.slice(cli.indexOf('      const flags ='),cli.indexOf('      delete options.json;'));
  const parse=args=>JSON.parse(JSON.stringify(vm.runInNewContext(`${metadata}\nconst command=args[0],needsTarget=true;${parser}\noptions;`,{args,invalidOption:(f,m)=>Error(m)})));
  const options={root:'/examples/demo root',out:'/examples/out/file.mp4',format:'mp4',encoder:'nvenc-h264',alpha:false,quality:'high',scale:2,'render-scale':1,upscale:'lanczos',workers:3,raster:'software',fps:29.97,from:1,to:2,'motion-blur':8,'max-motion-blur':32,shutter:.8,grain:.02,'adaptive-blur':.7,'no-post':true,'no-lint':true,overwrite:true,'no-hosted':true,'job-dir':'/examples/jobs',ffmpeg:'/tools/ffmpeg','max-bitrate':12,audio:"/examples/music's track.wav",'audio-offset':.2,'static-reuse':true,'hosted-executor':true,'job-dir-exact':'/internal'};
  const job={command:'render',shot:'/examples/demo root/shot.html',events:[{type:'start',options}]};
  const parsed=parse(commandArgs(job));
  assert.equal(parsed.format,undefined);parsed.format='mp4';parsed.alpha=false;
  for(const [key,value] of Object.entries(options))if(!['hosted-executor','job-dir-exact','upscale'].includes(key))assert.equal(parsed[key],typeof value==='boolean'?value:String(value),key);
  assert.equal(parsed.upscale,undefined);assert.doesNotMatch(commandText(job,'win32'),/hosted-executor|job-dir-exact/);
  assert.equal(quoteArgument("/a/b's $test.html",'win32'),"'/a/b''s $test.html'");
  assert.equal(quoteArgument("/a/b's $test.html",'linux'),"'/a/b'\"'\"'s $test.html'");
  for(const command of ['stills','verify']) {const j={...job,command,events:[{type:'start',options:{root:'/examples',format:'png',at:'0,.5',out:'/examples/stills','no-hosted':true}}]};assert.equal(parse(commandArgs(j)).at,'0,.5');}

  // Built-in defaults still need to override saved preferences when replayed.
  const home=createTempDirectory('multiplane-command-copy-');
  await writeFile(path.join(home,'config.json'),JSON.stringify({schema:'multiplane/1',encoder:'nvenc-h264',raster:'software'}));
  const env={MULTIPLANE_HOME:home};
  for(const command of ['render','stills','verify']) {
    const explicit=command==='render'?{encoder:'x264',raster:'gpu'}:{raster:'gpu'};
    const original=loadUserConfig(command,explicit,env).options;
    const copied={...job,command,events:[{type:'start',options:original}]};
    assert.deepEqual(loadUserConfig(command,parse(commandArgs(copied)),env).options,original,command);
  }
});

test('live jobs retain rollers, update values, navigate media, and disable motion with the OS preference',async ctx=>{
  const browser=await chromium.launch();ctx.after(()=>browser.close());const page=await browser.newPage();
  const image=await sharp({create:{width:640,height:360,channels:3,background:'#ccc'}}).png().toBuffer();
  const {errors,jobs}=await mountJobs(page,{media:async()=>({body:image,contentType:'image/png'})});
  await page.evaluate(()=>{window.row=document.querySelector('[data-roll="row-running"]');window.phase=document.querySelector('[data-roll="phase-running"]');});
  jobs[0].done=22;jobs[0].fps=20;
  await page.evaluate(jobs=>window.publish({jobs}),jobs);
  assert.equal(await page.evaluate(()=>window.row===document.querySelector('[data-roll="row-running"]')),true);
  assert.equal(await page.evaluate(()=>window.phase===document.querySelector('[data-roll="phase-running"]')),true);
  assert.equal(await page.locator('[data-roll="row-running"]').getAttribute('data-value'),'22');
  assert.equal(await page.locator('[data-roll="speed-running"]').getAttribute('data-value'),'20');
  await page.locator('[data-tab=options]').click();assert.doesNotMatch(await page.locator('#tab-content').innerText(),/hosted-executor|job-dir-exact/);
  await page.locator('[data-job=verify]').click();await page.locator('[data-tab=preview]').click();await page.locator('.triptych img').first().click();
  await page.waitForFunction(()=>document.querySelector('.lb-img img')?.naturalWidth===640);
  // Replay an old image load after navigation to cover cached-image callback races.
  await page.evaluate(()=>{window.staleImageLoad=document.querySelector('.lb-img img').onload;});
  await page.keyboard.press('3');assert.equal(await page.locator('.lb-title b').innerText(), zh.difference ?? '差异图');await page.locator('.lb .bbox').waitFor();assert.equal(await page.locator('.lb .bbox').count(),1);
  await page.evaluate(()=>window.staleImageLoad());
  assert.equal(await page.locator('.lb .bbox').count(),1);
  await page.locator('[data-v=box]').click();assert.equal(await page.locator('.lb .bbox').count(),0);
  await page.locator('[data-v=one]').click();assert.equal(await page.locator('.lb-zoom').innerText(),'100%');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.lb').count(),0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('[data-job=running]').click();jobs[0].phase='encode';await page.evaluate(jobs=>window.publish({jobs}),jobs);
  assert.equal(await page.locator('.pbar i').evaluate(el=>getComputedStyle(el).animationName),'none');
  jobs[0]={...jobs[1],jobId:'running'};await page.evaluate(jobs=>window.publish({jobs}),jobs);
  assert.equal(await page.locator('.progress-card').count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.faults),[]);
});
