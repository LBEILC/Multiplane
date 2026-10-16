import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureElectron } from './electron.mjs';
import { ensureLocalFfmpeg } from '../../tests/local-ffmpeg.mjs';
import { json } from '../src/main/hosted.mjs';
ensureLocalFfmpeg();
const root=path.resolve(import.meta.dirname,'../..'), out=path.join(root,'out/087');await mkdir(out,{recursive:true});
const work=await mkdtemp(path.join(out,'real-')),home=path.join(work,'home'),data=path.join(work,'desktop'),jobs=path.join(work,'jobs');
await mkdir(home);await mkdir(data);
await writeFile(path.join(data,'preferences.json'),JSON.stringify({wizardDone:true,language:'zh-CN',theme:'dark',notifications:false,autoCheckUpdates:false}));
const env={...process.env,MULTIPLANE_HOME:home,MULTIPLANE_APP_DATA:data,MULTIPLANE_TEST_USER_HOME:work};delete env.ELECTRON_RUN_AS_NODE;delete env.MULTIPLANE_NO_INDEX;delete env.MULTIPLANE_JOBS_DIR;delete env.MULTIPLANE_HOSTED;
const shot=path.join(work,'sample.html');
await writeFile(shot,'<style>body{margin:0}#stage{width:640px;height:360px;background:#abc}i{display:block;width:50px;height:50px;background:#c34}</style><div id="stage"><i></i></div><script>window.SHOT={duration:22,fps:2,async render(t){document.querySelector("i").style.transform="translateX("+t*20+"px)";await new Promise(r=>setTimeout(r,100));}}</script>');
function command(args,onEvent=()=>{}) {return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[path.join(root,'bin/multiplane'),...args],{env,cwd:work,windowsHide:true,shell:false});let stdout='',stderr='',pending='';
 child.stdout.on('data',b=>{stdout+=b;pending+=b;const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line.trim())onEvent(JSON.parse(line));});child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
});}
async function until(fn,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await delay(80);}throw Error('Verification timed out');}
const renderArgs=output=>['render',shot,'--root',work,'--out',output,'--job-dir',jobs,'--workers','1','--raster','software','--no-post','--no-lint','--no-hosted','--json'];
async function hashes(file){return new Promise((resolve,reject)=>{const child=spawn(env.MULTIPLANE_FFMPEG||'ffmpeg',['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-'],{windowsHide:true,shell:false});let text='';child.stdout.on('data',b=>text+=b);child.on('error',reject);child.on('close',code=>code?reject(Error('framemd5 failed')):resolve(text.split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim())));});}
const baseline=path.join(work,'baseline.mp4');assert.equal((await command(renderArgs(baseline))).code,0);const expected=await hashes(baseline);assert.equal(expected.length,44);
const evidence={frames:44,width:640,height:360,modes:[]};
for(const hosted of [false,true]){
 const output=path.join(work,hosted?'hosted.mp4':'standalone.mp4');let original;
 const rendering=command(renderArgs(output),e=>{if(e.type==='start')original=e.jobId;});
 await until(()=>original);const directory=path.join(jobs,original);
 await until(async()=> (await json(path.join(directory,'segments/manifest.json')))?.segments?.length>0);
 await writeFile(path.join(directory,'stop'),'');const stopped=await rendering;assert.equal(JSON.parse(stopped.stdout.trim().split('\n').at(-1)).code,'cancelled');
 await writeFile(path.join(home,'config.json'),JSON.stringify({hosted}));
 let desktop=await launchDesktop();
 try {
  const page=await desktop.firstWindow();page.setDefaultTimeout(30000);await page.locator(`[data-job="${original}"]`).click();await page.locator('#banner [data-resume]').click();
  const selected=await until(async()=>{const s=await page.evaluate(()=>window.multiplane.snapshot());return s.jobs.find(j=>j.events.some(e=>e.type==='start'&&e.resumedFrom===original));});
  assert.equal(await page.locator(`[data-job="${selected.jobId}"]`).getAttribute('aria-selected'),'true');
  if(hosted){const request=await json(path.join(home,'hosted',selected.jobId+'.running.json'));assert.equal(request.command,'resume');}
  else {assert.equal(selected.state,'running');await desktop.close();desktop=null;}
  const result=await until(async()=>(await json(path.join(selected.jobDir,'status.json')))?.result);
  assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.data.resume.framesReused>0);assert.deepEqual(await hashes(output),expected);
  evidence.modes.push({hosted,completed:true,framesReused:result.data.resume.framesReused,segmentsReused:result.data.resume.segmentsReused,frameHashesEqual:true,quitWhileRunning:!hosted});
  console.log(JSON.stringify(evidence.modes.at(-1)));
 }finally{if(desktop)await desktop.close();}
}
await writeFile(path.join(out,'real-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log('Real CLI and desktop resume verification passed.');


async function connect(endpoint) {
 const socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let id=0;const pending=new Map();socket.onmessage=event=>{const value=JSON.parse(event.data);if(value.id&&pending.has(value.id)){pending.get(value.id).resolve(value);pending.delete(value.id);}};
 socket.onclose=()=>{for(const p of pending.values())p.reject(Error('Desktop debugging connection closed'));pending.clear();};
 return {socket,async evaluate(expression){const request=++id;const response=new Promise((resolve,reject)=>pending.set(request,{resolve,reject}));socket.send(JSON.stringify({id:request,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));const value=await response;if(value.error||value.result.exceptionDetails)throw Error(JSON.stringify(value));return value.result.result.value;}};
}
async function launchDesktop(){
 const child=spawn(await ensureElectron(),[path.join(root,'app'),'--no-sandbox','--inspect=0','--remote-debugging-port=0'],{env,cwd:root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let log='';
 child.stderr.on('data',b=>log+=b);child.stdout.on('data',b=>log+=b);
 const endpoint=await until(()=>{if(child.exitCode!==null)throw Error(log);return log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];});
 const targets=await until(async()=>{const list=await (await fetch('http://'+new URL(endpoint).host+'/json/list')).json();return list.find(t=>t.type==='page'&&t.url.includes('index.html'));});
 const connection=await connect(targets.webSocketDebuggerUrl);
 const page={setDefaultTimeout(){},evaluate:fn=>connection.evaluate('('+fn.toString()+')()'),locator:selector=>({
  async click(){await until(()=>connection.evaluate('!!document.querySelector('+JSON.stringify(selector)+')'));await connection.evaluate('document.querySelector('+JSON.stringify(selector)+').click()');},
  getAttribute:name=>connection.evaluate('document.querySelector('+JSON.stringify(selector)+')?.getAttribute('+JSON.stringify(name)+')')
 })};
 const inspector=await until(()=>log.match(/Debugger listening on (ws:\/\/\S+)/)?.[1]);
 return {firstWindow:async()=>page,close:async()=>{
  connection.socket.close();const control=await connect(inspector);
  void control.evaluate("process.getBuiltinModule('module').createRequire(process.cwd() + '/app/package.json')('electron').app.quit()").catch(()=>{});
  await delay(100);control.socket.close();await until(()=>child.exitCode!==null);
 }};
}
