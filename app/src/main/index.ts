import { cliEntry, copyableCommand } from './cli-entry.mjs';
import { t, setLanguage, resolveLanguage, language, languagePreferences } from '../shared/i18n.mjs';
import { app, BrowserWindow, ipcMain, nativeTheme, Notification, shell, dialog, protocol, net, clipboard, Menu } from 'electron';
import { userError } from '../shared/errors.mjs';
import path from 'node:path';
import os from 'node:os';
import { readFile, mkdir } from 'node:fs/promises';
import { Configuration, Skills, rendererRoot, bundledCommand, parseDoctor, readEnvironment, checkFfmpeg } from './settings.mjs';
import { pathToFileURL } from 'node:url';
import { JobStore, Preferences, homeDirectory } from './store.mjs';
import type { Job, Snapshot } from '../shared/types';
import { BrowserInstaller } from './browser.mjs';
import { applicationMenu } from './menu';
import { configureDesktopPaths, migratePreferences, singleInstance } from './lifecycle.mjs';
import { createLogger } from './log.mjs';

// Main-process verification uses the same functions as doctor, without adding IPC.
export { bundledCommand, rendererRoot };

protocol.registerSchemesAsPrivileged([{ scheme: 'multiplane-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const { previous: oldData, directory: data, legacy: legacyData } = configureDesktopPaths(app);
const log = createLogger(data);
let win: BrowserWindow;
const primary = singleInstance(app, () => win);
const store = new JobStore(homeDirectory());
const prefs = new Preferences(app.getPath('userData'));
function updateMenu() {
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate(applicationMenu()) : null);
}
const snapshot = (select?: string): Snapshot => ({ language: language(), languagePreference: prefs.value.language, jobs: store.jobs.filter((j: Job) => !prefs.value.hidden.includes(j.jobId)), runningCount: store.jobs.filter((j: Job) => j.state === 'running').length, theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', select });
const publish = (select?: string) => { if (win && !win.isDestroyed()) win.webContents.send('snapshot', snapshot(select)); };
function allowed(job: Job) {
  const files = new Set<string>([path.join(job.jobDir, 'preview.png')]);
  for (const a of [...(job.result?.artifacts ?? []), ...job.events.filter(e => e.type === 'artifact')]) if (typeof a.path === 'string' && path.isAbsolute(a.path)) files.add(a.path);
  for (const e of job.events.filter(e => e.type === 'finding')) for (const f of Object.values(e.details?.images ?? {})) if (typeof f === 'string' && path.isAbsolute(f)) files.add(f);
  return files;
}
if (primary) app.whenReady().then(async () => {
  // Test overrides must never migrate the real user's preferences.
  if (oldData) await migratePreferences(oldData, data);
  if (legacyData) await migratePreferences(legacyData, data);
  log('startup', `Renderer home: ${store.home}; desktop data: ${data}`);
  await prefs.load(); setLanguage(resolveLanguage(prefs.value.language, app.getLocale())); nativeTheme.themeSource = prefs.value.theme as 'system' | 'light' | 'dark';
  updateMenu();
  const colours = () => nativeTheme.shouldUseDarkColors ? { color: '#151515', symbolColor: '#a8a7a2', height: 44 } : { color: '#fcfcfb', symbolColor: '#64635e', height: 44 };
  win = new BrowserWindow({ width: 1160, height: 720, minWidth: 960, minHeight: 600, show: false, icon: path.join(__dirname, 'brand', process.platform === 'win32' ? 'app.ico' : process.platform === 'darwin' ? 'app.icns' : 'app-512.png'), title: t('appName'), autoHideMenuBar: process.platform !== 'darwin', titleBarStyle: 'hidden', ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 15 } } : { titleBarOverlay: colours() }), backgroundColor: colours().color, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  nativeTheme.on('updated', () => { if (!win.isDestroyed()) { if (process.platform !== 'darwin') win.setTitleBarOverlay(colours()); win.setBackgroundColor(colours().color); publish(); } });
  protocol.handle('multiplane-media', async request => {
    try {
      const url = new URL(request.url), job = store.job(url.searchParams.get('job')) as Job;
      const file = path.resolve(url.searchParams.get('file') ?? '');
      if (!allowed(job).has(file) || !/\.(png|jpe?g|webp|mp4|webm)$/i.test(file)) return new Response(null, { status: 403 });
      return await net.fetch(pathToFileURL(file).href, { headers: request.headers });
    } catch { return new Response(null, { status: 404 }); }
  });
  const handle = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error('Invalid sender');
    try { return await fn(...args); }
    catch (error) { log(`ipc:${name}`, error); throw Error(userError(error)); }
  });
  ipcMain.on('renderer-fault', (event, message) => {
    if (event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && typeof message === 'string') log('renderer', message);
  });
  win.webContents.on('render-process-gone', (_event, details) => log('renderer-process', JSON.stringify(details)));
  win.webContents.on('did-fail-load', (_event, code, description) => log('renderer-load', `${code}: ${description}`));
  win.webContents.on('preload-error', (_event, _file, error) => log('preload', error));
  win.webContents.on('console-message', details => { if (details.level === 'error') log('renderer-console', `${details.message} (${details.sourceId}:${details.lineNumber})`); });
  handle('platform', () => ({ platform: process.platform, home: os.homedir() }));
  const jobFor = (id: unknown): Job => { if (typeof id !== 'string') throw Error('Invalid job'); return store.job(id); };
  const root = rendererRoot(app.isPackaged, process.resourcesPath, app.getAppPath());
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const config = new Configuration(root, homeDirectory());
  const skills = new Skills(root, { ...process.env, MULTIPLANE_AGENT_HOME: process.env.MULTIPLANE_TEST_USER_HOME || process.env.MULTIPLANE_AGENT_HOME || os.homedir() });
  const settings = async () => ({ ...await config.read(), own: prefs.value, version, packaged: app.isPackaged });
  const installer = new BrowserInstaller(root, (state: unknown) => { if (!win.isDestroyed()) win.webContents.send('browser-install-state', state); }, path.join(__dirname, 'browser-worker.cjs'));
  handle('browser-install-state', () => installer.state);
  let confirmingBrowser = false;
  handle('install-browser', async () => {
    if (installer.state.running || confirmingBrowser) return;
    confirmingBrowser = true;
    try {
      const answer = await dialog.showMessageBox(win, { type: 'question', message: t('browserConfirm'), detail: t('browserConfirmDetail'), buttons: [t('cancel'), t('downloadInstall')], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response === 1) installer.start();
    } finally { confirmingBrowser = false; }
  });
  handle('cancel-browser-install', () => installer.cancel());
  app.on('before-quit', event => { if (installer.child) { event.preventDefault(); void installer.cancel().then(() => app.quit()); } });
  handle('settings', settings);
  handle('check-ffmpeg', async () => checkFfmpeg(((await config.read()).values as Record<string, unknown>).ffmpeg));
  handle('save-setting', async (key, value, own) => {
    if (own) {
      if (!(key === 'language' ? languagePreferences.includes(value) : key === 'theme' ? ['system', 'light', 'dark'].includes(value) : ['notifications', 'wizardDone'].includes(key) && typeof value === 'boolean')) throw Error('Invalid preference');
      await prefs.save({ [key]: value }); if (key === 'language') { setLanguage(resolveLanguage(value, app.getLocale())); updateMenu(); win.setTitle(t('appName')); installer.refresh(); } nativeTheme.themeSource = prefs.value.theme as 'system' | 'light' | 'dark'; publish();
      if (key === 'wizardDone') log('wizard', JSON.stringify({ done: value, discovered: store.jobs.length, visible: snapshot().jobs.length }));
    } else { const saved = await config.save(key, value); return { ...await settings(), check: saved.check }; }
    return settings();
  });
  handle('choose-setting', async key => {
    if (!['ffmpeg', 'jobsDir'].includes(key)) throw Error('Invalid setting');
    const result = await dialog.showOpenDialog(win, { title: t(key === 'jobsDir' ? 'jobDirectory' : 'chooseFfmpeg'), buttonLabel: t('open'), properties: key === 'jobsDir' ? ['openDirectory'] : ['openFile'] });
    if (!result.canceled && result.filePaths[0]) { const saved = await config.save(key, result.filePaths[0]); return { ...await settings(), check: saved.check }; }
    return settings();
  });
  handle('open-config', async () => {
    await mkdir(path.dirname(config.file), { recursive: true });
    try { await readFile(config.file); shell.showItemInFolder(config.file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; const error = await shell.openPath(path.dirname(config.file)); if (error) throw Error(error); }
  });
  handle('doctor', async () => {
    try {
      const { stdout } = await bundledCommand(root, ['doctor', '--json']);
      const result = stdout.trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line)).at(-1);
      if (result?.code && !Array.isArray(result.data?.checks)) throw Error(result.code);
      return parseDoctor(stdout);
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      throw Error(e.code ?? (/^[a-z][a-z0-9_]+$/.test(e.message) ? e.message : 'internal_error'));
    }
  });
  const entry = cliEntry(process.platform, process.execPath, process.resourcesPath);
  handle('environment', async () => { const result = await readEnvironment(skills); return { ...result, command: { ...result.command, bundled: app.isPackaged ? copyableCommand(entry) : null } }; });
  handle('copy-bundled-command', () => clipboard.writeText(copyableCommand(entry)));
  let confirmationId = 0;
  let pendingConfirmation: { id: number; resolve: (accepted: boolean) => void } | undefined;
  handle('answer-skill-confirmation', (id, accepted) => {
    if (!pendingConfirmation || pendingConfirmation.id !== id || typeof accepted !== 'boolean') throw Error('Invalid confirmation');
    const pending = pendingConfirmation; pendingConfirmation = undefined; pending.resolve(accepted);
  });
  const cancelConfirmation = () => { pendingConfirmation?.resolve(false); pendingConfirmation = undefined; };
  win.on('closed', cancelConfirmation);
  win.webContents.on('did-start-loading', cancelConfirmation);
  handle('skill', async (host, action) => {
    if (!['install', 'remove'].includes(action)) throw Error('Invalid action');
    const status = await skills.status(host);
    if (status.blocked) throw Error(status.error ?? undefined);
    // TODO(design): CLI chooses the backup timestamp at execution; the dialog shows its naming pattern.
    const backupName = 'multiplane.bak-<yyyyMMdd-HHmmss>';
    if (status.state === 'modified' || action === 'remove') {
      if (pendingConfirmation) return { cancelled: true };
      const agent = t(host === 'claude' ? 'agentClaude' : 'agentCodex'), remove = action === 'remove';
      const accepted = await new Promise<boolean>(resolve => {
        const id = ++confirmationId; pendingConfirmation = { id, resolve };
        win.webContents.send('skill-confirmation', { id, titleKey: remove ? 'removeSkillTitle' : 'replaceSkillTitle', detailKey: remove ? status.state === 'modified' ? 'modifiedBackup' : 'removeSkillDetail' : 'replaceSkillDetail', actionKey: remove ? 'remove' : 'replace', values: { agent, backup: backupName, version }, title: remove ? t('removeSkillTitle', { agent }) : t('replaceSkillTitle', { agent }), detail: remove ? status.state === 'modified' ? t('modifiedBackup', { backup: backupName }) : t('removeSkillDetail', { agent }) : t('replaceSkillDetail', { backup: backupName, version }), action: remove ? t('remove') : t('replace'), danger: remove });
      });
      if (!accepted) return { cancelled: true };
    }
    return skills.change(host, action, status.signature, status.state === 'modified');
  });
  handle('copy-browser-command', () => clipboard.writeText('npx playwright install chromium'));
  handle('snapshot', () => {
    const value = snapshot();
    log('snapshot-request', JSON.stringify({ wizardDone: prefs.value.wizardDone, discovered: store.jobs.length, visible: value.jobs.length }));
    return value;
  });
  handle('stop', async id => {
    const job = jobFor(id); if (job.state !== 'running') return;
    const result = await dialog.showMessageBox(win, { type: 'warning', message: t('stopTitle', { name: path.basename(job.shot) }), detail: t('stopDetail'), buttons: [t('cancel'), t('stop')], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response === 1) await store.stop(job.jobId);
  });
  handle('hide', async id => { jobFor(id); await prefs.save({ hidden: [...new Set([...prefs.value.hidden, id])] }); publish(); });
  handle('open', async (id, file, reveal) => {
    const job = jobFor(id);
    if (file !== undefined && (typeof file !== 'string' || !allowed(job).has(file))) throw Error('Invalid artifact');
    if (reveal) { shell.showItemInFolder(file ?? job.jobDir); return; }
    const error = await shell.openPath(file ?? job.jobDir); if (error) throw Error(error);
  });
  let previousSummary = '';
  store.on('change', () => {
    const summary = JSON.stringify({ discovered: store.jobs.length, visible: snapshot().jobs.length });
    if (summary !== previousSummary) { log('jobs-scan', summary); previousSummary = summary; }
    publish();
  });
  store.on('fault', error => log('jobs', error));
  store.on('finished', (job: Job) => {
    log('job-finished', job.jobId);
    if (!prefs.value.notifications || !Notification.isSupported()) return;
    try {
      const label = job.state === 'succeeded' ? t('completed') : job.state === 'cancelled' ? t('cancelled') : t('failed');
      const notification = new Notification({ title: t('notification', { status: label, name: path.basename(job.shot) }), body: path.basename(path.dirname(job.shot)) });
      notification.on('click', async () => {
        try {
          if (prefs.value.hidden.includes(job.jobId)) await prefs.save({ hidden: prefs.value.hidden.filter((id: string) => id !== job.jobId) });
          if (win.isMinimized()) win.restore(); win.show(); win.focus(); publish(job.jobId);
        } catch (error) { log('notification-click', error); }
      });
      notification.show();
    } catch (error) { log('notification', error); }
  });
  // Let the CLI migrate shared files before the first index read.
  try { await config.read(); } catch (error) { log('home-migration', error); }
  await store.start();
  await win.loadFile(path.join(__dirname, 'index.html')); win.show();
}).catch(error => { log('startup', error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { void store.close(); });
