import type { Settings, Environment, Event } from '../shared/types';
import { menu } from './menu';
import { displayPath, revealLabel } from './platform';
const api = window.multiplane;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const names: Record<string, string> = { node: 'Node', browser: '浏览器', gpu: 'GPU 光栅', ffmpeg: 'FFmpeg', libx264: 'libx264', three: 'three.js', claude: 'Claude Code', codex: 'Codex' };
const states: Record<string, string> = { missing: '未安装', latest: '已是最新', update: '可更新', modified: '已被修改，不会自动替换' };
const configNames: Record<string, string> = { ffmpeg: 'FFmpeg 路径', raster: '光栅', encoder: '编码器', workers: '并行数', jobsDir: '作业目录' };
export class SettingsView {
  settings?: Settings; environment?: Environment; doctor?: Event;
  page = ''; step = 0; busy = false; checking = false; error = ''; doctorError = ''; ffmpegResult = '';
  selected = new Set<string>();
  private checkId = 0;
  private browserInstall = { running: false, text: '' };
  constructor(private container: HTMLElement, private navigate: (page: string) => void) {
    api.onBrowserInstallState(state => { const finished = this.browserInstall.running && !state.running; this.browserInstall = state; this.render(); if (finished) void this.check(); });
    container.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button'); if (b && !b.disabled) void this.click(b).catch(e => this.failure(e)); });
    container.addEventListener('change', e => { const input = e.target as HTMLInputElement; if (input.dataset.host && input.type === 'checkbox') { input.checked ? this.selected.add(input.dataset.host) : this.selected.delete(input.dataset.host); return; } if (input.dataset.input) void this.save(input.dataset.input, input.type === 'number' ? input.value === '' ? null : Number(input.value) : input.value || null); });
    container.addEventListener('keydown', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-select]'); if (b && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); void this.click(b); } });
    container.addEventListener('scroll', () => document.querySelector('.page-h')?.classList.toggle('stuck', container.scrollTop > 0));
  }
  async init() {
    try { this.settings = await api.settings(); this.browserInstall = await api.browserInstallState(); if (!this.settings.own.wizardDone) this.startWizard(); }
    catch (e) { this.failure(e); }
  }
  mount(page: string) { const changed = this.page !== page; this.page = page; this.error = ''; this.render(); if (changed) this.container.scrollTop = 0; if (page === '环境' && !this.checking) void this.check(); }
  private failure(e: unknown) { this.error = String(e instanceof Error ? e.message : e); this.render(); }
  private button(label: string, action: string, extra = '') { return `<button data-pref="${action}" ${this.busy ? 'disabled' : ''} ${extra}>${label}</button>`; }
  private async check() {
    const id = ++this.checkId; this.checking = true; this.error = ''; this.doctorError = ''; this.doctor = undefined; this.render();
    const results = await Promise.allSettled([api.doctor(), api.environment()]);
    if (id !== this.checkId) return;
    if (results[0].status === 'fulfilled') this.doctor = results[0].value;
    else this.doctorError = String(results[0].reason instanceof Error ? results[0].reason.message : results[0].reason).replace(/^Error invoking remote method 'doctor': Error: /, '');
    if (results[1].status === 'fulfilled') this.environment = results[1].value;
    if (results[1].status === 'rejected') this.error = String(results[1].reason);
    this.checking = false; this.render();
  }
  private checks() {
    if (this.checking) return '<p role="status">正在检查…</p>';
    if (this.doctorError) return `<div role="alert"><p>无法运行检查：${esc(this.doctorError)}</p>${this.step ? this.button('重新检查', 'check') : ''}</div>`;
    const checks = this.doctor?.data?.checks ?? [];
    const ffmpeg = checks.find((c: any) => c.name === 'ffmpeg')?.ok;
    const code = this.doctor?.code ?? '';
    const hintTarget = code.startsWith('browser_') ? 'browser' : code === 'unsupported_node' ? 'node' : code.startsWith('ffmpeg_') ? (!ffmpeg ? 'ffmpeg' : 'libx264') : code === 'three_not_installed' ? 'three' : '';
    return checks.map((c: any) => {
      if (c.name === 'three' && this.settings?.packaged) return '<div class="check-row" data-check="three"><span class="muted"><i aria-hidden="true" class="ri-subtract-line"></i> three.js</span><div class="check-status muted">由项目自己安装</div></div>';
      const neutral = (c.name === 'libx264' && !ffmpeg) || (c.name === 'three' && !c.ok);
      const tone = neutral ? 'muted' : c.ok ? 'succeeded' : 'cancelled';
      const version = String(c.detail).match(c.name === 'node' ? /Node (v?\d+(?:\.\d+)*)/ : /Chromium (\d+(?:\.\d+)*)/)?.[1];
      const status = ({
        node: c.ok ? `可用（${version ?? '—'}）` : '版本过低，需要 24 或更新',
        browser: c.ok ? `可用（Chromium ${version ?? '—'}）` : '未安装',
        gpu: c.ok ? '硬件加速可用' : '只能用软件光栅，渲染会变慢',
        ffmpeg: c.ok ? '可用' : '未找到',
        libx264: !ffmpeg ? '取决于 FFmpeg' : c.ok ? '可用' : '不可用',
        three: c.ok ? '可用' : '未安装（只有三维镜头需要）'
      } as Record<string, string>)[c.name];
      const hints = [...new Set([c.hint, c.name === hintTarget ? this.doctor?.hint : null].filter(Boolean))];
      const action = !c.ok && c.name === 'ffmpeg' ? this.button('选择 FFmpeg…', 'ffmpeg') : c.name === 'browser' && (!c.ok || this.browserInstall.text) ? `${!c.ok ? `<code>npx playwright install chromium</code> ${this.button('复制', 'copy')} ${this.browserInstall.running ? this.button('取消安装', 'cancel-browser') : this.button('安装浏览器', 'install-browser')}` : ''}${this.browserInstall.text ? `<pre class="browser-progress selectable" role="status">${esc(this.browserInstall.text)}</pre>` : ''}` : '';
      return `<div class="check-row" data-check="${esc(c.name)}"><span class="${tone}"><i aria-hidden="true" class="ri-${neutral ? 'subtract' : c.ok ? 'checkbox-circle' : 'error-warning'}-line"></i> ${esc(names[c.name] ?? c.name)}</span><div><div class="check-status ${neutral ? 'muted' : ''}">${esc(status)}</div><small class="check-detail selectable">${esc(c.detail)}${hints.map(h => `<br>${esc(h)}`).join('')}</small></div>${action ? `<div class="check-action">${action}</div>` : ''}</div>`;
    }).join('');
  }
  private infoRow(label: string, value: string) { return `<div class="info-row"><span>${label}</span><div>${value}</div></div>`; }
  private configPath(file: string) { return `<div class="path-value"><span class="mono muted">${esc(displayPath(file))}</span>${this.button('在文件夹中显示', 'open-config')}</div>`; }
  private environmentPage() {
    const command = this.environment?.command, config = this.doctor?.data?.config;
    const mismatch = command?.version && command.version.replace(/^multiplane\s+/, '') !== this.settings?.version;
    const configuration = config ? this.infoRow('配置文件', this.configPath(config.path)) + this.infoRow('状态', config.exists ? '已存在' : '尚未创建（全部使用默认值）') + this.infoRow('生效的设置', esc((config.applied ?? []).map((key: string) => configNames[key]).filter(Boolean).join('、') || '无')) : '';
    const commandRows = this.infoRow('命令行中的 multiplane', command?.path ? `<span class="mono muted">${esc(displayPath(command.path))}</span>` : '未找到（agent 也可以在项目里用 npx 调用）') + (command?.path ? this.infoRow('版本', `${esc(command.version ?? command.error ?? '—')}${mismatch ? '<p class="cancelled">版本与软件不同，作业以 agent 实际调用的版本为准。</p>' : ''}`) : '');
    return `<section class="card"><div class="card-head"><h2>渲染器</h2>${this.button('重新检查', 'check', this.checking ? 'disabled' : '')}</div>${this.checks()}${config ? `<h3>配置</h3>${configuration}` : ''}<h3>系统 PATH</h3>${commandRows}</section><h2>Agent skill</h2><div class="skill-cards">${(this.environment?.skills ?? []).map(s => `<section class="card" data-host-card="${s.host}"><h3>${names[s.host]}</h3><p class="mono muted">${esc(displayPath(s.target))}</p>${!s.detected ? `<p class="muted">未检测到 ${names[s.host]}</p>` : ''}<p class="${s.state === 'modified' ? 'cancelled' : ''}">${states[s.state]}</p><p class="muted">已装版本 ${esc(s.version ?? '—')} · 软件自带 ${esc(s.availableVersion)}</p><div class="actions">${s.state !== 'latest' ? this.button(s.state === 'missing' ? '安装' : '更新', 'skill', `data-host="${s.host}" data-operation="install"`) : ''}${s.state !== 'missing' ? this.button('移除', 'skill', `data-host="${s.host}" data-operation="remove"`) : ''}</div></section>`).join('')}</div>`;
  }
  private selector(key: string, value: unknown, options: [unknown, string][]) {
    return `<button class="sel" data-select="${key}" aria-label="${({ raster: '光栅', encoder: '编码器', theme: '外观' } as Record<string, string>)[key]}" aria-haspopup="listbox" aria-expanded="false" ${this.busy ? 'disabled' : ''}><span>${esc(options.find(([v]) => v === value)?.[1] ?? options[0][1])}</span><i class="ri-arrow-down-s-line"></i></button>`;
  }
  private choices(key: string): [unknown, string][] {
    return ({ raster: [['gpu', 'GPU'], ['software', '软件']], encoder: [['x264', 'x264'], ['nvenc-h264', 'NVENC H.264'], ['nvenc-hevc', 'NVENC HEVC']], theme: [['system', '跟随系统'], ['light', '浅'], ['dark', '深']] } as Record<string, [unknown, string][]>)[key];
  }
  private row(key: string, label: string, control: string, own = false) {
    const override = this.settings?.overrides[key];
    return `<div class="setting-row" id="setting-${key}"><div><label for="input-${key}">${label}</label>${own ? '' : `<small class="${override ? 'cancelled' : ''}">${override ? `环境变量优先 · ${esc(key === 'ffmpeg' ? 'MULTIPLANE_FFMPEG' : 'MULTIPLANE_JOBS_DIR')}<br><span class="mono muted">${esc(override)}</span>` : '命令行参数和环境变量优先'}</small>`}</div><div class="setting-control">${control}</div></div>`;
  }
  private pathRow(key: string, label: string) {
    return this.row(key, label, `<input id="input-${key}" data-input="${key}" class="path-input" aria-label="${label}" value="${esc(this.settings?.values[key])}" placeholder="${key === 'ffmpeg' ? '自动查找' : '默认'}" ${this.busy ? 'disabled' : ''}>${this.button('浏览…', 'choose', `data-key="${key}"`)}${key === 'ffmpeg' ? this.button('检测', 'test-ffmpeg') : this.button('默认', 'default-jobs')}`);
  }
  private settingsPage() {
    const s = this.settings!;
    return `<h2>渲染器</h2><section class="card settings-card">${this.pathRow('ffmpeg', 'FFmpeg 路径')}${this.ffmpegResult ? `<p class="selectable">${esc(this.ffmpegResult)}</p>` : ''}${this.row('raster', '光栅', this.selector('raster', s.values.raster ?? 'gpu', this.choices('raster')))}${this.row('encoder', '编码器', this.selector('encoder', s.values.encoder ?? 'x264', this.choices('encoder')))}${this.row('workers', '并行数', `<input id="input-workers" data-input="workers" type="number" min="1" step="1" aria-label="并行数" placeholder="自动" value="${esc(s.values.workers)}" ${this.busy ? 'disabled' : ''}>${this.button('自动', 'auto-workers')}`)}${this.pathRow('jobsDir', '作业目录')}${this.infoRow('配置文件', this.configPath(s.file))}</section><h2>软件</h2><section class="card settings-card">${this.row('theme', '外观', this.selector('theme', s.own.theme, this.choices('theme')), true)}${this.row('notifications', '作业结束通知', this.button(s.own.notifications ? '开启' : '关闭', 'notifications', `role="switch" aria-label="作业结束通知" aria-checked="${s.own.notifications}"`), true)}</section>`;
  }
  private about() {
    const mark = document.querySelector('.titlebar .brand-mark')?.outerHTML ?? '';
    return `<section class="about"><div id="about-brand" class="brand-lockup">${mark}<span>Multiplane</span></div><p class="mono">${esc(this.settings?.version)}</p><p class="mono">multiplane/1</p><p>把网页渲染成视频的本地渲染器，给 AI agent 用。</p>${this.button('重新运行首次引导', 'wizard')}</section>`;
  }
  private wizard() {
    const skills = this.environment?.skills.filter(s => s.detected) ?? [];
    const body = this.step === 1 ? `<h2>检查环境</h2><section class="card">${this.checks()}</section>` : this.step === 2 ? `<h2>设置 FFmpeg</h2><section class="card">${this.pathRow('ffmpeg', 'FFmpeg 路径')}${this.ffmpegResult ? `<p>${esc(this.ffmpegResult)}</p>` : ''}</section>` : `<h2>为 agent 安装 skill</h2>${skills.map(s => `<label class="skill-choice"><input type="checkbox" data-host="${s.host}" ${this.selected.has(s.host) ? 'checked' : ''} ${this.busy ? 'disabled' : ''}><span>${names[s.host]}</span><span class="muted">${states[s.state]}</span></label>`).join('') || '<p class="muted">未检测到 agent</p>'}`;
    return `<div class="wizard"><div class="wizard-steps">${['检查环境', '设置 FFmpeg', '安装 skill'].map((name, i) => `<span class="${this.step === i + 1 ? 'active' : ''}">${i + 1} ${name}</span>`).join('')}</div><div class="wizard-body">${body}</div><div class="wizard-footer">${this.button('跳过', 'skip')}${this.button(this.step === 3 ? '完成' : '下一步', 'next', `class="primary" ${this.checking ? 'disabled' : ''}`)}</div></div>`;
  }
  render() {
    if (this.page === '作业' && !this.step) { this.container.replaceChildren(); return; }
    const top = this.container.scrollTop;
    this.container.innerHTML = `${this.error ? `<div class="banner" role="alert">${esc(this.error)}</div>` : ''}${!this.settings ? '<p>无法读取设置</p>' : this.step ? this.wizard() : this.page === '环境' ? this.environmentPage() : this.page === '设置' ? this.settingsPage() : this.page === '关于' ? this.about() : ''}`;
    this.container.scrollTop = top;
  }
  startWizard() {
    this.step = 1; this.selected.clear(); this.navigate('首次引导');
    document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(b => b.disabled = true);
    void this.check();
  }
  private async advance(install: boolean) {
    if (this.step === 3) {
      if (install) for (const host of this.selected) { const result = await api.skill(host, 'install'); if (result.cancelled) return; this.selected.delete(host); }
      this.settings = await api.saveSetting('wizardDone', true, true);
      this.step = 0; document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(b => b.disabled = false); this.navigate('作业'); return;
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
    this.busy = true; this.error = ''; this.render();
    try { this.settings = await api.saveSetting(key, value, ['theme', 'notifications'].includes(key)); }
    catch (e) { this.failure(e); }
    finally { this.busy = false; this.render(); }
  }
  private async click(b: HTMLButtonElement) {
    if (this.busy) return;
    const d = b.dataset;
    if (d.select) { const key = d.select; menu(b, this.choices(key).map(([value, label]) => ({ label, selected: value === (key === 'theme' ? this.settings?.own.theme : this.settings?.values[key]), run: () => { void this.save(key, value); } }))); return; }
    if (d.pref === 'wizard') { this.startWizard(); return; }
    if (d.pref === 'check') { await this.check(); return; }
    if (d.pref === 'ffmpeg') { if (this.step) { this.step = 2; this.render(); } else this.navigate('设置'); document.getElementById('setting-ffmpeg')?.scrollIntoView({ block: 'nearest' }); document.getElementById('input-ffmpeg')?.focus(); return; }
    if (d.pref === 'copy') { await api.copyBrowserCommand(); return; }
    if (d.pref === 'install-browser') { await api.installBrowser(); return; }
    if (d.pref === 'cancel-browser') { await api.cancelBrowserInstall(); return; }
    if (d.pref === 'open-config') { await api.openConfig(); return; }
    if (d.pref === 'notifications') { await this.save('notifications', !this.settings?.own.notifications); return; }
    if (d.pref === 'auto-workers') { await this.save('workers', null); return; }
    if (d.pref === 'default-jobs') { await this.save('jobsDir', null); return; }
    this.busy = true; this.error = ''; this.render();
    try {
      if (d.pref === 'choose') this.settings = await api.chooseSetting(d.key!);
      if (d.pref === 'test-ffmpeg') { this.doctor = await api.doctor(); const c = this.doctor.data.checks.find((c: any) => c.name === 'ffmpeg'); this.ffmpegResult = `${c.ok ? '可用' : '不可用'} · ${c.detail}`; }
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
