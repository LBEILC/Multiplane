import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../../tools/process.mjs';
import { ensureLocalFfmpeg } from '../../tests/local-ffmpeg.mjs';
import { entryCommand } from './entry-command.mjs';
import { verifyNotices } from './notices.mjs';
import { launchOwned } from './owned-electron.mjs';

export async function verifyThreeRender(invoke, project, root) {
  await cp(path.join(root, 'examples/three-cards.html'), path.join(project, 'three-cards.html'));
  await cp(path.join(root, 'examples/assets'), path.join(project, 'assets'), { recursive: true });
  await assert.rejects(readFile(path.join(project, 'node_modules/three/package.json')), { code: 'ENOENT' });
  const rendered = await invoke(['render', path.join(project, 'three-cards.html'), '--root', project, '--workers', '1', '--to', '0.16666666666666666', '--json']);
  assert.equal(rendered.code, 0, rendered.stderr || rendered.stdout);
  const result = JSON.parse(rendered.stdout.trim().split('\n').at(-1));
  assert.equal(result.ok, true); assert.equal(result.data.frames, 2);
  return { ok: true, frames: result.data.frames, projectHasThree: false };
}

export async function verifyUnpackedThree(unpacked) {
  assert.equal(process.platform, 'win32', 'Focused unpacked verification currently targets Windows');
  ensureLocalFfmpeg();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const work = await mkdtemp(path.join(os.tmpdir(), 'multiplane-three-'));
  try {
    const installation = path.join(work, 'software'), project = path.join(work, 'project');
    await cp(unpacked, installation, { recursive: true });
    await mkdir(project);
    const renderer = path.join(installation, 'resources/renderer');
    const pkg = JSON.parse(await readFile(path.join(renderer, 'vendor/three/package.json'), 'utf8'));
    const licenses = await verifyNotices(path.join(installation, 'resources/app'));
    assert.ok(licenses.packages.some(p => p.name === 'three' && p.version === pkg.version));
    const env = { ...process.env, MULTIPLANE_HOME: path.join(work, 'home'), MULTIPLANE_APP_DATA: path.join(work, 'desktop'), MULTIPLANE_AGENT_HOME: path.join(work, 'agents'), MULTIPLANE_TEST_USER_HOME: path.join(work, 'user') };
    delete env.ELECTRON_RUN_AS_NODE;
    const invoke = args => {
      const command = entryCommand({ path: path.join(installation, 'multiplane.cmd'), args: [] }, args);
      return run(command.file, command.args, { ...command.options, env, cwd: project, capture: true });
    };
    const doctor = await invoke(['doctor', '--json']);
    assert.equal(doctor.code, 0, doctor.stderr || doctor.stdout);
    const check = JSON.parse(doctor.stdout.trim().split('\n').at(-1)).data.checks.find(c => c.name === 'three');
    assert.deepEqual(check, { name: 'three', ok: true, detail: `three.js ${pkg.version} is available (bundled with software).` });
    console.log('Isolated packaged doctor passed.');
    const render = await verifyThreeRender(invoke, project, root);
    console.log('Isolated packaged CLI rendered two three.js frames.');
    await mkdir(path.join(root, 'out/065'), { recursive: true });
    await mkdir(env.MULTIPLANE_APP_DATA, { recursive: true });
    await writeFile(path.join(env.MULTIPLANE_APP_DATA, 'preferences.json'), JSON.stringify({ language: 'zh-CN', wizardDone: true, notifications: false }));
    let owned;
    const application = await launchOwned(path.join(installation, 'Multiplane.exe'), env, value => { owned = value; })
      .catch(error => { console.error(owned?.diagnostics()); throw error; });
    let environmentRow;
    try {
      const page = await application.firstWindow();
      await page.locator('[data-page="environment"]').click();
      const row = page.locator('[data-check="three"]');
      await row.waitFor();
      environmentRow = await row.innerText();
      assert.ok(environmentRow.includes(pkg.version), environmentRow);
      assert.ok(environmentRow.includes('软件自带'), environmentRow);
      assert.equal(await row.locator('.succeeded').count(), 1);
      await row.screenshot({ path: path.join(root, 'out/065/environment-three.png') });
    } finally { await application.close(); }
    const evidence = { version: pkg.version, doctor: check, render, environmentRow, licenses: true, isolatedRuntime: true };
    await writeFile(path.join(root, 'out/065/packaged-three.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  } finally { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
