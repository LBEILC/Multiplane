import path from 'node:path';
import os from 'node:os';
import { mkdir, copyFile, unlink } from 'node:fs/promises';
import { constants, mkdirSync } from 'node:fs';
import { homeDirectory } from './store.mjs';

export function desktopDirectory(env = process.env, platform = process.platform, home) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return paths.join(homeDirectory({ ...env, MULTIPLANE_HOME: undefined }, platform, home), 'desktop');
}

export function configureDesktopPaths(app, env = process.env) {
  // An isolated test profile may not have a resolvable platform userData path.
  const previous = env.MULTIPLANE_APP_DATA ? null : process.platform === 'win32'
    ? path.join(env.APPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'), 'multiplane', 'desktop') : app.getPath('userData');
  let legacy = null;
  if (!env.MULTIPLANE_APP_DATA && process.platform === 'win32') {
    // A missing legacy platform directory must not block the new profile home.
    try { legacy = app.getPath('userData'); } catch { /* No legacy preferences to migrate. */ }
  }
  const directory = env.MULTIPLANE_APP_DATA ? path.resolve(env.MULTIPLANE_APP_DATA) : desktopDirectory(env);
  mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);
  return { previous, directory, ...(legacy ? { legacy } : {}) };
}

export async function migratePreferences(previous, next) {
  if (path.resolve(previous) === path.resolve(next)) return;
  await mkdir(next, { recursive: true });
  try {
    // Exclusive creation preserves newer preferences, including during a race.
    await copyFile(path.join(previous, 'preferences.json'), path.join(next, 'preferences.json'), constants.COPYFILE_EXCL);
    await unlink(path.join(previous, 'preferences.json'));
  } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
}

export function focusWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}

export function singleInstance(app, window) {
  if (!app.requestSingleInstanceLock()) { app.quit(); return false; }
  app.on('second-instance', () => focusWindow(window()));
  app.on('activate', () => focusWindow(window()));
  return true;
}
