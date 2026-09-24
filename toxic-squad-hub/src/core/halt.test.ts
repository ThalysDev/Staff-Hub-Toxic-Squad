// Disjuntor global (Onda 1): captcha/sessão param a rede do script inteiro
// até o jogador retomar. GM storage simulado em memória.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback));
vi.stubGlobal('GM_setValue', (key: string, value: unknown) => store.set(key, value));
vi.stubGlobal('GM_deleteValue', (key: string) => store.delete(key));

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

  it('fechado, a fila volta a rodar normalmente', async () => {
    tripHalt('captcha', 'x');
    clearHalt();
    await expect(enqueue(async () => 42)).resolves.toBe(42);
  });
});
