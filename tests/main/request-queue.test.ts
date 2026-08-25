import { describe, expect, it, vi } from 'vitest';
import { QueueError, RequestQueue, detectPageSentinels } from '../../src/main/tw/request-queue';

const settings = { minIntervalMs: 0, jitterMs: 0, ceiling: 10 };
const progressSpy = vi.fn();

function makeQueue(fetcher: (url: string) => Promise<{ ok: boolean; status: number; body: string; url: string }>) {
  return new RequestQueue(fetcher, progressSpy, settings);
}

const okBody = '<html><body>aldeia</body></html>';

describe('detectPageSentinels', () => {
  it('não dispara em página comum nem em post de fórum com a palavra captcha', () => {
    expect(detectPageSentinels(okBody)).toBeNull();
    expect(detectPageSentinels('<html>conversemos sobre captcha no chat</html>')).toBeNull();
  });

  it('detecta formulário de login (sessão) antes de captcha', () => {
    const loginPage = '<form id="login"><input name="password"><img id="captcha"></form>';
    expect(detectPageSentinels(loginPage)).toBe('session-expired');
  });

  it('detecta captcha isolado', () => {
    expect(detectPageSentinels('<div class="page"><img id="captcha" src="x"></div>')).toBe('captcha-suspected');
  });
});

describe('RequestQueue.run', () => {
  it('retorna corpos em ordem para respostas ok', async () => {
    const queue = makeQueue(async (url) => ({ ok: true, status: 200, body: `body:${url}`, url }));
    const bodies = await queue.run(['a', 'b'], { label: 'teste', ceiling: 10 });
    expect(bodies).toEqual(['body:a', 'body:b']);
  });

  it('reprova operação acima do teto (ceiling-exceeded)', async () => {
    const queue = makeQueue(async (url) => ({ ok: true, status: 200, body: url, url }));
    await expect(queue.run(['a', 'b', 'c'], { label: 'teste', ceiling: 2 })).rejects.toMatchObject({ kind: 'ceiling-exceeded' });
  });

  it('HTTP 4xx não vira corpo válido (fail-closed, sem retry)', async () => {
    const fetcher = vi.fn(async (url: string) => ({ ok: false, status: 404, body: 'não existe', url }));
    const queue = makeQueue(fetcher);
    await expect(queue.run(['a'], { label: 'teste', ceiling: 10 })).rejects.toMatchObject({ kind: 'http-error' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('HTTP 5xx tentativo entra em retry e falha após 3 tentativas', async () => {
    const fetcher = vi.fn(async (url: string) => ({ ok: false, status: 503, body: '', url }));
    const queue = makeQueue(fetcher);
    await expect(queue.run(['a'], { label: 'teste', ceiling: 10 })).rejects.toMatchObject({ kind: 'http-error' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('corpo 200 com formulário de login interrompe como session-expired', async () => {
    const queue = makeQueue(async (url) => ({ ok: true, status: 200, body: '<input name="password">', url }));
    await expect(queue.run(['a'], { label: 'teste', ceiling: 10 })).rejects.toMatchObject({ kind: 'session-expired' });
  });

  it('cancel() interrompe a operação', async () => {
    const queue = makeQueue(async (url) => ({ ok: true, status: 200, body: okBody, url }));
    const promise = queue.run(['a', 'b'], { label: 'teste', ceiling: 10 });
    queue.cancel();
    await expect(promise).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('recusa segunda operação enquanto uma está em andamento (aborted)', async () => {
    const queue = new RequestQueue(
      async (url: string) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ok: true, status: 200, body: okBody, url };
      },
      vi.fn(),
      settings,
    );
    const first = queue.run(['a'], { label: 'primeira', ceiling: 10 });
    await expect(queue.run(['b'], { label: 'segunda', ceiling: 10 })).rejects.toMatchObject({ kind: 'aborted' });
    await expect(first).resolves.toEqual([okBody]);
  });

  it('eventos de auditoria disparam em sucesso e falha', async () => {
    const onStarted = vi.fn();
    const onFinished = vi.fn();
    const onFailed = vi.fn();
    const ok = new RequestQueue(async (url: string) => ({ ok: true, status: 200, body: okBody, url }), vi.fn(), settings, {
      onStarted,
      onFinished,
      onFailed,
    });
    await ok.run(['a'], { label: 'ok-op', ceiling: 10 });
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();

    const fail = new RequestQueue(async (url: string) => ({ ok: false, status: 500, body: '', url }), vi.fn(), settings, {
      onStarted,
      onFinished,
      onFailed,
    });
    await fail.run(['a'], { label: 'fail-op', ceiling: 10 }).catch(() => undefined);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0]?.[0].error).toBeInstanceOf(QueueError);
  });
});
