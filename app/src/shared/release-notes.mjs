export const releaseIcons = Object.freeze({ restart: 'restart-line', film: 'film-line', shield: 'shield-check-line', speed: 'speed-up-line', sparkle: 'sparkling-2-line', layers: 'stack-line', palette: 'palette-line', terminal: 'terminal-box-line' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const localized = value => object(value) && ['zh-CN', 'en'].some(key => text(value[key])) && Object.keys(value).every(key => ['zh-CN', 'en'].includes(key) && text(value[key]));

// Runtime tolerates a missing translation; publishing requires both languages.
export function validateReleaseNotes(value, { version, bilingual = false, log = (_message) => {} } = {}) {
  const errors = [];
  const invalid = message => { errors.push(message); log(message); };
  if (!object(value) || value.schema !== 'multiplane-release-notes/1' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version) || (version && value.version !== version) || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isFinite(Date.parse(value.date)) || new Date(value.date).toISOString().slice(0, 10) !== value.date || !Array.isArray(value.items)) {
    invalid('Invalid release notes document');
    return { notes: null, errors };
  }
  let highlights = 0;
  const items = [];
  for (const [index, item] of value.items.entries()) {
    if (!object(item) || !['new', 'improved', 'fixed'].includes(item.kind) || !['renderer', 'app', 'skill'].includes(item.area) || !localized(item.title) || !localized(item.detail) || (item.highlight !== undefined && typeof item.highlight !== 'boolean') || (bilingual && ['title', 'detail'].some(field => ['zh-CN', 'en'].some(lang => !text(item[field][lang]))))) {
      invalid(`Invalid release notes item ${index}`); continue;
    }
    const clean = { kind: item.kind, area: item.area, title: { ...item.title }, detail: { ...item.detail }, highlight: item.highlight === true };
    if (clean.highlight && ++highlights > 2) { invalid(`Too many highlights: item ${index}`); clean.highlight = false; }
    if (item.icon !== undefined) {
      if (typeof item.icon === 'string' && Object.hasOwn(releaseIcons, item.icon)) clean.icon = item.icon;
      else invalid(`Unknown release notes icon: item ${index}`);
    }
    items.push(clean);
  }
  return { notes: { schema: value.schema, version: value.version, date: value.date, items }, errors };
}
