// Handlers IPC do auth (v0.30). O renderer nunca vê tokens — só estado/ações.

import { ipcMain } from 'electron';
import type { AuthService } from './services/auth-service';

export interface AuthIpcDeps {
  auth: AuthService;
}

export function registerAuthIpc(deps: AuthIpcDeps): void {
  const { auth } = deps;

  ipcMain.handle('auth:status', () => auth.status());
  ipcMain.handle('auth:login', (_e, nick: string, senha: string) => auth.login(nick, senha));
  ipcMain.handle('auth:register', (_e, nick: string, senha: string) => auth.register(nick, senha));
  ipcMain.handle('auth:logout', () => auth.logout());
  ipcMain.handle('auth:refresh-now', () => auth.refreshNow());
  ipcMain.handle('auth:trocar-senha', (_e, atual: string, nova: string) => auth.trocarSenha(atual, nova));
  ipcMain.handle('auth:admin-users', () => auth.adminUsers());
  ipcMain.handle('auth:admin-acao', (_e, id: string, acao: 'aprovar' | 'banir' | 'reabilitar') =>
    auth.adminUsersAcao(id, acao),
  );
  ipcMain.handle('auth:admin-resetar-senha', (_e, id: string) => auth.adminResetarSenha(id));
  ipcMain.handle('auth:admin-audit', () => auth.adminAudit());
  // Chaves in-game: mesmos canais auth:* — gated pelo ROLE no servidor
  // (exigirAdmin), fora de CANAIS_PROTEGIDOS como o resto do auth.
  ipcMain.handle('auth:keys-listar', () => auth.adminKeysListar());
  ipcMain.handle('auth:keys-emitir', (_e, ownerNick: string, dias: number, tier: 'staff' | 'lider') =>
    auth.adminKeysEmitir(ownerNick, dias, tier),
  );
  ipcMain.handle('auth:keys-revogar', (_e, id: string) => auth.adminKeysRevogar(id));
}
