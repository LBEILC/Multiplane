import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = path.join(root, 'out/083');
await mkdir(out, { recursive: true });
const clock = path.join(out, 'fixed-elapsed.mjs');
await writeFile(clock, "Object.defineProperty(performance, 'now', { value: () => 0 });\n");
const env = { ...process.env, MULTIPLANE_HOME: path.join(out, 'home'), MULTIPLANE_AGENT_HOME: path.join(out, 'user') };
const baseline = process.argv[2] === 'record';
const entry = baseline ? path.join(root, `bin/.startup-before-${process.pid}.mjs`) : path.join(root, 'bin/multiplane');
if (baseline) {
  const original = spawnSync('git', ['show', `${process.argv[3] || 'HEAD'}:bin/multiplane`], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(original.status, 0, original.stderr);
  await writeFile(entry, original.stdout, { flag: 'wx' });
}
try {
  for (const [command, action] of [['config', 'get'], ['skill', 'status']]) {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(clock).href, entry, command, action, '--json'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    // Stabilize elapsedMs at the clock source, then exclude only event timestamps.
    const normalized = result.stdout.replace(/"ts":"[^"]+"/g, '"ts":"<timestamp>"');
    const file = path.join(out, `baseline-${command}.jsonl`);
    if (baseline) await writeFile(file, normalized);
    else assert.equal(normalized, await readFile(file, 'utf8'));
    console.log(`${command} ${action} --json: ${baseline ? 'recorded' : 'byte-identical (timestamps excluded)'}`);
  }
} finally {
  if (baseline) await unlink(entry);
}
