import { benchRun, save, machine, shotNames } from './runner.mjs';
import { table } from './table.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const args=process.argv.slice(2);
if(args.includes('--help')) { console.log('Usage: npm run bench -- [--frames 8] [--repeats 3] [--shot NAME] [--full]\nOutputs: out/bench/results.json and out/bench/table.md. Set MULTIPLANE_FFMPEG when FFmpeg is not on PATH.\nRelated tools: node tools/bench/{validate,readback,experiments,canvas-policy}.mjs'); process.exit(0); }
const value=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const frames=Number(value('--frames',8)),repeats=Number(value('--repeats',3));
if(!Number.isSafeInteger(frames)||frames<1||!Number.isSafeInteger(repeats)||repeats<1)throw Error('Frames and repeats must be positive integers.');
let configs=shotNames.map(shot=>({shot,scale:1,blur:1,workers:1,raster:'gpu'}));
configs.push({shot:'dom-heavy',scale:1,blur:8,workers:1,raster:'gpu'},{shot:'canvas-2d',scale:2,blur:1,workers:1,raster:'gpu'},{shot:'webgl',scale:1,blur:1,workers:1,raster:'software'},{shot:'mixed',scale:1,blur:1,workers:'auto',raster:'gpu'});
configs.push({shot:'dom-light',scale:1,blur:1,grain:2,workers:1,raster:'gpu',options:{'render-scale':0.5}});
if(args.includes('--full'))configs=shotNames.flatMap(shot=>[1,2].flatMap(scale=>[1,8].flatMap(blur=>[1,'auto'].flatMap(workers=>['gpu','software'].map(raster=>({shot,scale,blur,workers,raster}))))));
if(value('--shot',null))configs=configs.filter(c=>c.shot===value('--shot'));
if(!configs.length)throw Error('Unknown shot name.');
await mkdir('out/bench',{recursive:true});
const data={machine:machine(),frames,repeats,method:'Stage percentages use summed worker service time; dispatch queue and overlap are reported separately. End-to-end includes setup and cleanup. FFmpeg asynchronous encoding overlaps capture; only write/callback wait and final drain are observable.',runs:[]};
for(const [i,config] of configs.entries())for(let repeat=0;repeat<repeats;repeat++){
  console.log(`Running ${i+1}/${configs.length}, repeat ${repeat+1}/${repeats}: ${JSON.stringify(config)}`);
  const run=await benchRun(config,frames,`out/bench/video-${i}-${repeat}.mp4`);run.repeat=repeat;data.runs.push(run);await save('out/bench/results.json',data);
  console.log(`End-to-end ${run.fps.toFixed(2)} fps; ${run.secondsPerVideoSecond.toFixed(2)} s / video s; workers ${run.workers}`);
}
const markdown=table(data);await writeFile('out/bench/table.md',markdown);console.log(markdown);
