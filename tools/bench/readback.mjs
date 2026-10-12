import { spawn } from 'node:child_process';
import { openShot } from '../../src/capture.mjs';
import { decodeNativePNG } from '../../src/png-native.mjs';
import { writeFrame } from '../../src/video-pipe.mjs';
import { resolveFFmpeg } from '../../src/ffmpeg.mjs';
import { encoderArgs } from '../../src/encoder.mjs';
import { environment } from '../../src/environment.mjs';
import { binaryReceiver,installReadback } from './binary.mjs';
import { save,shotPath,machine,summary } from './runner.mjs';
import { mkdir } from 'node:fs/promises';
export function difference(a,b){
 if(a.length!==b.length)throw Error('Pixel dimensions differ');let changedPixels=0,maxChannelDiff=0,sum=0;
 for(let p=0;p<a.length;p+=4){let changed=false;for(let c=0;c<4;c++){const d=Math.abs(a[p+c]-b[p+c]);changed ||= d>0;maxChannelDiff=Math.max(maxChannelDiff,d);sum+=d;}changedPixels+=Number(changed);}
 return {equal:changedPixels===0,changedPixels,maxChannelDiff,meanAbsoluteChannelDiff:sum/a.length};
}
const data={machine:machine(),method:'Warm end-to-end includes render, acquisition, pipe and encoder drain; shared browser/receiver startup excluded equally. Acquisition includes binary readback and transport. Three repeats with a fresh browser for each mode/repeat; t=0,0.5,1. Pixel comparison runs after encoder completion.',runs:[]};
await mkdir('out/bench',{recursive:true});
for(const shot of ['canvas-2d','webgl'])for(const scale of [1,2])for(const raster of ['gpu','software']){
 console.log(`Readback: ${shot} scale=${scale} raster=${raster}`);
 let capture=await openShot(shotPath(shot),scale,{raster}),receiver;
 try{
  const info=await environment(capture.browser),references=new Map();
  for(const t of [0,.5,1])references.set(t,(await decodeNativePNG(await capture.frame(t))).data);
  for(let repeat=0;repeat<3;repeat++)for(const mode of (repeat%2?['ws','post','screenshot']:['screenshot','post','ws'])){
   await capture.close();
   capture=await openShot(shotPath(shot),scale,{raster});
   receiver=await binaryReceiver(1920*1080*scale*scale*4);await installReadback(capture.page,receiver.url);
   const session=await capture.page.context().newCDPSession(capture.page);
   const start=performance.now();
   const encoder=spawn(await resolveFFmpeg(),['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${1920*scale}x${1080*scale}`,'-framerate','30','-i','pipe:0','-an',...encoderArgs('x264'),'-pix_fmt','yuv420p',`out/bench/proto-${shot}-${scale}-${raster}-${mode}-${repeat}.mp4`],{windowsHide:true,stdio:['pipe','ignore','pipe']});
   let stderr='';encoder.stderr.on('data',d=>stderr+=d);encoder.stdin.on('error',()=>{});
   const done=new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('close',code=>code===0?resolve():reject(Error(stderr)));});done.catch(()=>{});
   const rows=[],frames=[];
   for(const t of [0,.5,1]){
    const frameStart=performance.now();let pixels,acquisitionMs;
    if(mode==='screenshot'){
      // Separate render and screenshot using the same stage invalidation as production.
      await capture.page.evaluate(t=>{const s=document.querySelector('#stage');s.style.display='none';s.getBoundingClientRect();s.style.removeProperty('display');SHOT.render(t);s.getBoundingClientRect();},t);
      const snap=performance.now();
      const {data:png}=await session.send('Page.captureScreenshot',{format:'png',optimizeForSpeed:true,captureBeyondViewport:false,clip:{x:0,y:0,width:1920,height:1080,scale}});
      pixels=(await decodeNativePNG(Buffer.from(png,'base64'))).data;acquisitionMs=performance.now()-snap;
    }else{
      await capture.page.evaluate(t=>{const s=document.querySelector('#stage');s.style.display='none';s.getBoundingClientRect();s.style.removeProperty('display');SHOT.render(t);s.getBoundingClientRect();},t);
      const snap=performance.now();const pending=receiver.next();await capture.page.evaluate(mode=>window.BENCH_TRANSFER(mode),mode);pixels=await pending;acquisitionMs=performance.now()-snap;
    }
    const frameMs=performance.now()-frameStart;
    await writeFrame(encoder.stdin,pixels);
    frames.push(pixels);rows.push({t,acquisitionMs,frameMs});
   }
   encoder.stdin.end();await done;
   const elapsedMs=performance.now()-start;
   for(const [i,row]of rows.entries())Object.assign(row,difference(references.get(row.t),frames[i]));
   await receiver.close();receiver=undefined;
   data.runs.push({shot,scale,raster,mode,repeat,info,elapsedMs,acquisition:summary(rows.map(r=>r.acquisitionMs)),rows});await save('out/bench/readback.json',data);
  }
 }finally{await receiver?.close();await capture.close();}
}
console.log('Readback results: out/bench/readback.json');
