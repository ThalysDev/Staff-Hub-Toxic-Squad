// Handlers IPC do RASCUNHO do Planner de OP em Massa (grupos adicionados).
// As preferências por módulo têm teto de 20k por string — o rascunho real de
// uma OP da staff (2428 origens × 183 alvos) passa de 97k e era DESCARTADO
// com aviso de "grande demais" (perdia ao fechar o app). Aqui ele mora num
// JsonStore próprio (userData/stores/planner-draft.json), sem o teto de prefs.
// O shape dos grupos é validado pela UI (reviveGroupConfig) — o main guarda o
// array como veio, recusando apenas lixo estrutural (não-array/fora do teto).

import { ipcMain } from 'electron';
import { JsonStore } from './stores/json-store';
import type { Journal } from './journal';

export interface PlannerDraftIpcDeps {
  journal: Journal;
}

/** Teto sanitário do rascunho serializado (2 MB ≈ 20 grupos na escala real). */
const PLANNER_DRAFT_MAX_JSON = 2_000_000;

interface PlannerDraftState {
  groups: unknown[];
}

function fail(context: string, error: unknown): never {
  throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

export function registerPlannerDraftIpc(deps: PlannerDraftIpcDeps): void {
  const { journal } = deps;
  const store = new JsonStore<PlannerDraftState>('planner-draft', { groups: [] });
  // Serializa ler→gravar (mesma disciplina do preferences): dois saves em
  // rajada não podem partir da mesma base.
  let chain: Promise<unknown> = Promise.resolve();

  ipcMain.handle('plannerDraft:get', async (): Promise<unknown[]> => {
    try {
      const state = await store.load();
      return Array.isArray(state.groups) ? state.groups : [];
    } catch (error) {
      fail('Falha ao ler o rascunho do planner', error);
    }
  });

  ipcMain.handle('plannerDraft:save', async (_event, groups: unknown): Promise<unknown[]> => {
    try {
      if (!Array.isArray(groups)) {
        throw new Error('Rascunho inválido — esperada uma lista de grupos.');
      }
      const json = JSON.stringify(groups);
      if (json.length > PLANNER_DRAFT_MAX_JSON) {
        throw new Error(
          `Rascunho grande demais (${(json.length / 1000).toFixed(0)}k caracteres) — reduza as coordenadas dos grupos.`,
        );
      }
      const run = chain.then(async () => {
        await store.save({ groups });
        try {
          await journal.append('system', 'planner-draft-save', `grupos=${groups.length}`, false);
        } catch {
          // Journal é best-effort: falha de registro nunca derruba o save.
        }
        return groups;
      });
      chain = run.catch(() => undefined);
      return await run;
    } catch (error) {
      fail('Falha ao salvar o rascunho do planner', error);
    }
  });
}
