// Handlers IPC da sessão do JOGO (partição persist:tw): janela de login real,
// import de sid (dado colado pelo dono — nunca automatizado), status e logout.
// GATE: session:open-login e session:login-sid estão em CANAIS_PROTEGIDOS
// (index.ts) — este registrar SÓ pode ser chamado DEPOIS da instalação do
// wrapper do gate (ipcMain.handle sombreado), senão os canais ficam ungated.

import { ipcMain } from 'electron';
import type { Journal } from './journal';
import type { TwSessionManager } from './tw/session';

export interface SessionIpcDeps {
  twSession: TwSessionManager;
  journal: Journal;
  /** Janela principal VIVA no momento da chamada (session:open-login anexa o
   *  fluxo de login a ela) — lida por handler, nunca snapshotada no registro. */
  getMainWindow: () => Electron.BrowserWindow | null;
}

export function registerSessionIpc(deps: SessionIpcDeps): void {
  const { twSession, journal, getMainWindow } = deps;

  ipcMain.handle('session:open-login', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) twSession.openLogin(mainWindow);
  });
  ipcMain.handle('session:logout', () => twSession.logout());
  ipcMain.handle('session:status', () => twSession.getStatus());
  ipcMain.handle('session:login-sid', async (_event, world: string, sid: string) => {
    const result = await twSession.loginWithSid(world, sid);
    if (result.ok) {
      await journal.append('session', 'login-sid', `mundo=${result.status.world ?? '?'} jogador=${result.status.player ?? '?'}`, false);
    } else {
      await journal.append('session', 'login-sid-falhou', result.error, false);
    }
    return result;
  });
}
