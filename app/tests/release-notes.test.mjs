import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseNotes } from '../src/shared/release-notes.mjs';
import { Updates } from '../src/main/updates.mjs';
import { FakeUpdater } from './updates-fake.mjs';
import { note, release, notesFetcher } from './release-notes-fake.mjs';

test('both update paths select the same stable notes and tolerate missing attachments', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) for (const [inventory, expected] of [
    [[release('0.3.1')], ['0.3.1']],
    [[release('0.3.3'), release('0.3.2', false), release('0.3.1')], ['0.3.3', '0.3.1']],
    [[release('0.3.3', false), release('0.3.2'), release('0.3.1')], []]
  ]) {
    const updater = new FakeUpdater(); updater.version = inventory[0].tag_name.slice(1);
    const u = new Updates({ platform, packaged: true, version: '0.3.0', updater, fetcher: notesFetcher(inventory) });
    await u.check();
    assert.equal(u.state.phase, platform === 'win32' ? 'available' : 'manual');
    assert.deepEqual(u.state.notes.map(n => n.version), expected);
    assert.equal(u.state.releaseUrl, inventory[0].html_url);
    u.close();
  }
});

test('pagination, version ordering, stable filter and five-version cap', async () => {
  const updater = new FakeUpdater(); updater.version = '0.3.10';
  const inventory = Array.from({ length: 10 }, (_, i) => release(`0.3.${i + 1}`));
  const calls = [];
  const fetcher = notesFetcher(inventory);
  const u = new Updates({ platform: 'win32', packaged: true, version: '0.3.0', updater, fetcher: async (url, options) => {
    calls.push(url);
    if (url.endsWith('page=1')) return { ok: true, json: async () => Array.from({ length: 100 }, () => ({ ...release('0.4.0'), prerelease: true })) };
    return fetcher(url, options);
  } });
  await u.check();
  assert.deepEqual(u.state.notes.map(n => n.version), ['0.3.10', '0.3.9', '0.3.8', '0.3.7', '0.3.6']);
  assert.equal(calls.filter(url => url.includes('/download/')).length, 5);
  u.close();
});

test('invalid documents and entries are logged; unknown icons fall back; text remains literal', () => {
  for (const patch of [{ schema: 'other' }, { date: '2026-02-30' }, { version: '0.3.2' }, { items: null }]) {
    const logs = []; assert.equal(validateReleaseNotes({ ...note('0.3.1'), ...patch }, { version: '0.3.1', log: m => logs.push(m) }).notes, null); assert.ok(logs.length);
  }
  for (const patch of [{ title: undefined }, { detail: {} }, { kind: 'bad' }, { area: 'bad' }, { highlight: 'true' }]) {
    const doc = note('0.3.1'); doc.items = [{ ...doc.items[0], ...patch }];
    const result = validateReleaseNotes(doc); assert.equal(result.notes.items.length, 0); assert.ok(result.errors.length);
  }
  const doc = note('0.3.1'); doc.items[0].icon = 'evil" onclick="alert(1)'; doc.items[0].title.en = '<img src=x onerror=alert(1)>';
  let result = validateReleaseNotes(doc); assert.equal(result.notes.items[0].icon, undefined); assert.equal(result.notes.items[0].title.en, doc.items[0].title.en); assert.ok(result.errors.length);
  delete doc.items[0].title.en;
  assert.equal(validateReleaseNotes(doc).notes.items.length, 4);
  assert.equal(validateReleaseNotes(doc, { bilingual: true }).notes.items.length, 3);
  doc.items.forEach(i => i.highlight = true);
  assert.equal(validateReleaseNotes(doc).notes.items.filter(i => i.highlight).length, 2);
});

test('notes network/JSON failures do not block update installation', async () => {
  for (const fetcher of [async () => { throw Error('offline'); }, async () => ({ ok: true, json: async () => { throw Error('invalid JSON'); } })]) {
    const logs = [], updater = new FakeUpdater();
    const u = new Updates({ platform: 'win32', packaged: true, version: '0.3.0', updater, fetcher, log: (...args) => logs.push(args) });
    await u.check(); assert.equal(u.state.phase, 'available'); assert.deepEqual(u.state.notes, []); assert.ok(logs.length);
    const pending = u.download(); updater.resolveDownload([]); await pending; u.install(); assert.equal(updater.installs, 1); u.close();
  }
});
