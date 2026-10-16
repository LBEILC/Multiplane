import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createTempDirectory } from './helpers.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
test('CLI help metadata stays in sync with post and scale flags', async () => {
  const post = await readFile(new URL('../../src/post.mjs', import.meta.url), 'utf8');
  const cli = await readFile(new URL('../../bin/multiplane', import.meta.url), 'utf8');
  for (const name of ['postArgs', 'scaleArgs']) {
    const declaration = new RegExp(`const ${name} = (\\[[^;]+);`);
    assert.equal(cli.match(declaration)?.[1], post.match(declaration)?.[1]);
  }
});

test('help/version avoid the renderer and setup avoids unrelated command entry points', async () => {
  const temporary = createTempDirectory('multiplane-startup-');
  const hook = path.join(temporary, 'imports.mjs');
  await writeFile(hook, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  const forbidden = process.env.STARTUP_HELP === '1' ? /\\/src\\/(?:capture|post|render|index|benchmark|serve|events)\\.mjs$/ : /\\/src\\/(?:index|render|stills|verify|benchmark|serve)\\.mjs$/;
  if (forbidden.test(result.url)) throw Error('Unexpected startup import: ' + result.url);
  return result;
} });`);
  for (const args of [['--version'], ['--help'], ['config', 'get', '--json'], ['skill', 'status', '--json']]) {
    const { stdout, stderr } = await execute(process.execPath, ['--import', pathToFileURL(hook).href, path.join(root, 'bin/multiplane'), ...args], {
      cwd: root, windowsHide: true, env: { ...process.env, STARTUP_HELP: args.length === 1 ? '1' : '0', MULTIPLANE_HOME: temporary, MULTIPLANE_AGENT_HOME: temporary },
    });
    assert.ok(stdout.length); assert.equal(stderr, '');
  }
});
