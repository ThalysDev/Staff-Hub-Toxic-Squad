import { ipcMain, BrowserWindow, dialog } from 'electron';
import { writeFile, readFile } from 'node:fs/promises';
import { app } from 'electron';
import type { Journal } from './journal';
import type { OpArchiveService } from './services/op-archive-service';
import type { OpConferenceSnapshot, OpSaveInput, OpTotalsSnapshot } from '@shared/ipc-types';
import { serializeOpExport, parseOpExport } from '@shared/op-export';
import { parseDistribution } from '@shared/war-room';

export interface OpIpcDeps {
  journal: Journal;
  opArchive: OpArchiveService;
  /** Mundo ativo da sessão (para o cabeçalho do arquivo exportado). */
  world: () => string;
}

/** Resultado dos handlers com dialog: cancelamento NUNCA é erro silencioso. */
interface DialogCancel {
  ok: false;
  detail: string;
}

function parentOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

/** Nome de arquivo seguro (mesma política dos grupos). */
function sanitizeFileName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'op';
}

export function registerOpIpc(deps: OpIpcDeps): void {
  ipcMain.handle('oparchive:list', async () => {
    try {
      return await deps.opArchive.list();
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('oparchive:save', async (_event, input: OpSaveInput) => {
    try {
      return await deps.opArchive.save(input);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('oparchive:attach-conference', async (_event, id: string, conference: OpConferenceSnapshot, totals?: OpTotalsSnapshot[]) => {
    try {
      return await deps.opArchive.attachConference(id, conference, totals);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('oparchive:remove', async (_event, id: string) => {
    try {
      await deps.opArchive.remove(id);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('opshare:export', async (event, id: string): Promise<DialogCancel | { ok: true; path: string }> => {
    try {
      const ops = await deps.opArchive.list();
      const op = ops.find((candidate) => candidate.id === id);
      if (op === undefined) throw new Error('OP não encontrada no arquivo — recarregue a lista.');
      // A distribuição é "nick;alvos..." — cada (jogador, alvo) vira uma linha
      // do formato portável; a origem não existe no arquivo da OP (vazia).
      const distribution = parseDistribution(op.distribution).flatMap((player) =>
        player.coords.map((target) => ({ playerName: player.playerName, origin: '', target })),
      );
      const json = serializeOpExport({
        version: app.getVersion(),
        world: deps.world(),
        opTitle: op.title,
        targets: [...op.targets],
        distribution,
        ...(op.sendSchedule !== undefined ? { sendSchedule: op.sendSchedule } : {}),
      });
      const fileName = `op-${sanitizeFileName(op.title)}.json`;
      const parent = parentOf(event);
      const options = {
        title: 'Exportar OP',
        defaultPath: fileName,
        filters: [{ name: 'JSON', extensions: ['json'] as string[] }],
      };
      const { canceled, filePath } = parent !== undefined
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (canceled || filePath === undefined || filePath === '') {
        return { ok: false, detail: 'cancelado' };
      }
      await writeFile(filePath, json, 'utf-8');
      await deps.journal.append('system', 'opshare-export', `arquivo=${filePath}`, false);
      return { ok: true, path: filePath };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('opshare:import', async (event): Promise<DialogCancel | { ok: true; detail: string }> => {
    try {
      const parent = parentOf(event);
      const options = {
        title: 'Importar OP',
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
      const raw = await readFile(filePath, 'utf-8');
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Arquivo não é um JSON válido: ${filePath}`);
      }
      // Revalidação fail-closed do formato portável (parseOpExport valida tudo).
      const data = parseOpExport(json);
      // Distribuição volta ao formato de arquivo da OP ("nick;alvo alvo…"),
      // agrupando as linhas portáveis por jogador.
      const byPlayer = new Map<string, string[]>();
      for (const row of data.distribution) {
        const coords = byPlayer.get(row.playerName) ?? [];
        coords.push(row.target);
        byPlayer.set(row.playerName, coords);
      }
      const distributionText = [...byPlayer.entries()]
        .map(([playerName, coords]) => `${playerName};${coords.join(' ')}`)
        .join('\n');
      const entry = await deps.opArchive.save({
        title: data.opTitle,
        targets: [...data.targets],
        distribution: distributionText,
        ...(data.sendSchedule !== undefined ? { sendSchedule: data.sendSchedule } : {}),
      });
      await deps.journal.append('system', 'opshare-import', `arquivo=${filePath} op=${entry.title}`, false);
      return { ok: true, detail: `OP "${entry.title}" importada (${data.targets.length} alvos).` };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}
