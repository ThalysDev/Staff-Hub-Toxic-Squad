import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  BlindCheckInput,
  BlindVillageResult,
  OpArchiveEntry,
  OpConferenceSnapshot,
  OpSaveInput,
  OpTotalsSnapshot,
  QueueProgress,
  SessionStatus,
  Sg1Input,
  StaffHubApi,
  TroopKind,
} from '@shared/ipc-types';

/**
 * invoke com envelope de erro legível (C10): o Electron prefixa erros do main
 * com "Error invoking remote method 'canal': Error: …" — o usuário só precisa
 * da mensagem PT-BR que o service lançou. O tipo T é inferido do contrato
 * (satisfies StaffHubApi) em cada call site.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''));
  }
}

const api = {
  session: {
    openLogin: () => invoke('session:open-login'),
    logout: () => invoke('session:logout'),
    status: () => invoke('session:status'),
    loginWithSid: (world: string, sid: string) => invoke('session:login-sid', world, sid),
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch: Partial<AppSettings>) => invoke('settings:update', patch),
  },
  journal: {
    list: (limit: number) => invoke('journal:list', limit),
    clear: () => invoke('journal:clear'),
  },
  app: {
    getVersion: () => invoke('app:get-version'),
  },
  queue: {
    cancel: () => invoke('queue:cancel'),
  },
  updater: {
    check: () => invoke('updater:check'),
    downloadAndPrepare: () => invoke('updater:download-prepare'),
    restartToUpdate: () => invoke('updater:restart'),
  },
  dev: {
    captureFixture: (name: string, url: string) => invoke('dev:capture-fixture', name, url),
  },
  world: {
    refresh: () => invoke('world:refresh'),
    status: () => invoke('world:status'),
    tribes: () => invoke('world:tribes'),
    villages: () => invoke('world:villages'),
    players: () => invoke('world:players'),
    nobleMinutes: () => invoke('world:noble-minutes'),
    nightBonus: () =>
      invoke('world:night-bonus') as Promise<{ active: boolean; startHour: number; endHour: number }>,
    relations: () => invoke('world:relations'),
  },
  sg1: {
    analyze: (input: Sg1Input) => invoke('sg1:analyze', input),
  },
  troops: {
    collectSummary: (kind: TroopKind) => invoke('troops:collect-summary', kind),
    collectMembers: (kind: TroopKind) => invoke('troops:collect-members', kind),
    status: () => invoke('troops:status'),
    get: (kind: TroopKind) => invoke('troops:get', kind),
  },
  sg3: {
    checkBlind: (input: Omit<BlindCheckInput, 'defense'>) =>
      invoke('sg3:check-blind', input) as Promise<{ results: BlindVillageResult[]; bbcode: string }>,
    supporters: (coords: string[]) => invoke('sg3:supporters', coords) as Promise<import('@shared/types').SupportersResult>,
  },
  sg7: {
    conference: (threadUrl: string) => invoke("sg7:conference", threadUrl),
    adjust: (threadUrl: string, confirm: boolean) => invoke("sg7:adjust", threadUrl, confirm),
    deletePosts: (threadUrl: string, postIds: number[], confirm: boolean) => invoke("sg7:delete-posts", threadUrl, postIds, confirm),
    postPlan: (input: { threadUrl: string; bbcode: string }, confirm: boolean) =>
      invoke("sg7:post-plan", input, confirm) as Promise<{ ok: boolean; detail: string }>,
  },
  sg6: {
    reserveMass: (coords: string[], confirm: boolean) => invoke("sg6:reserve-mass", coords, confirm),
    sendMps: (
      input: { subject: string; body: string; entries: { playerName: string; coords: string[]; horarios?: string[] }[] },
      confirm: boolean,
    ) => invoke("sg6:send-mps", input, confirm),
  },
  opArchive: {
    list: () => invoke('oparchive:list') as Promise<OpArchiveEntry[]>,
    save: (input: OpSaveInput) => invoke('oparchive:save', input) as Promise<OpArchiveEntry>,
    attachConference: (id: string, conference: OpConferenceSnapshot, totals?: OpTotalsSnapshot[]) =>
      invoke('oparchive:attach-conference', id, conference, totals) as Promise<OpArchiveEntry>,
    remove: (id: string) => invoke('oparchive:remove', id) as Promise<void>,
  },
  sg5: {
    verify: (entries: import('@shared/ipc-types').Sg5VerifyEntry[]) =>
      invoke('sg5:verify', entries) as Promise<import('@shared/ipc-types').Sg5VerifyResult>,
    totals: (coords: string[]) =>
      invoke('sg5:totals', coords) as Promise<import('@shared/ipc-types').Sg5TotalsResult>,
    scanOwnVillages: () =>
      invoke('sg5:scan-own') as Promise<import('@shared/ipc-types').Sg5VerifyResult & { player: string }>,
  },
  window: {
    minimize: () => invoke('win:min'),
    toggleMaximize: () => invoke('win:max-toggle') as Promise<boolean>,
    close: () => invoke('win:close'),
    isMaximized: () => invoke('win:is-max') as Promise<boolean>,
  },
  events: {
    onQueueProgress: (cb: (progress: QueueProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: QueueProgress) => cb(progress);
      ipcRenderer.on('queue:progress', listener);
      return () => ipcRenderer.removeListener('queue:progress', listener);
    },
    onWindowMaxChanged: (cb: (maximized: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) => cb(maximized);
      ipcRenderer.on('win:max-changed', listener);
      return () => ipcRenderer.removeListener('win:max-changed', listener);
    },
    onUpdaterProgress: (cb: (progress: import('@shared/ipc-types').UpdateProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: import('@shared/ipc-types').UpdateProgress) => cb(progress);
      ipcRenderer.on('updater:progress', listener);
      return () => ipcRenderer.removeListener('updater:progress', listener);
    },
    onSessionChanged: (cb: (status: SessionStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: SessionStatus) => cb(status);
      ipcRenderer.on('session:changed', listener);
      return () => ipcRenderer.removeListener('session:changed', listener);
    },
  },
} satisfies StaffHubApi;

contextBridge.exposeInMainWorld('staffhub', api);
