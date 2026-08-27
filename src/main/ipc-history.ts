// Handlers IPC do HISTÓRICO DE TROPAS versionado (SG_2) e do DÉBITO DE BLIND
// por jogador (roadmap item 14, SG_3). Regras puras moram em
// @shared/snapshot-history (agregação por jogador, cap com rotação, ids) e
// @shared/blind-debt (mesclagem por rodada); aqui é só orquestração no padrão
// do ipc-templates: JsonStore próprio criado dentro do register (um por
// domínio: 'troops-history' e 'blind-debt') + journal best-effort +
// serialização do ciclo ler→aplicar→gravar por cadeia de promessas, para que
// dois arquivamentos/mesclagens seguidos nunca partam da mesma base e um
// perca a alteração do outro. worldHistory:list fica no ipc-world (junto do
// serviço de dados do mundo), não aqui.

import { ipcMain } from 'electron';
import {
  aggregateSnapshot,
  capHistory,
  newVersionId,
  type TroopsHistoryVersion,
} from '@shared/snapshot-history';
import { mergeBlindDebtRound, type BlindDebtEntry } from '@shared/blind-debt';
import type { TroopSnapshot } from '@shared/sg2-engine';
import { JsonStore } from './stores/json-store';
import type { Journal } from './journal';

/** Forma persistida do histórico (userData/stores/troops-history.json). */
interface TroopsHistoryStore {
  versions: TroopsHistoryVersion[];
}

/** Forma persistida do débito (userData/stores/blind-debt.json). */
interface BlindDebtStore {
  entries: BlindDebtEntry[];
}

export interface HistoryIpcDeps {
  journal: Journal;
}

function fail(context: string, error: unknown): never {
  throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

export function registerHistoryIpc(deps: HistoryIpcDeps): void {
  const { journal } = deps;
  const historyStore = new JsonStore<TroopsHistoryStore>('troops-history', { versions: [] });
  const debtStore = new JsonStore<BlindDebtStore>('blind-debt', { entries: [] });
  // O JsonStore já põe as ESCRITAS em fila, mas o load de um handler precisa
  // terminar antes do próximo — sem esta cadeia, dois archives seguidos leriam
  // a mesma base e o primeiro se perderia (mesma razão do templates).
  let chain: Promise<unknown> = Promise.resolve();

  ipcMain.handle('troopshistory:list', async (): Promise<TroopsHistoryVersion[]> => {
    try {
      const state = await historyStore.load();
      // Mais recente primeiro: o archive grava com unshift+cap, então a ordem
      // persistida já é a de exibição.
      return state.versions;
    } catch (error) {
      fail('Falha ao listar o histórico de tropas', error);
    }
  });

  ipcMain.handle('troopshistory:archive', async (_event, snapshot: TroopSnapshot): Promise<{ ok: boolean; detail: string }> => {
    try {
      const run = chain.then(async () => {
        // Snapshot sem entries lança PT-BR no engine (fail-closed: salvar versão
        // vazia esconderia regresso) — sobe contextualizado pelo catch do handler.
        const players = aggregateSnapshot(snapshot);
        const version: TroopsHistoryVersion = {
          id: newVersionId(),
          collectedAt: snapshot.collectedAt,
          source: snapshot.source,
          players,
        };
        const state = await historyStore.load();
        const versions = capHistory([version, ...state.versions]);
        await historyStore.save({ versions });
        const detail = `jogadores=${players.length}`;
        try {
          await journal.append('system', 'troopshistory-archive', detail, false);
        } catch {
          // Journal é best-effort: falha de disco no registro nunca derruba o arquivamento.
        }
        return { ok: true, detail };
      });
      // A cadeia interna engole a rejeição para as chamadas seguintes seguirem; o
      // caller desta chamada continua vendo o erro via `run` (await abaixo).
      chain = run.catch(() => undefined);
      return await run;
    } catch (error) {
      fail('Falha ao arquivar histórico', error);
    }
  });

  ipcMain.handle('troopshistory:remove', async (_event, id: string): Promise<void> => {
    try {
      const run = chain.then(async () => {
        const state = await historyStore.load();
        const versions = state.versions.filter((version) => version.id !== id);
        if (versions.length === state.versions.length) {
          // Regra idempotente: id que já sumiu é no-op — não grava, não journala.
          return;
        }
        await historyStore.save({ versions });
        try {
          await journal.append('system', 'troopshistory-remove', `id=${id}`, false);
        } catch {
          // Journal é best-effort: nunca derruba a remoção.
        }
      });
      chain = run.catch(() => undefined);
      await run;
    } catch (error) {
      fail('Falha ao remover a versão do histórico', error);
    }
  });

  ipcMain.handle('blinddebt:get', async (): Promise<BlindDebtEntry[]> => {
    try {
      const state = await debtStore.load();
      return state.entries;
    } catch (error) {
      fail('Falha ao ler o débito de blind', error);
    }
  });

  ipcMain.handle('blinddebt:apply', async (_event, round: { playerName: string; requested: number; sent: number }[]): Promise<BlindDebtEntry[]> => {
    try {
      const run = chain.then(async () => {
        const state = await debtStore.load();
        // Rodada inválida (nome/valores/cap) lança PT-BR na regra pura ANTES de
        // gravar — o catch do handler contextualiza.
        const entries = mergeBlindDebtRound(state.entries, round, new Date());
        await debtStore.save({ entries });
        try {
          await journal.append('system', 'blinddebt-apply', `rodada=${round.length}`, false);
        } catch {
          // Journal é best-effort: nunca derruba a mesclagem.
        }
        return entries;
      });
      chain = run.catch(() => undefined);
      return await run;
    } catch (error) {
      fail('Falha ao aplicar a rodada de blind', error);
    }
  });

  ipcMain.handle('blinddebt:clear', async (): Promise<void> => {
    try {
      const run = chain.then(async () => {
        const state = await debtStore.load();
        await debtStore.save({ entries: [] });
        try {
          await journal.append('system', 'blinddebt-clear', `jogadores=${state.entries.length}`, false);
        } catch {
          // Journal é best-effort: nunca derruba a limpeza.
        }
      });
      chain = run.catch(() => undefined);
      await run;
    } catch (error) {
      fail('Falha ao zerar o débito de blind', error);
    }
  });
}
