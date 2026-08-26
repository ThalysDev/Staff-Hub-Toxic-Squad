import { ipcMain } from 'electron';
import type { Journal } from './journal';
import type { OpArchiveService } from './services/op-archive-service';
import type { OpConferenceSnapshot, OpSaveInput, OpTotalsSnapshot } from '@shared/ipc-types';

export interface OpIpcDeps {
  journal: Journal;
  opArchive: OpArchiveService;
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
}
