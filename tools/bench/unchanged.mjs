// Prepare out/bench/baseline from a pre-change git archive (src, bin, examples, package.json).
﻿import {spawn} from 'node:child_process';import {readFile,writeFile} from 'node:fs/promises';import {decodeNativePNG} from '../../src/png-native.mjs';
const run=(args,extra={})=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{windowsHide:true,...extra});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.once('error',reject);child.once('close',code=>code===0?resolve(stdout):reject(Error(stdout+stderr)));});
const results=[];
for(const name of ['animation','typography','three-cards']){
 for(const variant of ['old','current']){
  await run([variant==='old'?'out/bench/baseline/bin/multiplane':'bin/multiplane','stills',`examples/${name}.html`,'--at','0,.5,1','--grain','2','--motion-blur','8','--out',`out/bench/unchanged-${name}-${variant}`,'--overwrite','--job-dir','out/bench/jobs']);
 }
 for(const t of ['0.00','0.50','1.00']){const a=(await decodeNativePNG(await readFile(`out/bench/unchanged-${name}-old/t-${t}.png`))).data,b=(await decodeNativePNG(await readFile(`out/bench/unchanged-${name}-current/t-${t}.png`))).data;results.push({name,t,equal:a.equals(b)});if(!a.equals(b))throw Error('Default pixels changed');}
}
for(const variant of ['old','current'])await run([variant==='old'?'out/bench/baseline/bin/multiplane':'bin/multiplane','render','examples/animation.html','--to','.5','--workers','2','--grain','2','--motion-blur','8','--overwrite','--out',`out/bench/unchanged-${variant}.mp4`,'--job-dir','out/bench/jobs'],{env:{...process.env,RENDER_FRAME_HASHES:`out/bench/hashes-${variant}.json`}});
const old=JSON.parse(await readFile('out/bench/hashes-old.json')),current=JSON.parse(await readFile('out/bench/hashes-current.json'));if(JSON.stringify(old)!==JSON.stringify(current))throw Error('Render pixels changed');results.push({renderFrames:old.length,equal:true});await writeFile('out/bench/unchanged.json',JSON.stringify(results,null,2));console.log('Pre-change and current pixels match.');
