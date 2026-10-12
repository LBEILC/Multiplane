import zh from './copy/zh-CN.mjs';
import en from './copy/en.mjs';

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
export const bytes = value => new Intl.NumberFormat(current, { style: 'unit', unit: 'byte', unitDisplay: 'short' }).format(value);
