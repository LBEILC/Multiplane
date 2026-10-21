import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, symlink, unlink, readFile, stat } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { renderShot, resumeRender, MultiplaneError } from '../src/index.mjs';
import { readManifest } from '../src/segments.mjs';

for (const rootAlias of [false, true]) test(`resume rejects retargeted ${rootAlias ? 'project root' : 'asset directory'} before launching or publishing`, { timeout: 60000 }, async () => {
  const directory = createTempDirectory('multiplane-render-alias-');
  const before = path.join(directory, 'before'), after = path.join(directory, 'after');
  for (const target of [before, after]) await mkdir(target);
  const alias = path.join(directory, 'current');
  const link = target => symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await link(before);
  const html = `<div id="stage" style="width:16px;height:16px"></div><script>
    let color;
    window.SHOT={duration:1,fps:2,
      ready:fetch('${rootAlias ? '' : 'current/'}color.json').then(response=>response.json()).then(value=>{color=value}),
      render(){document.querySelector('#stage').style.background=color}
    };</script>`;
  if (rootAlias) for (const target of [before, after]) await writeFile(path.join(target, 'shot.html'), html);
  else await writeFile(path.join(directory, 'shot.html'), html);
  await writeFile(path.join(before, 'color.json'), '"red"');
  await writeFile(path.join(after, 'color.json'), '"blue"');
  const root = rootAlias ? alias : directory, jobs = path.join(directory, 'jobs'), out = path.join(directory, 'video.mp4');
  let original;
  try {
    await renderShot(path.join(root, 'shot.html'), { root, 'job-dir': jobs, out, workers: 1,
      raster: 'software', 'no-lint': true, 'no-post': true, _segmentFrames: 1,
      _segmentHook(phase, index) { if (phase === 'sealed' && index === 0) throw new MultiplaneError('cancelled'); } });
    assert.fail('Expected interrupted render');
  } catch (error) {
    assert.equal(error.code, 'cancelled');
    original = path.join(jobs, error.result.jobId);
  }
  const manifest = readManifest(path.join(original, 'segments'));
  assert.equal(manifest.segments.length, 1);
  const checkpoint = await readFile(path.join(original, 'segments', manifest.segments[0].file));
  await unlink(alias); await link(after);
  let inspected = false;
  await assert.rejects(resumeRender(original, { _inspectFFmpeg() { inspected = true; throw Error('Must reject before launching'); } }),
    error => error.code === 'resume_unavailable' && error.details.reason === 'inputs_changed'
      && error.details.changes.includes(path.join(alias, 'color.json')));
  assert.equal(inspected, false);
  await assert.rejects(stat(out), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(original, 'segments', manifest.segments[0].file)), checkpoint);
  // The refused resume must preserve good work; restoring the alias makes it reusable.
  await unlink(alias); await link(before);
  const result = await resumeRender(original);
  assert.deepEqual(result.data.resume, { segmentsReused: 1, framesReused: 1 });
  assert.equal(result.data.outputCheck.verified, true);
  assert.equal(result.data.outputCheck.frames, 2);
});
