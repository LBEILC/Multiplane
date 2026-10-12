import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { openShot } from '../../src/capture.mjs';
import { scanShot } from '../../src/lint.mjs';
import { verifyShot } from '../../src/verify.mjs';
import { decodeNativePNG } from '../../src/png-native.mjs';
import { measuredShot } from './capture.mjs';
import { shotNames,shotPath,save } from './runner.mjs';
await mkdir('out/bench',{recursive:true});
process.env.MULTIPLANE_NO_INDEX='1';
const results=[];
for(const name of shotNames){
 console.log(`Validate ${name}`);const shot=shotPath(name),lint=await scanShot(shot);
 if(lint.data.errors||lint.data.warnings)throw Error(JSON.stringify(lint));
 const verified=await verifyShot(shot,{at:'0,0.5,1',workers:2,out:`out/bench/verify-${name}`,overwrite:true,'job-dir':'out/bench/jobs',onEvent:()=>{}});
 const measured=await measuredShot(shot,{scale:1,raster:'gpu'});let equivalent=true;
 try{for(const frame of [0,15,30]){
  const reference=(await decodeNativePNG(await measured.originalFrame(frame/30))).data;
  const actual=(await measured.frame(frame)).bytes;equivalent &&= reference.equals(actual);
 }}finally{await measured.capture.close();}
 if(!equivalent)throw Error(`Instrumentation changes pixels: ${name}`);
 results.push({name,lint:lint.data,verify:verified.data,measuredCaptureEquivalent:equivalent});await save('out/bench/validation.json',results);
}
