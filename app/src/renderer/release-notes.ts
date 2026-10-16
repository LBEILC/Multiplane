import { t, language } from '../shared/i18n.mjs';
import { releaseIcons } from '../shared/release-notes.mjs';
import type { ReleaseNotes, UpdateState } from '../shared/types';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const kinds = ['new', 'improved', 'fixed'] as const;
const kindCopy = { new: 'k_new', improved: 'k_improved', fixed: 'k_fixed' };
const countCopy = { new: 'kCount_new', improved: 'kCount_improved', fixed: 'kCount_fixed' };
const areaCopy = { renderer: 'a_renderer', app: 'a_app', skill: 'a_skill' };
const kindIcon = { new: 'sparkling-2-line', improved: 'arrow-up-double-line', fixed: 'hammer-line' };
const tx = (value: ReleaseNotes['items'][number]['title']) => esc(value[language() as 'en' | 'zh-CN'] || value.en || value['zh-CN']);
function versionNotes(r: ReleaseNotes, compact = false) {
  const counts = kinds.map(k => [k, r.items.filter(i => i.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => t(countCopy[k], { n })).join(' · ');
  const highlights = compact ? [] : r.items.filter(i => i.highlight).slice(0, 2);
  const rest = r.items.filter(i => !highlights.includes(i));
  const title = (i: ReleaseNotes['items'][number]) => `<b>${tx(i.title)}</b><span class="area">${t(areaCopy[i.area])}</span>`;
  const cards = highlights.length ? `<div class="rn-hl">${highlights.map(i => `<div class="hl-card"><span class="hl-ic k-${i.kind}"><i aria-hidden="true" class="ri-${i.icon && Object.hasOwn(releaseIcons, i.icon) ? releaseIcons[i.icon as keyof typeof releaseIcons] : kindIcon[i.kind]}"></i></span><div class="hl-tx"><div class="hl-t">${title(i)}</div><p>${tx(i.detail)}</p></div></div>`).join('')}</div>` : '';
  const groups = kinds.map(k => [k, rest.filter(i => i.kind === k)] as const).filter(([, list]) => list.length).map(([k, list]) => `<section class="rn-g"><h5 class="k-${k}"><i aria-hidden="true" class="ri-${kindIcon[k]}"></i>${t(kindCopy[k])}</h5><ul>${list.map(i => `<li><span class="li-t">${title(i)}</span><span class="li-d">${tx(i.detail)}</span></li>`).join('')}</ul></section>`).join('');
  return `<div class="rn-head"><b>${compact ? esc(r.version) : t('rnTitle', { v: esc(r.version) })}</b><span>${esc(r.date)} · ${counts}</span></div>${cards}<div class="rn-groups">${groups}</div>`;
}
export function releaseNotes(state: UpdateState) {
  const [latest, ...older] = state.notes;
  const content = latest?.version === state.version ? `${versionNotes(latest)}${older.length ? `<details class="rn-older"><summary>${t('rnSkipped', { n: older.length, list: older.map(r => esc(r.version)).join(language() === 'zh-CN' ? '、' : ', ') })}</summary>${older.map(r => versionNotes(r, true)).join('')}</details>` : ''}` : '';
  return `<div class="notes rn selectable">${content}<button class="rn-full" data-pref="update-release">${t('rnFull')}<i aria-hidden="true" class="ri-arrow-right-up-line"></i></button></div>`;
}
