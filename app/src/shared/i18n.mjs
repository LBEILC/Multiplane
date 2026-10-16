import resumeZh from './copy/resume-zh-CN.mjs';
import resumeEn from './copy/resume-en.mjs';
import trayZh from './copy/tray-zh-CN.mjs';
import trayEn from './copy/tray-en.mjs';
import jobsZh from './copy/jobs-zh-CN.mjs';
import jobsEn from './copy/jobs-en.mjs';
import zh from './copy/zh-CN.mjs';
import en from './copy/en.mjs';

Object.assign(zh, jobsZh, trayZh, resumeZh);
Object.assign(en, jobsEn, trayEn, resumeEn);
export const languagePreferences = ['system', 'zh-CN', 'en'];
let current = 'en';
const listeners = new Set();
export const language = () => current;
export function resolveLanguage(preference = 'system', system = '') {
  return preference === 'zh-CN' || preference === 'en' ? preference : /^zh/i.test(system) ? 'zh-CN' : 'en';
}
export function setLanguage(value) {
  const next = resolveLanguage(value);
  if (current === next) return false;
  current = next;
  for (const listener of listeners) listener();
  return true;
}
export function onLanguageChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function t(key, values = {}) {
  const text = (current === 'zh-CN' ? zh : en)[key];
  if (text === undefined) throw Error(`Unknown copy key: ${key}`);
  return text.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in values)) throw Error(`Missing placeholder ${name} for ${key}`);
    return String(values[name]);
  });
}
export function number(value, decimals = 0) {
  return value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat(current, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}
export function formatDuration(ms) {
  const minutes = number(Math.floor(ms / 60000));
  const seconds = new Intl.NumberFormat(current, { minimumIntegerDigits: 2, useGrouping: false }).format(Math.floor(ms / 1000) % 60);
  return t('duration', { minutes, seconds });
}
export function runningCount(count) {
  if (count === 0) return t('runningZero');
  return t(new Intl.PluralRules(current).select(count) === 'one' ? 'runningOne' : 'runningOther', { count: number(count) });
}
export function pixels(count) {
  return t(new Intl.PluralRules(current).select(count) === 'one' ? 'pixelsOne' : 'pixelsOther', { count: number(count) });
}
export const list = values => new Intl.ListFormat(current).format(values);
export function bytes(value, unit) {
  if (!Number.isFinite(value)) return '—';
  const units = ['KB', 'MB', 'GB'];
  const index = unit ? units.indexOf(unit) : Math.min(2, Math.max(0, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)) - 1));
  return `${new Intl.NumberFormat(current, { maximumFractionDigits: 1 }).format(value / 1024 ** (index + 1))} ${units[index]}`;
}
export function jobStarted(value, now = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const time = date.toLocaleTimeString(current, { hour: '2-digit', minute: '2-digit', hour12: false });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const text = date.toDateString() === now.toDateString() ? time : date.toDateString() === yesterday.toDateString() ? `${t('yesterday')} ${time}` : `${date.toLocaleDateString(current)} ${time}`;
  return t('started', { t: text });
}
