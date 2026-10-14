import { EventEmitter } from 'node:events';
export class FakeUpdater extends EventEmitter {
  checks = 0; downloads = 0; installs = 0;
  version = '0.3.1';
  setFeedURL(value) { this.feed = value; }
  async checkForUpdates() {
    this.checks++;
    if (this.checkError) throw Error('offline');
    if (this.waitCheck) await this.waitCheck;
    const token = { cancelled: false, cancel: () => { token.cancelled = true; this.rejectDownload?.(Error('cancelled')); } };
    return { isUpdateAvailable: this.available !== false, updateInfo: { version: this.version, releaseNotes: '<img src=x onerror=alert(1)>', releaseDate: '2026-10-01T00:00:00Z' }, cancellationToken: token };
  }
  downloadUpdate(token) {
    this.downloads++; this.token = token;
    return new Promise((resolve, reject) => { this.resolveDownload = resolve; this.rejectDownload = reject; });
  }
  quitAndInstall(...args) { this.installs++; this.installArgs = args; if (this.installError) this.emit('error', Error('install failed')); }
}
