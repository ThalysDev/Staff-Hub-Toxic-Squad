// Digesto do Quartel (main): ciclo get/set/send sobre JsonStore real (userData
// temporário), webhook via fetch global stubado (o POST sai da máquina — nunca
// pode partir com URL vazia/inválida) e gatilho automático maybeAutoSend.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { createElectronMock } = await import('./electron-mock');
  return createElectronMock();
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disposeElectronMock, electronMockState, resetElectronMock } from './electron-mock';
import { createDigestService, type DigestIpcDeps } from '../../src/main/ipc-digest';
import { Journal } from '../../src/main/journal';
import type { TwSessionManager } from '../../src/main/tw/session';
import type { SessionStatus } from '../../src/shared/ipc-types';
import { localDateKey } from '../../src/shared/digest';

const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';
const STORES_DIR = (): string => join(electronMockState.userDataDir, 'stores');

/** Grava um store JSON direto no disco (antes do 1º load do JsonStore). */
function seedStore(name: string, data: unknown): void {
  mkdirSync(STORES_DIR(), { recursive: true });
  writeFileSync(join(STORES_DIR(), name), JSON.stringify(data), 'utf-8');
}

function fakeSession(player: string | null): TwSessionManager {
  const status: SessionStatus = {
    state: player === null ? 'logged-out' : 'logged-in',
    world: 'br142',
    player,
    checkedAt: null,
  };
  return { getStatus: (): SessionStatus => status } as unknown as TwSessionManager;
}

/** Data de HOJE no fuso local com a hora dada (o digesto compara dias locais). */
function todayAt(hour: number): Date {
  const now = new Date();
  now.setHours(hour, 0, 0, 0);
  return now;
}

let journal: Journal;
let deps: DigestIpcDeps;

afterAll(() => {
  disposeElectronMock();
});

beforeEach(async () => {
  resetElectronMock();
  journal = new Journal();
  await journal.load();
  deps = { journal, twSession: fakeSession('Comandante') };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('digest:get / digest:set (config local)', () => {
  it('store nova volta desligada e sem URL', async () => {
    const service = createDigestService(deps);
    await expect(service.status()).resolves.toEqual({
      config: { webhookUrl: '', enabled: false },
      lastSentDate: null,
    });
  });

  it('set persiste webhook + enabled (URL normalizada com trim) e preserva lastSentDate', async () => {
    const service = createDigestService(deps);
    seedStore('digest.json', { webhookUrl: '', enabled: false, lastSentDate: '2026-09-01' });
    const status = await service.set({ webhookUrl: `  ${WEBHOOK}  `, enabled: true });
    expect(status).toEqual({ config: { webhookUrl: WEBHOOK, enabled: true }, lastSentDate: '2026-09-01' });
    // Reinicia o service (cache do JsonStore seria omitido) — a config persistiu.
    const reloaded = createDigestService(deps);
    await expect(reloaded.status()).resolves.toEqual(status);
    // Journal registra o estado, nunca a URL.
    const entries = await journal.list(50);
    const configEntry = entries.find((entry) => entry.action === 'digest-config');
    expect(configEntry?.detail).toContain('enabled=true');
    expect(configEntry?.detail).not.toContain('discord.com');
  });

  it('ativa o automático sem URL http(s) válida é recusado (fail-closed na config)', async () => {
    const service = createDigestService(deps);
    await expect(service.set({ webhookUrl: '', enabled: true })).rejects.toThrow(/http\(s\)/);
    await expect(service.set({ webhookUrl: 'ftp://x', enabled: true })).rejects.toThrow(/http\(s\)/);
  });
});

describe('digest:send (webhook externo)', () => {
  it('NUNCA envia com URL vazia — falha alto sem tocar a rede', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = createDigestService(deps);
    const result = await service.send();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/URL do webhook vazia ou inválida/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('envia POST {content} com o resumo do dia e marca lastSentDate + journal digest-sent', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    // Histórico: 2 versões, o Recruta cresce 21000 de pop off → 1 recrutamento
    // massivo; o Estável cresce > 500 de pop off para NÃO virar sinal 'inactive'.
    const version = (id: string, collectedAt: string, offPop: number, offPop2: number) => ({
      id,
      collectedAt,
      source: 'summary' as const,
      players: [
        { playerId: 1, playerName: 'Recruta', villageCount: 2, units: {}, offPop, defPop: 400 },
        { playerId: 2, playerName: 'Estável', villageCount: 1, units: {}, offPop: offPop2, defPop: 9000 },
      ],
    });
    seedStore('troops-history.json', {
      versions: [
        version('th-2', '2026-09-04T12:00:00.000Z', 22000, 9600),
        version('th-1', '2026-09-01T12:00:00.000Z', 1000, 9000),
      ],
    });
    // Coleta automática configurada (prefs legadas) + última coleta 15:00 → 21:00.
    seedStore('preferences.json', { sg2: { autoCollectHours: 6 } });
    seedStore('troops-snapshots.json', {
      world: 'br142',
      troops: { collectedAt: new Date(2026, 8, 4, 15, 0).toISOString() },
      defense: null,
    });
    // Journal de hoje: 1 coleta + 1 MP.
    await journal.append('read', 'collect-members', 'tropas por aldeia', false);
    await journal.append('mutation', 'mp-send', 'MP Jogador (2 alvos) → ok', false);
    await journal.append('mutation', 'reserve', 'reserva 500|500 → ok', false);

    const service = createDigestService(deps);
    await service.set({ webhookUrl: WEBHOOK, enabled: true });
    const result = await service.send();

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/sucesso/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string; headers: Record<string, string> }];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const payload = JSON.parse(init.body) as { content: string };
    expect(payload.content).toContain('🔔 **Digesto do Quartel —');
    expect(payload.content).toContain('**Staff Hub — Comandante**');
    expect(payload.content).toContain('🕵️ Auditoria: 1 recrutamento massivo');
    expect(payload.content).toContain('📦 Coletas hoje: 1');
    expect(payload.content).toContain('✉️ MPs/cobranças hoje: 1');
    expect(payload.content).toContain('⏰ Próxima coleta automática: 21:00');

    const status = await service.status();
    expect(status.lastSentDate).toBe(localDateKey(new Date()));
    const entries = await journal.list(50);
    expect(entries.some((entry) => entry.action === 'digest-sent')).toBe(true);
  });

  it('falha de HTTP vira resultado ok:false com detail + journal digest-error', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDigestService(deps);
    await service.set({ webhookUrl: WEBHOOK, enabled: false });
    const result = await service.send();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/HTTP 500/);
    expect((await service.status()).lastSentDate).toBeNull();
    const entries = await journal.list(50);
    expect(entries.some((entry) => entry.action === 'digest-error')).toBe(true);
  });
});

describe('maybeAutoSend (gatilho automático)', () => {
  function okFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async () => ({ ok: true, status: 204 }));
  }

  it('desligado, sem URL ou já enviado hoje: no-op sem rede', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const service = createDigestService(deps);
    await service.maybeAutoSend(todayAt(9)); // desligado
    await service.set({ webhookUrl: WEBHOOK, enabled: true });
    await service.maybeAutoSend(todayAt(7)); // antes das 08:00 locais
    await service.maybeAutoSend(todayAt(9)); // envia — 1ª vez no dia
    await service.maybeAutoSend(todayAt(15)); // já saiu hoje → no-op
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falha do webhook NÃO marca o dia (retenta no próximo ciclo)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    const service = createDigestService(deps);
    await service.set({ webhookUrl: WEBHOOK, enabled: true });
    await service.maybeAutoSend(todayAt(9)); // falha → dia NÃO marcado
    await service.maybeAutoSend(todayAt(15)); // tenta de novo → sucesso
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await service.status()).lastSentDate).toBe(localDateKey(new Date()));
  });

  it('exigirSessao lançando (deslogado): NENHUM fetch — envio automático exige sistema (P3 rev. 1/0.36)', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const restrito: DigestIpcDeps = { ...deps, exigirSessao: () => { throw new Error('sem sessão'); } };
    const service = createDigestService(restrito);
    await service.set({ webhookUrl: WEBHOOK, enabled: true });
    // Lança (estado normal deslogado) — o registrar engole com .catch(()=>{}).
    await expect(service.maybeAutoSend(todayAt(9))).rejects.toThrow(/sem sessão/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await service.status()).lastSentDate).toBeNull();
  });
});
