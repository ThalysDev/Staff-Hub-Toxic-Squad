// Store do rascunho do Planner (v0.32): round-trip real em disco (JsonStore
// com userData temporário), fail-closed contra lixo estrutural e teto de 2 MB.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { createElectronMock } = await import('./electron-mock');
  return createElectronMock();
});

import { disposeElectronMock, resetElectronMock } from './electron-mock';
import { ipcMain } from 'electron';
import { registerPlannerDraftIpc } from '../../src/main/ipc-planner-draft';
import { Journal } from '../../src/main/journal';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function handlerDe(canal: string): Handler {
  const calls = (ipcMain.handle as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const call = calls.find(([registered]) => registered === canal);
  if (call === undefined) throw new Error(`handler "${canal}" não registrado`);
  return call[1] as Handler;
}

let journal: Journal;

beforeAll(async () => {
  resetElectronMock();
  journal = new Journal();
  await journal.load();
  registerPlannerDraftIpc({ journal });
});

afterAll(() => {
  disposeElectronMock();
});

describe('planner-draft store', () => {
  it('get em store novo devolve lista vazia', async () => {
    await expect(handlerDe('plannerDraft:get')({})).resolves.toEqual([]);
  });

  it('save + get round-trip preserva os grupos como gravados', async () => {
    const groups = [
      { id: 'g1', nome: 'full', origins: [{ coord: '500|500', x: 500, y: 500 }], originQuotas: [1] },
      { id: 'g2', nome: 'fake', origins: [], originQuotas: [] },
    ];
    await expect(handlerDe('plannerDraft:save')({}, groups)).resolves.toEqual(groups);
    await expect(handlerDe('plannerDraft:get')({})).resolves.toEqual(groups);
  });

  it('recusa não-array (fail-closed, nunca grava lixo)', async () => {
    await expect(handlerDe('plannerDraft:save')({}, { groups: [] })).rejects.toThrow(/Rascunho inválido/);
    await expect(handlerDe('plannerDraft:save')({}, 'x')).rejects.toThrow(/Rascunho inválido/);
    // O que estava gravado continua intacto.
    await expect(handlerDe('plannerDraft:get')({})).resolves.toHaveLength(2);
  });

  it('recusa rascunho acima do teto de 2 MB', async () => {
    const pesado = [{ id: 'g', nome: 'x', payload: 'a'.repeat(2_100_000) }];
    await expect(handlerDe('plannerDraft:save')({}, pesado)).rejects.toThrow(/grande demais/);
  });

  it('save vazio limpa o rascunho (botão "Limpar todos" persiste)', async () => {
    await expect(handlerDe('plannerDraft:save')({}, [])).resolves.toEqual([]);
    await expect(handlerDe('plannerDraft:get')({})).resolves.toEqual([]);
  });
});
