import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isolateDevelopmentHome } from '../development-home.mjs';

isolateDevelopmentHome('bench-static-profile');
const revision = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw Error('Provide the full pre-change Git commit hash.');
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', revision, 'src', 'package.json'], { encoding: 'utf8', windowsHide: true }).trim().split('\n');
const results = [];
for (const version of ['before', 'after']) {
  // Instrument isolated copies so measurement never changes the working tree.
  const root = path.resolve('out/bench/static-profile', version);
  for (const file of files) {
    let text = version === 'before' ? execFileSync('git', ['show', `${revision}:${file}`], { encoding: 'utf8', windowsHide: true }) : await readFile(file, 'utf8');
    text = text.replace(/\r\n/g, '\n');
    if (file === 'src/static-reuse.mjs') {
      text = `export const reuseProfile = { compressMs: 0, decompressMs: 0, writeMs: 0, readMs: 0, copyMs: 0 };
const measured = async (key, fn) => { const start = performance.now(); try { return await fn(); } finally { reuseProfile[key] += performance.now() - start; } };
` + text;
      if (version === 'before') {
        text = text.replace('const compress = promisify(deflateRaw), decompress = promisify(inflateRaw);',
          "const compress = (...args) => measured('compressMs', () => promisify(deflateRaw)(...args)), decompress = (...args) => measured('decompressMs', () => promisify(inflateRaw)(...args));");
        text = text.replace('await writeFile(file, compressed ? await compress(bytes, { level: 1 }) : bytes);',
          "const stored = compressed ? await compress(bytes, { level: 1 }) : bytes; await measured('writeMs', () => writeFile(file, stored));");
        text = text.replace('const bytes = await readFile(file);', "const bytes = await measured('readMs', () => readFile(file));");
      } else {
        text = text.replace('pending.push({ ...item, png: owned ? item.png : Buffer.from(item.png) });',
          "const start = performance.now(); pending.push({ ...item, png: owned ? item.png : Buffer.from(item.png) }); reuseProfile.copyMs += performance.now() - start;");
      }
      text = text.replace('export function installStaticObserver() {', `export function installStaticObserver() {
  const profile = { hooksMs: 0, stylesMs: 0, snapshots: 0 };
  const measure = (key, fn) => { const start = performance.now(); try { return fn(); } finally { profile[key] += performance.now() - start; } };`);
      text = text.replace('!hooks.every(check => check())', "!measure('hooksMs', () => hooks.every(check => check()))");
      text = text.replace('const changedStyles = () => {', "const changedStyles = () => measure('stylesMs', () => {");
      text = text.replace('} catch { return true; }\n  };\n  const uncertain', '} catch { return true; }\n  });\n  const uncertain');
      text = text.replace('finally { readingStyles = false; }\n  };\n  const uncertain', 'finally { readingStyles = false; }\n  });\n  const uncertain');
      text = text.replace('const signature = JSON.stringify', 'profile.snapshots++;\n      const signature = JSON.stringify');
      text = text.replace("Object.defineProperty(globalThis, '__multiplaneStatic', { value: {", "Object.defineProperty(globalThis, '__multiplaneStatic', { value: { profile,");
    }
    if (file === 'src/post.mjs' && version === 'before') {
      text = text.replace('captureMs: 0,', 'auditMs: 0, captureMs: 0,');
      text = text.replace('let png, result;', 'const auditStart = performance.now();\n      let png, result;');
      text = text.replace('if (verifyReuse) {\n        Atomics.add', 'if (verifyReuse) {\n        stats.auditMs += performance.now() - auditStart;\n        Atomics.add');
    }
    const destination = path.join(root, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, text);
  }
  const { openShot } = await import(pathToFileURL(path.join(root, 'src/capture.mjs')));
  const { createPostCapture } = await import(pathToFileURL(path.join(root, 'src/post.mjs')));
  const { verifiedFrames, reuseProfile, reuseState } = await import(pathToFileURL(path.join(root, 'src/static-reuse.mjs')));
  for (const blur of [1, 6]) {
    const options = { transport: 'raw', 'motion-blur': blur };
    reuseState(options);
    for (const key of Object.keys(reuseProfile)) reuseProfile[key] = 0;
    const capture = await openShot('tools/bench/shots/static-half.html', 1, options);
    let observeMs = 0;
    const observe = capture.observe;
    capture.observe = async (...args) => { const start = performance.now(); try { return await observe(...args); } finally { observeMs += performance.now() - start; } };
    try {
      const processed = createPostCapture(capture, options);
      let sourceMs = 0, hashMs = 0;
      const source = async function* (first = 0, end = 120) {
        for (let frame = first; frame < end; frame++) {
          const start = performance.now();
          const png = await processed.frame(frame / 30, frame, frame === end - 1);
          sourceMs += performance.now() - start;
          yield { frame, png };
        }
      };
      const started = performance.now();
      const hash = createHash('sha256');
      for await (const item of verifiedFrames(source, options, 120, { owned: true })) {
        const start = performance.now();
        hash.update(item.png);
        hashMs += performance.now() - start;
      }
      const totalMs = performance.now() - started;
      results.push({ version, blur, totalMs, sourceMs, hashMs, stagingMs: totalMs - sourceMs - hashMs, observeMs, ...reuseProfile,
        observer: await capture.page.evaluate(() => globalThis.__multiplaneStatic.profile),
        stats: processed.stats, reuse: processed.staticReuse, sha256: hash.digest('hex') });
      console.log(JSON.stringify(results.at(-1)));
    } finally { await capture.close(); }
  }
}
for (const blur of [1, 6]) {
  const pair = results.filter(item => item.blur === blur);
  if (pair[0].sha256 !== pair[1].sha256) throw Error('Profiling changes pixels.');
}
await writeFile('out/bench/static-reuse-profile.json', JSON.stringify({ revision, results }, null, 2));
