import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export function fixtureJobs() {
  const event = (type, seconds, fields={}) => ({schema:'multiplane/1',type,command:'render',ts:new Date(Date.UTC(2026,9,16,6,31,0)+seconds*1000).toISOString(),...fields});
  const events = [event('start',0,{version:'0.3.7',shot:'/examples/geometry/card.html',options:{root:'.',quality:'standard',format:'mp4',encoder:'x264',out:'/examples/geometry/out/card.mp4',workers:2,raster:'gpu',scale:1,'render-scale':1,'motion-blur':4,'max-motion-blur':16,'adaptive-blur':.5,'no-post':false,'no-lint':false,overwrite:false,from:0,'job-dir':'/examples/geometry/out/jobs',ffmpeg:'ffmpeg','hosted-executor':true},workersSource:'estimate'}),
    event('progress',0,{phase:'launch',done:0,total:null}),
    event('environment',1,{chromium:'153.0.8010.12',node:'v24.14.0',gpu:{renderer:'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)',hardware:true},ffmpeg:{version:'ffmpeg version 8.0 Copyright (c) FFmpeg developers'}}),
    event('progress',1,{phase:'load',done:0,total:null}),
    event('shot',1.5,{width:640,height:360,duration:1,fps:30,cuts:[.4,.7],post:{motionBlur:4,grain:.015}}),
    event('progress',1.5,{phase:'capture',done:0,total:30,fps:0}),
    event('warning',2,{code:'browser_restarted',message:'A browser restarted.'}),
    event('progress',2.5,{phase:'capture',done:18,total:30,fps:18}),
    event('warning',2.6,{code:'future_warning',message:'Future renderer warning.',hint:'Future hint.'}),
    event('progress',3.2,{phase:'capture',done:30,total:30,fps:18}),
    event('progress',3.3,{phase:'encode',done:0,total:null}),
    event('artifact',3.6,{kind:'video',path:'/examples/geometry/out/card.mp4',bytes:246800}),
    event('progress',3.7,{phase:'finalize',done:0,total:null}),
    event('result',4,{ok:true,elapsedMs:4000,artifacts:[{kind:'video',path:'/examples/geometry/out/card.mp4',bytes:246800}],data:{output:'/examples/geometry/out/card.mp4',format:'mp4',encoder:'x264',quality:'standard',width:640,height:360,frames:30,fps:30,from:0,to:1,post:{motionBlur:4,grain:.015},blurSamples:{min:1,max:16,mean:4.4,histogram:{1:4,4:24,16:2}},outputCheck:{verified:true},resources:{peakMemoryBytes:950000000,workers:2,cpuCount:16},staticReuse:{reusedFrames:4}}})];
  const job=(id,command,state,ev)=>({jobId:id,jobDir:'/examples/geometry/out/jobs/'+id,shot:'/examples/geometry/'+id+'.html',command,state,phase:state==='running'?'capture':'finalize',done:18,total:30,fps:18,etaMs:700,startedAt:events[0].ts,updatedAt:ev.at(-1).ts,previewFrame:17,previewVersion:'1',hosted:true,pid:1,events:ev,result:ev.at(-1).type==='result'?ev.at(-1):null});
  const running=job('running','render','running',events.slice(0,8));
  const success=job('success','render','succeeded',events);
  const failed=job('failed','render','failed',[...events.slice(0,8),event('result',3,{ok:false,code:'render_threw',message:'render(t) threw an exception.',hint:'Check the shot at this time.',details:{t:.6},elapsedMs:3000,artifacts:[],data:{}})]);
  const finding=event('finding',3,{code:'nondeterministic_output',severity:'error',message:'Pixels differ between repeated renders.',location:{t:.4,frame:12},details:{check:'reload',changedPixels:6400,bbox:{x:180,y:95,w:120,h:80},images:{reference:'/images/reference.png',actual:'/images/actual.png',diff:'/images/diff.png'}}});
  const verify=job('verify','verify','failed',[...events.slice(0,8),finding,event('result',4,{ok:false,code:'nondeterministic_output',message:'Repeated frames differ.',elapsedMs:4000,data:{},artifacts:[]})]);
  const stills=job('stills','stills','succeeded',[...events.slice(0,8),event('result',4,{ok:true,elapsedMs:4000,artifacts:[0,1,2].map(i=>({kind:'still',path:`/images/still-${i}.png`,bytes:2048})),data:{stills:[0,1,2].map(i=>({path:`/images/still-${i}.png`,t:i/3,frame:i*10}))}})]);
  const cancelled=job('cancelled','render','cancelled',[...events.slice(0,8),event('result',3,{ok:false,code:'cancelled',message:'Cancelled by request.',elapsedMs:3000,artifacts:[],data:{}})]);
  return [running,success,failed,verify,stills,cancelled];
}

export async function mountJobs(page,{language='zh-CN',theme='dark',jobs=fixtureJobs(),media, reduced=false}={}) {
  await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
  await page.setViewportSize({width:1160,height:800});page.setDefaultTimeout(5000);
  const source=name=>new URL('../src/renderer/'+name,import.meta.url);
  const bundle=await build({entryPoints:[fileURLToPath(source('index.ts'))],bundle:true,write:false,platform:'browser',format:'iife'});
  await page.route('https://multiplane.test/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:(await readFile(source('index.html'),'utf8')).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'').replace(/<link[^>]*>/g,'').replace('<script src="renderer.js"></script>','').replace('<!-- BRAND_MARK -->',(await readFile(new URL('../design/icons/mark.svg',import.meta.url),'utf8')).replace('<svg ','<svg class="brand-mark" '))});
    if(url.pathname.startsWith('/media/')) {
      const response=await media(decodeURIComponent(url.pathname.slice(7)));
      const range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      if(range){const start=Number(range[1]),end=range[2]?Number(range[2]):response.body.length-1;return route.fulfill({...response,status:206,body:response.body.subarray(start,end+1),headers:{'accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${response.body.length}`}});}
      return route.fulfill({...response,headers:{'accept-ranges':'bytes'}});
    }
    try{return route.fulfill({body:await readFile(new URL(url.pathname.startsWith('/icons/')?'../node_modules/remixicon/fonts/'+url.pathname.split('/').at(-1):'../build/fonts/MiSansVF.ttf',import.meta.url))});}catch{return route.abort();}
  });
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('https://multiplane.test/');
  await page.addStyleTag({content:await readFile(new URL('../design/tokens.css',import.meta.url),'utf8')});
  await page.addStyleTag({content:await readFile(source('style.css'),'utf8')});
  await page.addStyleTag({content:(await readFile(new URL('../node_modules/remixicon/fonts/remixicon.css',import.meta.url),'utf8')).replaceAll('url("','url("/icons/')});
  await page.evaluate(({jobs,language,theme})=>{
    document.documentElement.dataset.language=language;document.documentElement.dataset.theme=theme;
    const state={ready:true,jobs,language,theme,hosted:true,runningCount:1};let subscriber;
    window.publish=(change)=>{Object.assign(state,change);subscriber(structuredClone(state));};
    window.faults=[];window.opened=[];
    window.multiplane={platform:async()=>({platform:'win32',home:'/example'}),snapshot:async()=>structuredClone(state),subscribe:fn=>{subscriber=fn;},reportFault:e=>window.faults.push(e),
      settings:async()=>({own:{wizardDone:true,language,theme},values:{hosted:true},overrides:{},version:'0.3.7'}),
      browserInstallState:async()=>({running:false}),onBrowserInstallState:()=>{},onSkillConfirmation:()=>{},updateState:async()=>({phase:'development'}),onUpdateState:()=>{},
      media:(_id,path)=>'https://multiplane.test/media/'+encodeURIComponent(path),open:async(...args)=>window.opened.push(args),stop:async()=>{},hide:async()=>{}};
  },{jobs,language,theme});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.locator('.job').first().waitFor();await page.evaluate(()=>document.fonts.ready);
  return {errors,jobs};
}
