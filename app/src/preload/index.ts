import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Snapshot, SkillConfirmation } from '../shared/types';
const bridge: Bridge = {
  platform: () => ipcRenderer.invoke('platform'),
  browserInstallState: () => ipcRenderer.invoke('browser-install-state'),
  installBrowser: () => ipcRenderer.invoke('install-browser'),
  cancelBrowserInstall: () => ipcRenderer.invoke('cancel-browser-install'),
  onBrowserInstallState: fn => { const listener = (_event: unknown, state: import('../shared/types').BrowserInstallState) => fn(state); ipcRenderer.on('browser-install-state', listener); return () => ipcRenderer.removeListener('browser-install-state', listener); },
  onSkillConfirmation: fn => { const listener = (_event: unknown, value: SkillConfirmation) => fn(value); ipcRenderer.on('skill-confirmation', listener); return () => ipcRenderer.removeListener('skill-confirmation', listener); },
  answerSkillConfirmation: (id, accepted) => ipcRenderer.invoke('answer-skill-confirmation', id, accepted),
  settings: () => ipcRenderer.invoke('settings'),
  saveSetting: (key, value, own) => ipcRenderer.invoke('save-setting', key, value, own),
  chooseSetting: key => ipcRenderer.invoke('choose-setting', key),
  openConfig: () => ipcRenderer.invoke('open-config'),
  doctor: () => ipcRenderer.invoke('doctor'),
  environment: () => ipcRenderer.invoke('environment'),
  skill: (host, action) => ipcRenderer.invoke('skill', host, action),
  copyBrowserCommand: () => ipcRenderer.invoke('copy-browser-command'),
  snapshot: () => ipcRenderer.invoke('snapshot'),
  subscribe: fn => { const listener = (_event: unknown, value: Snapshot) => fn(value); ipcRenderer.on('snapshot', listener); return () => ipcRenderer.removeListener('snapshot', listener); },
  stop: id => ipcRenderer.invoke('stop', id),
  hide: id => ipcRenderer.invoke('hide', id),
  open: (id, file, reveal) => ipcRenderer.invoke('open', id, file, reveal),
  media: (id, file, version = '') => `multiplane-media://local/?${new URLSearchParams({ job: id, file, version })}`
};
contextBridge.exposeInMainWorld('multiplane', bridge);
