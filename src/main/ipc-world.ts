// Handlers IPC do módulo SG_1: dados do mundo (map dumps oficiais + diplomacia)
// e Análise de Aldeias e Distâncias. Nenhum handler muta o jogo — SG_1 é 100%
// leitura; falhas sempre voltam como erro legível.

import { ipcMain } from 'electron';
import type { Journal } from './journal';
import type { TwSessionManager } from './tw/session';
import type { RequestQueue } from './tw/request-queue';
import type { WorldDataService } from './services/world-data-service';
import type { Sg1Service } from './services/sg1-service';
import type { Sg1Input } from '@shared/types';

export interface WorldIpcDeps {
  twSession: TwSessionManager;
  queue: RequestQueue;
  journal: Journal;
  worldData: WorldDataService;
  sg1: Sg1Service;
}

function fail(context: string, error: unknown): never {
  throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

export function registerWorldIpc(deps: WorldIpcDeps): void {
  const { twSession, journal, worldData, sg1, queue } = deps;
  // `queue` entra SÓ no guard do refresh (C4): os dumps em si saem por fetch
  // direto (village.txt.gz exige bytes crus, fora do fetchForQueue da fila) —
  // mas não podem correr junto com uma coleta (pacing triplicado = risco).

  ipcMain.handle('world:refresh', async () => {
    if (queue.isRunning) {
      fail('Falha ao atualizar os dados do mundo', new Error('Uma operação está em andamento — aguarde terminar (ou cancele) antes de atualizar os dados do mundo.'));
    }
    // Ocupação real (C4): os dumps rodam fora da fila, mas marcam a fila
    // ocupada para que nenhuma coleta/mutação comece em paralelo.
    queue.beginOperation();
    try {
      const status = await worldData.refresh();
      const world = twSession.getStatus().world ?? '?';
      await journal.append(
        'read',
        'world-refresh',
        `mundo=${world} aldeias=${status.villageCount} jogadores=${status.playerCount} tribos=${status.allyCount}`,
        false,
      );
      return status;
    } catch (error) {
      fail('Falha ao atualizar os dados do mundo', error);
    } finally {
      queue.endOperation();
    }
  });

  ipcMain.handle('world:status', async () => {
    try {
      return await worldData.status();
    } catch (error) {
      fail('Falha ao ler o status do mundo', error);
    }
  });

  ipcMain.handle('world:tribes', async () => {
    try {
      return await worldData.tribes();
    } catch (error) {
      fail('Falha ao ler as tribos do mundo', error);
    }
  });

  ipcMain.handle('world:villages', async () => {
    try {
      return await worldData.villages();
    } catch (error) {
      fail('Falha ao ler as aldeias do mundo', error);
    }
  });

  ipcMain.handle('world:players', async () => {
    try {
      return await worldData.players();
    } catch (error) {
      fail('Falha ao ler os jogadores do mundo', error);
    }
  });

  ipcMain.handle('world:noble-minutes', async () => {
    try {
      return await sg1.nobleMinutesPerField();
    } catch (error) {
      fail('Falha ao obter a velocidade do nobre', error);
    }
  });

  ipcMain.handle('world:night-bonus', async () => {
    try {
      return await sg1.nightBonus();
    } catch (error) {
      fail('Falha ao obter o bônus noturno do mundo', error);
    }
  });

  ipcMain.handle('world:morale-info', async () => {
    try {
      return await sg1.moraleInfo();
    } catch (error) {
      fail('Falha ao obter a moral do mundo', error);
    }
  });

  ipcMain.handle('world:unit-pops', async () => {
    try {
      return await sg1.unitPops();
    } catch (error) {
      fail('Falha ao obter a população das unidades do mundo', error);
    }
  });

  ipcMain.handle('world:relations', async () => {
    if (queue.isRunning) {
      fail('Falha ao ler as relações diplomáticas', new Error('Uma operação está em andamento — aguarde terminar antes de ler a diplomacia.'));
    }
    // Ocupação (C4): a página de contratos é um GET direto fora da fila —
    // não pode correr junto com coleta/mutação (pacing somado = risco).
    queue.beginOperation();
    try {
      const relations = await worldData.relations();
      await journal.append('read', 'world-relations', `inimigos=${relations.enemies.length} aliados=${relations.allies.length} pna=${relations.naps.length}`, false);
      return relations;
    } catch (error) {
      fail('Falha ao ler as relações diplomáticas', error);
    } finally {
      queue.endOperation();
    }
  });

  ipcMain.handle('sg1:analyze', async (_event, input: Sg1Input) => {
    try {
      const result = await sg1.analyze(input);
      await journal.append(
        'read',
        'sg1-analyze',
        `tribo=${input.ownTag} inimigos=${input.enemyTags.join(';')} k=${input.kDesired.join(' ')} → próprias=${result.ownVillageCount} inimigas=${result.enemyVillageCount}`,
        false,
      );
      return result;
    } catch (error) {
      fail('Falha na Análise de Aldeias e Distâncias', error);
    }
  });
}