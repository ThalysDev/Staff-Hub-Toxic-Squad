// Handlers IPC das coletas de tropas (SG_2) e defesa (SG_3): sumário por
// jogador, coleta completa por aldeia, status das datas e leitura do snapshot
// salvo. 100% leitura — nenhum handler muta o jogo; falhas sempre voltam como
// erro legível pt-BR.

import { ipcMain } from 'electron';
import type { Journal } from './journal';
import type { TwSessionManager } from './tw/session';
import type { RequestQueue } from './tw/request-queue';
import type { TroopsService } from './services/troops-service';
import type { TroopKind } from '@shared/ipc-types';

export interface TroopsIpcDeps {
  twSession: TwSessionManager;
  queue: RequestQueue;
  journal: Journal;
  troops: TroopsService;
}

function fail(context: string, error: unknown): never {
  throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

export function registerTroopsIpc(deps: TroopsIpcDeps): void {
  const { troops } = deps;
  // twSession/queue/journal ficam no contrato de deps para integração futura
  // (ex.: cancelamento da coleta); os handlers atuais só tocam o serviço.

  ipcMain.handle('troops:collect-summary', async (_event, kind: TroopKind) => {
    try {
      return await troops.collectSummary(kind);
    } catch (error) {
      fail('Falha ao coletar o resumo de tropas', error);
    }
  });

  ipcMain.handle('troops:collect-members', async (_event, kind: TroopKind) => {
    try {
      return await troops.collectAllMembers(kind);
    } catch (error) {
      fail('Falha ao coletar tropas por aldeia', error);
    }
  });

  ipcMain.handle('troops:status', async () => {
    try {
      return await troops.status();
    } catch (error) {
      fail('Falha ao ler o status das coletas', error);
    }
  });

  ipcMain.handle('troops:get', async (_event, kind: TroopKind) => {
    try {
      return await troops.get(kind);
    } catch (error) {
      fail('Falha ao ler as tropas salvas', error);
    }
  });
}