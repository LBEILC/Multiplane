import { userError } from '../shared/errors.mjs';
import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Snapshot, SkillConfirmation } from '../shared/types';
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args).catch(error => { throw Error(userError(error)); });
const bridge: Bridge = {
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
  environment: () => invoke('environment'),
  skill: (host, action) => invoke('skill', host, action),
  copyBrowserCommand: () => invoke('copy-browser-command'),
  snapshot: () => invoke('snapshot'),
  subscribe: fn => { const listener = (_event: unknown, value: Snapshot) => fn(value); ipcRenderer.on('snapshot', listener); return () => ipcRenderer.removeListener('snapshot', listener); },
  stop: id => invoke('stop', id),
  hide: id => invoke('hide', id),
  open: (id, file, reveal) => invoke('open', id, file, reveal),
  media: (id, file, version = '') => `multiplane-media://local/?${new URLSearchParams({ job: id, file, version })}`
};
contextBridge.exposeInMainWorld('multiplane', bridge);
