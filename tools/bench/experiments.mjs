import { openShot } from '../../src/capture.mjs';
import { writeFile,readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { benchRun,save,shotPath } from './runner.mjs';
const results={variants:[],streaming:[]};
const base={shot:'dom-heavy',scale:1,blur:1,workers:1,raster:'gpu'};
const variants=[['baseline',{}],['playwright',{options:{capture:'playwright'}}],['png-compressed',{options:{optimize:false}}],['js-decoder',{options:{decoder:'js'}}],['auto-workers',{workers:'auto'}],['pipe-64k',{chunkBytes:65536}],['pipe-8m',{chunkBytes:8388608}]];
for(let repeat=0;repeat<3;repeat++)for(const [name,change]of (repeat%2?[...variants].reverse():variants)){
 console.log(`Variant ${name} repeat ${repeat+1}`);const run=await benchRun({...base,...change},8,`out/bench/variant-${name}-${repeat}.mp4`);results.variants.push({name,repeat,...run});await save('out/bench/experiments.json',results);
}
for(const scale of [1,2]){
 const capture=await openShot(shotPath('canvas-2d'),scale);
 try{for(let i=0;i<8;i++)await writeFile(`out/bench/blur-${scale}-${i}.png`,await capture.frame(.5+((i+.5)/8-.5)*.5/30));}finally{await capture.close();}
 for(let repeat=0;repeat<3;repeat++)for(const mode of ['buffered','float64','float32']){
  console.log(`Streaming ${mode} scale ${scale} repeat ${repeat+1}`);
  const run=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--expose-gc','tools/bench/stream-child.mjs',mode,String(scale)],{windowsHide:true});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.once('error',reject);child.once('close',code=>code===0?resolve(JSON.parse(stdout)):reject(Error(stderr)));});
  if(mode!=='buffered'){const expected=await readFile(`out/bench/stream-buffered-${scale}.rgba`),actual=await readFile(`out/bench/stream-${mode}-${scale}.rgba`);let changedPixels=0,maxChannelDiff=0;for(let p=0;p<expected.length;p+=4){let changed=false;for(let c=0;c<4;c++){const delta=Math.abs(expected[p+c]-actual[p+c]);changed ||= delta>0;maxChannelDiff=Math.max(maxChannelDiff,delta);}changedPixels+=Number(changed);}Object.assign(run,{changedPixels,maxChannelDiff,equal:changedPixels===0});}else Object.assign(run,{changedPixels:0,maxChannelDiff:0,equal:true});
  results.streaming.push({...run,repeat});await save('out/bench/experiments.json',results);
 }
}
console.log('Experiments: out/bench/experiments.json');
