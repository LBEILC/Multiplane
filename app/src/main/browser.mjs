import { t } from '../shared/i18n.mjs';
import path from 'node:path';
import os from 'node:os';
import { userError } from '../shared/errors.mjs';
import { spawn } from 'node:child_process';

export class BrowserInstaller {
  child = null;
  rawState = { running: false, text: '' };
  statusKey = '';
  statusValues = {};
  get state() {
    const values = this.statusKey === 'installError' ? { ...this.statusValues, error: userError(this.statusValues.error) } : this.statusValues;
    const status = this.statusKey ? t(this.statusKey, values) : '';
    return { running: this.rawState.running, text: [status, this.rawState.text].filter(Boolean).join('\n') };
  }
  constructor(root, notify, worker, launch = spawn) { this.root = root; this.notify = notify; this.worker = worker; this.launch = launch; }
  refresh() { this.notify(this.state); }
  publish(patch) { this.rawState = { ...this.rawState, ...patch }; this.refresh(); }
  start() {
    if (this.child) return false;
    // Deliberately use Playwright's default shared cache, never an app-private cache.
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CI: '1' };
    delete env.PLAYWRIGHT_BROWSERS_PATH;
    delete env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    this.cancelled = false;
    this.statusKey = 'browserConnecting'; this.statusValues = {};
    this.publish({ running: true, text: '' });
    // Keep certificate checks enabled; scope the Electron/BoringSSL compatibility setting to downloads.
    const tls = process.platform === 'win32' ? ['--tls-max-v1.2'] : [];
    const child = this.child = this.launch(process.execPath, [...tls, this.worker, path.join(this.root, 'node_modules/playwright/cli.js'), 'install', 'chromium'], { cwd: os.tmpdir(), env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const output = bytes => this.publish({ text: (this.rawState.text + '\n' + bytes.toString().replace(/\x1b\[[0-9;]*m/g, '')).slice(-6000) });
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('error', error => { this.child = null; this.statusKey = 'installError'; this.statusValues = { error: userError(error) }; this.publish({ running: false }); });
    child.once('close', code => { this.child = null; this.statusKey = this.cancelled ? 'installCancelled' : code === 0 ? 'browserInstalled' : 'installExitError'; this.statusValues = { code, output: this.cancelled || code === 0 ? '' : this.rawState.text }; this.publish({ running: false, text: '' }); });
    return true;
  }
  async cancel() {
    if (!this.child) return;
    this.cancelled = true;
    const child = this.child;
    // A normal exit runs Playwright's lock cleanup; its downloader exits on IPC disconnect.
    await new Promise(resolve => {
      const fallback = () => {
        if (process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
          return;
        }
        const killer = this.launch('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
      };
      const timer = setTimeout(fallback, 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      try { child.send({ action: 'cancel' }, error => { if (error) { clearTimeout(timer); fallback(); } }); }
      catch { clearTimeout(timer); fallback(); }
    });
  }
}
