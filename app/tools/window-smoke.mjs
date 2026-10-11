import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const execute = promisify(execFile);
const tool = name => fileURLToPath(new URL(name, import.meta.url));
const run = (command, args) => execute(command, args, { timeout: 30000, windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export async function validateCapture(png, bounds) {
  const metadata = await sharp(png).metadata(), stats = await sharp(png).stats();
  assert.ok(metadata.width >= bounds.width - 2 && metadata.height >= bounds.height - 2, 'Capture does not cover the whole window');
  assert.ok(stats.channels.some(c => c.stdev > 2), 'Capture is blank');
  return { width: metadata.width, height: metadata.height };
}

export async function trafficLightPixels(png, windowBounds, buttons) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sx = info.width / windowBounds.width, sy = info.height / windowBounds.height;
  const matches = {};
  for (const [name, button] of Object.entries(buttons)) {
    const left = Math.max(0, Math.floor((button.x - windowBounds.x) * sx));
    const top = Math.max(0, Math.floor((button.y - windowBounds.y) * sy));
    const right = Math.min(info.width, Math.ceil((button.x + button.width - windowBounds.x) * sx));
    const bottom = Math.min(info.height, Math.ceil((button.y + button.height - windowBounds.y) * sy));
    let count = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y * info.width + x) * 4, [r, g, b, a] = data.subarray(i, i + 4);
      const colored = name === 'close' ? r > 150 && r > g * 1.4 && r > b * 1.4 : name === 'minimize' ? r > 150 && g > 110 && b < g * .65 : g > 100 && g > r * 1.4 && g > b * 1.3;
      if (a > 200 && colored) count++;
    }
    matches[name] = count;
    assert.ok(count >= 3, `No visible ${name} traffic-light pixels in its native bounds`);
  }
  return matches;
}

export async function ensureWindowManager(evidence) {
  if (process.platform !== 'linux') return;
  try { await run('wmctrl', ['-m']); evidence.windowManager = 'existing'; return; } catch { /* Xvfb alone has no window manager. */ }
  const child = spawn('openbox', ['--sm-disable'], { stdio: 'ignore' });
  let failure;
  child.on('error', error => { failure = error; });
  try {
    for (let i = 0; i < 50; i++) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw Error('Openbox exited before becoming ready');
      try { await run('wmctrl', ['-m']); evidence.windowManager = 'openbox'; return child; } catch { await delay(100); }
    }
    throw Error('No X11 window manager became ready');
  } catch (error) { child.kill(); throw error; }
}

async function geometry(app) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0], handle = win.getNativeWindowHandle();
    const bounds = win.getBounds(), content = win.getContentBounds();
    return { bounds, content, display: screen.getDisplayMatching(bounds), source: win.getMediaSourceId(),
      handle: (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(),
      electron: process.versions.electron, pid: process.pid };
  });
}

export async function captureWindow(app, out, evidence) {
  const result = evidence.wholeWindow = { status: 'unavailable', attempts: [] };
  const file = 'window.png', destination = path.join(out, file);
  // A clean empty jobs page is selected by the caller before any native capture.
  let info;
  try {
    await app.evaluate(({ app, BrowserWindow }) => {
      if (process.platform === 'darwin') app.focus({ steal: true });
      const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus();
    });
    await delay(200);
    info = await geometry(app);
  } catch (error) { result.reason = `Cannot prepare native window capture: ${error.message}`; return; }
  result.bounds = info.bounds;
  const methods = ['desktopCapturer:window', ...(process.platform === 'linux' ? ['import:X11'] : process.platform === 'darwin' ? ['screencapture'] : ['desktopCapturer:screen-crop'])];
  for (const method of methods) {
    try {
      let png;
      if (method.startsWith('desktopCapturer:')) {
        const capture = await app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, method) => {
          const win = BrowserWindow.getAllWindows()[0], bounds = win.getBounds();
          const display = screen.getDisplayMatching(bounds);
          const isScreen = method.endsWith('screen-crop');
          const size = isScreen ? display.size : bounds;
          const sources = await Promise.race([
            desktopCapturer.getSources({ types: [isScreen ? 'screen' : 'window'], thumbnailSize: { width: Math.ceil(size.width * display.scaleFactor), height: Math.ceil(size.height * display.scaleFactor) } }),
            new Promise((_, reject) => setTimeout(() => reject(Error('desktopCapturer timed out')), 12000))
          ]);
          const source = sources.find(s => isScreen ? s.display_id === String(display.id) : s.id === win.getMediaSourceId());
          if (!source || source.thumbnail.isEmpty()) throw Error('No nonempty source for this window');
          let image = source.thumbnail;
          if (isScreen) {
            const d = display.bounds;
            if (bounds.x < d.x || bounds.y < d.y || bounds.x + bounds.width > d.x + d.width || bounds.y + bounds.height > d.y + d.height) throw Error('Window spans or exceeds the captured display');
            const scaleX = image.getSize().width / d.width, scaleY = image.getSize().height / d.height;
            image = image.crop({ x: Math.round((bounds.x - d.x) * scaleX), y: Math.round((bounds.y - d.y) * scaleY), width: Math.round(bounds.width * scaleX), height: Math.round(bounds.height * scaleY) });
          }
          return image.toPNG().toString('base64');
        }, method);
        png = Buffer.from(capture, 'base64');
      } else if (method === 'import:X11') {
        await run('import', ['-window', info.handle, destination]);
        png = await readFile(destination);
      } else {
        const id = info.source.split(':')[1];
        assert.match(id, /^\d+$/);
        await run('/usr/sbin/screencapture', ['-x', '-o', '-l', id, destination]);
        png = await readFile(destination);
      }
      const metadata = await validateCapture(png, info.bounds);
      await writeFile(destination, png);
      Object.assign(result, { status: 'captured', method, file, width: metadata.width, height: metadata.height });
      evidence.screenshots.push(file);
      return;
    } catch (error) { result.attempts.push({ method, reason: error.message }); }
  }
  result.reason = 'All native whole-window capture methods failed; see attempts';
  await rm(destination, { force: true }).catch(error => { result.attempts.push({ method: 'cleanup', reason: error.message }); });
}

async function waitState(app, key, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await app.evaluate(({ BrowserWindow }, key) => {
      const win = BrowserWindow.getAllWindows()[0];
      return key === 'minimized' ? win.isMinimized() : win.isMaximized();
    }, key);
    if (value === expected) return;
    await delay(100);
  }
  throw Error(`Window ${key} did not become ${expected}`);
}

export async function checkWindowControls(app, page, work, out, evidence) {
  const check = evidence.windowControls = { status: 'running', actions: [] };
  let macHelper;
  try {
    const info = await geometry(app);
    check.electron = info.electron;
    const lock = JSON.parse(await readFile(tool('../package.json'), 'utf8')).devDependencies.electron;
    assert.equal(info.electron, lock, 'Runtime Electron must match the locked version');
    check.reference = `https://github.com/electron/electron/blob/v${lock}/docs/api/base-window.md#winsettitlebaroverlayoptions-windows-linux`;
    if (process.platform === 'darwin') {
      macHelper = path.join(work, 'window-accessibility');
      await execute('xcrun', ['swiftc', tool('window-accessibility.swift'), '-o', macHelper], { timeout: 120000 });
      check.buttons = JSON.parse((await run(macHelper, [String(info.pid), 'inspect'])).stdout);
      // Compare visible brand children, not the padded wrapper that intentionally contains the lights.
      check.brand = await page.locator('.titlebar > .brand-lockup').evaluate(el => [...el.children].map(child => {
        const { x, y, width, height } = child.getBoundingClientRect(); return { x, y, width, height };
      }));
      for (const rect of Object.values(check.buttons)) {
        assert.ok(rect.enabled && rect.pressable && rect.width > 0 && rect.height > 0, 'Traffic light is unavailable');
        const local = { ...rect, x: rect.x - info.content.x, y: rect.y - info.content.y };
        assert.ok(local.x >= 0 && local.y >= 0 && local.x + local.width <= 78 && local.y + local.height <= 44, 'Traffic light is outside the reserved titlebar area');
        assert.ok(check.brand.every(brand => !intersects(local, brand)), 'Traffic lights overlap the brand');
      }
      assert.equal(evidence.wholeWindow.status, 'captured', 'Traffic-light visibility requires a native screenshot');
      check.visiblePixels = await trafficLightPixels(await readFile(path.join(out, evidence.wholeWindow.file)), evidence.wholeWindow.bounds, check.buttons);
      check.method = 'Accessibility AXPress / AXZoomWindow on native traffic lights';
    } else {
      await page.waitForFunction(() => navigator.windowControlsOverlay?.visible && navigator.windowControlsOverlay.getTitlebarAreaRect().height > 0, null, { timeout: 10000 });
      check.overlay = await page.evaluate(() => {
        const { x, y, width, height } = navigator.windowControlsOverlay.getTitlebarAreaRect();
        return { visible: navigator.windowControlsOverlay.visible, titlebar: { x, y, width, height }, viewportWidth: innerWidth, reservedRight: innerWidth - x - width };
      });
      assert.ok(check.overlay.visible && check.overlay.titlebar.width > 0 && check.overlay.titlebar.height > 0 && check.overlay.reservedRight > 0, 'Missing overlay or empty right-hand button area');
      check.method = process.platform === 'win32' ? 'WM_SYSCOMMAND (native caption system commands)' : 'X11 window-manager commands (xdotool / wmctrl)';
    }
    const trigger = async action => {
      if (process.platform === 'darwin') await run(macHelper, [String(info.pid), action]);
      else if (process.platform === 'win32') await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tool('window-system.ps1'), '-WindowHandle', info.handle, '-OwnerPid', String(info.pid), '-Action', action]);
      else if (action === 'minimize') await run('xdotool', ['windowminimize', info.handle]);
      else if (action === 'close') await run('wmctrl', ['-i', '-c', info.handle]);
      else await run('wmctrl', ['-i', '-r', info.handle, '-b', `${action === 'maximize' ? 'add' : 'remove'},maximized_vert,maximized_horz`]);
    };
    await trigger('minimize'); await waitState(app, 'minimized', true);
    check.actions.push({ action: 'minimize', passed: true });
    // Restoring a minimized window is setup for the next caption-button check.
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.restore(); win.show(); win.focus(); });
    await waitState(app, 'minimized', false);
    await trigger('maximize'); await waitState(app, 'maximized', true);
    check.actions.push({ action: 'maximize', passed: true });
    await trigger('restore'); await waitState(app, 'maximized', false);
    check.actions.push({ action: 'restore', passed: true });
    // Keep the child handle before close disposes Playwright's Electron dispatcher.
    const processHandle = app.process();
    const closed = page.waitForEvent('close', { timeout: 15000 });
    await Promise.all([closed, trigger('close')]);
    for (let i = 0; i < 100 && processHandle.exitCode === null; i++) await delay(100);
    assert.equal(processHandle.exitCode, 0, 'Native close must end the application cleanly');
    check.actions.push({ action: 'close', passed: true });
    check.status = 'passed';
  } catch (error) { check.status = 'failed'; check.reason = error.message; throw error; }
}
