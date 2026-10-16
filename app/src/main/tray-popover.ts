import { BrowserWindow, ipcMain, type Tray, type Screen } from 'electron';
import path from 'node:path';
import { trayPosition } from './tray.mjs';
import type { Snapshot } from '../shared/types';

export class TrayPopover {
  readonly window: BrowserWindow;
  private height = 160;
  private closing: ReturnType<typeof setTimeout> | undefined;
  private blurredAt = -Infinity;
  private ready: Promise<void>;
  constructor(private options: { tray: Tray; screen: Screen; directory: string; snapshot: () => Snapshot; open: (id?: string, settings?: boolean) => void; quit: () => void }) {
    this.window = new BrowserWindow({ width: 300, height: this.height, show: false, frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: true, webPreferences: { preload: path.join(options.directory, 'tray-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.window.on('blur', () => { this.blurredAt = Date.now(); this.hide(); });
    this.window.webContents.on('before-input-event', (event, input) => { if (input.key === 'Escape') { event.preventDefault(); this.hide(); } });
    ipcMain.handle('tray:snapshot', event => { this.authorize(event); return options.snapshot(); });
    ipcMain.on('tray:height', (event, height) => {
      this.authorize(event);
      if (typeof height !== 'number' || !Number.isFinite(height)) return;
      this.height = Math.max(100, Math.min(480, Math.ceil(height)));
      this.position();
    });
    ipcMain.on('tray:action', (event, action, id) => {
      this.authorize(event);
      if (!['open', 'settings', 'quit', 'close'].includes(action)) return;
      if (id !== undefined && (typeof id !== 'string' || !options.snapshot().jobs.some(j => j.jobId === id))) return;
      this.hide();
      if (action === 'open' || action === 'settings') options.open(id, action === 'settings');
      if (action === 'quit') options.quit();
    });
    this.ready = this.window.loadFile(path.join(options.directory, 'tray.html'));
  }
  private authorize(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
    if (event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) throw Error('Invalid tray sender');
  }
  private position() {
    const cursor = this.options.screen.getCursorScreenPoint();
    let icon: Electron.Rectangle | undefined;
    try { icon = this.options.tray.getBounds(); } catch { /* Overflow trays may not expose bounds. */ }
    const display = icon && icon.width > 0 && icon.height > 0 ? this.options.screen.getDisplayMatching(icon) : this.options.screen.getDisplayNearestPoint(cursor);
    const { edge, ...bounds } = trayPosition(icon, cursor, display, { width: 300, height: this.height });
    this.window.setBounds(bounds);
    return edge;
  }
  async toggle() {
    // Clicking the tray can blur the window before Electron delivers the click.
    if (this.window.isVisible() || Date.now() - this.blurredAt < 250) { this.hide(); return; }
    await this.ready;
    if (this.closing) { clearTimeout(this.closing); this.closing = undefined; }
    this.publish(this.options.snapshot());
    const edge = this.position();
    this.window.show(); this.window.focus();
    this.window.webContents.send('tray:visibility', { visible: true, edge });
  }
  hide() {
    if (!this.window.isVisible() || this.closing) return;
    this.window.webContents.send('tray:visibility', { visible: false });
    this.closing = setTimeout(() => { this.closing = undefined; if (!this.window.isDestroyed()) this.window.hide(); }, 120);
  }
  publish(value: Snapshot) { if (!this.window.isDestroyed()) this.window.webContents.send('tray:snapshot', value); }
  destroy() {
    if (this.closing) clearTimeout(this.closing);
    ipcMain.removeHandler('tray:snapshot'); ipcMain.removeAllListeners('tray:height'); ipcMain.removeAllListeners('tray:action');
    this.window.destroy();
  }
}
