import './test-home.mjs';
import test from 'node:test';
import { fullTest } from './suite.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { draftScale,applyDraft } from '../src/draft.mjs';
import { run,createTempDirectory } from './helpers.mjs';
import { decodePNG } from '../src/png.mjs';
const out=createTempDirectory();
const cli=args=>run(process.execPath,['bin/multiplane',...args,'--json','--job-dir',path.join(out,'jobs')]);
const events=result=>{assert.equal(result.code,0,result.stdout+result.stderr);return result.stdout.trim().split('\n').map(JSON.parse);};

test('draft stills publish relative output paths with and without atomic replacement', {timeout:60000}, async()=>{
 const directory=createTempDirectory(path.resolve('out/tests/draft-small-'));
 const shot=path.join(directory,'draft-small.html');
 await writeFile(shot,'<style>html,body{margin:0}#stage{width:640px;height:360px;background:#789}</style><div id="stage"></div><script>window.SHOT={duration:1,render(t){}}</script>');
 const target=path.join(directory,'draft-small');
 for(const extra of [[],['--overwrite']]){
  const list=events(await cli(['stills',shot,'--draft','--at','0','--out',path.relative(process.cwd(),target),...extra]));
  const result=list.at(-1);
  assert.equal(result.data.draft,true);
  assert.equal(result.data.stills[0].path,path.join(target,'t-0.00.png'));
  assert.deepEqual(result.artifacts.map(a=>a.path),[path.join(target,'t-0.00.png'),path.join(target,'_sheet.png')]);
  const image=decodePNG(await readFile(result.data.stills[0].path));
  assert.equal(image.width,640);assert.equal(image.height,360);
 }
});
test('draft chooses the largest legal common scale and respects explicit values',async()=>{
 assert.equal(draftScale(1920,1080),.5);assert.equal(draftScale(642,366),1/3);assert.equal(draftScale(640,360,.25),.25);
 assert.throws(()=>draftScale(642,362),{code:'invalid_scale'});
 const explicit={draft:true,'render-scale':.75,'motion-blur':8,grain:3,upscale:'neighbor'};
 assert.deepEqual(await applyDraft('render','unused',explicit,{'motion-blur':16,grain:5}),{...explicit,'max-motion-blur':1});
 assert.equal((await applyDraft('render','unused',{...explicit,'max-motion-blur':64},{}))['max-motion-blur'],1);
 const disabled=await applyDraft('render','unused',{draft:true,'render-scale':.5,'no-post':true,grain:3,'motion-blur':8},{});
 assert.equal(disabled.grain,0);assert.equal(disabled['motion-blur'],1);assert.equal(disabled.shutter,.5);
 const configured={grain:4};assert.equal(await applyDraft('render','unused',{},configured),configured);
});
test('draft render and stills report effective preset; explicit settings match manual pixels', {timeout:120000},async()=>{
 const result=events(await cli(['render','examples/animation.html','--draft','--workers','1','--to','.1','--out',path.join(out,'draft.mp4')]));
 const start=result.find(e=>e.type==='start').options;
 assert.equal(start.draft,true);assert.equal(start['render-scale'],.5);assert.equal(start['motion-blur'],1);assert.equal(start['max-motion-blur'],1);assert.equal(result.at(-1).data.post.maxMotionBlur,1);assert.equal(start.grain,0);assert.equal(start.upscale,'lanczos');assert.equal(result.at(-1).data.draft,true);
 for(const [name,args]of [['draft',['--draft']],['manual',['--render-scale','.5','--motion-blur','1','--grain','0']],['override',['--draft','--render-scale','1','--grain','2','--motion-blur','2']],['explicit',['--render-scale','1','--grain','2','--motion-blur','2','--max-motion-blur','2']]]){
  const list=events(await cli(['stills','examples/animation.html','--at','.5','--out',path.join(out,name),...args]));
  assert.equal(list.at(-1).data.draft,name==='draft'||name==='override'?true:undefined);
 }
 for(const [a,b]of [['draft','manual'],['override','explicit']])assert.deepEqual(decodePNG(await readFile(path.join(out,a,'t-0.50.png'))).data,decodePNG(await readFile(path.join(out,b,'t-0.50.png'))).data);
});
fullTest('draft uses loaded stage dimensions and rejects impossible presets', {timeout:60000},async()=>{
 for(const [width,height,expected]of [[642,366,1/3],[642,362,null]]){
  const file=path.join(out,`stage-${height}.html`);await writeFile(file,`<style>html,body{margin:0}#stage{width:${width}px;height:${height}px}</style><div id="stage"></div><script>window.SHOT={duration:1,render(t){document.querySelector('#stage').style.background='#789'}};</script>`);
  const r=await cli(['stills',path.basename(file),'--root',out,'--draft','--at','0','--out',path.join(out,`size-${height}`)]);
  if(expected===null){assert.notEqual(r.code,0);assert.equal(JSON.parse(r.stdout.trim().split('\n').at(-1)).code,'invalid_scale');}
  else assert.equal(events(r).find(e=>e.type==='start').options['render-scale'],expected);
 }
});

test('draft is a boolean CLI flag and conflicts with other quality presets',async()=>{
 const help=await run(process.execPath,['bin/multiplane','render','--help']);assert.match(help.stdout,/--draft(?: |$)/);assert.doesNotMatch(help.stdout,/--draft <value>/);
 const result=await cli(['verify','examples/animation.html','--draft','--quality','high']);assert.notEqual(result.code,0);assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).code,'invalid_option');
});

test('draft lint rejects nondeterministic shots before opening the dimension probe',async()=>{
 const file=path.join(out,'invalid.html');await writeFile(file,'<style>#stage{width:640px;height:360px}</style><div id="stage"></div><script>window.SHOT={duration:1,render(t){Date.now()}}</script>');
 const result=await cli(['stills','invalid.html','--root',out,'--draft','--out',path.join(out,'invalid-result')]);
 const list=result.stdout.trim().split('\n').map(JSON.parse);assert.notEqual(result.code,0);assert.equal(list.at(-1).code,'lint_failed');assert.equal(list[0].type,'start');assert.ok(list.some(e=>e.type==='finding'&&e.code==='wall_clock'));assert.equal(list.some(e=>e.type==='environment'),false);
});
