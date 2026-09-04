import { useSyncExternalStore } from 'react';
import type { UpdateCheckResult, UpdateProgress } from '@shared/ipc-types';

/** Estado de UI do atualizador — traduz o contrato IPC no vocabulário do banner. */
export type UpdateUiState =
  | { phase: 'idle' }
  | { phase: 'available'; latestVersion: string; notes: string }
  | { phase: 'downloading'; progress: UpdateProgress } // download|verify|extract
  | { phase: 'ready'; version: string }
  | { phase: 'error'; detail: string };

export interface UpdateStatusApi {
  state: UpdateUiState;
  /** Re-checagem manual (fail-soft: erro do canal vira estado 'error'). */
  check(): Promise<void>;
  /** downloadAndPrepare; erros viram estado 'error', nunca exceção ao chamador. */
  download(): Promise<void>;
  /** restartToUpdate; nunca lança ao chamador. */
  restart(): Promise<void>;
  /** Oculta o banner DESTA versão (persistido); versão nova reabre na hora. */
  snooze(version: string): void;
  snoozedVersion: string | null;
}

/** Re-checagem de fundo enquanto houver assinante (banner montado). */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SNOOZE_KEY = 'shs-update-snooze';

// ---------------------------------------------------------------------------
// Store SINGLETON (mesmo padrão do useToast): UM listener de progresso e UM
// timer de re-checagem no máximo, compartilhados por todos os assinantes — o
// banner é montado no App, mas a store sobrevive a navegação entre páginas.
// ---------------------------------------------------------------------------

let uiState: UpdateUiState = { phase: 'idle' };
let snoozedVersion: string | null = loadSnoozedVersion();
let snapshot: { state: UpdateUiState; snoozedVersion: string | null } = {
  state: uiState,
  snoozedVersion,
};
const listeners = new Set<() => void>();
let checkTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeProgress: (() => void) | null = null;

function loadSnoozedVersion(): string | null {
  try {
    const stored = window.localStorage.getItem(SNOOZE_KEY);
    return stored !== null && stored !== '' ? stored : null;
  } catch {
    return null; // localStorage indisponível: snooze vive só nesta sessão
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function commit(): void {
  snapshot = { state: uiState, snoozedVersion };
  emit();
}

/** Compara só o que a UI exibe — progresso repetido não dispara re-render. */
function sameUiState(a: UpdateUiState, b: UpdateUiState): boolean {
  if (a.phase !== b.phase) return false;
  switch (a.phase) {
    case 'idle':
      return true;
    case 'available':
      return b.phase === 'available' ? a.latestVersion === b.latestVersion && a.notes === b.notes : false;
    case 'downloading': {
      if (b.phase !== 'downloading') return false;
      const pa = a.progress;
      const pb = b.progress;
      if (pa.phase !== pb.phase) return false;
      if (pa.phase === 'download' && pb.phase === 'download') {
        return pa.receivedBytes === pb.receivedBytes && pa.totalBytes === pb.totalBytes;
      }
      return true;
    }
    case 'ready':
      return b.phase === 'ready' ? a.version === b.version : false;
    case 'error':
      return b.phase === 'error' ? a.detail === b.detail : false;
  }
}

function setState(next: UpdateUiState): void {
  if (sameUiState(uiState, next)) return;
  uiState = next;
  commit();
}

/**
 * Erro NUNCA rebaixa 'ready'/'downloading' já alcançados (eventos tardios de
 * um preparo antigo / check transiente do canal não derrubam o que está na
 * tela). EXCEÇÃO: falha do restartToUpdate — quem clicou "Reiniciar agora"
 * precisa VER o erro e destravar o botão (P1 da revisão 1 da v0.35.2).
 */
function applyError(detail: string, opts?: { force?: boolean }): void {
  if (!opts?.force && (uiState.phase === 'ready' || uiState.phase === 'downloading')) return;
  setState({ phase: 'error', detail });
}

function onProgress(progress: UpdateProgress): void {
  switch (progress.phase) {
    case 'download':
    case 'verify':
    case 'extract':
      setState({ phase: 'downloading', progress });
      break;
    case 'ready':
      setState({ phase: 'ready', version: progress.version });
      break;
    case 'error':
      // Evento de erro do atualizador = falha REAL do download/preparo (o
      // main só emite isso no handlePrepareError) — sempre vence o guard
      // (F1 da revisão 2: sem force, a barra de progresso morreria sem
      // erro nem botão de repetir).
      applyError(progress.detail, { force: true });
      break;
  }
}

/** check() → estado: verdades VIVAS do atualizador primeiro (versão já
 *  preparada / download em curso sobrevivem a remount), depois erro do canal,
 *  depois o anúncio. */
function stateFromCheck(result: UpdateCheckResult): UpdateUiState {
  if (result.preparedVersion !== undefined && result.preparedVersion !== '') {
    return { phase: 'ready', version: result.preparedVersion };
  }
  if (result.downloadInProgress === true) {
    const live = result.lastProgress;
    if (live !== undefined && (live.phase === 'download' || live.phase === 'verify' || live.phase === 'extract')) {
      return { phase: 'downloading', progress: live };
    }
    return { phase: 'downloading', progress: { phase: 'download', receivedBytes: 0, totalBytes: 0 } };
  }
  if (result.error !== undefined) return { phase: 'error', detail: result.error };
  if (result.updateAvailable) {
    return { phase: 'available', latestVersion: result.latestVersion, notes: result.manifest?.notes ?? '' };
  }
  return { phase: 'idle' };
}

async function runCheck(manual: boolean): Promise<void> {
  try {
    const result = await window.staffhub.updater.check();
    const next = stateFromCheck(result);
    if (next.phase === 'error') {
      // Erro do CANAL no check periódico é transiente: NÃO derruba um
      // 'ready'/'downloading' que já está na tela (F2 da revisão 2 — o
      // setState cru substituiria "pronta — reinicie" por um erro de rede
      // por até 6h).
      applyError(next.detail);
    } else {
      setState(next);
    }
    // Verificação PEDIDA pelo usuário limpa o adiamento: o banner reaparece
    // para a versão snoozada (undo natural do "Agora não" — P3 da revisão 1).
    if (manual && snoozedVersion !== null) {
      snoozedVersion = null;
      try {
        window.localStorage.removeItem(SNOOZE_KEY);
      } catch {
        // storage ausente: snooze já era só de sessão
      }
      commit();
    }
  } catch {
    applyError('Não foi possível verificar atualizações agora.');
  }
}

async function runDownload(): Promise<void> {
  // Otimista: entra em 'downloading' na hora — o próprio estado é a trava
  // contra clique duplo (o botão some com a troca de fase).
  if (uiState.phase !== 'ready') {
    setState({ phase: 'downloading', progress: { phase: 'download', receivedBytes: 0, totalBytes: 0 } });
  }
  try {
    const outcome = await window.staffhub.updater.downloadAndPrepare();
    // "Já está em andamento" é INFORMAÇÃO (download continua), não falha.
    if (!outcome.ok && !outcome.detail.includes('já está em andamento')) {
      // Falha REAL do preparo com estado 'downloading' na tela: force (F1) —
      // o guard existe para erros transientes de CHECK, não para estes.
      applyError(outcome.detail !== '' ? outcome.detail : 'Não foi possível preparar a atualização.', { force: true });
    }
  } catch {
    applyError('Não foi possível preparar a atualização. Tente novamente.', { force: true });
  }
}

async function runRestart(): Promise<void> {
  try {
    await window.staffhub.updater.restartToUpdate();
    // Sucesso aqui = o app está saindo para trocar de versão.
  } catch {
    // force: o estado É 'ready' (foi o que renderizou o botão) — sem isso o
    // guard engoliria a falha e o "Reiniciando…" travaria para sempre (P1).
    applyError('O hub não conseguiu reiniciar sozinho. Feche-o e abra de novo para concluir.', { force: true });
  }
}

function snoozeVersion(version: string): void {
  if (version === '') return;
  snoozedVersion = version;
  try {
    window.localStorage.setItem(SNOOZE_KEY, version);
  } catch {
    // Sem storage: o snooze vale só nesta sessão — a store segue correta.
  }
  commit();
}

function startBackground(): void {
  // 1º assinante montou: checagem imediata (fail-soft) + progresso vivo + 6h.
  void runCheck(false);
  unsubscribeProgress = window.staffhub.events.onUpdaterProgress(onProgress);
  checkTimer = setInterval(() => {
    void runCheck(false);
  }, RECHECK_INTERVAL_MS);
}

function stopBackground(): void {
  if (checkTimer !== null) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  if (unsubscribeProgress !== null) {
    unsubscribeProgress();
    unsubscribeProgress = null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) startBackground();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopBackground();
  };
}

function getSnapshot(): { state: UpdateUiState; snoozedVersion: string | null } {
  return snapshot;
}

/** Ações com identidade ESTÁVEL (module-level): consumidores podem usar
 * `check`/`download`/`restart` em deps de useMemo/useEffect sem re-render
 * churn (F3 da revisão 2). O objeto retornado pelo hook ainda é novo por
 * render (carrega state/snoozedVersion), mas as funções não. */
const STABLE_ACTIONS = {
  // Manual: limpa o adiamento da versão (banner reaparece se ela for a atual).
  check: (): Promise<void> => runCheck(true),
  download: runDownload,
  restart: runRestart,
  snooze: snoozeVersion,
} satisfies Omit<UpdateStatusApi, 'state' | 'snoozedVersion'>;

export function useUpdateStatus(): UpdateStatusApi {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { state: current.state, snoozedVersion: current.snoozedVersion, ...STABLE_ACTIONS };
}
