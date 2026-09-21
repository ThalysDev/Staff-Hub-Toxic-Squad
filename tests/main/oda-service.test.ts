/**
 * Testes do Painel de Guerra ODA/ODD no WorldDataService: download dos dumps
 * oficiais kill_att/def_tribe.txt.gz (gzip), parse fail-closed, guarda de
 * 1 download/hora/arquivo (reuso do cache) e persistência no store 'oda-odd'.
 * Estratégia de mock idem world-data-service.test.ts (tests/main/electron-mock.ts)
 * — login real de mentira, Journal/JsonStore reais em userData temporário.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { createElectronMock } = await import('./electron-mock');
  return createElectronMock();
});

import {
  disposeElectronMock,
  electronMockState,
  fetchCallCount,
  html,
  resetElectronMock,
  routeElectronFetch,
  type FetchRoute,
} from './electron-mock';
import { TwSessionManager } from '../../src/main/tw/session';
import { Journal } from '../../src/main/journal';
import { WorldDataService } from '../../src/main/services/world-data-service';

const WORLD = 'br142';
const SID = `0:${'3d'.repeat(32)}`;
const TRIBE_ID = 7;

/** TSV de kills da tribo 7 (e de outras para o ranking ter ruído real). */
function killsTsv(tribeKills: number): string {
  return `1\t7\tToxic Squad\t${tribeKills}\n2\t42\tRivais BR\t500\n3\t99\tNeutros\t10\n`;
}

/** Corpo gzip do dump como string latin1 (round-trip exato no arrayBuffer do mock). */
function gz(content: string): string {
  return gzipSync(Buffer.from(content, 'utf-8')).toString('latin1');
}

function killRoutes(attKills: number, defKills: number): FetchRoute[] {
  return [
    { match: '/map/kill_att_tribe.txt.gz', handler: () => ({ ok: true, status: 200, body: gz(killsTsv(attKills)) }) },
    { match: '/map/kill_def_tribe.txt.gz', handler: () => ({ ok: true, status: 200, body: gz(killsTsv(defKills)) }) },
  ];
}

/** Login (route overview) + rotas extras registradas JUNTAS: o
 *  routeElectronFetch substitui a implementação, então não podem ser
 *  registradas em duas chamadas separadas se ambas serão usadas. Devolve
 *  também a sessão para instanciar um SEGUNDO serviço (novo JsonStore lê o
 *  store do disco — o cache em memória do primeiro não vê reescrita). */
async function buildService(routes: FetchRoute[] = []): Promise<{ service: WorldDataService; twSession: TwSessionManager }> {
  const twSession = new TwSessionManager();
  const overview = readFileSync(fileURLToPath(new URL('../fixtures/br142/overview.html', import.meta.url)), 'utf-8');
  routeElectronFetch([{ match: 'screen=overview', handler: () => html(overview) }, ...routes]);
  const login = await twSession.loginWithSid(WORLD, SID);
  expect(login.ok).toBe(true);
  return { service: new WorldDataService(twSession, new Journal(), () => false), twSession };
}

/** Reescreve a marca de último download do store (simula o tempo passando). */
function ageLastFetch(hoursAgo: number): void {
  const file = join(electronMockState.userDataDir, 'stores', 'oda-odd.json');
  const store = JSON.parse(readFileSync(file, 'utf-8')) as { lastFetch: Record<string, string> };
  const iso = new Date(Date.now() - hoursAgo * 60 * 60_000).toISOString();
  store.lastFetch = { att: iso, def: iso };
  writeFileSync(file, JSON.stringify(store), 'utf-8');
}

beforeEach(() => {
  resetElectronMock();
});

afterAll(() => {
  disposeElectronMock();
});

describe('WorldDataService.odaRefresh (Painel de Guerra ODA/ODD)', () => {
  it('baixa os dois arquivos, acha a tribo e arquiva o primeiro snapshot (delta null)', async () => {
    const { service } = await buildService(killRoutes(91_234, 80_901));

    const result = await service.odaRefresh(TRIBE_ID);
    expect(result.tribeId).toBe(TRIBE_ID);
    expect(result.outcomes).toEqual([
      { kind: 'att', source: 'fetched', kills: 91_234, delta: null },
      { kind: 'def', source: 'fetched', kills: 80_901, delta: null },
    ]);
    expect(fetchCallCount('/map/kill_att_tribe.txt.gz')).toBe(1);
    expect(fetchCallCount('/map/kill_def_tribe.txt.gz')).toBe(1);

    const status = await service.odaStatus();
    expect(status.world).toBe(WORLD);
    expect(status.allyTribeId).toBe(TRIBE_ID);
    expect(status.history.att).toHaveLength(1);
    expect(status.history.def[0]?.kills).toBe(80_901);
    expect(status.lastFetch.att).not.toBe('');
  });

  it('refresh dentro de 1h reusa o cache dos dois arquivos (zero novo download)', async () => {
    const { service } = await buildService(killRoutes(91_234, 80_901));
    await service.odaRefresh(TRIBE_ID);

    const second = await service.odaRefresh(TRIBE_ID);
    expect(second.outcomes).toEqual([
      { kind: 'att', source: 'cache', kills: 91_234, delta: null },
      { kind: 'def', source: 'cache', kills: 80_901, delta: null },
    ]);
    expect(fetchCallCount('/map/kill_att_tribe.txt.gz')).toBe(1);
    expect(fetchCallCount('/map/kill_def_tribe.txt.gz')).toBe(1);
  });

  it('fora da janela de 1h baixa de novo e calcula o delta vs a leitura anterior', async () => {
    const { service, twSession } = await buildService(killRoutes(91_234, 80_901));
    await service.odaRefresh(TRIBE_ID);
    ageLastFetch(2);

    routeElectronFetch(killRoutes(92_500, 80_700));
    // Serviço NOVO: o JsonStore do primeiro tem o store em cache em memória —
    // só um load fresco vê o lastFetch reescrito no disco.
    const secondService = new WorldDataService(twSession, new Journal(), () => false);
    const second = await secondService.odaRefresh(TRIBE_ID);
    expect(second.outcomes).toEqual([
      { kind: 'att', source: 'fetched', kills: 92_500, delta: 1_266 },
      { kind: 'def', source: 'fetched', kills: 80_700, delta: -201 },
    ]);
    expect(fetchCallCount('/map/kill_att_tribe.txt.gz')).toBe(2);
    const status = await secondService.odaStatus();
    expect(status.history.att).toHaveLength(2);
  });

  it('tribo ausente do ranking: falha PT-BR por arquivo e NADA é gravado', async () => {
    const { service } = await buildService(killRoutes(91_234, 80_901));

    await expect(service.odaRefresh(1234)).rejects.toThrow('Falha ao atualizar os ODs da tribo 1234');
    const status = await service.odaStatus();
    expect(status.history.att).toHaveLength(0);
    expect(status.history.def).toHaveLength(0);
    expect(status.allyTribeId).toBeNull();
  });

  it('gzip inválido falha com erro claro (fail-closed, sem snapshot)', async () => {
    const { service } = await buildService([
      { match: '/map/kill_att_tribe.txt.gz', handler: () => ({ ok: true, status: 200, body: 'não é gzip' }) },
      { match: '/map/kill_def_tribe.txt.gz', handler: () => ({ ok: true, status: 200, body: 'não é gzip' }) },
    ]);

    await expect(service.odaRefresh(TRIBE_ID)).rejects.toThrow('não é gzip válido');
    expect((await service.odaStatus()).history.att).toHaveLength(0);
  });

  it('ID inválido (0/negativo/não inteiro) lança antes de qualquer download', async () => {
    const { service } = await buildService();
    await expect(service.odaRefresh(0)).rejects.toThrow('ID da tribo inválido');
    await expect(service.odaRefresh(-5)).rejects.toThrow('ID da tribo inválido');
    expect(electronMockState.fetch.mock.calls.some(([url]) => String(url).includes('/map/kill'))).toBe(false);
  });
});

describe('WorldDataService.odaStatus (sem rede, nunca mistura mundos)', () => {
  it('sem store devolve vazio já rotulado com o mundo da sessão', async () => {
    const { service } = await buildService();
    const status = await service.odaStatus();
    expect(status).toEqual({
      world: WORLD,
      allyTribeId: null,
      history: { att: [], def: [] },
      lastFetch: { att: '', def: '' },
    });
  });
});
