// Gateway da API do jogo — assinatura REAL do TribalWars.post (BR142, 24/09/2026):
// post(screen, params{ajaxaction}, data, onSuccess, onError, noLoading) → void.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (k: string, d: unknown) => (store.has(k) ? store.get(k) : d));
vi.stubGlobal('GM_setValue', (k: string, v: unknown) => store.set(k, v));
vi.stubGlobal('GM_deleteValue', (k: string) => store.delete(k));
let behavior: (onSuccess: (r: unknown) => void, onError: (r?: unknown) => void) => void = () => undefined;
const calls: unknown[][] = [];
const TribalWars = {
  post(this: unknown, ...args: unknown[]): void {
    calls.push(args);
    behavior(args[3] as (r: unknown) => void, args[4] as (r?: unknown) => void);
  },
};
vi.stubGlobal('window', { location: { hostname: 'br142.tribalwars.com.br' }, TribalWars, setTimeout, clearTimeout });

const { callGameAction, classifyGatewayError } = await import('./game-gateway');
const { isHalted, clearHalt } = await import('./halt');
const { scavengeSquadErrors } = await import('../modules/tsh/tsh-transport');

describe('gateway da API do jogo', () => {
  beforeEach(() => {
    calls.length = 0;
    store.clear();
  });

  it('manda a ação como OBJETO (ajaxaction) e os dados no corpo', async () => {
    behavior = (ok) => ok({ squad_responses: [] });
    const r = await callGameAction('scavenge_api', 'send_squads', { 'squad_requests[0][village_id]': '1' });
    expect(r.ok).toBe(true);
    expect(calls[0]?.[0]).toBe('scavenge_api');
    expect(calls[0]?.[1]).toEqual({ ajaxaction: 'send_squads' });
    expect(calls[0]?.[2]).toEqual({ 'squad_requests[0][village_id]': '1' });
  });

  it('recusa do jogo (texto) = nada aconteceu, com a mensagem dele', async () => {
    behavior = (_ok, err) => err('Este nível de coleta já está ativo.');
    expect(await callGameAction('scavenge_api', 'send_squads', {})).toEqual({ ok: false, error: 'Este nível de coleta já está ativo.', afterMutation: false, code: 'recusado' });
  });

  it('erro sem argumento = desafio anti-bot → pausa o script', async () => {
    clearHalt();
    behavior = (_ok, err) => err();
    const r = await callGameAction('scavenge_api', 'send_squads', {});
    expect(r).toMatchObject({ ok: false, botProtect: true });
    expect(isHalted()).toBe(true);
    clearHalt();
  });

  it('aldeia de origem vai nos params da URL (buildURL do jogo usa params.village)', async () => {
    behavior = (ok) => ok({});
    await callGameAction('market', 'map_send', { target_id: '2' }, 8000, { village: '123' });
    expect(calls[0]?.[1]).toEqual({ ajaxaction: 'map_send', village: '123' });
    expect(calls[0]?.[2]).toEqual({ target_id: '2' });
  });

  it('falha de rede (xhr) = incerto', () => {
    expect(classifyGatewayError({ status: 500 })).toMatchObject({ afterMutation: true });
  });

  it('resposta do send_squads: erros por grupo', () => {
    expect(scavengeSquadErrors({ squad_responses: [{ success: true }, { success: false, error: '<b>Tropas</b> insuficientes' }] })).toEqual(['Tropas insuficientes']);
    expect(scavengeSquadErrors({})).toEqual([]);
  });
});
