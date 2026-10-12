import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import zh from '../src/shared/copy/zh-CN.mjs';
import en from '../src/shared/copy/en.mjs';
import { resolveLanguage, setLanguage, language, t, number, formatDuration, runningCount, pixels, onLanguageChange } from '../src/shared/i18n.mjs';
import { Preferences } from '../src/main/store.mjs';
import { userError } from '../src/shared/errors.mjs';
import { createTempDirectory } from './helpers.mjs';
import { applicationMenu } from '../src/main/menu.ts';

test('copy has identical keys and placeholders, no unused entries, and source has no Han characters', async () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  const placeholders = value => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();
  for (const key of Object.keys(en)) assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), key);
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const references = new Set();
  for (const relative of await readdir(root, { recursive: true })) {
    if (!/\.(?:ts|mjs|cjs|css|html)$/.test(relative) || relative.split(path.sep).includes('copy')) continue;
    const source = await readFile(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /\p{Script=Han}/u, relative);
    if (relative.endsWith('.html')) for (const match of source.matchAll(/data-copy(?:-label)?="([^"]+)"/g)) references.add(match[1]);
    const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
    const walk = node => {
      if (ts.isStringLiteral(node)) references.add(node.text);
      ts.forEachChild(node, walk);
    };
    walk(tree);
  }
  for (const key of Object.keys(en)) assert.ok(references.has(key), `Unused copy key: ${key}`);
});

test('system locale resolution, explicit overrides and persisted language preferences', async ctx => {
  for (const system of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans', 'zh-Hant-TW', 'ZH-cn']) assert.equal(resolveLanguage('system', system), 'zh-CN', system);
  for (const system of ['', 'en', 'en-US', 'fr-FR', 'ja-JP', 'de', 'und']) assert.equal(resolveLanguage('system', system), 'en', system);
  for (const system of ['zh-CN', 'fr-FR', '']) {
    assert.equal(resolveLanguage('en', system), 'en');
    assert.equal(resolveLanguage('zh-CN', system), 'zh-CN');
  }
  const root = createTempDirectory('multiplane-language-'); ctx.after(() => rm(root, { recursive: true, force: true }));
  let prefs = new Preferences(root);
  assert.equal((await prefs.load()).language, 'system');
  for (const value of ['en', 'zh-CN', 'system']) {
    await prefs.save({ language: value });
    prefs = new Preferences(root);
    assert.equal((await prefs.load()).language, value);
  }
  await prefs.save({ language: 'fr-FR' });
  assert.equal((await new Preferences(root).load()).language, 'system');
});

test('language changes notify once and named interpolation and Intl formatting use the active locale', () => {
  setLanguage('en');
  let changes = 0;
  const unsubscribe = onLanguageChange(() => changes++);
  assert.equal(setLanguage('en'), false);
  assert.equal(runningCount(0), en.runningZero);
  assert.equal(runningCount(1), '1 job running');
  assert.equal(runningCount(1200), '1,200 jobs running');
  assert.equal(pixels(1), '1 pixel'); assert.equal(pixels(2), '2 pixels');
  assert.equal(t('stopTitle', { name: '<shot>.html' }), 'Stop “<shot>.html”?');
  assert.throws(() => t('stopTitle'), /Missing placeholder/);
  assert.throws(() => t('missing-key'), /Unknown copy key/);
  assert.equal(formatDuration(125000), '2:05');
  assert.equal(number(1234.56, 1), new Intl.NumberFormat('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(1234.56));
  assert.equal(setLanguage('zh-CN'), true);
  assert.equal(language(), 'zh-CN'); assert.equal(changes, 1);
  assert.equal(runningCount(1), '1 个作业进行中');
  assert.equal(t('languageEnglish'), 'English');
  assert.equal(t('languageChinese'), en.languageChinese);
  assert.equal(userError(Error(en.skillChanged)), zh.skillChanged);
  setLanguage('en');
  assert.equal(userError(Error(zh.skillChanged)), en.skillChanged);
  unsubscribe();
});

test('NSIS explicitly maps the Chinese primary UI language to Simplified Chinese and others to English', async () => {
  const script = await readFile(new URL('../tools/installer.nsh', import.meta.url), 'utf8');
  assert.match(script, /GetUserDefaultUILanguage/);
  assert.match(script, /IntOp \$0 \$0 & 0x3ff/);
  assert.match(script, /StrCpy \$LANGUAGE 1033/);
  assert.match(script, /\$0 = 4[\s\S]*StrCpy \$LANGUAGE 2052/);
  const { default: config } = await import('../electron-builder.config.cjs');
  assert.deepEqual(config.nsis.installerLanguages, ['en_US', 'zh_CN']);
  assert.equal(config.nsis.displayLanguageSelector, false);
});

test('macOS menu roles stay native while every owned label follows the current language', () => {
  const collect = items => items.flatMap(item => [{ role: item.role, label: item.label }, ...Array.isArray(item.submenu) ? collect(item.submenu) : []]);
  setLanguage('en'); const english = collect(applicationMenu());
  assert.deepEqual(applicationMenu().map(item => item.role), ['appMenu', 'editMenu', 'windowMenu']);
  for (const role of ['pasteAndMatchStyle', 'delete', 'showSubstitutions', 'toggleSmartQuotes', 'toggleSmartDashes', 'toggleTextReplacement', 'startSpeaking', 'stopSpeaking']) assert.ok(english.some(item => item.role === role), role);
  setLanguage('zh-CN'); const chinese = collect(applicationMenu());
  assert.deepEqual(english.map(item => item.role), chinese.map(item => item.role));
  for (let i = 0; i < english.length; i++) if (english[i].label && english[i].label !== en.appName) assert.notEqual(english[i].label, chinese[i].label);
  assert.equal(english.find(item => item.role === 'copy').label, en.copy);
  assert.equal(chinese.find(item => item.role === 'copy').label, zh.copy);
  setLanguage('en');
});
