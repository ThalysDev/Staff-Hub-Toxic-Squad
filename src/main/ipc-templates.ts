// Handlers IPC da biblioteca de TEMPLATES DE MP: mensagens padrão reutilizadas
// no envio de MPs do SG_6 (assunto+corpo) e no pacote do SG_4 (só corpo).
// Regras puras (sanitização, teto de 50, default único, remoção idempotente)
// moram em @shared/mp-templates-rules; aqui é só orquestração no padrão do
// ipc-preferences: JsonStore próprio 'mp-templates' ({templates: []}) criado
// dentro do register + journal best-effort + serialização do ciclo
// ler→aplicar→gravar por cadeia de promessas, para que dois saves seguidos
// nunca partam da mesma base e um perca a alteração do outro.

import { ipcMain } from 'electron';
import {
  type MpTemplateEntry,
  type MpTemplateSaveInput,
  markDefault,
  removeTemplate,
  SEED_MP_TEMPLATES,
  sortTemplatesNewestFirst,
  upsertTemplate,
} from '@shared/mp-templates-rules';
import { JsonStore } from './stores/json-store';
import type { Journal } from './journal';

/** Forma persistida da biblioteca (userData/stores/mp-templates.json). */
interface TemplatesStore {
  templates: MpTemplateEntry[];
}

export interface TemplatesIpcDeps {
  journal: Journal;
}

function fail(context: string, error: unknown): never {
  throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Localiza no resultado qual entrada foi salva: id mantido na edição; id novo
 * (ausente da lista anterior) na criação. Impossível na prática falhar —
 * fail-closed por garantia.
 */
function findSaved(prev: MpTemplateEntry[], next: MpTemplateEntry[], input: MpTemplateSaveInput): MpTemplateEntry {
  const saved = input.id !== undefined
    ? next.find((template) => template.id === input.id)
    : next.find((template) => !prev.some((old) => old.id === template.id));
  if (saved === undefined) {
    throw new Error('Template salvo não encontrado após a gravação — recarregue a biblioteca.');
  }
  return saved;
}

export function registerTemplatesIpc(deps: TemplatesIpcDeps): void {
  const { journal } = deps;
  const store = new JsonStore<TemplatesStore>('mp-templates', { templates: [] });
  // O JsonStore já põe as ESCRITAS em fila, mas o load de um save precisa
  // terminar antes do próximo — sem esta cadeia, dois saves seguidos leriam a
  // mesma base e o primeiro se perderia (mesma razão do preferences).
  let chain: Promise<unknown> = Promise.resolve();

  // Seeds da v0.33 (modelos aprovados pelo dono: Diretrizes de OP + Cobrança
  // de faltas): instalados UMA vez quando a biblioteca está VAZIA — usuário
  // que já curou a própria biblioteca nunca é sobrescrito. Best-effort: falha
  // aqui só significa começar sem modelos padrão.
  chain = chain.then(async () => {
    try {
      const state = await store.load();
      if (state.templates.length > 0) return;
      let templates = state.templates;
      for (const seed of SEED_MP_TEMPLATES) templates = upsertTemplate(templates, seed, new Date());
      await store.save({ templates });
      try {
        await journal.append('system', 'templates-seed', `seeds=${SEED_MP_TEMPLATES.length}`, false);
      } catch {
        // Journal é best-effort.
      }
    } catch {
      // Seed é conveniência: nunca derruba o registro dos handlers.
    }
  });

  ipcMain.handle('templates:list', async (): Promise<MpTemplateEntry[]> => {
    try {
      const state = await store.load();
      return sortTemplatesNewestFirst(state.templates);
    } catch (error) {
      fail('Falha ao listar os templates de MP', error);
    }
  });

  ipcMain.handle('templates:save', async (_event, input: MpTemplateSaveInput): Promise<MpTemplateEntry> => {
    try {
      const run = chain.then(async () => {
        const state = await store.load();
        const existed = input.id !== undefined && state.templates.some((template) => template.id === input.id);
        const next = upsertTemplate(state.templates, input, new Date());
        await store.save({ templates: next });
        const saved = findSaved(state.templates, next, input);
        try {
          await journal.append(
            'system',
            'templates-save',
            `nome=${saved.name} (id=${saved.id}) ${existed ? 'atualizado' : 'novo'}${saved.isDefault ? ' default' : ''}`,
            false,
          );
        } catch {
          // Journal é best-effort: falha de disco no registro nunca derruba o save.
        }
        return saved;
      });
      // A cadeia interna engole a rejeição para as chamadas seguintes seguirem; o
      // caller desta chamada continua vendo o erro via `run` (await abaixo).
      chain = run.catch(() => undefined);
      return await run;
    } catch (error) {
      fail('Falha ao salvar o template de MP', error);
    }
  });

  ipcMain.handle('templates:remove', async (_event, id: string): Promise<void> => {
    try {
      const run = chain.then(async () => {
        const state = await store.load();
        const removed = state.templates.find((template) => template.id === id);
        if (removed === undefined) {
          // Regra pura idempotente: id que já sumiu é no-op — não grava, não journala.
          return;
        }
        await store.save({ templates: removeTemplate(state.templates, id) });
        try {
          await journal.append(
            'system',
            'templates-remove',
            `nome=${removed.name} (id=${id})${removed.isDefault ? ' default' : ''}`,
            false,
          );
        } catch {
          // Journal é best-effort: nunca derruba a remoção.
        }
      });
      chain = run.catch(() => undefined);
      await run;
    } catch (error) {
      fail('Falha ao remover o template de MP', error);
    }
  });

  ipcMain.handle('templates:set-default', async (_event, id: string): Promise<MpTemplateEntry | null> => {
    try {
      const run = chain.then(async () => {
        const state = await store.load();
        // id inexistente lança PT-BR na regra pura (fail-closed, nunca silencioso).
        const next = markDefault(state.templates, id);
        await store.save({ templates: next });
        const marked = next.find((template) => template.id === id);
        if (marked === undefined) {
          throw new Error('Template não encontrado após marcar o default — recarregue a biblioteca.');
        }
        try {
          await journal.append('system', 'templates-default', `nome=${marked.name} (id=${id})`, false);
        } catch {
          // Journal é best-effort: nunca derruba a marcação.
        }
        // O contrato IPC prevê null, mas com id válido o default sempre existe.
        return marked;
      });
      chain = run.catch(() => undefined);
      return await run;
    } catch (error) {
      fail('Falha ao marcar o template default', error);
    }
  });
}
