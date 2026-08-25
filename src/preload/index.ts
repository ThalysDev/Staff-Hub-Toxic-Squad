import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, QueueProgress, SessionStatus, StaffHubApi } from '@shared/ipc-types';

const api = {
  session: {
    openLogin: () => ipcRenderer.invoke('session:open-login'),
    logout: () => ipcRenderer.invoke('session:logout'),
    status: () => ipcRenderer.invoke('session:status'),
    loginWithSid: (world: string, sid: string) => ipcRenderer.invoke('session:login-sid', world, sid),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  },
  journal: {
    list: (limit: number) => ipcRenderer.invoke('journal:list', limit),
    clear: () => ipcRenderer.invoke('journal:clear'),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
  },
  dev: {
    captureFixture: (name: string, url: string) => ipcRenderer.invoke('dev:capture-fixture', name, url),
  },
  events: {
    onQueueProgress: (cb: (progress: QueueProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: QueueProgress) => cb(progress);
      ipcRenderer.on('queue:progress', listener);
      return () => ipcRenderer.removeListener('queue:progress', listener);
    },
    onSessionChanged: (cb: (status: SessionStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: SessionStatus) => cb(status);
      ipcRenderer.on('session:changed', listener);
      return () => ipcRenderer.removeListener('session:changed', listener);
    },
  },
} satisfies StaffHubApi;

contextBridge.exposeInMainWorld('staffhub', api);
