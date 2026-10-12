import { readFile,writeFile } from 'node:fs/promises';
import { averageLinear,linearToByte } from '../../src/post.mjs';
import { decodeNativePNG } from '../../src/png-native.mjs';
import { createHash } from 'node:crypto';
const [mode,scaleText]=process.argv.slice(2),scale=Number(scaleText),width=1920*scale,height=1080*scale;
const files=Array.from({length:8},(_,i)=>`out/bench/blur-${scale}-${i}.png`);
global.gc?.();const base=process.memoryUsage().rss,start=performance.now();let peak=base;
const sample=()=>{peak=Math.max(peak,process.memoryUsage().rss);};
let result;
if(mode==='buffered'){
 const images=[];for(const file of files){images.push(await decodeNativePNG(await readFile(file)));sample();}
 result=averageLinear(images).data;sample();
}else{
 const sums=mode==='float32'?new Float32Array(width*height*4):new Float64Array(width*height*4);sample();
 const linear=Float64Array.from({length:256},(_,i)=>{const v=i/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
 for(const file of files){const {data}=await decodeNativePNG(await readFile(file));for(let p=0;p<data.length;p++)sums[p]+=p%4===3?data[p]:linear[data[p]];sample();}
 result=Buffer.alloc(width*height*4);for(let p=0;p<result.length;p++)result[p]=p%4===3?Math.round(sums[p]/8):linearToByte(sums[p]/8);sample();
}
const elapsedMs=performance.now()-start;
await writeFile(`out/bench/stream-${mode}-${scale}.rgba`,result);
console.log(JSON.stringify({mode,scale,elapsedMs,baseRss:base,sampledPeakRss:peak,osPeakRss:process.resourceUsage().maxRSS*1024,sha256:createHash('sha256').update(result).digest('hex')}));
