import test from 'node:test';
import assert from 'node:assert/strict';
import { runAccessibilityAction, selectWindowCandidate } from '../tools/window-selection.mjs';

const target = { pid: 42, title: 'Multiplane' };
const main = { ...target, index: 1, role: 'AXWindow', position: { x: 0, y: 31 } };
const other = { ...main, index: 0, title: 'Inspector' };
const duplicate = { ...main, index: 2, position: { x: 100, y: 31 } };

test('multiple windows select only the matching PID, title and role', async () => {
  const candidates = [other, { ...main, pid: 43 }, { ...main, role: 'AXSheet' }, main];
  assert.equal(selectWindowCandidate(candidates, target), main);
  const calls = [], check = {};
  const result = await runAccessibilityAction(async (...args) => {
    calls.push(args);
    return args[0] === 'windows' ? { candidates } : { ok: true };
  }, target, 'close', 'AXPress', check);
  assert.equal(result.ok, true);
  assert.deepEqual(calls[1], ['close', 'AXPress', 1]);
});

test('ambiguous windows and a changed AX tree retry before pressing close', async () => {
  let time = 0, listings = 0, presses = 0;
  const check = {};
  await runAccessibilityAction(async action => {
    if (action === 'windows') return { candidates: ++listings === 1 ? [main, duplicate] : [other, main] };
    if (++presses === 1) return { kind: 'window-selection-pending', candidates: [main, duplicate] };
    return { ok: true };
  }, target, 'close', 'AXPress', check, { timeout: 30, interval: 10, now: () => time, sleep: async ms => { time += ms; } });
  assert.equal(listings, 3);
  assert.equal(presses, 2);
  assert.equal(time, 20);
  assert.equal(check.windowSelections[0].status, 'selected');
});

test('selection timeout preserves every candidate title, role and position without closing', async () => {
  for (const candidates of [[main, duplicate, other], [other], []]) {
    let time = 0;
    const check = {};
    await assert.rejects(runAccessibilityAction(async action => {
      assert.equal(action, 'windows');
      return { candidates };
    }, target, 'close', 'AXPress', check, { timeout: 20, interval: 10, now: () => time, sleep: async ms => { time += ms; } }), /selection timed out/);
    assert.equal(check.windowSelections[0].status, 'timeout');
    assert.deepEqual(check.windowSelections[0].attempts.at(-1).candidates, candidates);
  }
});

test('native close errors and broken helper responses are not converted into selection success', async () => {
  const result = await runAccessibilityAction(async action => action === 'windows'
    ? { candidates: [main] } : { ok: false, axError: -25205 }, target, 'close', 'AXPress', {});
  assert.equal(result.ok, false);
  await assert.rejects(runAccessibilityAction(async () => ({}), target, 'close', 'AXPress', {}), /Invalid AX/);
});
