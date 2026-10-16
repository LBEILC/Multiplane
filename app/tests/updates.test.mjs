import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeUpdater, reportFallback } from './updates-fake.mjs';
import { Updates, newerVersion, releasePage } from '../src/main/updates.mjs';
import { Preferences } from '../src/main/store.mjs';
import { createTempDirectory } from './helpers.mjs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const make = (extra = {}) => new Updates({ platform: 'win32', packaged: true, version: '0.3.0', updater: new FakeUpdater(), fetcher: async () => ({ ok: true, json: async () => [] }), ...extra });

test('updater diagnostics and actual transferred bytes reach the persistent logger', async () => {
  const rows = [], u = make({ log: (scope, message) => rows.push({ scope, message }) });
  const f = u.updater;
  f.logger.info('Download block maps (old: "https://example.invalid/v0.3.0/setup.blockmap")');
  f.logger.debug('download range: bytes=0-99');
  f.logger.warn('Cache miss');
  f.logger.error(Error('Cannot download differentially, fallback to full download'));
  await u.check(); const pending = u.download();
  f.emit('download-progress', { percent: 50, transferred: 300000, total: 600000 });
  assert.equal(u.state.total, 600000);
  assert.equal(u.state.transferred, 300000);
  f.emit('download-progress', { percent: 100, transferred: 600000, total: 600000 });
  f.resolveDownload([]); await pending;
  f.logger.info('Executing: setup.exe with args: --updated,--force-run');
  assert.ok(rows.some(row => row.scope === 'updates:info' && row.message.includes('v0.3.0')));
  assert.ok(rows.some(row => row.scope === 'updates:error' && row.message.includes('fallback to full download')));
  assert.ok(rows.some(row => row.scope === 'updates:info' && row.message.includes('--force-run')));
  assert.deepEqual(JSON.parse(rows.filter(row => row.scope === 'updates:progress').at(-1).message), { transferred: 600000, total: 600000, percent: 100 });
});

test('Windows updates explicitly target the running installation directory', () => {
  const installationDirectory = 'D:\\Custom Programs\\Multiplane';
  const u = make({ installationDirectory });
  assert.equal(u.updater.installDirectory, installationDirectory);
  for (const extra of [{ packaged: false }, { platform: 'darwin' }]) {
    assert.equal(make({ installationDirectory, ...extra }).updater.installDirectory, undefined);
  }
});

test('Windows explicit download, progress, cancel/retry, install and no background install', async () => {
  const updates = make(), fake = updates.updater, phases = [];
  updates.publish = state => phases.push(state.phase);
  assert.equal(fake.disableWebInstaller, true); assert.equal(fake.autoDownload, false); assert.equal(fake.autoInstallOnAppQuit, false); assert.equal(fake.allowPrerelease, false); assert.equal(fake.allowDowngrade, false);
  assert.equal(fake.feed.repo, 'Multiplane');
  updates.install(); await updates.download(); assert.equal(fake.installs + fake.downloads, 0);
  await updates.check(); assert.equal(updates.state.phase, 'available'); assert.equal(fake.downloads, 0);
  const download = updates.download(); await updates.download(); await updates.check(); assert.equal(fake.downloads, 1); assert.equal(fake.checks, 1);
  fake.emit('download-progress', { percent: 35, transferred: 35, total: 100 }); assert.equal(updates.state.percent, 35);
  updates.cancel(); fake.emit('download-progress', { percent: 90 }); await download;
  assert.equal(updates.state.phase, 'available'); assert.equal(updates.state.percent, 0);
  const retry = updates.download(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fake.checks, 2); assert.equal(fake.token.cancelled, false);
  fake.resolveDownload([]); await retry; assert.equal(updates.state.phase, 'downloaded');
  await updates.check(); assert.equal(updates.state.phase, 'downloaded'); assert.equal(fake.checks, 2);
  updates.install(); updates.install(); assert.equal(fake.installs, 1); assert.deepEqual(fake.installArgs, [false, true]);
  updates.close(); assert.ok(phases.includes('checking')); assert.ok(phases.includes('downloading'));
});

test('check, download and installation failures are recoverable and late events are ignored', async () => {
  const u = make(), f = u.updater;
  f.checkError = true; await u.check(); assert.equal(u.state.errorStage, 'check');
  f.checkError = false; await u.check(); const pending = u.download(); f.rejectDownload(Error('offline')); await pending; assert.equal(u.state.errorStage, 'download');
  f.emit('download-progress', { percent: 50 }); assert.equal(u.state.phase, 'error');
  await u.check(); const retry = u.download(); f.resolveDownload([]); await retry;
  f.installError = true; u.install(); assert.equal(u.state.errorStage, 'install'); assert.equal(u.state.phase, 'error');
  await u.check(); assert.equal(u.state.phase, 'available');
});

test('updater eligibility is respected and closed checks cannot publish late results', async () => {
  const u = make(); u.updater.available = false;
  await u.check(); assert.equal(u.state.phase, 'current'); await u.download(); assert.equal(u.updater.downloads, 0);
  let finish; u.updater.waitCheck = new Promise(resolve => { finish = resolve; });
  const pending = u.check(); u.close(); let events = 0; u.publish = () => events++;
  finish(); await pending; assert.equal(events, 0);
});

test('automatic startup/daily checks honor preferences, development and active operations', async () => {
  let tick, interval, clears = 0;
  const u = make({ timers: { setInterval(fn, ms) { tick = fn; interval = ms; return 1; }, clearInterval() { clears++; } } });
  u.configureAutomatic(false); assert.equal(u.updater.checks, 0);
  u.configureAutomatic(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(u.updater.checks, 1); assert.equal(interval, 86400000);
  tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(u.updater.checks, 2);
  u.configureAutomatic(false); assert.ok(clears); await u.check(); assert.equal(u.updater.checks, 3);
  u.close(); await u.check(); assert.equal(u.updater.checks, 3);
  for (const platform of ['win32', 'darwin', 'linux']) {
    const dev = make({ platform, packaged: false, fetcher() { throw Error('must not fetch'); } });
    dev.configureAutomatic(true); await dev.check(); await dev.download(); dev.install();
    assert.equal(dev.state.phase, 'development'); assert.equal(dev.updater.checks, 0);
  }
});

test('macOS/Linux use stable Release metadata only and cannot download/install', async () => {
  for (const platform of ['darwin', 'linux']) {
    let release = { tag_name: 'v0.3.1', body: 'Notes', html_url: 'https://untrusted.invalid/file', published_at: '2026-10-01' };
    const u = make({ platform, fetcher: async (url, options) => { assert.ok(options.signal); if (url.includes('?per_page=')) return { ok: true, json: async () => [] }; assert.match(url, /LBEILC\/Multiplane\/releases\/latest$/); return { ok: true, json: async () => release }; } });
    await u.check(); assert.equal(u.state.phase, 'manual'); assert.equal(u.state.releaseUrl, releasePage);
    await u.download(); u.install(); assert.equal(u.updater.downloads + u.updater.installs + u.updater.checks, 0);
    release = { ...release, tag_name: 'v0.3.0' }; await u.check(); assert.equal(u.state.phase, 'current');
    release.prerelease = true; await u.check(); assert.equal(u.state.phase, 'error');
  }
  assert.equal(newerVersion('0.3.1-beta.1', '0.3.0'), false);
  assert.equal(newerVersion('0.10.0', '0.9.0'), true);
  assert.equal(newerVersion('0.2.9', '0.3.0'), false);
});

test('auto-check preference migrates to true and persists false independently of renderer config', async t => {
  const dir = createTempDirectory('updates-prefs-'); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'preferences.json'), JSON.stringify({ theme: 'dark' }));
  const prefs = new Preferences(dir); await prefs.load(); assert.equal(prefs.value.autoCheckUpdates, true);
  await prefs.save({ autoCheckUpdates: false }); const next = new Preferences(dir); await next.load(); assert.equal(next.value.autoCheckUpdates, false); assert.equal(next.value.theme, 'dark');
});

test('full download reasons follow fallback diagnostics and reset on cancellation/retry', async () => {
  for (const [failure, reason] of [['old-404', 'old-blockmap-missing'], ['other', 'other'], ['new-404', 'other']]) {
    const published = [], u = make({ publish: state => published.push(state) }), f = u.updater;
    reportFallback(f, failure);
    assert.equal(u.state.fullDownloadReason, undefined);
    await u.check(); const pending = u.download();
    f.emit('download-progress', { percent: 40, total: 134400000, transferred: 53760000 });
    assert.equal(u.state.fullDownloadReason, '');
    reportFallback(f, failure);
    assert.equal(u.state.fullDownloadReason, reason);
    assert.equal(published.at(-1).fullDownloadReason, reason);
    u.cancel(); reportFallback(f); await pending;
    assert.equal(u.state.fullDownloadReason, '');
    const retry = u.download(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(u.state.fullDownloadReason, '');
    f.resolveDownload([]); await retry;
    assert.equal(u.state.phase, 'downloaded');
    assert.equal(u.state.fullDownloadReason, '');
    u.close(); reportFallback(f);
    assert.equal(u.state.fullDownloadReason, '');
  }
});
