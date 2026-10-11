import test from 'node:test';
import assert from 'node:assert/strict';
import { runWindowActions, isOperable, isNormal, isZoomed } from '../tools/window-actions.mjs';

function fixture(options = {}) {
  let time = 0;
  const state = { isMinimized: false, isMaximized: false, isFullScreen: false, isVisible: true, isFocused: true };
  const calls = [], pending = [], callTimes = {}, check = { actions: [], method: 'native system command' };
  const later = (delta, update) => pending.push({ at: time + delta, update });
  const driver = {
    state: async () => ({ ...state }),
    command: async action => {
      calls.push(action);
      callTimes[action] = time;
      if (action === 'deminiaturize') {
        later(10, { isMinimized: false });
        later(30, { isVisible: true });
      } else if (action === 'focus') {
        if (!options.noFocus && !state.isFocused) later(40, { isFocused: true });
      } else if (action === 'leave-full-screen') {
        if (!options.stuckFullScreen) later(30, { isFullScreen: false });
        later(40, { bounds: { x: 0, y: 0, width: 800, height: 600 } });
        later(60, { bounds: { x: 10, y: 10, width: 800, height: 600 } });
      }
      else if (action === 'maximize' && !options.noProgrammaticMaximize) later(20, { isMaximized: true });
      else if (action === 'unmaximize' && !options.noRestore) later(20, { isMaximized: false });
    },
    native: async (action, method) => {
      calls.push(`${action}:${method}`);
      assert.ok(isOperable(state), `${action} must wait for a visible focused window`);
      if (action === 'minimize') {
        if (options.minimizeError) return { ok: false, axError: -25202 };
        if (!options.noMinimize) later(10, { isMinimized: true, isVisible: false, isFocused: false });
      } else if (action === 'maximize') {
        assert.ok(isNormal(state));
        if (options.infrastructureError) throw Error('Helper exited without JSON');
        if (options.invalidResult) return { ok: true };
        if (options.loseFocusOnZoom) later(10, { isFocused: false });
        if (options.zoom?.[method] === 'error') return { ok: false, kind: 'ax-action-error', axError: -25202 };
        if (options.zoom?.[method] === 'error-but-zoomed') {
          later(20, { isMaximized: true });
          return { ok: false, kind: 'ax-action-error', axError: -25205 };
        }
        if (options.zoom?.[method] === 'bounds') {
          // The initial outer bounds are part of the observed pre-action state.
          later(20, { bounds: { x: 0, y: 25, width: 1024, height: 700 }, workArea: { x: 0, y: 25, width: 1024, height: 700 } });
          return { ok: false, kind: 'ax-action-error', axError: -25205 };
        }
        if (options.zoom?.[method] === 'fullscreen') later(10, { isFullScreen: true });
        else if (options.zoom?.[method] !== 'noop') later(20, { isMaximized: true });
      } else if (action === 'restore') later(20, { isMaximized: false });
      return { ok: true, kind: 'ax-action', axError: 0 };
    },
    close: async () => {
      calls.push('close:AXPress');
      assert.ok(isNormal(state));
      if (options.closeError) throw Error('Native close failed');
    }
  };
  const run = () => runWindowActions(driver, check, { mac: options.mac ?? true, timeout: 100, interval: 10, stableFor: 30,
    now: () => time, sleep: async ms => {
      time += ms;
      for (const entry of pending.filter(p => p.at <= time)) Object.assign(state, entry.update);
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= time) pending.splice(i, 1);
    } });
  return { run, check, calls, state, callTimes };
}

test('native zoom waits for deminiaturize, visibility and focus, then restores before native close', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.check.status, 'passed');
  assert.equal(f.check.zoomMethod, 'AXZoomWindow');
  assert.equal(f.check.zoomAttempts.length, 1);
  assert.ok(f.calls.indexOf('deminiaturize') < f.calls.indexOf('maximize:AXZoomWindow'));
  assert.ok(f.calls.indexOf('unmaximize') < f.calls.indexOf('close:AXPress'));
  assert.ok(f.check.states.every(s => Object.keys(s.state).length === 5));
  assert.equal(f.check.actions.find(a => a.action === 'restore').method, 'BrowserWindow.unmaximize');
});

test('AX error with observed zoom is a native pass and retains the error code', async () => {
  const f = fixture({ zoom: { AXZoomWindow: 'error-but-zoomed' } }); await f.run();
  assert.equal(f.check.status, 'passed');
  assert.equal(f.check.zoomMethod, 'AXZoomWindow');
  assert.equal(f.check.zoomAttempts[0].result.axError, -25205);
  assert.equal(f.check.actions.find(a => a.action === 'maximize').native, true);
  assert.ok(!f.calls.includes('maximize'));
});

test('AX success without zoom and accidental full screen cannot masquerade as native zoom', async () => {
  const f = fixture({ zoom: { AXZoomWindow: 'fullscreen' } }); await f.run();
  assert.equal(f.check.status, 'passed-with-unverified-zoom');
  assert.ok(f.callTimes.maximize >= f.callTimes['leave-full-screen'] + 90);
  assert.ok(f.check.zoomAttempts.every(a => a.status === 'no-zoom-state-change' && a.result.axError === 0));
  assert.equal(f.check.states.find(s => s.status === 'unexpected-full-screen').state.isFullScreen, true);
  assert.equal(f.check.zoomAttempts[0].state.isFullScreen, false);
  assert.equal(f.check.actions.find(a => a.action === 'maximize').native, false);
});

test('unchanged AX state requires actual programmatic maximize and restore state changes', async () => {
  const zoom = { AXZoomWindow: 'error' };
  const f = fixture({ zoom }); await f.run();
  assert.equal(f.check.status, 'passed-with-unverified-zoom');
  assert.equal(f.check.zoomMethod, 'BrowserWindow.maximize');
  for (const extra of [{ noProgrammaticMaximize: true }, { noRestore: true }]) {
    const failed = fixture({ zoom, ...extra });
    await assert.rejects(failed.run(), /timed out.*window state/);
    assert.equal(failed.check.status, 'failed');
    assert.ok(!failed.calls.includes('close:AXPress'));
  }
});

test('successful AX return without state change waits for timeout before fallback', async () => {
  const f = fixture({ zoom: { AXZoomWindow: 'noop' } }); await f.run();
  assert.equal(f.check.zoomAttempts[0].status, 'no-zoom-state-change');
  assert.equal(f.check.states.find(s => s.step === 'maximize:AXZoomWindow').status, 'timeout');
  assert.equal(f.check.zoomMethod, 'BrowserWindow.maximize');
});

test('work-area outer bounds also verify native zoom', async () => {
  const f = fixture({ zoom: { AXZoomWindow: 'bounds' } });
  f.state.bounds = { x: 20, y: 40, width: 800, height: 600 };
  await f.run();
  assert.equal(f.check.status, 'passed');
  assert.equal(f.check.actions.find(a => a.action === 'maximize').native, true);
});

test('already work-area sized bounds cannot turn an unchanged window into a native pass', () => {
  const state = { isMinimized: false, isFullScreen: false, isVisible: true, isFocused: true, isMaximized: false,
    bounds: { x: 0, y: 25, width: 1024, height: 700 }, workArea: { x: 0, y: 25, width: 1024, height: 700 } };
  assert.equal(isZoomed(state, state), false);
});

test('full-screen recovery failure prevents further actions', async () => {
  const f = fixture({ zoom: { AXZoomWindow: 'fullscreen' }, stuckFullScreen: true });
  await assert.rejects(f.run(), /leave-full-screen.*timed out/);
  assert.ok(!f.calls.includes('maximize'));
  assert.ok(!f.calls.includes('close:AXPress'));
});

test('minimize, focus, restore, close and helper failures remain hard failures', async () => {
  for (const options of [{ noMinimize: true }, { minimizeError: true }, { noFocus: true },
    { noRestore: true }, { closeError: true }, { infrastructureError: true },
    { invalidResult: true }, { loseFocusOnZoom: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run());
    assert.equal(f.check.status, 'failed');
    assert.deepEqual(Object.keys(f.check.failureState).sort(), ['isFocused', 'isFullScreen', 'isMaximized', 'isMinimized', 'isVisible']);
  }
});

test('non-macOS retains native maximize and restore without zoom degradation', async () => {
  const f = fixture({ mac: false }); await f.run();
  assert.equal(f.check.status, 'passed');
  assert.equal(f.check.zoomAttempts.length, 0);
  assert.ok(f.calls.includes('restore:undefined'));
});
