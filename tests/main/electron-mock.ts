/**
 * Mock do módulo 'electron' para testes Vitest dos módulos de src/main.
 *
 * COMO USAR (o hoisting do vi.mock exige esta ordem exata):
 *
 *   1. No topo do arquivo de teste, ANTES de qualquer import de código de
 *      src/main (o Vitest hoista o vi.mock de qualquer forma, mas manter a
 *      ordem deixa a intenção visível):
 *
 *        vi.mock('electron', async () => {
 *          const { createElectronMock } = await import('./electron-mock');
 *          return createElectronMock();
 *        });
 *
 *      A factory PRECISA ser async e importar este helper via import()
 *      dinâmico: o vi.mock é içado para antes dos imports estáticos, então
 *      qualquer variável de módulo referenciada diretamente na factory ainda
 *      não estaria inicializada (TDZ). O import dinâmico dentro da factory
 *      resolve isso porque só roda quando o 'electron' é efetivamente
 *      importado pelo grafo — e devolve A MESMA instância de módulo que o
 *      teste importa estaticamente depois (mesmo registry do Vitest).
 *
 *   2. No beforeAll/beforeEach do teste, chame `resetElectronMock()`:
 *      cria um userData REAL em mkdtemp (Journal/JsonStore gravam de verdade,
 *      com tmp+rename atômicos) e reseta o fetch da partição.
 *
 *   3. Configure as respostas com `routeElectronFetch([...])`: rotas na
 *      ordem (a primeira que casa atende); handler recebe o init do fetch
 *      (method/body) para inspecionar POSTs; sem rota casada o fetch REJEITA
 *      com erro alto — teste nunca passa silencioso por página errada.
 *
 *   4. No afterAll, `disposeElectronMock()` apaga o diretório temporário.
 *
 * O que o mock exporta como 'electron':
 *   - session.fromPartition(partition) → { fetch, cookies, clearStorageData }
 *     (TODAS as partições compartilham o MESMO `electronMockState.fetch`,
 *     que é o vi.fn roteado por `routeElectronFetch`);
 *   - app.getPath('userData') → temp dir real (outros nomes falham alto);
 *   - ipcMain.{handle,removeHandler,on} → no-ops espiáveis;
 *   - Notification → classe fake (isSupported true, show/close no-op);
 *   - BrowserWindow → classe fake com static fromWebContents.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

/** Resposta que os handlers de rota devolvem (viram um "Response" fake). */
export interface MockFetchResponse {
  ok: boolean;
  status: number;
  body: string;
}

/** Init que chega ao ses.fetch (só o que os services usam de verdade). */
export interface MockFetchInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** Rota: casamento por substring ou RegExp na URL; primeira casada atende. */
export interface FetchRoute {
  match: RegExp | string;
  handler: (init: MockFetchInit, url: string) => MockFetchResponse | Promise<MockFetchResponse>;
}

/** Estado COMPARTILHADO entre a factory do vi.mock e o arquivo de teste. */
export const electronMockState = {
  /** Diretório real (mkdtemp) devolvido por app.getPath('userData'). */
  userDataDir: '',
  /** O fetch de TODAS as partições (session.fromPartition(...).fetch). */
  fetch: vi.fn(),
};

/** Response fake com a superfície que o app usa: ok/status/text(). */
class FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  private readonly body: string;

  constructor(response: MockFetchResponse) {
    this.ok = response.ok;
    this.status = response.status;
    this.body = response.body;
  }

  async text(): Promise<string> {
    return this.body;
  }
}

/** Atalho para página HTML 200. */
export function html(body: string, status = 200): MockFetchResponse {
  return { ok: status >= 200 && status < 300, status, body };
}

/** Cria/reinicia o userData temporário e limpa o fetch da partição. */
export function resetElectronMock(): void {
  if (electronMockState.userDataDir !== '') {
    rmSync(electronMockState.userDataDir, { recursive: true, force: true });
  }
  electronMockState.userDataDir = mkdtempSync(join(tmpdir(), 'staffhub-electron-mock-'));
  electronMockState.fetch.mockReset();
  // Default alto: fetch sem rota nunca resolve silenciosamente.
  electronMockState.fetch.mockImplementation(async (url: unknown) => {
    throw new Error(`[electron-mock] fetch sem rota configurada: ${String(url)}`);
  });
}

/** Apaga o userData temporário (afterAll). */
export function disposeElectronMock(): void {
  if (electronMockState.userDataDir !== '') {
    rmSync(electronMockState.userDataDir, { recursive: true, force: true });
    electronMockState.userDataDir = '';
  }
}

/** Instala as rotas do fetch da partição (na ordem; primeira casada atende). */
export function routeElectronFetch(routes: FetchRoute[]): void {
  electronMockState.fetch.mockImplementation(async (url: unknown, init?: unknown) => {
    const target = String(url);
    for (const route of routes) {
      const matched = typeof route.match === 'string' ? target.includes(route.match) : route.match.test(target);
      if (!matched) continue;
      const response = await route.handler((init ?? {}) as MockFetchInit, target);
      return new FakeResponse(response);
    }
    throw new Error(`[electron-mock] fetch sem rota configurada: ${target}`);
  });
}

/** Conta quantas chamadas de fetch casaram com o trecho de URL (asserts). */
export function fetchCallCount(match: RegExp | string): number {
  return electronMockState.fetch.mock.calls.filter(([url]) =>
    typeof match === 'string' ? String(url).includes(match) : match.test(String(url)),
  ).length;
}

/** Init (method/body) das chamadas que casaram, na ordem (asserts de POST). */
export function fetchCalls(match: RegExp | string): MockFetchInit[] {
  return electronMockState.fetch.mock.calls
    .filter(([url]) => (typeof match === 'string' ? String(url).includes(match) : match.test(String(url))))
    .map(([, init]) => (init ?? {}) as MockFetchInit);
}

/**
 * A factory do vi.mock('electron', async () => …). Devolve o módulo fake
 * completo — veja o cabeçalho do arquivo para o padrão de uso.
 */
export function createElectronMock() {
  const partitionSessions = new Map<string, unknown>();
  const makeSession = () => ({
    fetch: electronMockState.fetch,
    cookies: {
      get: vi.fn(async () => []),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    clearStorageData: vi.fn(async () => undefined),
  });

  return {
    session: {
      fromPartition: vi.fn((partition: string) => {
        if (!partitionSessions.has(partition)) {
          partitionSessions.set(partition, makeSession());
        }
        return partitionSessions.get(partition);
      }),
    },
    app: {
      getPath: vi.fn((name: string) => {
        if (name === 'userData') {
          if (electronMockState.userDataDir === '') {
            throw new Error("[electron-mock] chame resetElectronMock() no beforeAll/beforeEach antes de usar app.getPath('userData')");
          }
          return electronMockState.userDataDir;
        }
        throw new Error(`[electron-mock] app.getPath("${name}") não suportado neste mock`);
      }),
      on: vi.fn(),
      whenReady: vi.fn(async () => undefined),
    },
    ipcMain: {
      handle: vi.fn(),
      removeHandler: vi.fn(),
      on: vi.fn(),
    },
    // safeStorage "criptografia" de teste: round-trip base64 estável — o
    // AuthService só precisa de encrypt/decrypt coerentes + available true.
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((texto: string) => Buffer.from(texto, 'utf8')),
      decryptString: vi.fn((blob: Buffer) => blob.toString('utf8')),
    },
    Notification: class MockNotification {
      static isSupported(): boolean {
        return true;
      }

      onclick: (() => void) | null = null;

      constructor(_options: unknown) {
        void _options;
      }

      show(): void {
        /* no-op */
      }

      close(): void {
        /* no-op */
      }
    },
    BrowserWindow: class MockBrowserWindow {
      static fromWebContents = vi.fn(() => null);

      static getAllWindows = vi.fn((): unknown[] => []);

      webContents = {
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        loadURL: vi.fn(async () => undefined),
      };

      constructor(_options?: unknown) {
        void _options;
      }

      isDestroyed(): boolean {
        return false;
      }

      on(): this {
        return this;
      }

      once(): this {
        return this;
      }

      loadURL(): Promise<void> {
        return Promise.resolve();
      }

      close(): void {
        /* no-op */
      }

      focus(): void {
        /* no-op */
      }

      show(): void {
        /* no-op */
      }
    },
  };
}
