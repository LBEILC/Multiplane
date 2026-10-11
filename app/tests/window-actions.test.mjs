import test from 'node:test';
import assert from 'node:assert/strict';
import { runWindowActions, isOperable, isNormal } from '../tools/window-actions.mjs';

function fixture(options = {}) {
  let time = 0;
  const state = { isMinimized: false, isMaximized: false, isFullScreen: false, isVisible: true, isFocused: true };
  const calls = [], pending = [], check = { actions: [], method: 'native system command' };
  const later = (delta, update) => pending.push({ at: time + delta, update });
  const driver = {
    state: async () => ({ ...state }),
    command: async action => {
      calls.push(action);
      if (action === 'deminiaturize') {
        later(10, { isMinimized: false });
        later(30, { isVisible: true });
      } else if (action === 'focus') {
        if (!options.noFocus && !state.isFocused) later(40, { isFocused: true });
      } else if (action === 'leave-full-screen') later(30, { isFullScreen: false });
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
  const run = () => runWindowActions(driver, check, { mac: options.mac ?? true, timeout: 100, interval: 10,
    now: () => time, sleep: async ms => {
      time += ms;
      for (const entry of pending.filter(p => p.at <= time)) Object.assign(state, entry.update);
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= time) pending.splice(i, 1);
    } });
  return { run, check, calls, state };
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

test('AX error retains system code and falls back to Option AXPress', async () => {
  const f = fixture({ zoom: { AXZoomWindow: 'error' } }); await f.run();
  assert.equal(f.check.status, 'passed');
  assert.equal(f.check.zoomMethod, 'Option+AXPress');
  assert.equal(f.check.zoomAttempts[0].result.axError, -25202);
});

test('AX success without zoom and accidental full screen cannot masquerade as native zoom', async () => {
  const f = fixture({ zoom: { AXZoomWindow: 'fullscreen', 'Option+AXPress': 'noop' } }); await f.run();
  assert.equal(f.check.status, 'passed-with-unverified-zoom');
  assert.ok(f.calls.indexOf('leave-full-screen') < f.calls.indexOf('maximize:Option+AXPress'));
  assert.ok(f.check.zoomAttempts.every(a => a.status === 'no-zoom-state-change' && a.result.axError === 0));
  assert.equal(f.check.zoomAttempts[0].state.isFullScreen, true);
  assert.equal(f.check.actions.find(a => a.action === 'maximize').native, false);
});

test('both AX errors require actual programmatic maximize and restore state changes', async () => {
  const zoom = { AXZoomWindow: 'error', 'Option+AXPress': 'error' };
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
