import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { runCommand } from '../src/events.mjs';
import { projectPath } from '../app/src/shared/job-detail.mjs';
import { createTempDirectory } from './helpers.mjs';

for (const root of ['.', '../project', path.resolve('project'), undefined]) {
  test(`start events preserve the absolute project root (${root ?? 'omitted'})`, async () => {
    const jobs = createTempDirectory('multiplane-event-root-');
    const expectedRoot = path.resolve(root ?? process.cwd());
    for (const command of ['render', 'stills', 'verify', 'lint', 'inspect']) {
      const job = ['render', 'stills', 'verify'].includes(command);
      for (const shot of ['shots/a.html', 'other/b.html']) {
        const events = [];
        let effectiveRoot;
        const result = await runCommand(command, shot, {
          ...(root === undefined ? {} : { root }), 'job-dir': jobs,
          'no-lint': true, 'no-hosted': true, _resources: false,
          onEvent: event => events.push(event),
        }, async context => {
          effectiveRoot = context.options.root;
          return {};
        }, job);
        assert.equal(result.ok, true, result.message);
        assert.equal(effectiveRoot, expectedRoot);
        const start = events.find(event => event.type === 'start');
        assert.equal(start.options.root, expectedRoot);
        assert.equal(start.shot, path.resolve(expectedRoot, shot));
        if (job) {
          const directory = path.join(jobs, result.jobId);
          const persisted = (await readFile(path.join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
          const status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8'));
          assert.deepEqual(persisted, events);
          assert.equal(projectPath({ ...status, events: persisted }), expectedRoot.replaceAll('\\', '/'));
        }
      }
    }
  });
}

test('a non-string project root is rejected before the action runs', async () => {
  const error = await runCommand('render', 'shots/a.html', { root: true }, async () => {
    assert.fail('The action must not run with an invalid root');
  }).then(() => assert.fail('Expected invalid_option'), error => error);
  assert.equal(error.code, 'invalid_option');
});
