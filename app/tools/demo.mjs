import { errorCodes } from '../../src/errors.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, copyFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { ensureElectron } from './electron.mjs';
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(path.join(root, 'package.json'));
const sharp = require('sharp');
export const run = (exe, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { shell: false, windowsHide: true, ...options });
  let stdout = '', stderr = '';
  child.stdout?.on('data', b => stdout += b); child.stderr?.on('data', b => stderr += b);
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(Error(`Exit ${code}: ${stderr}`)));
});
export async function demo() {
  const home = path.join(root, 'out', 'app-demo'); await mkdir(home, { recursive: true });
  const index = [];
  const schema = 'multiplane/1';
  for (const [id, state, command] of [['running','running','render'], ['success','succeeded','render'], ['failed','failed','render'], ['cancelled','cancelled','render'], ['verify','failed','verify'], ['lost','running','render'], ['stills','succeeded','stills']]) {
    const jobId = `demo-20261011-${String(index.length + 1).padStart(3, '0')}`;
    const jobDir = path.join(home, 'jobs', id); await mkdir(jobDir, { recursive: true });
    const timestamp = new Date(Date.now() - (id === 'success' || id === 'cancelled' ? 86400000 : 0)).toISOString();
    const shot = path.join(root, 'examples', id === 'failed' || id === 'stills' ? 'typography.html' : id === 'lost' ? 'three-cards.html' : 'animation.html');
    const event = (type, fields = {}) => ({ schema, type, command, ts: timestamp, ...fields });
    const image = path.join(jobDir, 'preview.png');
    const svg = `<svg width="480" height="270"><rect width="480" height="270" fill="#eeeeea"/><rect x="${id === 'verify' ? 220 : 180}" y="95" width="80" height="80" rx="8" fill="#555550"/><path d="M40 210H440" stroke="#aaa"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(image);
    const events = [event('start', { jobId, shot, version: '0.0.0', options: { root, workers: 1, raster: 'gpu', encoder: 'x264', scale: 1, from: 0, to: 2 } }), event('environment', { node: 'v24', platform: process.platform, chromium: 'demo', gpu: { renderer: 'demo', hardware: true }, ffmpeg: { version: 'demo', path: 'ffmpeg' } }), event('shot', { width: 480, height: 270, duration: 2, fps: 30, cuts: [], post: {} }), event('progress', { phase: 'capture', done: 24, total: 60, fps: 12, etaMs: 3000 })];
    const artifacts = []; let data = {};
    if (id === 'success') {
      const out = await run(process.execPath, ['bin/multiplane', 'render', 'examples/animation.html', '--workers', '1', '--job-dir', path.join(home, 'seed'), '--json'], { cwd: root, env: { ...process.env, MULTIPLANE_NO_INDEX: '1' } });
      const result = out.trim().split('\n').map(JSON.parse).at(-1);
      const video = path.join(jobDir, 'animation.mp4'); await copyFile(result.data.output, video);
      artifacts.push({ path: video, kind: 'video', bytes: (await stat(video)).size });
      data = { ...result.data, output: video };
    }
    if (id === 'verify') {
      const reference = path.join(jobDir, 'reference.png'), actual = path.join(jobDir, 'actual.png'), diff = path.join(jobDir, 'diff.png');
      await sharp(Buffer.from(svg.replace('x="220"', 'x="180"'))).png().toFile(reference);
      await copyFile(image, actual);
      await sharp(Buffer.from('<svg width="480" height="270"><rect width="480" height="270" fill="#171717"/><rect x="180" y="95" width="40" height="80" fill="#e3695c"/><rect x="260" y="95" width="40" height="80" fill="#e3695c"/></svg>')).png().toFile(diff);
      events.push(event('finding', { code: 'nondeterministic_output', severity: 'error', message: 'Pixels differ between repeated renders.', location: { t: 0.8, frame: 24 }, details: { check: 'reload', changedPixels: 6400, maxChannelDiff: 170, bbox: { x: 180, y: 95, w: 120, h: 80 }, images: { reference, actual, diff } } }));
      artifacts.push({ path: diff, kind: 'diff-image', bytes: 1000 }); data = { passed: false, times: [0.8], workers: 1, findings: 1, checks: [{ name: 'reload', passed: false }] };
    }
    if (id === 'stills') { artifacts.push({ path: image, kind: 'contact-sheet', bytes: 1000 }, { path: image, kind: 'still', bytes: 1000 }); data = { stills: [{ t: 0.8, frame: 24, path: image }], contactSheet: image }; }
    let result = null;
    if (state !== 'running') {
      const code = id === 'verify' ? 'nondeterministic_output' : id === 'failed' ? 'render_threw' : id === 'cancelled' ? 'cancelled' : null;
      result = event('result', { ok: state === 'succeeded', code, message: code ? errorCodes[code].message : null, artifacts, elapsedMs: 5200, jobId, data });
      events.push(...artifacts.map(a => event('artifact', a)), result);
    }
    const status = { schema, jobId, command, shot, pid: id === 'lost' ? 2147483647 : process.pid, state, phase: state === 'running' ? 'capture' : 'finalize', done: state === 'running' ? 24 : 60, total: 60, fps: 12, etaMs: 3000, startedAt: timestamp, updatedAt: timestamp, result, previewFrame: 24 };
    await writeFile(path.join(jobDir, 'status.json'), JSON.stringify(status));
    await writeFile(path.join(jobDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    index.push({ schema, event: 'start', jobId, jobDir, command, shot, pid: status.pid, ts: timestamp });
  }
  await writeFile(path.join(home, 'jobs.jsonl'), index.map(e => JSON.stringify(e)).join('\n') + '\n');
  const appData = path.join(home, 'app-data'); await mkdir(appData, { recursive: true });
  await writeFile(path.join(appData, 'preferences.json'), JSON.stringify({ theme: 'system', notifications: false, hidden: [], wizardDone: true }));
  const user = path.join(home, 'test-user'); await mkdir(user, { recursive: true });
  const env = { ...process.env, MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: appData, MULTIPLANE_TEST_USER_HOME: user, USERPROFILE: user, HOME: user, CODEX_HOME: path.join(user, '.codex'), CLAUDE_CONFIG_DIR: path.join(user, '.claude') }; delete env.ELECTRON_RUN_AS_NODE;
  return { home, appData, env };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await demo(); await run(await ensureElectron(), ['.'], { cwd: path.join(root, 'app'), env: fixture.env, stdio: 'inherit' });
}
