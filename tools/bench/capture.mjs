import { openShot } from '../../src/capture.mjs';
import { isolateDevelopmentHome } from '../development-home.mjs';
isolateDevelopmentHome('bench');
import { createPostCapture } from '../../src/post.mjs';
import { environment } from '../../src/environment.mjs';

export const keys = ['renderPageMs','renderBridgeMs','screenshotMs','base64Ms','decodeMs','averageMs','grainMs','resizeMs','otherMs'];
export async function measuredShot(shot, options) {
  const capture = await openShot(shot, options['render-scale'] ?? options.scale ?? 1, options);
  const info = await environment(capture.browser);
  const session = await capture.page.context().newCDPSession(capture.page);
  const sums = Object.fromEntries(keys.map(k=>[k,0]));
  const scale = options['render-scale'] ?? options.scale ?? 1;
  const originalFrame = capture.frame.bind(capture);
  async function beginFrame(t, {motionBlur=1}={}) {
    const start=performance.now();
    const inside=await capture.page.evaluate(({t,motionBlur})=>{
      const stage=document.querySelector('#stage');const display=stage.style.getPropertyValue('display'),priority=stage.style.getPropertyPriority('display');
      stage.style.setProperty('display','none','important');stage.getBoundingClientRect();
      if(display)stage.style.setProperty('display',display,priority);else stage.style.removeProperty('display');
      const previous=SHOT.sampleContext;SHOT.sampleContext={time:t,motionBlur};
      const start=performance.now();let elapsed;
      try{SHOT.render(t);elapsed=performance.now()-start;}finally{if(previous===undefined)delete SHOT.sampleContext;else SHOT.sampleContext=previous;}
      stage.getBoundingClientRect();return elapsed;
    },{t,motionBlur});
    sums.renderPageMs+=inside;sums.renderBridgeMs+=performance.now()-start-inside;
    const snap=performance.now();
    const png=(options.capture==='playwright'
      ? capture.page.screenshot({type:'png',animations:'allow'}).then(buffer=>{sums.screenshotMs+=performance.now()-snap;return buffer;})
      : session.send('Page.captureScreenshot',{format:'png',optimizeForSpeed:options.optimize!==false,captureBeyondViewport:false,clip:{x:0,y:0,width:capture.width,height:capture.height,scale}}).then(({data})=>{
        sums.screenshotMs+=performance.now()-snap;const start=performance.now();const buffer=Buffer.from(data,'base64');sums.base64Ms+=performance.now()-start;return buffer;
      }));
    png.catch(()=>{});return {png};
  }
  capture.beginFrame=beginFrame;capture.frame=async(t,c)=>(await beginFrame(t,c)).png;
  const post=createPostCapture(capture,{...options,transport:'raw'},30);
  return {capture,info,originalFrame,async frame(index){
    const before={...sums},stats={...post.stats},start=performance.now();
    const bytes=await post.frame(index/30,index);
    const measures={...Object.fromEntries(keys.map(k=>[k,sums[k]-before[k]]))};
    for(const key of ['decodeMs','averageMs','grainMs','resizeMs'])measures[key]=post.stats[key]-stats[key];
    const elapsed=performance.now()-start;
    // Capture/decode can overlap. Keep overlap explicit instead of negative overhead.
    const work=Object.values(measures).reduce((a,b)=>a+b,0);
    measures.otherMs=Math.max(0,elapsed-work);
    return {bytes,measures,elapsed,overlapMs:Math.max(0,work-elapsed),samples:post.stats.samples-stats.samples};
  }};
}
