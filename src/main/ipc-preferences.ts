// Handlers IPC de preferências por módulo (get/save/reset). As preferências
// moram num único JsonStore ('preferences') no formato { módulo: { chave: valor } }.
// Validação/sanitização ficam em @shared/preferences-rules; aqui é só orquestração:
// store + journal (best-effort) + serialização do ciclo ler→mesclar→gravar, para
// que dois saves seguidos nunca partam da mesma base e se sobrescrevam.

import { ipcMain } from 'electron';
import { isPreferenceModule, sanitizePrefPatch, validatePrefMerge } from '@shared/preferences-rules';
import { JsonStore } from './stores/json-store';
import type { Journal } from './journal';

export interface PreferencesIpcDeps {
  journal: Journal;
}

/** Saída de sanitizePrefPatch (Record<string, PrefValue>) — sem importar PrefValue direto. */
type SanitizedPrefs = ReturnType<typeof sanitizePrefPatch>;

function fail(context: string, error: unknown): never {
  throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Módulo fora da lista conhecida é recusado fail-closed — nunca lê/grava lixo. */
function assertModule(module: unknown): void {
  if (typeof module !== 'string' || !isPreferenceModule(module)) {
    throw new Error(`Módulo de preferências inválido: ${String(module)}`);
  }
}

export function registerPreferencesIpc(deps: PreferencesIpcDeps): void {
  const { journal } = deps;
  const store = new JsonStore<Record<string, Record<string, unknown>>>('preferences', {});
  // Serializa o ciclo ler→mesclar→gravar: o JsonStore já põe as ESCRITAS em fila,
  // mas o load de um save precisa terminar antes do merge do próximo — sem esta
  // cadeia, dois saves seguidos leriam a mesma base e o primeiro se perderia.
  let chain: Promise<unknown> = Promise.resolve();

  ipcMain.handle('preferences:get', async (_event, module: string): Promise<Record<string, unknown>> => {
    try {
      assertModule(module);
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
