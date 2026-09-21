// Handlers IPC do Painel de Guerra ODA/ODD: kills ofensivos/defensivos por
// tribo a partir dos dumps oficiais do mundo (kill_att/def_tribe.txt.gz).
// Toda a regra (store 'oda-odd', guarda de 1 download/hora/arquivo, parse
// fail-closed, cap de 60 snapshots) vive no WorldDataService — aqui é só
// orquestração no padrão do ipc-world: o refresh toca o jogo (download de
// dump fora da fila), então consulta/marca a ocupação da RequestQueue (C4).
//
// GATE: `oda:status` é leitura de store local, SEM rede — fica FORA de
// CANAIS_PROTEGIDOS (padrão troopshistory). `oda:refresh` baixa arquivos do
// jogo e PRECISA do canal exato 'oda:refresh' na lista (src/main/index.ts) —
// um prefixo 'oda:' gatearia também o status local.

import { ipcMain } from 'electron';
import { erroFilaOcupada } from '@shared/error-catalog';
import type { OdaOddRefreshResult, OdaOddStatus } from '@shared/ipc-types';
import type { RequestQueue } from './tw/request-queue';
import type { WorldDataService } from './services/world-data-service';

export interface OdaIpcDeps {
  worldData: WorldDataService;
  queue: RequestQueue;
}

function fail(context: string, error: unknown): never {
  throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

export function registerOdaIpc(deps: OdaIpcDeps): void {
  const { worldData, queue } = deps;

  ipcMain.handle('oda:status', async (): Promise<OdaOddStatus> => {
    try {
      return await worldData.odaStatus();
    } catch (error) {
      fail('Falha ao ler o painel de OD', error);
    }
  });

  ipcMain.handle('oda:refresh', async (_event, tribeId: number): Promise<OdaOddRefreshResult> => {
    if (queue.isRunning) {
      fail('Falha ao atualizar os ODs', new Error(erroFilaOcupada('atualizar os ODs')));
    }
    // Ocupação real (C4): os dumps de kills rodam fora da fila (gzip/bytes
    // crus), mas marcam a fila ocupada para que nenhuma coleta/mutação comece
    // em paralelo — mesmo padrão do world:refresh.
    queue.beginOperation();
    try {
      return await worldData.odaRefresh(tribeId);
    } catch (error) {
      fail('Falha ao atualizar os ODs', error);
    } finally {
      queue.endOperation();
    }
  });
}
