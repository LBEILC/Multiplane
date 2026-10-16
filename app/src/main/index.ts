import { ResumeJobs } from './resume.mjs';
import { TrayPopover } from './tray-popover';
import { cliEntry, copyableCommand } from './cli-entry.mjs';
import { t, setLanguage, resolveLanguage, language, languagePreferences } from '../shared/i18n.mjs';
import { app, BrowserWindow, ipcMain, nativeTheme, Notification, shell, dialog, protocol, net, clipboard, Menu, Tray, nativeImage, screen } from 'electron';
import { Hosted } from './hosted.mjs';
import { JobStopper } from './stop.mjs';
import { trayTemplate, hideOnClose, trayProgress } from './tray.mjs';
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
import { Updates } from './updates.mjs';
import { autoUpdater as platformUpdater } from 'electron-updater';
import { WindowsUpdater } from './windows-updater.mjs';
const autoUpdater = process.platform === 'win32' ? new WindowsUpdater() : platformUpdater;

// Main-process verification uses the same functions as doctor, without adding IPC.
export { bundledCommand, rendererRoot };

protocol.registerSchemesAsPrivileged([{ scheme: 'multiplane-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const { previous: oldData, directory: data, legacy: legacyData } = configureDesktopPaths(app);
const log = createLogger(data);
let win: BrowserWindow;
const primary = singleInstance(app, () => win);
const store = new JobStore(homeDirectory());
const prefs = new Preferences(app.getPath('userData'));
let hosted: Hosted;
let resumes: ResumeJobs;
let tray: Tray | undefined;
let popover: TrayPopover | undefined;
let trayBusy: boolean | undefined;
let tooltipAt = 0;
let tooltipTimer: ReturnType<typeof setTimeout> | undefined;
let quitting = false, quitReady = false, confirmingQuit = false;
let stopper: JobStopper;
let jobsReady = false;
let hostedReady = false;
let startup: Promise<void> = Promise.resolve();
const showWindow = (id?: string) => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); publish(id); };
function updateTray() {
  if (!tray) return;
  const progress = trayProgress(store.jobs);
  win.setProgressBar(progress.value);
  const busy = progress.count > 0;
  if (trayBusy !== busy) {
    trayBusy = busy;
    const file = process.platform === 'darwin' ? (busy ? 'trayBusyTemplate.png' : 'trayTemplate.png') : process.platform === 'win32' ? (busy ? 'tray-busy.ico' : 'app.ico') : (busy ? 'tray-busy-32.png' : 'tray.png');
    const image = nativeImage.createFromPath(path.join(__dirname, 'brand', file));
    if (process.platform === 'darwin') image.setTemplateImage(true);
    tray.setImage(image);
  }
  const remaining = 1000 - (Date.now() - tooltipAt);
  if (remaining <= 0) {
    tray.setToolTip(busy ? t('trTip', { n: progress.count, p: progress.percent }) : t('appName'));
    tooltipAt = Date.now();
  } else if (!tooltipTimer) tooltipTimer = setTimeout(() => { tooltipTimer = undefined; updateTray(); }, remaining);
  if (process.platform === 'linux') tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(store.jobs, showWindow, () => app.quit()) as Electron.MenuItemConstructorOptions[]));
}
function updateMenu() {
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate(applicationMenu()) : null);
}
const snapshot = (select?: string): Snapshot => ({ ready: jobsReady, hosted: hostedReady ? hosted.enabled : undefined, language: language(), languagePreference: prefs.value.language, jobs: (resumes?.decorate(store.jobs) ?? store.jobs).filter((j: Job) => !prefs.value.hidden.includes(j.jobId)), runningCount: store.jobs.filter((j: Job) => j.state === 'running').length, theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', select });
const publish = (select?: string) => { const value = snapshot(select); if (win && !win.isDestroyed()) win.webContents.send('snapshot', value); popover?.publish(value); };
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
  resumes = new ResumeJobs(store, root, { changed: (id?: string) => publish(id), report: error => log('resume', error) });
  handle('resume', (id: string) => { jobFor(id); return resumes.resume(id); });
  handle('resume-priority', (id: string) => { jobFor(id); resumes.prioritize(id); });
  hosted = new Hosted(store.home, version, { report: error => log('hosted', error), changed: () => { publish(); updateTray(); } });
  const image = nativeImage.createFromPath(path.join(__dirname, 'brand', process.platform === 'win32' ? 'app.ico' : process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (process.platform === 'darwin') image.setTemplateImage(true);
  tray = new Tray(image);
  if (process.platform !== 'linux') {
    popover = new TrayPopover({ tray, screen, snapshot, directory: __dirname, open: (id?: string, settings?: boolean) => {
      showWindow(id);
      if (settings) win.webContents.send('navigate', 'settings');
      else win.webContents.send('navigate', 'jobs');
    }, quit: () => app.quit() });
    tray.on('click', () => popover?.toggle());
    if (process.platform === 'win32') tray.on('right-click', () => popover?.toggle());
  }
  updateTray();
  win.on('close', event => {
    if (!hideOnClose(hosted.enabled, quitting)) {
      // Ask about a retained queue before destroying the only window.
      if (!quitting) { event.preventDefault(); app.quit(); }
      return;
    }
    event.preventDefault(); win.hide();
    if (!prefs.value.trayExplained) {
      void prefs.save({ trayExplained: true }).catch(error => log('preferences', error));
      if (Notification.isSupported()) new Notification({ title: t('appName'), body: t('background') }).show();
    }
  });
  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    if (confirmingQuit) return;
    confirmingQuit = true;
    void (async () => {
      await startup;
      await store.refresh();
      if (store.jobs.some((job: Job) => job.state === 'queued')) {
        // TODO(design): Review queue-exit and forced-file-location copy introduced by 046.
        const options: Electron.MessageBoxOptions = { type: 'question', message: t('quit'), detail: t('quitQueue'), buttons: [t('cancel'), t('quit')], defaultId: 0, cancelId: 0, noLink: true };
        const answer = await (win.isDestroyed() ? dialog.showMessageBox(options) : dialog.showMessageBox(win, options));
        if (answer.response !== 1) return;
      }
      quitting = true; resumes.close(); updates.close(); await hosted.close(); await installer.cancel(); await store.close();
      stopper?.close();
      if (tooltipTimer) clearTimeout(tooltipTimer); popover?.destroy(); tray?.destroy(); tray = undefined; quitReady = true; app.quit();
    })().catch(error => log('quit', error)).finally(() => { confirmingQuit = false; });
  });
  const skills = new Skills(root, { ...process.env, MULTIPLANE_AGENT_HOME: process.env.MULTIPLANE_TEST_USER_HOME || process.env.MULTIPLANE_AGENT_HOME || os.homedir() });
  let initialConfig: ReturnType<typeof config.read>;
  let firstSettings = true;
  const settings = async () => {
    const initial = firstSettings; firstSettings = false;
    return { ...await (initial ? initialConfig : config.read()), own: prefs.value, version, packaged: app.isPackaged };
  };
  const updates = new Updates({ platform: process.platform, packaged: app.isPackaged, version: app.getVersion(), updater: autoUpdater, installationDirectory: path.dirname(app.getPath('exe')), fetcher: (input, init) => net.fetch(input instanceof URL ? input.href : input, init), log, publish: (state: unknown) => { if (!win.isDestroyed()) win.webContents.send('updates:state', state); } });
  handle('updates:state', () => updates.state);
  handle('updates:check', () => updates.check());
  handle('updates:download', () => updates.download());
  handle('updates:cancel', () => updates.cancel());
  handle('updates:install', () => updates.install());
  handle('updates:release', () => shell.openExternal(updates.state.releaseUrl));
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
  handle('settings', settings);
  handle('check-ffmpeg', async () => checkFfmpeg(((await config.read()).values as Record<string, unknown>).ffmpeg));
  handle('save-setting', async (key, value, own) => {
    await startup; firstSettings = false;
    if (own) {
      if (!(key === 'language' ? languagePreferences.includes(value) : key === 'theme' ? ['system', 'light', 'dark'].includes(value) : ['notifications', 'wizardDone', 'autoCheckUpdates'].includes(key) && typeof value === 'boolean')) throw Error('Invalid preference');
      await prefs.save({ [key]: value }); if (key === 'language') { setLanguage(resolveLanguage(value, app.getLocale())); updateMenu(); win.setTitle(t('appName')); installer.refresh(); updateTray(); } nativeTheme.themeSource = prefs.value.theme as 'system' | 'light' | 'dark'; publish();
      if (key === 'wizardDone') log('wizard', JSON.stringify({ done: value, discovered: store.jobs.length, visible: snapshot().jobs.length }));
      if (key === 'autoCheckUpdates') updates.configureAutomatic(value);
    } else { const saved = await config.save(key, value); if (key === 'hosted') { await hosted.tick(); publish(); updateTray(); } return { ...await settings(), check: saved.check }; }
    return settings();
  });
  handle('choose-setting', async key => {
    await startup; firstSettings = false;
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
  stopper = new JobStopper(store, {
    changed: async () => { await startup; await hosted.tick(); }, report: error => log('stop', error),
    confirm: async (job: Job) => (await dialog.showMessageBox(win, { type: 'warning', message: t(job.state === 'queued' ? 'queueStopT' : 'stopTitle', { name: path.basename(job.shot) }), detail: t(job.state === 'queued' ? 'queueStopH' : 'stopDetail'), buttons: [t('cancel'), t('stop')], defaultId: 0, cancelId: 0, noLink: true })).response === 1,
    confirmForce: async (job: Job) => (await dialog.showMessageBox(win, { type: 'warning', message: t('forceT', { name: path.basename(job.shot) }), detail: t('forceH'), buttons: [t('keepWaiting'), t('force')], defaultId: 0, cancelId: 0, noLink: true })).response === 1,
  });
  handle('stop', async id => { jobFor(id); await stopper.stop(id); });
  handle('hide', async id => { jobFor(id); await prefs.save({ hidden: [...new Set([...prefs.value.hidden, id])] }); publish(); });
  handle('open', async (id, file, reveal) => {
    const job = jobFor(id);
    if (file !== undefined && (typeof file !== 'string' || !allowed(job).has(file))) throw Error('Invalid artifact');
    if (reveal) { shell.showItemInFolder(file ?? job.jobDir); return; }
    const error = await shell.openPath(file ?? job.jobDir); if (error) throw Error(error);
  });
  let previousSummary = '';
  store.on('change', () => {
    resumes.update();
    const summary = JSON.stringify({ discovered: store.jobs.length, visible: snapshot().jobs.length });
    if (summary !== previousSummary) { log('jobs-scan', summary); previousSummary = summary; }
    publish();
    updateTray();
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
  // Register IPC before loading. Shared-file migration still precedes both consumers.
  initialConfig = config.read();
  void initialConfig.catch(error => log('home-migration', error));
  const loaded = win.loadFile(path.join(__dirname, 'index.html'), { query: { theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', language: language() } });
  startup = (async () => {
    try { await initialConfig; } catch { /* The settings IPC reports the read failure. */ }
    await Promise.all([
      hosted.start().then(() => { hostedReady = true; publish(); }),
      store.start().then(() => { jobsReady = true; publish(); }),
    ]);
  })();
  void startup.catch(error => { log('startup-services', error); app.exit(1); });
  await loaded; win.show();
  updates.configureAutomatic(prefs.value.autoCheckUpdates);
}).catch(error => { log('startup', error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
