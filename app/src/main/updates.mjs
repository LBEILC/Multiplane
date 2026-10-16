import { validateReleaseNotes } from '../shared/release-notes.mjs';
export const releasePage = 'https://github.com/LBEILC/Multiplane/releases/latest';
const releaseApi = 'https://api.github.com/repos/LBEILC/Multiplane/releases/latest';
const day = 24 * 60 * 60 * 1000;
const stable = value => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export function newerVersion(next, current) {
  if (!stable(next)) return false;
  const a = next.split('.').map(BigInt), b = current.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
const releaseUrl = value => {
  try { const url = new URL(value); if (url.origin === 'https://github.com' && /^\/LBEILC\/Multiplane\/releases\/(?:tag\/[^/]+|latest)$/.test(url.pathname) && !url.username && !url.password) return url.href; } catch {}
  return releasePage;
};

// Electron is injected so every transition can be exercised without the network.
export class Updates {
  constructor({ platform, packaged, version, updater, installationDirectory, fetcher = fetch, publish = (_state) => {}, log = (_scope, _error) => {}, now = () => new Date().toISOString(), timers = { setInterval, clearInterval } }) {
    Object.assign(this, { updater, fetcher, publish, log, now, timers });
    this.state = { phase: packaged ? 'idle' : 'development', currentVersion: version, version: '', canInstall: packaged && platform === 'win32', checkedAt: '', publishedAt: '', notes: [], releaseUrl: releasePage, percent: 0, transferred: 0, total: 0, errorStage: '' };
    this.packaged = packaged;
    if (this.state.canInstall) {
      // Preserve updater diagnostics, including blockmap URLs, fallback errors and spawn arguments.
      updater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => {
        const message = args.map(value => value?.stack ?? String(value)).join(' ');
        this.log(`updates:${level}`, message);
        this.observeDownloadLog(message);
      }]));
      // Update the running installation even if the install registry has drifted.
      if (installationDirectory) updater.installDirectory = installationDirectory;
      updater.disableWebInstaller = true;
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      updater.setFeedURL({ provider: 'github', owner: 'LBEILC', repo: 'Multiplane', releaseType: 'release' });
      updater.on('download-progress', progress => {
        if (this.state.phase !== 'downloading' || this.cancelling) return;
        const number = value => Number.isFinite(value) ? Math.max(0, value) : 0;
        this.set({ percent: Math.min(100, number(progress.percent)), transferred: number(progress.transferred), total: number(progress.total) });
        this.log('updates:progress', JSON.stringify({ transferred: this.state.transferred, total: this.state.total, percent: this.state.percent }));
      });
      // check/download also reject; install can report failures only through this event.
      updater.on('error', error => { this.log('updates', error); if (this.installing) { this.installing = false; this.set({ phase: 'error', errorStage: 'install' }); } });
    }
  }
  observeDownloadLog(message) {
    if (this.state.phase !== 'downloading' || this.cancelling || this.closed) return;
    // electron-updater 6.8.9 reports differential fallback through its logger.
    const maps = /^Download block maps \(old: "([^"]+)", new: /.exec(message);
    if (maps) this.oldBlockmapUrl = maps[1];
    if (!message.startsWith('Cannot download differentially, fallback to full download:')) return;
    const missing = /Cannot download "([^"]+)", status 404\b/.exec(message);
    this.set({ fullDownloadReason: missing && missing[1] === this.oldBlockmapUrl ? 'old-blockmap-missing' : 'other' });
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.publish(this.state); return this.state; }
  configureAutomatic(enabled) {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = undefined;
    if (!enabled || !this.packaged || this.closed) return;
    void this.check();
    this.timer = this.timers.setInterval(() => { void this.check(); }, day);
    this.timer?.unref?.();
  }
  async check() {
    if (!this.packaged || this.closed || this.operation || ['downloading', 'downloaded'].includes(this.state.phase)) return this.state;
    this.operation = 'check';
    this.oldBlockmapUrl = undefined;
    this.set({ phase: 'checking', errorStage: '', fullDownloadReason: '' });
    try {
      let info, allowed = true;
      if (this.state.canInstall) {
        const result = await this.updater.checkForUpdates();
        if (!result?.updateInfo) throw Error('Missing update information');
        allowed = result.isUpdateAvailable === true;
        this.token = result.cancellationToken;
        info = { version: result.updateInfo.version, publishedAt: result.updateInfo.releaseDate ?? '', releaseUrl: `https://github.com/LBEILC/Multiplane/releases/tag/v${result.updateInfo.version}` };
      } else {
        this.abort = new AbortController();
        const response = await this.fetcher(releaseApi, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Multiplane' }, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]) });
        if (!response.ok) throw Error(`Release request failed: ${response.status}`);
        const release = await response.json();
        if (release.draft || release.prerelease) throw Error('Expected a stable release');
        info = { version: String(release.tag_name ?? '').replace(/^v/, ''), publishedAt: release.published_at ?? '', releaseUrl: releaseUrl(release.html_url) };
      }
      if (!stable(info.version)) throw Error('Invalid stable version');
      if (this.closed) return this.state;
      const available = allowed && newerVersion(info.version, this.state.currentVersion);
      const notes = available ? await this.loadNotes(info.version) : [];
      if (this.closed) return this.state;
      this.set({ ...info, notes, checkedAt: this.now(), phase: available ? this.state.canInstall ? 'available' : 'manual' : 'current', percent: 0, transferred: 0, total: 0 });
    } catch (error) { this.log('updates', error); if (!this.closed) this.set({ phase: 'error', errorStage: 'check' }); }
    finally { this.operation = undefined; this.abort = undefined; }
    return this.state;
  }
  async loadNotes(target) {
    this.abort ??= new AbortController();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]);
    const request = async url => {
      const response = await this.fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Multiplane' }, signal });
      if (!response.ok) throw Error(`Release notes request failed: ${response.status}`);
      return response.json();
    };
    try {
      const releases = new Map();
      // Both update paths use the same paginated public inventory.
      for (let page = 1; ; page++) {
        const batch = await request(`https://api.github.com/repos/LBEILC/Multiplane/releases?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw Error('Invalid release inventory');
        for (const release of batch) {
          const version = String(release.tag_name ?? '').replace(/^v/, '');
          if (!release.draft && !release.prerelease && stable(version) && newerVersion(version, this.state.currentVersion) && !newerVersion(version, target)) releases.set(version, release);
        }
        if (batch.length < 100) break;
        if (page === 20) throw Error('Release inventory exceeds page limit');
      }
      const versions = [...releases.keys()].sort((a, b) => newerVersion(a, b) ? -1 : newerVersion(b, a) ? 1 : 0).slice(0, 5);
      const notes = await Promise.all(versions.map(async version => {
        try {
          const asset = releases.get(version).assets?.find(asset => asset.name === 'release-notes.json');
          if (!asset) return null;
          const url = new URL(asset.browser_download_url);
          if (url.origin !== 'https://github.com' || url.username || url.password || !url.pathname.startsWith('/LBEILC/Multiplane/releases/download/')) throw Error('Invalid release notes asset URL');
          return validateReleaseNotes(await request(url.href), { version, log: message => this.log('updates:notes', `${version}: ${message}`) }).notes;
        } catch (error) { this.log('updates:notes', error); return null; }
      }));
      // Never present an older document as the target release.
      return notes[0]?.version === target ? notes.filter(Boolean) : [];
    } catch (error) { this.log('updates:notes', error); return []; }
  }
  async download() {
    if (!this.state.canInstall || this.closed || this.operation || this.state.phase !== 'available') return this.state;
    // A cancelled token cannot be reused. Recheck before the next explicit download.
    if (!this.token || this.token.cancelled) await this.check();
    if (this.state.phase !== 'available' || this.operation || this.closed || !this.token) return this.state;
    this.operation = 'download'; this.cancelling = false;
    this.oldBlockmapUrl = undefined;
    this.set({ phase: 'downloading', percent: 0, transferred: 0, total: 0, errorStage: '', fullDownloadReason: '' });
    try {
      await this.updater.downloadUpdate(this.token);
      if (!this.cancelling && !this.closed) this.set({ phase: 'downloaded', percent: 100 });
    } catch (error) {
      if (!this.cancelling && !this.closed) { this.log('updates', error); this.set({ phase: 'error', errorStage: 'download' }); }
    } finally {
      this.operation = undefined;
      if (this.cancelling && !this.closed) this.set({ phase: 'available', percent: 0, transferred: 0, total: 0, fullDownloadReason: '' });
      this.cancelling = false;
    }
    return this.state;
  }
  cancel() {
    if (this.operation === 'download') { this.cancelling = true; this.token?.cancel(); }
    return this.state;
  }
  install() {
    if (!this.state.canInstall || this.closed || this.operation || this.installing || this.state.phase !== 'downloaded') return;
    this.installing = true;
    try { this.updater.quitAndInstall(false, true); }
    catch (error) { this.installing = false; this.log('updates', error); this.set({ phase: 'error', errorStage: 'install' }); }
  }
  close() { this.closed = true; this.timers.clearInterval(this.timer); this.abort?.abort(); this.token?.cancel(); }
}
