import { openShot } from '../../src/capture.mjs';
import { decodeNativePNG } from '../../src/png-native.mjs';
import { binaryReceiver,installReadback } from './binary.mjs';
import { save,shotPath } from './runner.mjs';
const runs=[];
for(const scale of [1,2])for(let repeat=0;repeat<3;repeat++){
 const reference=await openShot(shotPath('canvas-2d'),scale,{raster:'gpu'}),pixels=[];
 try{for(const t of [0,.5,1])pixels.push((await decodeNativePNG(await reference.frame(t))).data);}finally{await reference.close();}
 const capture=await openShot(shotPath('canvas-2d'),scale,{raster:'gpu',onBrowser:browser=>{
  const newPage=browser.newPage.bind(browser);
  browser.newPage=async options=>{const page=await newPage(options);await page.addInitScript(()=>{
   const getContext=HTMLCanvasElement.prototype.getContext;
   HTMLCanvasElement.prototype.getContext=function(kind,attributes){return getContext.call(this,kind,kind==='2d'?{...attributes,willReadFrequently:false}:attributes);};
  });return page;};
 }});
 let receiver;
 try{
  receiver=await binaryReceiver(pixels[0].length);await installReadback(capture.page,receiver.url);
  const rows=[];for(const [index,t]of [0,.5,1].entries()){
   await capture.page.evaluate(t=>SHOT.render(t),t);const pending=receiver.next();await capture.page.evaluate(()=>BENCH_TRANSFER('post'));const actual=await pending;
   let changedPixels=0,maxChannelDiff=0;for(let p=0;p<actual.length;p+=4){let changed=false;for(let c=0;c<4;c++){const delta=Math.abs(actual[p+c]-pixels[index][p+c]);changed ||= delta>0;maxChannelDiff=Math.max(maxChannelDiff,delta);}changedPixels+=Number(changed);}
   rows.push({t,changedPixels,maxChannelDiff});
  }
  runs.push({scale,repeat,policy:'explicit willReadFrequently:false',rows});await save('out/bench/canvas-policy.json',runs);
 }finally{await receiver?.close();await capture.close();}
}
console.log('Canvas policy diagnostics: out/bench/canvas-policy.json');
