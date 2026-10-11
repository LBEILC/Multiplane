import path from 'node:path';
import { userError } from '../shared/errors.mjs';
import { spawn } from 'node:child_process';

export class BrowserInstaller {
  child = null;
  state = { running: false, text: '' };
  constructor(root, notify, worker, launch = spawn) { this.root = root; this.notify = notify; this.worker = worker; this.launch = launch; }
  publish(patch) { this.state = { ...this.state, ...patch }; this.notify(this.state); }
  start() {
    if (this.child) return false;
    // Deliberately use Playwright's default shared cache, never an app-private cache.
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CI: '1' };
    delete env.PLAYWRIGHT_BROWSERS_PATH;
    delete env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    this.cancelled = false;
    this.publish({ running: true, text: '正在连接 Playwright 下载服务…' });
    // Keep certificate checks enabled; scope the Electron/BoringSSL compatibility setting to downloads.
    const tls = process.platform === 'win32' ? ['--tls-max-v1.2'] : [];
    const child = this.child = this.launch(process.execPath, [...tls, this.worker, path.join(this.root, 'node_modules/playwright/cli.js'), 'install', 'chromium'], { cwd: this.root, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const output = bytes => this.publish({ text: (this.state.text + '\n' + bytes.toString().replace(/\x1b\[[0-9;]*m/g, '')).slice(-6000) });
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('error', error => { this.child = null; this.publish({ running: false, text: `安装失败：${userError(error)}` }); });
    child.once('close', code => { this.child = null; this.publish({ running: false, text: this.cancelled ? '已取消安装' : code === 0 ? '浏览器安装完成' : `安装失败（${code}）\n${this.state.text}` }); });
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
