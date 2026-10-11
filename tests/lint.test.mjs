import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { scanShot } from '../src/lint.mjs';
import { lintShot } from '../src/index.mjs';
import { run, createTempDirectory } from './helpers.mjs';
import { base, cases } from './lint-cases.mjs';

await mkdir('out/tests', { recursive: true });
const root = createTempDirectory(path.resolve('out/tests/lint-'));
for (const file of ['image.gif', 'image.apng', 'image.png', 'font.woff2']) await writeFile(path.join(root, file), 'fixture');
let id = 0;
async function scan(html) {
  const file = `case-${id++}.html`; await writeFile(path.join(root, file), html);
  return scanShot(file, { root });
}
for (const [code, positive, negative, , line, column] of cases) {
  test(`${code}: exact location and safe counterexample`, async () => {
    const result = await scan(positive), found = result.findings.filter(f => f.code === code);
    assert.equal(found.length, 1, JSON.stringify(result));
    assert.equal(found[0].location.line, line); assert.equal(found[0].location.column, column);
    assert.ok(found[0].hint); assert.ok(found[0].details.snippet.length <= 160);
    assert.equal((await scan(negative)).findings.length, 0);
  });
}
test('all direct JS variants, masking, templates and shadowed globals', async () => {
  for (const text of ['Date()', 'new Date()', 'performance.now()', 'Date.now()']) assert.equal((await scan(base + `<script>${text}</script>`)).findings[0].code, 'wall_clock');
  for (const text of ['crypto.randomUUID()', 'crypto.getRandomValues(a)']) assert.equal((await scan(base + `<script>${text}</script>`)).findings[0].code, 'unseeded_random');
  for (const text of ['new Animation()', 'document.timeline']) assert.equal((await scan(base + `<script>${text}</script>`)).findings[0].code, 'web_animations');
  for (const text of ['new Audio()', 'a.play()']) assert.equal((await scan(base + `<script>${text}</script>`)).findings[0].code, 'media_playback');
  for (const text of ['setInterval(f,0)', 'requestAnimationFrame(f)', 'requestIdleCallback(f)']) assert.equal((await scan(base + `<script>${text}</script>`)).findings[0].code, 'timer_driven');
  const safe = base + '<script>/* Date.now() */\nconst s="Math.random()"; const t=`Date.now()`; const r=/Date.now()/;\nfunction f(Date,Math){ Date.now(); Math.random(); }</script><!-- <video> --><style>/* @keyframes x {} */p{content:"animation:spin;url(https://example.com)"}</style>';
  assert.deepEqual((await scan(safe)).findings, []);
  const template = await scan(base + '<script>\nconst t=`plain Date.now() ${Math.random()}`;\n</script>');
  assert.equal(template.findings.length, 1); assert.equal(template.findings[0].code, 'unseeded_random'); assert.equal(template.findings[0].location.column, 29);
});
test('CSS and JS style variants; zero duration and empty values stay safe', async () => {
  for (const declaration of ['animation:spin 1s', 'animation-name:spin', 'transition:opacity 1s', 'transition-duration:200ms']) {
    const result = await scan(base + `<style>\np{${declaration}}</style>`);
    assert.equal(result.findings[0].code, 'css_animation'); assert.equal(result.findings[0].location.column, 3);
  }
  for (const prop of ['animation', 'transition']) {
    assert.equal((await scan(base + `<script>a.style.${prop}='spin 1s'</script>`)).findings[0].code, 'css_animation');
    assert.equal((await scan(base + `<script>a.style.${prop}=''</script>`)).findings.length, 0);
  }
  assert.equal((await scan(base + '<style>p{transition:opacity 0s ease;transition-duration:0ms;content:"@keyframes"}</style>')).findings.length, 0);
  assert.equal((await scan(base.replace('style="width:32px;height:32px"', 'style'))).findings[0].code, 'stage_size_unfixed');
});
test('async render forms and indirect font definitions', async () => {
  for (const text of ['const render=async()=>{};', 'class ShotView {async render(){}}', 'window.SHOT.render=async function(){};', 'const s={render:async function(){await ready}};']) {
    assert.equal((await scan(base + `<script>${text}</script>`)).findings[0].code, 'async_render');
  }
  const indirect = base.replace('Shot.define({duration:1,render(){}})', 'const config={fonts:["12px Test"],render(){}};Shot.define(config)') + '<style>@font-face{font-family:Test;src:url(font.woff2)}</style>';
  assert.equal((await scan(indirect)).findings.length, 0);
  for (const definition of ['var SHOT={render(){}};', 'var SHOT; SHOT={render(){}};', 'SHOT={render(){}};']) {
    assert.equal((await scan('<div id="stage" style="width:32px;height:32px"></div><script>' + definition + '</script>')).findings.length, 0);
  }
});
test('resource contexts, recursion, cycles, root boundary and runtime exclusions', async () => {
  for (const html of ['<link href="//example.com/a.css">', '<style>p{background:url(https://example.com/a.png)}</style>', '<style>@import "https://example.com/a.css";</style>', '<script type="module">import "https://example.com/a.js";</script>', '<script>fetch("https://example.com");</script>', '<script>new FontFace("Test","url(https://example.com/a.woff2)");</script>']) {
    assert.equal((await scan(base + html)).findings[0].code, 'remote_resource');
  }
  await writeFile(path.join(root, 'a.js'), 'import "./b.js";');
  await writeFile(path.join(root, 'b.js'), 'import "./a.js";\n  Date.now();');
  await writeFile(path.join(root, 'a.css'), '@import "b.css";');
  await writeFile(path.join(root, 'b.css'), '@import "a.css";\np{animation:spin 1s}');
  const result = await scan(base + '<script type="module" src="a.js"></script><link rel="stylesheet" href="a.css">');
  assert.equal(result.data.files.length, 5);
  assert.deepEqual(result.findings.map(f => f.location), [{ file: 'b.css', line: 2, column: 3 }, { file: 'b.js', line: 2, column: 3 }]);
  for (const url of ['../outside.png', '%2e%2e/outside.png', 'missing.png']) assert.equal((await scan(base + `<img src="${url}">`)).findings[0].code, 'resource_missing');
  assert.equal((await scan(base + '<img src="data:image/png;base64,a"><script type="module">import "three";import "/multiplane/three.js";</script>')).findings.length, 0);
  const outer = createTempDirectory(path.resolve('out/tests/outer-')); await writeFile(path.join(outer, 'a.js'), 'Date.now()');
  await symlink(outer, path.join(root, 'linked'), 'junction');
  assert.equal((await scan(base + '<script src="linked/a.js"></script>')).findings[0].code, 'resource_missing');
});
test('suppression only comes from real comments on the previous line', async () => {
  const result = await scan(base + '<script>\n// multiplane-disable-next-line wall_clock, unseeded_random\nDate.now(); Math.random();\n/* multiplane-disable-next-line */\nDate.now();\nconst s="multiplane-disable-next-line wall_clock";\nDate.now();</script>\n<!-- multiplane-disable-next-line media_playback -->\n<audio></audio>\n<style>\n/* multiplane-disable-next-line css_animation */\np{animation:spin 1s}</style>');
  assert.equal(result.data.suppressed, 4); assert.equal(result.data.errors, 2); assert.equal(result.data.warnings, 1);
  assert.deepEqual(result.findings.find(f => f.code === 'lint_directive_invalid').location, { file: result.data.files[0], line: 7, column: 1 });
});
test('CLI raw evidence, JS API, browser-free blocking and bypass', async () => {
  const evidence = [];
  for (const [code, positive, negative] of cases) for (const [kind, html] of [['trigger', positive], ['safe', negative]]) {
    const name = `${code}-${kind}.html`; await writeFile(path.join(root, name), html);
    const result = await run(process.execPath, ['bin/multiplane','lint',name,'--root',root,'--json']);
    const events = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'result'); assert.equal(events.filter(e => e.type === 'result').length, 1);
    assert.equal(events.at(-1).data.errors > 0 ? 1 : 0, result.code);
    evidence.push({ code, kind, html, stdout: result.stdout });
  }
  await writeFile('out/tests/003-lint-evidence.json', JSON.stringify(evidence, null, 2));
  const file = path.join(root, 'blocked.html'); await writeFile(file, base + '<script>Date.now()</script>');
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'absent-browser') };
  for (const command of ['render', 'stills', 'verify']) {
    const result = await run(process.execPath, ['bin/multiplane',command,file,'--job-dir',root,'--json'], { env });
    const events = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).code, 'lint_failed'); assert.ok(!events.some(e => e.type === 'environment'));
    const bypass = await run(process.execPath, ['bin/multiplane',command,file,'--no-lint','--job-dir',root,'--json'], { env });
    assert.equal(JSON.parse(bypass.stdout.trim().split('\n').at(-1)).code, 'browser_not_installed');
  }
  await assert.rejects(lintShot(file, { root }), error => error.code === 'lint_failed' && error.result.data.errors === 1);
});
test('bundled examples have zero findings in under one second', async () => {
  for (const name of ['animation', 'typography', 'three-cards']) {
    const before = performance.now(), result = await lintShot(`examples/${name}.html`);
    assert.equal(result.data.errors, 0); assert.equal(result.data.warnings, 0); assert.ok(performance.now() - before < 1000);
  }
});
