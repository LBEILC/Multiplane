// The driver owns platform I/O; this state machine is testable with a virtual clock.
export const isOperable = s => !s.isMinimized && !s.isFullScreen && s.isVisible && s.isFocused;
export const isNormal = s => isOperable(s) && !s.isMaximized;

export async function runWindowActions(driver, check, { mac = false, timeout = 10000, interval = 100,
  now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  check.states = [];
  check.zoomAttempts = [];
  const sample = async () => {
    const state = await driver.state();
    check.lastState = state;
    return state;
  };
  const wait = async (step, predicate) => {
    const start = now();
    let state;
    do {
      state = await sample(step);
      if (predicate(state)) {
        check.states.push({ step, status: 'passed', state });
        return state;
      }
      if (now() - start >= timeout) break;
      await sleep(interval);
    } while (true);
    check.states.push({ step, status: 'timeout', state });
    const error = Error(`${step} timed out after ${timeout}ms; window state: ${JSON.stringify(state)}`);
    error.windowStateTimeout = true;
    throw error;
  };
  const ready = async (step, normal = false) => {
    let state = await sample(step);
    if (state.isFullScreen) {
      await driver.command('leave-full-screen');
      await wait(`${step}:leave-full-screen`, s => !s.isFullScreen);
    }
    state = await sample(step);
    if (state.isMinimized) {
      await driver.command('deminiaturize');
      await wait(`${step}:deminiaturize`, s => !s.isMinimized);
    }
    if (normal && (await sample(step)).isMaximized) {
      await driver.command('unmaximize');
      await wait(`${step}:unmaximize`, s => !s.isMaximized);
    }
    await driver.command('focus');
    return wait(step, normal ? isNormal : isOperable);
  };
  const native = async (action, method) => {
    const result = await driver.native(action, method);
    if (result?.ok === false) throw Error(`${action} ${method}: ${JSON.stringify(result)}; window state: ${JSON.stringify(await sample(action))}`);
  };
  try {
    await ready('before-minimize', true);
    await native('minimize', 'AXPress');
    await wait('minimize', s => s.isMinimized);
    check.actions.push({ action: 'minimize', method: mac ? 'AXPress' : check.method, passed: true, native: true });
    await ready('after-minimize:restored-visible-focused', true);

    let verifiedZoom = !mac;
    if (mac) {
      // Only explicit AX action failures or an observed zoom timeout may degrade.
      // Missing helpers, invalid JSON, permissions and lost windows remain hard failures.
      for (const method of ['AXZoomWindow', 'Option+AXPress']) {
        await ready(`before-zoom:${method}`, true);
        const attempt = { method, before: await sample(method) };
        check.zoomAttempts.push(attempt);
        const result = await driver.native('maximize', method);
        Object.assign(attempt, { result });
        if (typeof result?.ok !== 'boolean' || !Number.isInteger(result.axError)) throw Error(`Invalid AX result: ${JSON.stringify(result)}`);
        if (!result.ok) {
          if (result.kind !== 'ax-action-error' || !Number.isInteger(result.axError)) throw Error(`Invalid zoom failure: ${JSON.stringify(result)}`);
          attempt.status = 'unavailable';
          attempt.state = await sample(method);
          continue;
        }
        try {
          attempt.state = await wait(`maximize:${method}`, s => isOperable(s) && s.isMaximized);
          attempt.status = 'passed';
          verifiedZoom = true;
          check.zoomMethod = method;
          break;
        } catch (error) {
          if (!error.windowStateTimeout) throw error;
          attempt.status = 'no-zoom-state-change';
          attempt.reason = error.message;
          attempt.state = check.lastState;
          // A hidden, minimized or unfocused window is a readiness failure, not
          // evidence that this environment lacks an Accessibility zoom action.
          if (!isOperable(attempt.state) && !attempt.state.isFullScreen) throw error;
        }
      }
      if (!verifiedZoom) {
        check.zoom = { status: 'unverified', reason: 'Cannot trigger zoom through Accessibility in this environment' };
        await ready('before-programmatic-maximize', true);
        await driver.command('maximize');
        await wait('programmatic-maximize', s => isOperable(s) && s.isMaximized);
        check.zoomMethod = 'BrowserWindow.maximize';
      }
    } else {
      await ready('before-maximize', true);
      await native('maximize');
      await wait('maximize', s => isOperable(s) && s.isMaximized);
    }
    check.actions.push({ action: 'maximize', method: mac ? check.zoomMethod : check.method, passed: true, native: verifiedZoom });
    await ready('before-restore');
    // Restoration is setup for close, not a substitute for a native zoom assertion.
    if (mac) await driver.command('unmaximize');
    else await native('restore');
    await wait('restore', isNormal);
    check.actions.push({ action: 'restore', method: mac ? 'BrowserWindow.unmaximize' : check.method, passed: true, native: !mac });
    await ready('before-close', true);
    await driver.close();
    check.actions.push({ action: 'close', method: mac ? 'AXPress' : check.method, passed: true, native: true });
    check.status = verifiedZoom ? 'passed' : 'passed-with-unverified-zoom';
  } catch (error) {
    check.status = 'failed';
    check.reason = error.message;
    // Closing may already have disposed the Electron connection.
    try { check.failureState = await sample('failure'); } catch { check.failureState = check.lastState; }
    throw error;
  }
}
