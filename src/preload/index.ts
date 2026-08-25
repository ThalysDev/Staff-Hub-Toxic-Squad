import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, QueueProgress, SessionStatus, Sg1Input, StaffHubApi, TroopKind } from '@shared/ipc-types';

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
  world: {
    refresh: () => ipcRenderer.invoke('world:refresh'),
    status: () => ipcRenderer.invoke('world:status'),
    tribes: () => ipcRenderer.invoke('world:tribes'),
    villages: () => ipcRenderer.invoke('world:villages'),
    relations: () => ipcRenderer.invoke('world:relations'),
  },
  sg1: {
    analyze: (input: Sg1Input) => ipcRenderer.invoke('sg1:analyze', input),
  },
  troops: {
    collectSummary: (kind: TroopKind) => ipcRenderer.invoke('troops:collect-summary', kind),
    collectMembers: (kind: TroopKind) => ipcRenderer.invoke('troops:collect-members', kind),
    status: () => ipcRenderer.invoke('troops:status'),
    get: (kind: TroopKind) => ipcRenderer.invoke('troops:get', kind),
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
