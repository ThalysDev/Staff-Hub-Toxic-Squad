import { randomUUID } from 'node:crypto';

export type QueueRequestResult = {
  ok: boolean;
  status: number;
  body: string;
  url: string;
};

export type QueueFailureKind =
  | 'cancelled'
  | 'ceiling-exceeded'
  | 'session-expired'
  | 'captcha-suspected'
  | 'http-error'
  | 'aborted';

export class QueueError extends Error {
  constructor(
    readonly kind: QueueFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'QueueError';
  }
}

export interface QueueOptions {
  /** Rótulo exibido no progresso (ex.: "Coletando tropas"). */
  label: string;
  /** Teto de requisições da operação. */
  ceiling: number;
}

export interface QueueEventHandlers {
  /** Journal/auditoria: início, término e falha de cada operação da fila. */
  onStarted?: (info: { operationId: string; label: string; total: number }) => void;
  onFinished?: (info: { operationId: string; label: string; total: number }) => void;
  onFailed?: (info: { operationId: string; label: string; error: QueueError }) => void;
  /** Sentinela de conteúdo detectado (login/captcha no corpo): aviso IMEDIATO
   * antes do throw — o main usa para espelhar a queda de sessão no
   * TwSessionManager (a UI para de mostrar "Ativa" na hora). Invocado de forma
   * best-effort: um listener que lance NÃO altera o fail-fast da fila. */
  onSentinel?: (kind: 'session-expired' | 'captcha-suspected') => void;
}

/** Sentinelas de conteúdo que interrompem a fila (detect-pause-notify).
 * Marcadores estruturais de formulário — texto solto como "captcha" num post
 * de fórum NÃO pode derrubar a fila. Sessão é checada ANTES de captcha: uma
 * página de login com captcha é, antes de tudo, sessão caída.
 * Marcadores confrontados contra fixtures reais do BR142 e cobertos por
 * testes (tests/main/sg6-service.test.ts, sg7-service.test.ts). */
const SESSION_EXPIRED_MARKERS = ['name="password"', 'id="login"', 'login_button'];
const CAPTCHA_MARKERS = ['bot_check', 'id="captcha"', 'captcha_img'];

export function detectPageSentinels(html: string): QueueFailureKind | null {
  const lower = html.toLowerCase();
  if (SESSION_EXPIRED_MARKERS.some((m) => lower.includes(m))) return 'session-expired';
  if (CAPTCHA_MARKERS.some((m) => lower.includes(m))) return 'captcha-suspected';
  return null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fila sequencial de requisições ao jogo com pacing humano, jitter, teto por
 * operação e cancelamento. Leituras podem repetir em falha transitória (5xx);
 * a fila nunca decide mutar duas vezes — mutações entram aqui como operação
 * de requisição única e o chamador cuida da semântica.
 */
export class RequestQueue {
  private operationId: string | null = null;
  private externalOperations = 0;
  private cancelled = false;
  private executed = 0;
  private lastAt = 0;

  constructor(
    private fetcher: (url: string) => Promise<QueueRequestResult>,
    private readonly onProgress: (info: { operationId: string; label: string; done: number; total: number }) => void,
    private settings: { minIntervalMs: number; jitterMs: number; ceiling: number },
    private readonly events: QueueEventHandlers = {},
  ) {}

  updateSettings(settings: { minIntervalMs: number; jitterMs: number; ceiling: number }): void {
    this.settings = settings;
  }

  cancel(): void {
    this.cancelled = true;
  }

  get isRunning(): boolean {
    return this.operationId !== null || this.externalOperations > 0;
  }

  /**
   * Ocupação externa (C4 — single-flight global): mutações e downloads de
   * dumps rodam FORA da fila (POSTs diretos / gzip), mas marcam a fila ocupada
   * para que NENHUMA coleta (nem outra mutação) comece em paralelo — pacing
   * duplicado/triplicado é risco de ban. begin/end sempre em try/finally.
   */
  beginOperation(): void {
    this.externalOperations += 1;
  }

  endOperation(): void {
    this.externalOperations = Math.max(0, this.externalOperations - 1);
  }

  /** Executa N requisições em sequência com pacing; retorna corpos em ordem. */
  async run(urls: string[], options: QueueOptions): Promise<string[]> {
    if (this.operationId !== null || this.externalOperations > 0) {
      throw new QueueError('aborted', 'Outra operação está em andamento — aguarde terminar (ou cancele na barra de progresso) antes de iniciar outra.');
    }
    if (urls.length > options.ceiling) {
      throw new QueueError('ceiling-exceeded', `Operação excede o teto de ${options.ceiling} requisições (${urls.length}).`);
    }
    this.operationId = randomUUID();
    this.cancelled = false;
    this.executed = 0;
    const bodies: string[] = [];
    this.events.onStarted?.({ operationId: this.operationId, label: options.label, total: urls.length });
    try {
      for (const url of urls) {
        if (this.cancelled) throw new QueueError('cancelled', 'Operação cancelada pelo usuário.');
        await this.pace();
        const result = await this.fetchWithRetry(url);
        if (!result.ok) {
          // Fail-closed: qualquer resposta de erro HTTP vira falha da operação —
          // corpo de página de erro nunca entra como dado válido.
          throw new QueueError('http-error', `HTTP ${result.status} em ${url}`);
        }
        this.executed += 1;
        this.onProgress({ operationId: this.operationId, label: options.label, done: this.executed, total: urls.length });
        const sentinel = detectPageSentinels(result.body);
        if (sentinel) {
          if (sentinel === 'session-expired' || sentinel === 'captcha-suspected') {
            // Best-effort: erro num listener nunca pode impedir o fail-fast da
            // fila — o QueueError segue inalterado de qualquer forma.
            try {
              this.events.onSentinel?.(sentinel);
            } catch {
              // listener do dono falhou — segue o lançamento normal abaixo
            }
          }
          throw new QueueError(sentinel, sentinel === 'captcha-suspected'
            ? 'Captcha detectado — operação pausada. Resolva manualmente na janela de login.'
            : 'Sessão expirada — operação interrompida. Faça login novamente.');
        }
        bodies.push(result.body);
      }
      this.events.onFinished?.({ operationId: this.operationId, label: options.label, total: urls.length });
      return bodies;
    } catch (error) {
      const queueError = error instanceof QueueError ? error : new QueueError('http-error', error instanceof Error ? error.message : String(error));
      this.events.onFailed?.({ operationId: this.operationId, label: options.label, error: queueError });
      throw queueError;
    } finally {
      this.operationId = null;
    }
  }

  private async pace(): Promise<void> {
    const elapsed = Date.now() - this.lastAt;
    const wait = this.settings.minIntervalMs - elapsed;
    if (wait > 0) await sleep(wait + Math.random() * this.settings.jitterMs);
    this.lastAt = Date.now();
  }

  private async fetchWithRetry(url: string): Promise<QueueRequestResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.cancelled) throw new QueueError('cancelled', 'Operação cancelada pelo usuário.');
      try {
        const result = await this.fetcher(url);
        if (result.ok || (result.status >= 400 && result.status < 500)) return result;
        lastError = new QueueError('http-error', `HTTP ${result.status} em ${url}`);
      } catch (error) {
        lastError = error;
      }
      await sleep(500 * (attempt + 1));
    }
    throw lastError instanceof Error ? lastError : new QueueError('http-error', `Falha ao obter ${url}`);
  }
}
