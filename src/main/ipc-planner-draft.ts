// Handlers IPC do RASCUNHO do Planner de OP em Massa (grupos adicionados).
// As preferências por módulo têm teto de 20k por string — o rascunho real de
// uma OP da staff (2428 origens × 183 alvos) passa de 97k e era DESCARTADO
// com aviso de "grande demais" (perdia ao fechar o app). Aqui ele mora num
// JsonStore próprio (userData/stores/planner-draft.json), sem o teto de prefs.
// O shape dos grupos é validado pela UI (reviveGroupConfig) — o main guarda o
// array como veio, recusando apenas lixo estrutural (não-array/fora do teto).
//
// Store POR USUÁRIO do sistema (v0.36, mesmo esquema do ipc-preferences): a
// store legada 'planner-draft.json' é machine-wide — um 2º login na mesma
// máquina herdava o rascunho de OP do 1º. Com sessão ativa cada conta usa
// planner-draft.<nick>.json; sem sessão segue a legada, que também é SEMENTE
// (1º acesso de um usuário sem arquivo próprio copia a legada uma vez).

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
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

// ---------------------------------------------------------------------------
// Sessão do sistema → arquivo de store (mesmo esquema do ipc-preferences)
// ---------------------------------------------------------------------------

/** Nick da sessão do sistema lido direto de auth-session.json (o AuthService
 *  vive no ipc-auth/index.ts, que não chega aqui; o arquivo é a verdade em
 *  disco e a leitura é barata — arquivo pequeno, uma vez por interação). */
async function currentUserNick(): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(app.getPath('userData'), 'stores', 'auth-session.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { user?: { nick?: unknown } | null };
    const nick = parsed.user?.nick;
    return typeof nick === 'string' && nick !== '' ? nick : null;
  } catch {
    return null; // sem sessão (logout) ou arquivo ausente: store legada
  }
}

/** Parte de NOME DE ARQUIVO derivada do nick: só caracteres seguros + sufixo
 *  hash do nick CRU (nicks distintos tipo "a.b" e "a_b" não podem colidir no
 *  mesmo arquivo). */
function nickFilePart(nick: string): string {
  const base = (nick.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'user').slice(0, 40);
  let hash = 0;
  for (let index = 0; index < nick.length; index++) hash = (hash * 31 + nick.charCodeAt(index)) >>> 0;
  return `${base}-${hash.toString(36)}`;
}

export function registerPlannerDraftIpc(deps: PlannerDraftIpcDeps): void {
  const { journal } = deps;
  const legacyStore = new JsonStore<PlannerDraftState>('planner-draft', { groups: [] });
  /** Uma store por usuário (cache do processo; a chave é o nome de arquivo). */
  const userStores = new Map<string, JsonStore<PlannerDraftState>>();

  /** Store da requisição: por usuário quando há sessão do sistema; legada
   *  quando não (logout/boot/ler o arquivo deu erro). */
  async function storeInUse(): Promise<JsonStore<PlannerDraftState>> {
    const nick = await currentUserNick();
    if (nick === null) return legacyStore;
    const part = nickFilePart(nick);
    const cached = userStores.get(part);
    if (cached !== undefined) return cached;
    const store = new JsonStore<PlannerDraftState>(`planner-draft.${part}`, { groups: [] });
    // SEMENTE única por usuário: arquivo próprio AUSENTE + legada com grupos
    // → copia a legada (o rascunho atual do dono migra sem ele perceber).
    // Arquivo ausente é checado em disco (arquivo vazio ≠ ausente: quem limpou
    // o rascunho de propósito não o vê ressuscitar).
    const userFile = join(app.getPath('userData'), 'stores', `planner-draft.${part}.json`);
    try {
      await fs.stat(userFile);
    } catch {
      const legacy = await legacyStore.load();
      if (legacy.groups.length > 0) await store.save({ groups: legacy.groups }).catch(() => undefined);
    }
    userStores.set(part, store);
    return store;
  }
  // Serializa ler→gravar (mesma disciplina do preferences): dois saves em
  // rajada não podem partir da mesma base.
  let chain: Promise<unknown> = Promise.resolve();

  ipcMain.handle('plannerDraft:get', async (): Promise<unknown[]> => {
    try {
      const store = await storeInUse();
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
        const store = await storeInUse();
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
