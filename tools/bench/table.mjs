import { summary } from './runner.mjs';
export function table(data) {
 const groups=new Map();for(const run of data.runs){const key=JSON.stringify(run.config);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);}
 let text='# Render benchmark\n\n'+data.method+'\n\n';
 for(const runs of groups.values()){
  const c=runs[0].config,label=`${c.shot}, output scale ${c.scale}, render scale ${c.options?.['render-scale']??c.scale}, samples ${c.blur}, grain ${c.grain??0}, workers ${c.workers} (actual ${runs[0].workers}), ${c.raster}`;
  text+=`## ${label}\n\n| Stage | Mean ms/frame | P50 | P95 | Work % |\n|---|---:|---:|---:|---:|\n`;
  const keys=Object.keys(runs[0].stages).filter(key=>runs[0].stages[key].workPercent!==undefined);
  const summed=keys.reduce((sum,key)=>sum+summary(runs.flatMap(r=>r.rows.map(row=>row[key]))).mean,0);
  for(const key of keys){const s=summary(runs.flatMap(r=>r.rows.map(row=>row[key])));text+=`| ${key} | ${s.mean.toFixed(3)} | ${s.p50.toFixed(3)} | ${s.p95.toFixed(3)} | ${(s.mean/summed*100).toFixed(2)} |\n`;}
  const elapsed=summary(runs.map(r=>r.secondsPerVideoSecond)),fps=summary(runs.map(r=>r.fps)),drain=summary(runs.map(r=>r.encoderDrainMs));
  const peaks=runs.map(r=>r.processTreePeakMemory).filter(v=>Number.isFinite(v)&&v>0);
  text+=`\nSeconds/video-second: ${elapsed.mean.toFixed(3)} (${elapsed.min.toFixed(3)}–${elapsed.max.toFixed(3)}). End-to-end fps: ${fps.mean.toFixed(3)} (${fps.min.toFixed(3)}–${fps.max.toFixed(3)}). Encoder final drain ms/job: ${drain.mean.toFixed(3)} (${drain.min.toFixed(3)}–${drain.max.toFixed(3)}). Process-tree peak memory: ${peaks.length ? (Math.max(...peaks)/1024**2).toFixed(1)+' MiB' : 'unknown'} (${peaks.length}/${runs.length} measured runs).\n\n`;
  for(const key of ['dispatchAndQueueMs','overlapMs','samples']){const s=summary(runs.flatMap(r=>r.rows.map(row=>row[key])));text+=`${key}: mean ${s.mean.toFixed(3)}, P50 ${s.p50.toFixed(3)}, P95 ${s.p95.toFixed(3)}.\n\n`;}
 }
 return text;
}
