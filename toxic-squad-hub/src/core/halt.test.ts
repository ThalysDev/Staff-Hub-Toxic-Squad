// Disjuntor global (Onda 1): captcha/sessão param a rede do script inteiro
// até o jogador retomar. GM storage simulado em memória.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback));
vi.stubGlobal('GM_setValue', (key: string, value: unknown) => store.set(key, value));
vi.stubGlobal('GM_deleteValue', (key: string) => store.delete(key));
const location = { hostname: 'br142.tribalwars.com.br' };
vi.stubGlobal('window', { location });

const { clearHalt, haltState, isHalted, tripHalt, HaltedError } = await import('./halt');
const { enqueue, enqueueUrgent } = await import('./net');

describe('disjuntor de captcha/sessão', () => {
  beforeEach(() => store.clear());

  it('abre com o primeiro motivo e só o jogador fecha', () => {
    expect(isHalted()).toBe(false);
    tripHalt('captcha', 'desafio na praça');
    tripHalt('sessao', 'login'); // segundo motivo não sobrescreve o primeiro
    expect(haltState()?.reason).toBe('captcha');
    expect(haltState()?.detail).toBe('desafio na praça');
    clearHalt();
    expect(isHalted()).toBe(false);
  });

  it('aberto, as duas filas de rede recusam QUALQUER operação (leitura ou envio)', async () => {
    tripHalt('sessao', 'login');
    const operation = vi.fn(async () => 'ok');
    await expect(enqueue(operation)).rejects.toBeInstanceOf(HaltedError);
    await expect(enqueueUrgent(operation)).rejects.toBeInstanceOf(HaltedError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('vale POR MUNDO: captcha no br141 não pausa o br142', () => {
    location.hostname = 'br141.tribalwars.com.br';
    tripHalt('captcha', 'x');
    location.hostname = 'br142.tribalwars.com.br';
    expect(isHalted()).toBe(false);
    location.hostname = 'br141.tribalwars.com.br';
    expect(isHalted()).toBe(true);
    location.hostname = 'br142.tribalwars.com.br';
  });

  it('fechado, a fila volta a rodar normalmente', async () => {
    tripHalt('captcha', 'x');
    clearHalt();
    await expect(enqueue(async () => 42)).resolves.toBe(42);
  });
});
