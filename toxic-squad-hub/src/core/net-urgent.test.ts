// P1-3 da revisão (regra de ouro): a fila URGENTE (faixa de precisão) é uma
// cadeia PRÓPRIA — nunca espera a normal (um GET pendurado não pode atrasar um
// cravado em segundos), mas serializa urgentes entre si com o gap de 200ms.
// O teste cobre a LÓGICA pura (createSerialQueue) e as instâncias do módulo,
// com timers falsos: sem DOM e sem rede.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSerialQueue, enqueue, enqueueUrgent } from './net';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSerialQueue (fila serial pura)', () => {
  it('serializa: a segunda só começa ≥gapMs depois do INÍCIO da primeira', async () => {
    const queue = createSerialQueue(200);
    const starts: number[] = [];
    const first = queue.enqueue(async () => {
      starts.push(Date.now());
      return 'a';
    });
    const second = queue.enqueue(async () => {
      starts.push(Date.now());
      return 'b';
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(1); // a segunda ainda espera o gap
    await vi.advanceTimersByTimeAsync(199);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBe(200);
    await expect(first).resolves.toBe('a');
    await expect(second).resolves.toBe('b');
  });

  it('a primeira operação de um contexto novo não espera (nada com que espaçar)', async () => {
    const queue = createSerialQueue(200);
    let ran = false;
    const operation = queue.enqueue(async () => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toBe(true);
    await operation;
  });

  it('um erro em um elo não derruba a cadeia', async () => {
    const queue = createSerialQueue(200);
    const order: string[] = [];
    const failing = queue.enqueue(async () => {
      order.push('a');
      throw new Error('falha simulada');
    });
    const next = queue.enqueue(async () => {
      order.push('b');
      return 'ok';
    });
    await expect(failing).rejects.toThrow('falha simulada');
    await vi.advanceTimersByTimeAsync(200);
    await expect(next).resolves.toBe('ok');
    expect(order).toEqual(['a', 'b']);
  });

  it('fila normal ocupada NÃO segura a urgente (cadeias independentes)', async () => {
    const normal = createSerialQueue(200);
    const urgent = createSerialQueue(200);
    let releaseNormal: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseNormal = resolve;
    });
    let normalFinished = false;
    let urgentRan = false;
    const hanging = normal.enqueue(async () => {
      await gate;
      normalFinished = true;
    });
    const urgentOperation = urgent.enqueue(async () => {
      urgentRan = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(urgentRan).toBe(true); // a urgente passou sem esperar o pendurado
    expect(normalFinished).toBe(false); // e a normal segue pendurada
    releaseNormal?.();
    await vi.advanceTimersByTimeAsync(0);
    await hanging;
    await urgentOperation;
    expect(normalFinished).toBe(true);
  });
});

describe('filas do módulo (enqueue × enqueueUrgent)', () => {
  // A instância do módulo vive fora do teste: o relógio falso de cada teste é
  // adiantado em 1 minuto para o lastRequestAt do teste anterior nunca cair
  // "no futuro" (o que viraria uma espera artificial no próximo enqueue).
  let epoch = Date.now();
  beforeEach(() => {
    epoch += 60_000;
    vi.setSystemTime(epoch);
  });

  it('enqueueUrgent não espera um enqueue normal pendurado', async () => {
    let releaseNormal: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseNormal = resolve;
    });
    let normalFinished = false;
    let urgentRan = false;
    const hanging = enqueue(async () => {
      await gate;
      normalFinished = true;
    });
    const urgentOperation = enqueueUrgent(async () => {
      urgentRan = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(urgentRan).toBe(true);
    expect(normalFinished).toBe(false);
    releaseNormal?.();
    await vi.advanceTimersByTimeAsync(0);
    await hanging;
    await urgentOperation;
    expect(normalFinished).toBe(true);
  });

  it('a cadeia normal segue intacta: serializada e viva após um erro', async () => {
    const order: string[] = [];
    const failing = enqueue(async () => {
      order.push('a');
      throw new Error('falha simulada');
    });
    const next = enqueue(async () => {
      order.push('b');
      return 'ok';
    });
    await expect(failing).rejects.toThrow('falha simulada');
    expect(order).toEqual(['a']); // a segunda não furou a fila
    await vi.advanceTimersByTimeAsync(200);
    await expect(next).resolves.toBe('ok');
    expect(order).toEqual(['a', 'b']);
  });
});
