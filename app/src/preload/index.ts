import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Snapshot, SkillConfirmation } from '../shared/types';
// The parser may not have created <html> yet. Mutation observers run before paint.
const initial = new URLSearchParams(location.search);
const initializeDocument = () => {
  if (!document.documentElement) return false;
  document.documentElement.dataset.theme = initial.get('theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.language = initial.get('language') === 'zh-CN' ? 'zh-CN' : 'en';
  return true;
};
if (!initializeDocument()) {
  const observer = new MutationObserver(() => { if (initializeDocument()) observer.disconnect(); });
  observer.observe(document, { childList: true });
}
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args).catch(error => {
  let message = String(error?.message ?? error);
  for (;;) { const clean = message.replace(/^(?:Error:\s*|Error invoking remote method '[^']+':\s*)/, ''); if (clean === message) break; message = clean; }
  throw Error(message);
});
const bridge: Bridge = {
  onNavigate: fn => { const listener = (_event: unknown, page: string) => fn(page); ipcRenderer.on('navigate', listener); return () => ipcRenderer.removeListener('navigate', listener); },
  updateState: () => invoke('updates:state'),
  checkUpdates: () => invoke('updates:check'),
  downloadUpdate: () => invoke('updates:download'),
  cancelUpdate: () => invoke('updates:cancel'),
  installUpdate: () => invoke('updates:install'),
  openRelease: () => invoke('updates:release'),
  onUpdateState: fn => { const listener = (_event: unknown, state: import('../shared/types').UpdateState) => fn(state); ipcRenderer.on('updates:state', listener); return () => ipcRenderer.removeListener('updates:state', listener); },
  reportFault: message => ipcRenderer.send('renderer-fault', String(message).slice(0, 12000)),
  platform: () => invoke('platform'),
  browserInstallState: () => invoke('browser-install-state'),
  installBrowser: () => invoke('install-browser'),
  cancelBrowserInstall: () => invoke('cancel-browser-install'),
  onBrowserInstallState: fn => { const listener = (_event: unknown, state: import('../shared/types').BrowserInstallState) => fn(state); ipcRenderer.on('browser-install-state', listener); return () => ipcRenderer.removeListener('browser-install-state', listener); },
  onSkillConfirmation: fn => { const listener = (_event: unknown, value: SkillConfirmation) => fn(value); ipcRenderer.on('skill-confirmation', listener); return () => ipcRenderer.removeListener('skill-confirmation', listener); },
  answerSkillConfirmation: (id, accepted) => invoke('answer-skill-confirmation', id, accepted),
  settings: () => invoke('settings'),
  saveSetting: (key, value, own) => invoke('save-setting', key, value, own),
  chooseSetting: key => invoke('choose-setting', key),
  openConfig: () => invoke('open-config'),
  doctor: () => invoke('doctor'),
  checkFfmpeg: () => invoke('check-ffmpeg'),
  environment: () => invoke('environment'),
  skill: (host, action) => invoke('skill', host, action),
  copyBundledCommand: () => invoke('copy-bundled-command'),
  copyBrowserCommand: () => invoke('copy-browser-command'),
  snapshot: () => invoke('snapshot'),
  subscribe: fn => { const listener = (_event: unknown, value: Snapshot) => fn(value); ipcRenderer.on('snapshot', listener); return () => ipcRenderer.removeListener('snapshot', listener); },
  resume: id => invoke('resume', id),
  resumePriority: id => invoke('resume-priority', id),
  stop: id => invoke('stop', id),
  hide: id => invoke('hide', id),
  open: (id, file, reveal) => invoke('open', id, file, reveal),
  media: (id, file, version = '') => `multiplane-media://local/?${new URLSearchParams({ job: id, file, version })}`
};
contextBridge.exposeInMainWorld('multiplane', bridge);
