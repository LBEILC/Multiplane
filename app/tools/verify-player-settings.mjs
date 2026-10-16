import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import sharp from 'sharp';
import { ensureElectron } from './electron.mjs';
import { run } from './demo.mjs';
import { ensureLocalFfmpeg } from '../../tests/local-ffmpeg.mjs';

ensureLocalFfmpeg();
const root = fileURLToPath(new URL('../..', import.meta.url));
const out = path.join(root, 'out/090');
const home = path.join(out, 'renderer'), data = path.join(out, 'desktop'), user = path.join(out, 'user'), jobDir = path.join(home, 'jobs/number');
for (const dir of [out, home, data, user, jobDir]) await mkdir(dir, { recursive: true });
const video = path.join(out, 'frame-number.mp4');
const fps = 30, frames = 960;
// Ten high-contrast blocks encode the frame number, independently of player labels.
const blocks = Array.from({ length: 10 }, (_, i) => `drawbox=x=${i*64}:y=0:w=64:h=64:color=white:t=fill:enable='mod(floor(n/${2**i}),2)'`);
const filter = ['drawbox=x=0:y=0:w=640:h=64:color=black:t=fill', ...blocks].join(',');
if (!(await stat(video).catch(() => null))) await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=30:duration=32', '-vf', filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8M', '-minrate', '8M', '-maxrate', '8M', '-bufsize', '8M', '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-pix_fmt', 'yuv420p', video]);
const size = (await stat(video)).size;
assert.ok(size >= 20*1024*1024);
const jobId = 'player-090', shot = path.join(root, 'examples/animation.html'), ts = '2026-10-16T00:00:00.000Z';
const event = (type, fields) => ({ schema:'multiplane/1', type, command:'render', ts, ...fields });
const result = event('result', { ok:true, jobId, elapsedMs:32000, artifacts:[{kind:'video',path:video,bytes:size}], data:{output:video,width:960,height:540,frames,fps,format:'mp4',encoder:'x264',from:0,to:32} });
const events = [event('start',{jobId,shot,options:{},version:'0.3.8'}), event('shot',{width:960,height:540,fps,duration:32,cuts:[]}), result];
await writeFile(path.join(jobDir,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
await writeFile(path.join(jobDir,'status.json'),JSON.stringify({schema:'multiplane/1',jobId,command:'render',shot,pid:process.pid,state:'succeeded',phase:'finalize',done:frames,total:frames,startedAt:ts,updatedAt:ts,result}));
await writeFile(path.join(home,'jobs.jsonl'),JSON.stringify({schema:'multiplane/1',event:'start',jobId,jobDir,command:'render',shot,pid:process.pid,ts})+'\n');
await writeFile(path.join(data,'preferences.json'),JSON.stringify({language:'zh-CN',theme:'dark',notifications:true,wizardDone:true,hidden:[]}));
await writeFile(path.join(home,'config.json'),'{}');
const env = {...process.env,MULTIPLANE_HOME:home,MULTIPLANE_APP_DATA:data,MULTIPLANE_TEST_USER_HOME:user};
for (const key of ['ELECTRON_RUN_AS_NODE','MULTIPLANE_FFMPEG','MULTIPLANE_JOBS_DIR']) delete env[key];
const electron = await _electron.launch({executablePath:await ensureElectron(),args:[path.join(root,'app')],env});
const evidence = { bytes:size, seconds:32, frames:[], responses:[], screenshots:[] }, errors=[];
try {
  await electron.firstWindow();
  let page;
  for(let i=0;i<150;i++){page=electron.windows().find(p=>p.url().includes('/index.html?'));if(page)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(page,'Main application window');page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
  await electron.evaluate(({session})=>{globalThis.mediaResponses=[];session.defaultSession.webRequest.onCompleted({urls:['multiplane-media://*/*']},d=>globalThis.mediaResponses.push({status:d.statusCode,range:d.responseHeaders?.['content-range']??d.responseHeaders?.['Content-Range']}));});
  await page.locator('[data-job="player-090"]').click();
  await page.locator('[data-tab=preview]').click();
  await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
  const check=async expected=>{
    await page.waitForFunction(()=>{const v=document.querySelector('video');return v.readyState>=2&&!v.seeking;});
    const {data:pixels,info}=await sharp(await page.locator('video').screenshot()).raw().toBuffer({resolveWithObject:true});
    let actual=0;
    for(let i=0;i<10;i++){const x=Math.floor((i*64+32)/960*info.width),y=Math.floor(32/540*info.height);if(pixels[(y*info.width+x)*info.channels]>128)actual|=1<<i;}
    assert.equal(actual,expected);evidence.frames.push({expected,actual});
  };
  await page.locator('[data-pl=start]').click();await check(0);
  // A real pointer drag exercises the native range input; use its rounded target.
  const scrub=await page.locator('[data-scrub]').boundingBox();
  await page.mouse.move(scrub.x+8,scrub.y+scrub.height/2);await page.mouse.down();await page.mouse.move(scrub.x+scrub.width/2,scrub.y+scrub.height/2,{steps:8});await page.mouse.up();
  const middle=Number(await page.locator('[data-scrub]').inputValue());assert.ok(Math.abs(middle-480)<5);await check(middle);
  for(let i=1;i<=3;i++){await page.locator('[data-pl=next]').click();await check(middle+i);}
  for(let i=2;i>=0;i--){await page.locator('[data-pl=prev]').click();await check(middle+i);}
  await page.locator('[data-pl=end]').click();await check(959);
  await page.locator('[data-pl=start]').click();await check(0);
  await page.locator('[data-pl=toggle] i').click();
  await page.waitForFunction(()=>{const v=document.querySelector('video');return !v.paused&&v.currentTime>.15;});
  // Hold down across several presented frames to catch replacement of the icon.
  await page.locator('[data-pl=toggle] i').evaluate(el=>{window.originalPlayIcon=el;});
  await page.locator('[data-pl=toggle] i').click({delay:250});
  assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
  assert.equal(await page.evaluate(()=>window.originalPlayIcon===document.querySelector('[data-pl=toggle] i')),true);
  const pausedAt=await page.locator('video').evaluate(v=>v.currentTime);
  await page.locator('[data-pl=toggle] i').click();
  await page.waitForFunction(t=>{const v=document.querySelector('video');return !v.paused&&v.currentTime>t+.1;},pausedAt);
  await page.locator('[data-pl=toggle] i').click({delay:200});
  assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
  evidence.playPauseResume=true;
  evidence.responses=await electron.evaluate(()=>globalThis.mediaResponses);
  assert.ok(evidence.responses.some(r=>r.status===206));
  await page.screenshot({path:path.join(out,'player.png')});evidence.screenshots.push('player.png');
  await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html?')).setContentSize(1160,1000));
  await page.locator('[data-page=settings]').click();
  for(const theme of ['dark','light']) {
    await page.locator('[data-select=theme]').click();await page.getByRole('option',{name:theme==='dark'?'深':'浅',exact:true}).click();
    await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
    const toggle=page.locator('[data-pref=notifications]');
    assert.equal(await toggle.getAttribute('role'),'switch');assert.equal(await toggle.innerText(),'');assert.match(await toggle.getAttribute('class'),/upd-switch/);
    const before=await toggle.getAttribute('aria-checked');await toggle.click();await page.waitForFunction(before=>document.querySelector('[data-pref=notifications]').getAttribute('aria-checked')!==before,before);
    assert.equal(JSON.parse(await readFile(path.join(data,'preferences.json'),'utf8')).notifications,before!=='true');
    const fonts=await page.evaluate(()=>{const info=s=>{const el=document.querySelector(s),p=getComputedStyle(el,'::placeholder'),c=getComputedStyle(el);return {placeholder:p.fontFamily,size:p.fontSize,value:c.fontFamily};};return {ffmpeg:info('#input-ffmpeg'),jobs:info('#input-jobsDir'),workers:info('#input-workers')};});
    for(const key of ['ffmpeg','jobs']){assert.equal(fonts[key].placeholder,fonts.workers.placeholder);assert.equal(fonts[key].size,fonts.workers.size);assert.notEqual(fonts[key].value,fonts[key].placeholder);}
    evidence.fonts=fonts;
    // Sanitize only the displayed config path before taking shareable screenshots.
    await page.locator('.path-value .mono').evaluate(el=>el.textContent='D:/Multiplane/config.json');
    await page.locator('#placeholder').evaluate(el=>el.scrollTop=0);
    const name=`settings-zh-CN-${theme}.png`;await page.screenshot({path:path.join(out,name)});evidence.screenshots.push(name);
  }
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
} catch(error) {const page=electron.windows().find(p=>p.url().includes('/index.html?'))??await electron.firstWindow();console.error(errors);console.error(await page.locator('body').innerText());await page.screenshot({path:path.join(out,'failure.png')});throw error;} finally {await electron.close();}
