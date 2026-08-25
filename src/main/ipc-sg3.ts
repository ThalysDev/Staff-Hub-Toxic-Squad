import { ipcMain } from 'electron';
import type { Journal } from './journal';
import type { TroopsService } from './services/troops-service';
import type { BlindCheckInput, BlindVillageResult } from '@shared/ipc-types';
import { checkBlind, blindBbcodeTable } from '@shared/sg3-engine';

export interface Sg3IpcDeps {
  troops: TroopsService;
  journal: Journal;
}

/** Handlers do SG_3 (verificação de blind) — rodam sobre a última coleta de defesa. */
export function registerSg3Ipc(deps: Sg3IpcDeps): void {
  ipcMain.handle('sg3:check-blind', async (_event, input: Omit<BlindCheckInput, 'defense'>) => {
    try {
      const defense = await deps.troops.getDefenseVillages();
      if (defense === null || defense.entries.length === 0) {
        throw new Error('Sem coleta de defesa em memória — use "Coletar Informações de Defesa" primeiro.');
      }
      const results: BlindVillageResult[] = checkBlind({ ...input, defense });
      const bbcode = blindBbcodeTable(results);
      await deps.journal.append('read', 'sg3-check-blind', `${results.length} aldeia(s) com falta (${input.countMode})`, true);
      return { results, bbcode };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}
