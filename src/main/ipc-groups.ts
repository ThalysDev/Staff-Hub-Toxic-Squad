import { promises as fs } from 'node:fs';
import { ipcMain, BrowserWindow, dialog } from 'electron';
import type { Journal } from './journal';
import type { GroupsService } from './services/groups-service';
import type { GroupSaveInput } from '@shared/groups-rules';

export interface GroupsIpcDeps {
  journal: Journal;
  groups: GroupsService;
}

/** Resultado dos handlers com dialog: cancelamento NUNCA é erro silencioso. */
interface DialogCancel {
  ok: false;
  detail: 'cancelado';
}

/** Janela chamadora como parent (modal correto) ou undefined se já fechada. */
function parentOf(event: Electron.IpcMainInvokeEvent): Electron.BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

/** Remove tudo que não é seguro em nome de arquivo (mantém letras/números/-/_). */
function sanitizeFileName(value: string): string {
  return value.replace(/[^\p{L}\p{N}\-_]+/gu, '-').replace(/^-+|-+$/g, '') || 'grupo';
}

export function registerGroupsIpc(deps: GroupsIpcDeps): void {
  ipcMain.handle('groups:list', async () => {
    try {
      return await deps.groups.list();
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('groups:save', async (_event, input: GroupSaveInput) => {
    try {
      return await deps.groups.save(input);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('groups:remove', async (_event, id: string) => {
    try {
      await deps.groups.remove(id);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('groups:export', async (event, id: string): Promise<DialogCancel | { ok: true; path: string }> => {
    try {
      const payload = await deps.groups.exportPayload(id);
      // O payload foi gerado por nós (groupPayloadForExport); extrair nome/mundo
      // dele para montar o defaultPath sugerido no diálogo.
      const header = JSON.parse(payload) as { nome?: unknown; mundo?: unknown };
      const nome = typeof header.nome === 'string' ? header.nome : '';
      const mundo = typeof header.mundo === 'string' ? header.mundo : '';
      const fileName = `grupo-${sanitizeFileName(nome || 'grupo')}-${sanitizeFileName(mundo || 'mundo')}.json`;
      const parent = parentOf(event);
      const options = {
        title: 'Exportar grupo',
        defaultPath: fileName,
        filters: [{ name: 'JSON', extensions: ['json'] as string[] }],
      };
      const { canceled, filePath } = parent !== undefined
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (canceled || filePath === undefined || filePath === '') {
        return { ok: false, detail: 'cancelado' };
      }
      await fs.writeFile(filePath, payload, 'utf-8');
      await deps.journal.append('system', 'groups-export', `arquivo=${filePath}`, false);
      return { ok: true, path: filePath };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('groups:import', async (event): Promise<DialogCancel | { ok: true; entry: Awaited<ReturnType<GroupsService['importPayload']>> }> => {
    try {
      const parent = parentOf(event);
      const options = {
        title: 'Importar grupo',
        filters: [{ name: 'JSON', extensions: ['json'] as string[] }],
        properties: ['openFile'] as Array<'openFile'>,
      };
      const { canceled, filePaths } = parent !== undefined
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (canceled || filePaths.length === 0) {
        return { ok: false, detail: 'cancelado' };
      }
      const filePath = filePaths[0]!;
      const raw = await fs.readFile(filePath, 'utf-8');
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Arquivo não é um JSON válido: ${filePath}`);
      }
      const entry = await deps.groups.importPayload(json);
      await deps.journal.append('system', 'groups-import-file', `arquivo=${filePath}`, false);
      return { ok: true, entry };
    } catch (error) {
      // Erro de parse/validação do groups-rules sobe com a mensagem PT-BR original.
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}
