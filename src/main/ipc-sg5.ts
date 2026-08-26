import { ipcMain } from 'electron';
import type { Journal } from './journal';
import type { Sg5Service, VerifyEntry } from './services/sg5-service';

export interface Sg5IpcDeps {
  sg5: Sg5Service;
  journal: Journal;
}

export function registerSg5Ipc(deps: Sg5IpcDeps): void {
  ipcMain.handle('sg5:verify', async (_event, entries: VerifyEntry[]) => {
    try {
      return await deps.sg5.verify(entries);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('sg5:totals', async (_event, coords: string[]) => {
    try {
      return await deps.sg5.totals(coords);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('sg5:scan-own', async () => {
    try {
      return await deps.sg5.scanOwnVillages();
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}
