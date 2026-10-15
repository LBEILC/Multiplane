import { updateCard, updateHint } from './updates';
import { t, language, list, number } from '../shared/i18n.mjs';
import { userError } from '../shared/errors.mjs';
import type { Settings, Environment, Event, UpdateState } from '../shared/types';
import { menu } from './menu';
import { displayPath, revealLabel } from './platform';
import { doctorCopy } from '../shared/doctor-copy.mjs';
const api = window.multiplane;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const names = (): Record<string, string> => ({ node: t('techNode'), browser: t('browser'), gpu: t('gpuRaster'), ffmpeg: t('techFfmpeg'), libx264: t('techLibx264'), three: t('techThree'), claude: t('agentClaude'), codex: t('agentCodex') });
const states = (): Record<string, string> => ({ missing: t('notInstalled'), latest: t('upToDate'), update: t('updateAvailable'), modified: t('modified'), error: t('skillReadError') });
const configNames = (): Record<string, string> => ({ ffmpeg: t('ffmpegPath'), raster: t('rasterization'), encoder: t('encoder'), workers: t('workers'), jobsDir: t('jobDirectory') });
export class SettingsView {
  updates?: UpdateState; busyJobs = 0;
  settings?: Settings; environment?: Environment; doctor?: Event;
  page = ''; step = 0; busy = false; checking = false; error = ''; doctorError = '';
  private ffmpegCheck?: Awaited<ReturnType<typeof api.checkFfmpeg>>;
  private ffmpegChecking = false;
  private ffmpegId = 0;
  private checkMarkup(check: any, options = {}) {
    const content = doctorCopy(check, options);
    if ('raw' in content) return `<div class="check-status selectable">${esc(content.raw)}</div><small class="check-detail selectable">${esc(content.hint)}</small>`;
    const values = Object.fromEntries(Object.entries(content.values).map(([key, value]) => [key, `<span class="mono">${esc(value)}</span>`]));
    return `<div class="check-status selectable">${t(content.status, values)}</div><small class="check-detail selectable">${esc(content.explanation)}</small>${content.data ? `<div class="mono selectable">${esc(content.data).replaceAll('\n', '<br>')}</div>` : ''}`;
  }
  private get ffmpegFeedback() {
    return this.ffmpegChecking ? `<div class="ffmpeg-feedback" role="status">${t('checking')}</div>` : this.ffmpegCheck ? `<div class="ffmpeg-feedback" role="status">${this.checkMarkup(this.ffmpegCheck)}</div>` : '';
  }
  private async inspectFfmpeg() {
    const id = ++this.ffmpegId;
    this.ffmpegChecking = true; this.ffmpegCheck = undefined; this.render();
    try { const result = await api.checkFfmpeg(); if (id === this.ffmpegId) this.ffmpegCheck = result; }
    catch (error) { if (id === this.ffmpegId) this.ffmpegCheck = { name: 'ffmpeg', ok: false, detail: '', reason: 'cannot-run', diagnostic: userError(error) }; }
    finally { if (id === this.ffmpegId) { this.ffmpegChecking = false; this.render(); } }
  }
  private async savedFfmpeg() {
    const check = this.settings?.check;
    if (check) { ++this.ffmpegId; this.ffmpegChecking = false; this.ffmpegCheck = { name: 'ffmpeg', ok: check.usable, detail: check.version ?? '', ...(check.reason ? { reason: check.reason } : {}) }; }
    else await this.inspectFfmpeg();
  }
  selected = new Set<string>();
  private checkId = 0;
  private browserInstall = { running: false, text: '' };
  constructor(private container: HTMLElement, private navigate: (page: string) => void) {
    api.onUpdateState(state => { this.updates = state; updateHint(state); if (this.page === 'about') this.render(); });
    api.onBrowserInstallState(state => { const finished = this.browserInstall.running && !state.running; this.browserInstall = state; this.render(); if (finished) void this.check(); });
    container.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button'); if (b && !b.disabled) void this.click(b).catch(e => this.failure(e)); });
    container.addEventListener('change', e => { const input = e.target as HTMLInputElement; if (input.dataset.host && input.type === 'checkbox') { input.checked ? this.selected.add(input.dataset.host) : this.selected.delete(input.dataset.host); return; } if (input.dataset.input) void this.save(input.dataset.input, input.type === 'number' ? input.value === '' ? null : Number(input.value) : input.value || null); });
    container.addEventListener('keydown', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-select]'); if (b && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); void this.click(b); } });
    container.addEventListener('scroll', () => document.querySelector('.page-h')?.classList.toggle('stuck', container.scrollTop > 0));
  }
  async init() {
    try { this.updates = await api.updateState(); updateHint(this.updates); this.settings = await api.settings(); this.browserInstall = await api.browserInstallState(); if (!this.settings.own.wizardDone) this.startWizard(); }
    catch (e) { this.failure(e); }
  }
  syncHosting(enabled: boolean) {
    if (this.settings) this.settings.values.hosted = enabled;
    this.container.querySelector('[data-pref=hosted]')?.setAttribute('aria-checked', String(enabled));
  }
  mount(page: string) { const changed = this.page !== page; this.page = page; this.error = ''; this.render(); if (changed) this.container.scrollTop = 0; if (page === 'environment' && !this.checking) void this.check(); }
  private failure(e: unknown) { this.error = userError(e); this.render(); }
  private button(label: string, action: string, extra = '') { return `<button data-pref="${action}" ${this.busy ? 'disabled' : ''} ${extra}>${label}</button>`; }
  private async check() {
    const id = ++this.checkId; this.checking = true; this.error = ''; this.doctorError = ''; this.doctor = undefined; this.render();
    const results = await Promise.allSettled([api.doctor(), api.environment()]);
    if (id !== this.checkId) return;
    if (results[0].status === 'fulfilled') this.doctor = results[0].value;
    else this.doctorError = userError(results[0].reason);
    if (results[1].status === 'fulfilled') this.environment = results[1].value;
    if (results[1].status === 'rejected') {
      const error = userError(results[1].reason);
      this.environment = { command: { path: null, version: null, error }, skills: ['claude', 'codex'].map(host => ({ host, target: '', detected: false, availableVersion: this.settings?.version ?? '', version: null, state: 'error', blocked: true, error })) };
    }
    this.checking = false; this.render();
  }
  private checks() {
    if (this.checking) return `<p role="status">${t('checking')}</p>`;
    if (this.doctorError) return `<div role="alert"><p>${t('checkFailed', { error: esc(userError(this.doctorError)) })}</p>${this.step ? this.button(t('checkAgain'), 'check') : ''}</div>`;
    const checks = this.doctor?.data?.checks ?? [];
    const ffmpeg = checks.find((c: any) => c.name === 'ffmpeg')?.ok;
    return checks.map((c: any) => {
      const neutral = (c.name === 'libx264' && !ffmpeg) || (c.name === 'three' && !c.ok);
      const tone = neutral ? 'muted' : c.ok ? 'succeeded' : 'cancelled';
      const action = !c.ok && c.name === 'ffmpeg' ? this.button(t('chooseFfmpeg'), 'ffmpeg') : c.name === 'browser' && (!c.ok || this.browserInstall.text) ? `${!c.ok ? this.browserInstall.running ? this.button(t('cancelInstall'), 'cancel-browser') : this.button(t('installBrowser'), 'install-browser') : ''}${this.browserInstall.text ? `<pre class="browser-progress selectable" role="status">${esc(this.browserInstall.text)}</pre>` : ''}` : '';
      return `<div class="check-row" data-check="${esc(c.name)}"><span class="${tone}"><i aria-hidden="true" class="ri-${neutral ? 'subtract' : c.ok ? 'checkbox-circle' : 'error-warning'}-line"></i> ${esc(names()[c.name] ?? c.name)}</span><div>${this.checkMarkup(c, { ffmpeg, packaged: this.settings?.packaged, environment: this.doctor?.environment })}</div>${action ? `<div class="check-action">${action}</div>` : ''}</div>`;
    }).join('');
  }
  private infoRow(label: string, value: string) { return `<div class="info-row"><span>${label}</span><div>${value}</div></div>`; }
  private configPath(file: string) { return `<div class="path-value"><span class="mono muted">${esc(displayPath(file))}</span>${this.button(revealLabel(), 'open-config')}</div>`; }
  private environmentPage() {
    const command = this.environment?.command, config = this.doctor?.data?.config;
    const mismatch = command?.version && command.version.replace(/^multiplane\s+/, '') !== this.settings?.version;
    const configuration = config ? this.infoRow(t('configFile'), this.configPath(config.path)) + this.infoRow(t('status'), config.exists ? t('exists') : t('configMissing')) + this.infoRow(t('settingsInEffect'), esc(list((config.applied ?? []).map((key: string) => configNames()[key]).filter(Boolean)) || t('none'))) : '';
    const commandRows = command?.error ? `<p role="alert">${esc(userError(command.error))}</p>` : this.infoRow(t('commandLine'), command?.path ? `<span class="mono muted">${esc(displayPath(command.path))}</span>` : command?.bundled ? `${t('bundledCommand')}<br><span class="mono muted selectable">${esc(command.bundled)}</span>${this.button(t('copy'), 'copy-bundled')}` : t('commandMissing')) + (command?.path ? this.infoRow(t('version'), `${esc(command.version ?? command.error ?? '—')}${mismatch ? `<p class="cancelled">${t('versionMismatch')}</p>` : ''}`) : '');
    return `<section class="card"><div class="card-head"><h2>${t('renderer')}</h2>${this.button(t('checkAgain'), 'check', this.checking ? 'disabled' : '')}</div>${this.checks()}${config ? `<h3>${t('configuration')}</h3>${configuration}` : ''}<h3>${t('systemPath')}</h3>${commandRows}</section><h2>${t('agentSkill')}</h2><div class="skill-cards">${(this.environment?.skills ?? []).map(s => `<section class="card" data-host-card="${s.host}"><h3>${names()[s.host]}</h3><p class="mono muted">${esc(displayPath(s.target))}</p>${!s.detected ? `<p class="muted">${t('agentNotDetected', { name: names()[s.host] })}</p>` : ''}<p class="${s.state === 'modified' ? 'cancelled' : ''}">${states()[s.state]}</p>${s.error ? `<p role="alert">${esc(userError(s.error))}</p>` : ''}<p class="muted">${t('skillVersions', { installed: esc(s.version ?? '—'), bundled: esc(s.availableVersion) })}</p><div class="actions">${!s.blocked && s.state !== 'latest' ? this.button(s.state === 'missing' ? t('install') : t('update'), 'skill', `data-host="${s.host}" data-operation="install"`) : ''}${!s.blocked && s.state !== 'missing' ? this.button(t('remove'), 'skill', `data-host="${s.host}" data-operation="remove"`) : ''}</div></section>`).join('')}</div>`;
  }
  private selector(key: string, value: unknown, options: [unknown, string][]) {
    return `<button class="sel" data-select="${key}" aria-label="${({ raster: t('rasterization'), encoder: t('encoder'), theme: t('appearance'), language: t('language') } as Record<string, string>)[key]}" aria-haspopup="listbox" aria-expanded="false" ${this.busy ? 'disabled' : ''}><span>${esc(options.find(([v]) => v === value)?.[1] ?? options[0][1])}</span><i class="ri-arrow-down-s-line"></i></button>`;
  }
  private choices(key: string): [unknown, string][] {
    return ({ raster: [['gpu', t('rasterGpu')], ['software', t('software')]], encoder: [['x264', t('encoderX264')], ['nvenc-h264', t('encoderNvencH264')], ['nvenc-hevc', t('encoderNvencHevc')]], language: [['system', t('languageSystem')], ['zh-CN', t('languageChinese')], ['en', t('languageEnglish')]], theme: [['system', t('system')], ['light', t('light')], ['dark', t('dark')]] } as Record<string, [unknown, string][]>)[key];
  }
  private row(key: string, label: string, control: string, own = false) {
    const override = this.settings?.overrides[key];
    return `<div class="setting-row" id="setting-${key}"><div><label for="input-${key}">${label}</label>${own ? '' : `<small class="${override ? 'cancelled' : ''}">${override ? `${t('envPrecedence')} · ${esc(key === 'ffmpeg' ? 'MULTIPLANE_FFMPEG' : 'MULTIPLANE_JOBS_DIR')}<br><span class="mono muted">${esc(override)}</span>` : t('optionPrecedence')}</small>`}</div><div><div class="setting-control">${control}</div>${key === 'ffmpeg' ? this.ffmpegFeedback : ''}</div></div>`;
  }
  private pathRow(key: string, label: string) {
    return this.row(key, label, `<input id="input-${key}" data-input="${key}" class="path-input" aria-label="${label}" value="${esc(this.settings?.values[key])}" placeholder="${key === 'ffmpeg' ? t('autoFind') : t('default')}" ${this.busy ? 'disabled' : ''}>${this.button(t(key === 'ffmpeg' ? 'chooseFfmpeg' : 'browse'), 'choose', `data-key="${key}"`)}${key === 'ffmpeg' ? this.button(t('detect'), 'test-ffmpeg') : this.button(t('default'), 'default-jobs')}`);
  }
  private hostingRow() {
    return `<div class="setting-row" id="setting-hosted"><div><label>${t('hostingL')}</label><small>${t('hostingD')}</small></div><div class="setting-control">${this.button('', 'hosted', `class="upd-switch" role="switch" aria-label="${t('hostingL')}" aria-checked="${this.settings?.values.hosted === true}"`)}</div></div>`;
  }
  private settingsPage() {
    const s = this.settings!;
    return `<h2>${t('renderer')}</h2><section class="card settings-card">${this.hostingRow()}${this.pathRow('ffmpeg', t('ffmpegPath'))}${this.row('raster', t('rasterization'), this.selector('raster', s.values.raster ?? 'gpu', this.choices('raster')))}${this.row('encoder', t('encoder'), this.selector('encoder', s.values.encoder ?? 'x264', this.choices('encoder')))}${this.row('workers', t('workers'), `<input id="input-workers" data-input="workers" type="number" min="1" step="1" aria-label="${t('workers')}" placeholder="${t('automatic')}" value="${esc(s.values.workers)}" ${this.busy ? 'disabled' : ''}>${this.button(t('automatic'), 'auto-workers')}`)}${this.pathRow('jobsDir', t('jobDirectory'))}${this.infoRow(t('configFile'), this.configPath(s.file))}</section><h2>${t('software')}</h2><section class="card settings-card">${this.row('language', t('language'), this.selector('language', s.own.language ?? 'system', this.choices('language')), true)}${this.row('theme', t('appearance'), this.selector('theme', s.own.theme, this.choices('theme')), true)}${this.row('notifications', t('notifyFinish'), this.button(s.own.notifications ? t('on') : t('off'), 'notifications', `role="switch" aria-label="${t('notifyFinish')}" aria-checked="${s.own.notifications}"`), true)}</section>`;
  }
  private about() {
    const mark = document.querySelector('.titlebar .brand-mark')?.outerHTML ?? '';
    return `<section class="about"><div id="about-brand" class="brand-lockup">${mark}<span>${t('appName')}</span></div><p class="mono">${esc(this.settings?.version)}</p><p class="mono">multiplane/1</p><p>${t('description')}</p>${this.button(t('rerunWizard'), 'wizard')}</section>${updateCard(this.updates, this.settings?.own.autoCheckUpdates !== false, this.busyJobs)}`;
  }
  private wizard() {
    const skills = this.environment?.skills.filter(s => s.detected) ?? [];
    const body = this.step === 4 ? `<h2>${t('hosted')}</h2><section class="card">${this.hostingRow()}</section>` : this.step === 1 ? `<h2>${t('checkEnvironment')}</h2><section class="card">${this.checks()}</section>` : this.step === 2 ? `<h2>${t('setupFfmpeg')}</h2><section class="card">${this.pathRow('ffmpeg', t('ffmpegPath'))}</section>` : `<h2>${t('installAgentSkill')}</h2>${skills.map(s => `<label class="skill-choice"><input type="checkbox" data-host="${s.host}" ${this.selected.has(s.host) ? 'checked' : ''} ${this.busy ? 'disabled' : ''}><span>${names()[s.host]}</span><span class="muted">${states()[s.state]}</span></label>`).join('') || `<p class="muted">${t('noAgent')}</p>`}`;
    return `<div class="wizard"><div class="wizard-steps">${[t('checkEnvironment'), t('setupFfmpeg'), t('installSkill'), t('hosted')].map((name, i) => `<span class="${this.step === i + 1 ? 'active' : ''}">${number(i + 1)} ${name}</span>`).join('')}</div><div class="wizard-body">${body}</div><div class="wizard-footer">${this.button(t('skip'), 'skip')}${this.button(this.step === 4 ? t('done') : t('next'), 'next', `class="primary" ${this.checking ? 'disabled' : ''}`)}</div></div>`;
  }
  setBusyJobs(count: number) { if (count === this.busyJobs) return; this.busyJobs = count; if (this.page === 'about') this.render(); }
  render() {
    updateHint(this.updates);
    if (this.page === 'jobs' && !this.step) { this.container.replaceChildren(); return; }
    const top = this.container.scrollTop;
    this.container.innerHTML = `${this.error ? `<div class="banner" role="alert">${esc(userError(this.error))}</div>` : ''}${this.page === 'environment' ? this.environmentPage() : !this.settings ? `<p>${t('settingsReadError')}</p>` : this.step ? this.wizard() : this.page === 'settings' ? this.settingsPage() : this.page === 'about' ? this.about() : ''}`;
    this.container.scrollTop = top;
  }
  startWizard() {
    this.step = 1; this.selected.clear(); this.navigate('wizard');
    document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(b => b.disabled = true);
    void this.check();
  }
  private async advance(install: boolean) {
    if (this.step === 3) {
      if (install) for (const host of this.selected) { const result = await api.skill(host, 'install'); if (result.cancelled) return; this.selected.delete(host); }
      this.step = 4; return;
    }
    if (this.step === 4) {
      this.settings = await api.saveSetting('wizardDone', true, true);
      this.step = 0; document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(b => b.disabled = false); this.navigate('jobs'); return;
    }
    if (this.step === 1) this.step = this.doctor?.data.checks.find((c: any) => c.name === 'ffmpeg')?.ok ? 3 : 2;
    else this.step = 3;
    if (this.step === 3) {
      this.environment = await api.environment();
      this.selected = new Set(this.environment.skills.filter(s => s.detected && s.state === 'missing').map(s => s.host));
    }
    this.error = '';
  }
  private async save(key: string, value: unknown) {
    if (key === 'ffmpeg') { ++this.ffmpegId; this.ffmpegChecking = true; this.ffmpegCheck = undefined; }
    this.busy = true; this.error = ''; this.render();
    try { this.settings = await api.saveSetting(key, value, ['theme', 'notifications', 'language', 'autoCheckUpdates'].includes(key)); if (key === 'ffmpeg') await this.savedFfmpeg(); }
    catch (e) { this.failure(e); }
    finally { this.ffmpegChecking = false; this.busy = false; this.render(); }
  }
  private async click(b: HTMLButtonElement) {
    if (this.busy) return;
    const d = b.dataset;
    if (d.select) { const key = d.select; menu(b, this.choices(key).map(([value, label]) => ({ label, selected: value === (key === 'theme' || key === 'language' ? this.settings?.own[key] ?? 'system' : this.settings?.values[key]), run: () => { void this.save(key, value); } }))); return; }
    if (d.pref === 'update-check') { await api.checkUpdates(); return; }
    if (d.pref === 'update-download') { await api.downloadUpdate(); return; }
    if (d.pref === 'update-cancel') { await api.cancelUpdate(); return; }
    if (d.pref === 'update-install') { await api.installUpdate(); return; }
    if (d.pref === 'update-release') { await api.openRelease(); return; }
    if (d.pref === 'update-later') { this.navigate('jobs'); return; }
    if (d.pref === 'autoCheckUpdates') { await this.save('autoCheckUpdates', this.settings?.own.autoCheckUpdates === false); return; }
    if (d.pref === 'wizard') { this.startWizard(); return; }
    if (d.pref === 'check') { await this.check(); return; }
    if (d.pref === 'ffmpeg') { if (this.step) { this.step = 2; this.render(); } else this.navigate('settings'); document.getElementById('setting-ffmpeg')?.scrollIntoView({ block: 'nearest' }); document.getElementById('input-ffmpeg')?.focus(); return; }
    if (d.pref === 'copy-bundled') { await api.copyBundledCommand(); return; }
    if (d.pref === 'copy') { await api.copyBrowserCommand(); return; }
    if (d.pref === 'install-browser') { await api.installBrowser(); return; }
    if (d.pref === 'cancel-browser') { await api.cancelBrowserInstall(); return; }
    if (d.pref === 'open-config') { await api.openConfig(); return; }
    if (d.pref === 'hosted') { await this.save('hosted', !this.settings?.values.hosted); return; }
    if (d.pref === 'notifications') { await this.save('notifications', !this.settings?.own.notifications); return; }
    if (d.pref === 'auto-workers') { await this.save('workers', null); return; }
    if (d.pref === 'default-jobs') { await this.save('jobsDir', null); return; }
    this.busy = true; this.error = ''; this.render();
    try {
      if (d.pref === 'choose') { this.settings = await api.chooseSetting(d.key!); if (d.key === 'ffmpeg') await this.savedFfmpeg(); }
      if (d.pref === 'test-ffmpeg') await this.inspectFfmpeg();
      if (d.pref === 'skill') { await api.skill(d.host!, d.operation!); this.environment = await api.environment(); }
      if (d.pref === 'next' || d.pref === 'skip') await this.advance(d.pref === 'next');
    } finally {
      this.busy = false; this.render();
      if (d.pref === 'skill') {
        const card = this.container.querySelector(`[data-host-card="${d.host}"]`);
        (card?.querySelector<HTMLButtonElement>(`button[data-operation="${d.operation}"]`) ?? card?.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true });
      }
    }
  }
}
