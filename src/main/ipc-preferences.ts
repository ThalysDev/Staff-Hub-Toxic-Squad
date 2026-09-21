// Handlers IPC de preferências por módulo (get/save/reset). As preferências
// moram num único JsonStore no formato { módulo: { chave: valor } }.
// Store POR USUÁRIO do sistema (v0.36): a store legada 'preferences.json' é
// machine-wide — numa máquina com duas contas do Staff Hub, a segunda herdava
// filtros/presets da primeira. Com sessão ativa cada conta usa
// preferences.<nick>.json (nick saneado + hash); sem sessão segue a legada.
// A legada também é SEMENTE: o 1º acesso de um usuário sem arquivo próprio
// copia a legada uma vez — o setup atual do dono migra sem ele perceber.
// Validação/sanitização ficam em @shared/preferences-rules; aqui é só orquestração:
// store + journal (best-effort) + serialização do ciclo ler→mesclar→gravar, para
// que dois saves seguidos nunca partam da mesma base e se sobrescrevam.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import { isPreferenceModule, sanitizePrefPatch, validatePrefMerge } from '@shared/preferences-rules';
import { JsonStore } from './stores/json-store';
import type { Journal } from './journal';

export interface PreferencesIpcDeps {
  journal: Journal;
}

/** Saída de sanitizePrefPatch (Record<string, PrefValue>) — sem importar PrefValue direto. */
type SanitizedPrefs = ReturnType<typeof sanitizePrefPatch>;

type PrefsFile = Record<string, Record<string, unknown>>;

function fail(context: string, error: unknown): never {
  throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Módulo fora da lista conhecida é recusado fail-closed — nunca lê/grava lixo. */
function assertModule(module: unknown): void {
  if (typeof module !== 'string' || !isPreferenceModule(module)) {
    throw new Error(`Módulo de preferências inválido: ${String(module)}`);
  }
}

// ---------------------------------------------------------------------------
// Sessão do sistema → arquivo de store (mesmo esquema do ipc-planner-draft)
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

export function registerPreferencesIpc(deps: PreferencesIpcDeps): void {
  const { journal } = deps;
  const legacyStore = new JsonStore<PrefsFile>('preferences', {});
  /** Uma store por usuário (cache do processo; a chave é o nome de arquivo). */
  const userStores = new Map<string, JsonStore<PrefsFile>>();

  /** Store da requisição: por usuário quando há sessão do sistema; legada
   *  quando não (logout/boot/ler o arquivo deu erro). */
  async function storeInUse(): Promise<JsonStore<PrefsFile>> {
    const nick = await currentUserNick();
    if (nick === null) return legacyStore;
    const part = nickFilePart(nick);
    const cached = userStores.get(part);
    if (cached !== undefined) return cached;
    const store = new JsonStore<PrefsFile>(`preferences.${part}`, {});
    // SEMENTE única por usuário: arquivo próprio AUSENTE + legada com conteúdo
    // → copia a legada uma vez (o que o dono já configurou migra sem ele
    // perceber). Arquivo ausente é checado em disco (arquivo vazio ≠ ausente:
    // quem zerou as prefs de propósito não as vê ressuscitar).
    const userFile = join(app.getPath('userData'), 'stores', `preferences.${part}.json`);
    try {
      await fs.stat(userFile);
    } catch {
      const legacy = await legacyStore.load();
      if (Object.keys(legacy).length > 0) await store.save(legacy).catch(() => undefined);
    }
    userStores.set(part, store);
    return store;
  }
  // Serializa o ciclo ler→mesclar→gravar: o JsonStore já põe as ESCRITAS em fila,
  // mas o load de um save precisa terminar antes do merge do próximo — sem esta
  // cadeia, dois saves seguidos leriam a mesma base e o primeiro se perderia.
  let chain: Promise<unknown> = Promise.resolve();

  ipcMain.handle('preferences:get', async (_event, module: string): Promise<Record<string, unknown>> => {
    try {
      assertModule(module);
      const store = await storeInUse();
      const prefs = await store.load();
      return prefs[module] ?? {};
    } catch (error) {
      fail('Falha ao ler as preferências', error);
    }
  });

  ipcMain.handle('preferences:save', async (_event, module: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      assertModule(module);
      const sanitized = sanitizePrefPatch(patch ?? {});
      const run = chain.then(async () => {
        const store = await storeInUse();
        const prefs = await store.load();
        const merged = validatePrefMerge((prefs[module] ?? {}) as SanitizedPrefs, sanitized);
        const next: Record<string, Record<string, unknown>> = { ...prefs, [module]: merged };
        await store.save(next);
        try {
          await journal.append('system', 'prefs-save', `modulo=${module} chaves=${Object.keys(sanitized).length}`, false);
        } catch {
          // Journal é best-effort: falha de disco no registro nunca derruba o save.
        }
        return merged;
      });
      // A cadeia interna engole a rejeição para os saves seguintes seguirem; o
      // caller desta chamada continua vendo o erro via `run` (await abaixo).
      chain = run.catch(() => undefined);
      return await run;
    } catch (error) {
      fail('Falha ao salvar as preferências', error);
    }
  });

  ipcMain.handle('preferences:reset', async (_event, module: string): Promise<void> => {
    try {
      assertModule(module);
      const run = chain.then(async () => {
        const store = await storeInUse();
        const prefs = await store.load();
        const modulePrefs = prefs[module];
        if (modulePrefs !== undefined) {
          // "Restaurar padrões do módulo" limpa os CAMPOS do formulário, mas
          // PRESERVA os presets nomeados (presets:*) — perder filtros curados
          // num reset de padrões seria perda de dado do usuário.
          const presets: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(modulePrefs)) {
            if (key.startsWith('presets:')) presets[key] = value;
          }
          const next: Record<string, Record<string, unknown>> = { ...prefs };
          delete next[module];
          if (Object.keys(presets).length > 0) next[module] = presets;
          await store.save(next);
        }
        try {
          await journal.append('system', 'prefs-reset', `modulo=${module}`, false);
        } catch {
          // Journal é best-effort: nunca derruba o reset.
        }
      });
      chain = run.catch(() => undefined);
      await run;
    } catch (error) {
      fail('Falha ao redefinir as preferências', error);
    }
  });
}
