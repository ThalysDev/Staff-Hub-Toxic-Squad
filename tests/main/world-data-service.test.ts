/**
 * Testes do WorldDataService focados no CANCELAMENTO do refresh (Mutation-Truth):
 * os downloads de dump correm FORA da RequestQueue (gzip/bytes crus), então o
 * serviço consulta o cancelamento da fila entre um download e outro. Estratégia
 * de mock idem sg6/sg7 (tests/main/electron-mock.ts) — login real de mentira,
 * Journal real em userData temporário.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { createElectronMock } = await import('./electron-mock');
  return createElectronMock();
});

import { disposeElectronMock, electronMockState, html, resetElectronMock, routeElectronFetch } from './electron-mock';
import { TwSessionManager } from '../../src/main/tw/session';
import { Journal } from '../../src/main/journal';
import { WorldDataService } from '../../src/main/services/world-data-service';

const WORLD = 'br142';
const SID = `0:${'3d'.repeat(32)}`;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/br142/${name}`, import.meta.url)), 'utf-8');
}

async function buildService(isCancelled: () => boolean): Promise<WorldDataService> {
  const twSession = new TwSessionManager();
  routeElectronFetch([{ match: 'screen=overview', handler: () => html(fixture('overview.html')) }]);
  const login = await twSession.loginWithSid(WORLD, SID);
  expect(login.ok).toBe(true);
  return new WorldDataService(twSession, new Journal(), isCancelled);
}

beforeEach(() => {
  resetElectronMock();
});

afterAll(() => {
  disposeElectronMock();
});

describe('WorldDataService.refresh (cancelamento entre downloads de dump)', () => {
  it('cancelado antes do primeiro download: aborta com erro LIMPO e SEM nenhum fetch de dump', async () => {
    const service = await buildService(() => true);

    await expect(service.refresh()).rejects.toThrow('Atualização dos dados do mundo cancelada.');
    // nenhum hit em /map/* — o cancelamento veio ANTES do tráfego
    expect(electronMockState.fetch.mock.calls.some(([url]) => String(url).includes('/map/'))).toBe(false);
  });

  it('sem cancelamento, o refresh segue para os downloads (o 4xx do dump vira erro de rede normal)', async () => {
    const service = await buildService(() => false);
    routeElectronFetch([{ match: '/map/village.txt.gz', handler: () => ({ ok: false, status: 404, body: '' }) }]);

    await expect(service.refresh()).rejects.toThrow('Falha ao baixar village.txt.gz: HTTP 404');
    expect(electronMockState.fetch.mock.calls.some(([url]) => String(url).includes('/map/'))).toBe(true);
  });
});
