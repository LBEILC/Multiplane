import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { defaultWorkers } from '../../src/render-pool.mjs';
import { resolveFFmpeg } from '../../src/ffmpeg.mjs';
import { encoderArgs } from '../../src/encoder.mjs';
import { stopChild } from '../../src/process.mjs';
import { createResourceSampler } from '../../src/resources.mjs';

export const shotNames=['dom-light','dom-heavy','canvas-2d','webgl','mixed'];
export const shotPath=name=>`tools/bench/shots/${name}.html`;
export function summary(values){const v=[...values].sort((a,b)=>a-b);return {mean:v.reduce((a,b)=>a+b,0)/v.length,p50:v[Math.ceil(v.length*.5)-1],p95:v[Math.ceil(v.length*.95)-1],min:v[0],max:v.at(-1)};}
export async function benchRun(config,frames,output){
  const start=performance.now(),slots=[];let encoder,finished;
  const resources=createResourceSampler();
  const workers=Math.min(config.workers==='auto'?defaultWorkers(config.scale):config.workers,Math.ceil(frames/4));
  const options={scale:config.scale,raster:config.raster,'motion-blur':config.blur,grain:config.grain??0,...config.options};
  let info,stderr='',rows=[],hashes=[],writeMs=0,backpressureMs=0;
  try{
    for(let i=0;i<workers;i++){
      const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{shot:shotPath(config.shot),options}});
      const slot={worker};slots.push(slot);
      slot.ready=new Promise((resolve,reject)=>{slot.pending={resolve,reject};});
      slot.ready.catch(()=>{});
      worker.on('message',m=>{if(m.error)slot.pending?.reject(Error(m.error));else slot.pending?.resolve(m);slot.pending=null;});
      worker.on('error',e=>slot.pending?.reject(e));
      slot.exit=new Promise(resolve=>worker.on('exit',code=>{slot.pending?.reject(Error(`Worker exited: ${code}`));resolve();}));
    }
    info=(await Promise.all(slots.map(s=>s.ready)))[0].info;
    const ffmpeg=await resolveFFmpeg();
    encoder=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${1920*config.scale}x${1080*config.scale}`,'-framerate','30','-i','pipe:0','-an',...encoderArgs('x264'),'-pix_fmt','yuv420p',output],{windowsHide:true,stdio:['pipe','ignore','pipe']});
    encoder.stderr.on('data',d=>{stderr=(stderr+d).slice(-4000);});encoder.stdin.on('error',()=>{});
    finished=new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('close',code=>code===0?resolve():reject(Error(stderr)));});finished.catch(()=>{});
    let next=0;const queue=[];
    const schedule=slot=>{if(next>=frames)return;const index=next++;const sent=performance.now();const promise=new Promise((resolve,reject)=>{slot.pending={resolve,reject};});promise.catch(()=>{});slot.worker.postMessage({type:'frame',index});queue.push({slot,promise,sent});};
    slots.forEach(schedule);
    while(queue.length){
      const {slot,promise,sent}=queue.shift();const frame=await promise;const received=performance.now();schedule(slot);
      const bytes=Buffer.from(frame.bytes.buffer,frame.bytes.byteOffset,frame.bytes.byteLength);
      hashes.push(createHash('sha256').update(bytes).digest('hex'));
      let syncMs=0,waitMs=0,pressureMs=0,callbackMs=0;const size=config.chunkBytes??1024*1024;
      for(let offset=0;offset<bytes.length;offset+=size){
        const before=performance.now();
        let accepted;
        const callback=new Promise((resolve,reject)=>{accepted=encoder.stdin.write(bytes.subarray(offset,offset+size),e=>e?reject(e):resolve());});
        const after=performance.now();syncMs+=after-before;
        await callback;const wait=performance.now()-after;
        // The production writer waits for every callback, even if write() returns true.
        waitMs+=wait;if(accepted)callbackMs+=wait;else pressureMs+=wait;
      }
      writeMs+=syncMs;backpressureMs+=pressureMs;
      rows.push({...frame.measures,pipeWriteMs:syncMs,pipeWaitMs:waitMs,pipeBackpressureMs:pressureMs,pipeCallbackMs:callbackMs,dispatchAndQueueMs:Math.max(0,received-sent-frame.elapsed),frameElapsedMs:frame.elapsed,overlapMs:frame.overlapMs,samples:frame.samples});
    }
    const end=performance.now();encoder.stdin.end();await finished;const encoderDrainMs=performance.now()-end;
    for(const slot of slots)slot.worker.postMessage({type:'close'});await Promise.all(slots.map(s=>s.exit));
    await resources.stop();
    const elapsedMs=performance.now()-start;
    const stages=Object.fromEntries(Object.keys(rows[0]).map(k=>[k,summary(rows.map(r=>r[k]))]));
    const accounting=['renderPageMs','renderBridgeMs','screenshotMs','base64Ms','decodeMs','averageMs','grainMs','resizeMs','otherMs','pipeWriteMs','pipeBackpressureMs','pipeCallbackMs'];
    const work=accounting.reduce((sum,k)=>sum+stages[k].mean,0);
    for(const k of accounting)stages[k].workPercent=100*stages[k].mean/work;
    return {config,workers,frames,info,elapsedMs,secondsPerVideoSecond:elapsedMs/1000/(frames/30),fps:frames/(elapsedMs/1000),processTreePeakMemory:resources.snapshot().peakMemoryBytes,encoderDrainMs,writeMs,backpressureMs,stages,rows,hashes};
  }finally{
    await resources.stop();
    for(const s of slots){s.worker.postMessage({type:'close'});}
    await Promise.all(slots.map(s=>s.exit));
    if(encoder&&!encoder.exitCode&&encoder.exitCode!==0)await stopChild(encoder);
  }
}
export async function save(file,data){await mkdir('out/bench',{recursive:true});await writeFile(file,JSON.stringify(data,null,2)+'\n');}
export const machine=()=>({cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryGiB:totalmem()/1024**3,node:process.version});
