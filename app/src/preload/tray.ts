import { contextBridge, ipcRenderer } from 'electron';
import type { Snapshot } from '../shared/types';
contextBridge.exposeInMainWorld('trayBridge', {
  snapshot: () => ipcRenderer.invoke('tray:snapshot'),
  subscribe: (fn: (snapshot: Snapshot) => void) => {
    const listener = (_event: unknown, value: Snapshot) => fn(value);
    ipcRenderer.on('tray:snapshot', listener);
    return () => ipcRenderer.removeListener('tray:snapshot', listener);
  },
  visibility: (fn: (state: {visible: boolean; edge?: string}) => void) => {
    ipcRenderer.on('tray:visibility', (_event, state) => fn(state));
  },
  height: (height: number) => ipcRenderer.send('tray:height', height),
  action: (action: string, id?: string) => ipcRenderer.send('tray:action', action, id),
});
