// Handlers IPC de SISTEMA: settings (pacing/URL de atualização, sanitizados na
// fronteira) e journal (trilha de auditoria). GATE: journal:clear está em
// CANAIS_PROTEGIDOS (index.ts) — este registrar SÓ pode ser chamado DEPOIS da
// instalação do wrapper do gate; settings:get/update e journal:list ficam
// LIVRES de propósito (diagnóstico e atualização funcionam sem sessão).

import { ipcMain } from 'electron';
import type { Journal } from './journal';
import type { RequestQueue } from './tw/request-queue';
import type { JsonStore } from './stores/json-store';
import type { AppSettings } from '@shared/ipc-types';

export interface SystemIpcDeps {
  settings: JsonStore<AppSettings>;
  journal: Journal;
  /** Fila de requisições (snapshot no registro — wireEvents roda antes) para o
   *  settings:update reaplicar o pacing ao vivo; null = fila ainda não existe. */
  queue: RequestQueue | null;
  /** Sanitização de settings da fronteira do main (defaults seguros — ver
   *  sanitizeSettings em index.ts; o piso humano de 350ms é política). */
  sanitize: (value: Partial<AppSettings>) => AppSettings;
}

export function registerSystemIpc(deps: SystemIpcDeps): void {
  const { settings, journal, queue, sanitize } = deps;

  ipcMain.handle('settings:get', async () => {
    const raw = await settings.load();
    const safe = sanitize(raw);
    return safe;
  });
  ipcMain.handle('settings:update', async (_event, patch: Record<string, unknown>) => {
    const current = await settings.load();
    const next = sanitize({ ...current, ...patch });
    await settings.save(next);
    queue?.updateSettings({
      minIntervalMs: next.requestMinIntervalMs,
      jitterMs: next.requestJitterMs,
      ceiling: next.requestCeiling,
    });
    await journal.append('system', 'settings-update', JSON.stringify(next), false);
    return next;
  });

  ipcMain.handle('journal:list', (_event, limit: number) => journal.list(limit));
  ipcMain.handle('journal:clear', () => journal.clear());
}
