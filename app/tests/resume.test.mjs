import test from 'node:test';
import assert from 'node:assert/strict';
import { ResumeJobs, launchResume } from '../src/main/resume.mjs';
import { createTempDirectory } from './helpers.mjs';
import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
const job = (id) => ({jobId:id,jobDir:'/separate/jobs/'+id,command:'render',state:'failed',startedAt:id,updatedAt:id,events:[]});
test('resume discovery is serial, capped, selected first, cached and invalidated by descendants', async () => {
  const store={home:createTempDirectory(),jobs:Array.from({length:25},(_,i)=>job(String(i).padStart(2,'0')))};
  const calls=[];let active=0;
  const manager=new ResumeJobs(store,'renderer',{run:async(_root,args)=>{assert.equal(++active,1);assert.ok(args[1].startsWith('/separate/jobs/'));calls.push(args[1].split('/').at(-1));await Promise.resolve();active--;return {stdout:JSON.stringify({type:'result',ok:true,data:{resume:{available:true,framesDone:4,framesTotal:16}}})};}});
  manager.prioritize('00');manager.update();clearTimeout(manager.timer);manager.timer=null;
  await manager.drain();assert.equal(calls.length,20);assert.equal(calls[0],'00');await manager.drain();assert.equal(calls.length,20);
  store.jobs.push({...job('new'),state:'running',events:[{type:'start',resumedFrom:'00'}]});manager.update();clearTimeout(manager.timer);manager.timer=null;
  await manager.drain();assert.equal(calls.length,21);assert.equal(manager.decorate(store.jobs)[0].resumedBy,'new');manager.close();
});
test('resume deduplicates clicks, records refusal details and refreshes availability', async () => {
  const original=job('old'),store={home:'home',jobs:[original],job:()=>original,refresh:async()=>{}};
  let finish, launches=0;
  const manager=new ResumeJobs(store,'root',{launch:async(_r,_h,_id,emit)=>{assert.equal(_id,'/separate/jobs/old');launches++;await new Promise(resolve=>finish=resolve);emit({type:'result',code:'resume_unavailable',ok:false,details:{reason:'inputs_changed',changes:['shot.html']}});}});
  const attempt=manager.resume('old');await manager.resume('old');assert.equal(launches,1);assert.equal(manager.decorate([original])[0].resuming,true);
  finish();await attempt;assert.deepEqual(manager.decorate([original])[0].resumeError,{reason:'inputs_changed',changes:['shot.html']});manager.close();
});
test('resume child gets detached file descriptors and parses output through files', async () => {
  const events=[];let detached=false;
  const code=await launchResume('renderer',createTempDirectory(),'old',e=>events.push(e),{create:(_file,args,opts)=>{
    assert.deepEqual(args.slice(-3),['resume','old','--json']);assert.equal(opts.detached,true);assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);assert.equal(typeof opts.stdio[1],'number');
    const child=Object.assign(new EventEmitter(),{unref(){detached=true;}});
    queueMicrotask(()=>child.emit('spawn'));
    writeSync(opts.stdio[1],JSON.stringify({schema:'multiplane/1',type:'result',ok:true,jobId:'new'})+'\n');
    setTimeout(()=>child.emit('exit',0),30);return child;
  }});assert.equal(code,0);assert.equal(detached,true);assert.equal(events[0].jobId,'new');
});
