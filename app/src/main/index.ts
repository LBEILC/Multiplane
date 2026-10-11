import { app, BrowserWindow, ipcMain, nativeTheme, Notification, shell, dialog, protocol, net, clipboard, Menu } from 'electron';
import { userError } from '../shared/errors.mjs';
import path from 'node:path';
import os from 'node:os';
import { readFile, mkdir } from 'node:fs/promises';
import { Configuration, Skills, rendererRoot, bundledCommand, parseDoctor, readEnvironment } from './settings.mjs';
import { pathToFileURL } from 'node:url';
import { JobStore, Preferences, homeDirectory } from './store.mjs';
import type { Job, Snapshot } from '../shared/types';
import { BrowserInstaller } from './browser.mjs';

// Main-process verification uses the same functions as doctor, without adding IPC.
export { bundledCommand, rendererRoot };

protocol.registerSchemesAsPrivileged([{ scheme: 'multiplane-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
if (process.env.MULTIPLANE_APP_DATA) app.setPath('userData', path.resolve(process.env.MULTIPLANE_APP_DATA));
let win: BrowserWindow;
const store = new JobStore(homeDirectory());
const prefs = new Preferences(app.getPath('userData'));
const snapshot = (select?: string): Snapshot => ({ jobs: store.jobs.filter((j: Job) => !prefs.value.hidden.includes(j.jobId)), runningCount: store.jobs.filter((j: Job) => j.state === 'running').length, theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', select });
const publish = (select?: string) => { if (win && !win.isDestroyed()) win.webContents.send('snapshot', snapshot(select)); };
function allowed(job: Job) {
  const files = new Set<string>([path.join(job.jobDir, 'preview.png')]);
  for (const a of [...(job.result?.artifacts ?? []), ...job.events.filter(e => e.type === 'artifact')]) if (typeof a.path === 'string' && path.isAbsolute(a.path)) files.add(a.path);
  for (const e of job.events.filter(e => e.type === 'finding')) for (const f of Object.values(e.details?.images ?? {})) if (typeof f === 'string' && path.isAbsolute(f)) files.add(f);
  return files;
}
app.whenReady().then(async () => {
  await prefs.load(); nativeTheme.themeSource = prefs.value.theme as 'system' | 'light' | 'dark';
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  const colours = () => nativeTheme.shouldUseDarkColors ? { color: '#151515', symbolColor: '#a8a7a2', height: 44 } : { color: '#fcfcfb', symbolColor: '#64635e', height: 44 };
  win = new BrowserWindow({ width: 1160, height: 720, minWidth: 960, minHeight: 600, show: false, icon: path.join(__dirname, 'brand', process.platform === 'win32' ? 'app.ico' : process.platform === 'darwin' ? 'app.icns' : 'app-512.png'), title: 'Multiplane', autoHideMenuBar: process.platform !== 'darwin', titleBarStyle: 'hidden', ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 15 } } : { titleBarOverlay: colours() }), backgroundColor: colours().color, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
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
    catch (error) { throw Error(userError(error)); }
  });
  handle('platform', () => ({ platform: process.platform, home: os.homedir() }));
  const jobFor = (id: unknown): Job => { if (typeof id !== 'string') throw Error('Invalid job'); return store.job(id); };
  const root = rendererRoot(app.isPackaged, process.resourcesPath, app.getAppPath());
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const config = new Configuration(homeDirectory());
  const skills = new Skills(path.join(root, 'skills', 'multiplane'), version, { user: process.env.MULTIPLANE_TEST_USER_HOME || os.homedir() });
  const settings = async () => ({ ...await config.read(), own: prefs.value, version, packaged: app.isPackaged });
  const installer = new BrowserInstaller(root, (state: unknown) => { if (!win.isDestroyed()) win.webContents.send('browser-install-state', state); }, path.join(__dirname, 'browser-worker.cjs'));
  handle('browser-install-state', () => installer.state);
  let confirmingBrowser = false;
  handle('install-browser', async () => {
    if (installer.state.running || confirmingBrowser) return;
    confirmingBrowser = true;
    try {
      const answer = await dialog.showMessageBox(win, { type: 'question', message: '安装 Chromium 浏览器？', detail: '将从 Playwright 的官方下载服务下载 Chromium，安装到 Playwright 的默认缓存目录（命令行渲染也用它），约占 300–500 MB 磁盘空间。', buttons: ['取消', '下载并安装'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response === 1) installer.start();
    } finally { confirmingBrowser = false; }
  });
  handle('cancel-browser-install', () => installer.cancel());
  app.on('before-quit', event => { if (installer.child) { event.preventDefault(); void installer.cancel().then(() => app.quit()); } });
  handle('settings', settings);
  handle('save-setting', async (key, value, own) => {
    if (own) {
      if (!(key === 'theme' ? ['system', 'light', 'dark'].includes(value) : ['notifications', 'wizardDone'].includes(key) && typeof value === 'boolean')) throw Error('Invalid preference');
      await prefs.save({ [key]: value }); nativeTheme.themeSource = prefs.value.theme as 'system' | 'light' | 'dark'; publish();
    } else await config.save(key, value);
    return settings();
  });
  handle('choose-setting', async key => {
    if (!['ffmpeg', 'jobsDir'].includes(key)) throw Error('Invalid setting');
    const result = await dialog.showOpenDialog(win, { properties: key === 'jobsDir' ? ['openDirectory'] : ['openFile'] });
    if (!result.canceled && result.filePaths[0]) await config.save(key, result.filePaths[0]);
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
  handle('environment', () => readEnvironment(skills));
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
    const backupName = await skills.backupName(host);
    if (status.state === 'modified' || action === 'remove') {
      if (pendingConfirmation) return { cancelled: true };
      const agent = host === 'claude' ? 'Claude Code' : 'Codex', remove = action === 'remove';
      const accepted = await new Promise<boolean>(resolve => {
        const id = ++confirmationId; pendingConfirmation = { id, resolve };
        win.webContents.send('skill-confirmation', { id, title: remove ? `移除 ${agent} 的 Multiplane skill？` : `替换 ${agent} 里改过的 Multiplane skill？`, detail: remove ? status.state === 'modified' ? `你改过这个 skill，原来的目录会先备份为 ${backupName}。` : `${agent} 之后将不再加载这个 skill。` : `原来的目录会先备份为 ${backupName}，再装入软件自带的版本 ${version}。`, action: remove ? '移除' : '替换', danger: remove });
      });
      if (!accepted) return { cancelled: true };
    }
    return skills.change(host, action, status.signature, backupName);
  });
  handle('copy-browser-command', () => clipboard.writeText('npx playwright install chromium'));
  handle('snapshot', () => snapshot());
  handle('stop', async id => {
    const job = jobFor(id); if (job.state !== 'running') return;
    const result = await dialog.showMessageBox(win, { type: 'warning', message: `停止「${path.basename(job.shot)}」？`, detail: '渲染会立刻结束，已完成的产物会保留，未完成的不会写出。', buttons: ['取消', '停止'], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response === 1) await store.stop(job.jobId);
  });
  handle('hide', async id => { jobFor(id); await prefs.save({ hidden: [...new Set([...prefs.value.hidden, id])] }); publish(); });
  handle('open', async (id, file, reveal) => {
    const job = jobFor(id);
    if (file !== undefined && (typeof file !== 'string' || !allowed(job).has(file))) throw Error('Invalid artifact');
    if (reveal) { shell.showItemInFolder(file ?? job.jobDir); return; }
    const error = await shell.openPath(file ?? job.jobDir); if (error) throw Error(error);
  });
  store.on('change', () => publish());
  store.on('fault', error => console.error(error.message));
  store.on('finished', (job: Job) => {
    if (!prefs.value.notifications || !Notification.isSupported()) return;
    const label = job.state === 'succeeded' ? '已完成' : job.state === 'cancelled' ? '已取消' : '失败';
    const notification = new Notification({ title: `${label}：${path.basename(job.shot)}`, body: path.basename(path.dirname(job.shot)) });
    notification.on('click', async () => {
      if (prefs.value.hidden.includes(job.jobId)) await prefs.save({ hidden: prefs.value.hidden.filter((id: string) => id !== job.jobId) });
      if (win.isMinimized()) win.restore(); win.show(); win.focus(); publish(job.jobId);
    });
    notification.show();
  });
  await store.start();
  await win.loadFile(path.join(__dirname, 'index.html')); win.show();
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { void store.close(); });
