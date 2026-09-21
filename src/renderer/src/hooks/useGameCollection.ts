import { useRef, useState } from 'react';
import type { QueueProgress } from '@shared/ipc-types';
import { useToast } from './useToast';

/**
 * useGameCollection — costura comum do "Pipeline de Coleta" das páginas SG:
 * o encanamento busy/progresso/erro que antes era replicado página a página
 * (estado de busy, assinatura de onQueueProgress, toasts de erro/sucesso).
 *
 * Semântica preservada em relação aos efeitos/estados locais que substitui:
 *   - busy trava início duplicado (run() devolve null sem executar fn);
 *   - o progresso da fila do main é assinado SOMENTE enquanto busy (assinatura
 *     entra no início da operação e sai no finally; `progress` volta a null) —
 *     as barras continuam condicionadas a `busy && progress !== null` na página;
 *   - erro dispara toast 'error' com a mensagem e RELANÇA o erro original, para
 *     a página manter seu erro inline (callout/parágrafo) como hoje — por isso
 *     quem chama run() sem `silent` precisa de try/catch (ou .catch);
 *   - `silent` troca toast+relançamento por console.warn e devolve null (mesmo
 *     espírito do disparo automático silencioso do SG_2).
 *
 * Comportamento EXTRA de cada página (ranking de ameaças do SG_3, registro de
 * snapshot do SG_5, marcações do mapa do SG_1) fica NA PÁGINA, dentro do fn —
 * o hook é só o encanamento.
 */

/** Opções de UMA operação (por chamada de run). */
export interface GameCollectionRunOptions<T> {
  /** Toast 'info' ao iniciar a operação (opcional). */
  startLabel?: string;
  /** Toast 'ok' no sucesso: texto fixo ou derivado do retorno da operação. */
  doneLabel?: string | ((result: T) => string);
  /** Erro silencioso: console.warn em vez de toast + relançamento. */
  silent?: boolean;
}

/** Opções da instância do hook. */
export interface GameCollectionOptions {
  /** Roda após cada operação bem-sucedida (ex.: refreshMemory após coleta). */
  onDone?: () => void;
  /** Rótulo de sucesso padrão para run() chamado sem doneLabel próprio. */
  collectLabel?: string;
}

export interface GameCollectionApi {
  /** true enquanto uma operação deste hook está em andamento. */
  busy: boolean;
  /** Último evento de progresso recebido durante a operação (null fora dela). */
  progress: QueueProgress | null;
  /**
   * Executa uma operação de coleta/leitura longa: liga busy, assina o
   * progresso via onQueueProgress (enquanto busy), toasts ok/erro
   * configuráveis e devolve o retorno de fn. Devolve null sem executar fn
   * quando outra operação já está em andamento (busy).
   */
  run<T>(fn: () => Promise<T>, opts?: GameCollectionRunOptions<T>): Promise<T | null>;
}

export function useGameCollection(hookOpts?: GameCollectionOptions): GameCollectionApi {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<QueueProgress | null>(null);
  // Guarda síncrona: dois inícios no mesmo tick não passam pelo setState.
  const busyRef = useRef(false);
  // Opções da instância em ref: run nunca fecha sobre valores velhos (as
  // páginas costumam passar objeto literal, de identidade nova a cada render).
  const optsRef = useRef<GameCollectionOptions>({});
  optsRef.current = hookOpts ?? {};

  async function run<T>(fn: () => Promise<T>, runOpts?: GameCollectionRunOptions<T>): Promise<T | null> {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setProgress(null);
    const unsubscribe = window.staffhub.events.onQueueProgress(setProgress);
    try {
      if (runOpts?.startLabel !== undefined) push('info', runOpts.startLabel);
      const result = await fn();
      const doneLabel = runOpts?.doneLabel ?? optsRef.current.collectLabel;
      if (doneLabel !== undefined) {
        push('ok', typeof doneLabel === 'function' ? doneLabel(result) : doneLabel);
      }
      optsRef.current.onDone?.();
      return result;
    } catch (error) {
      if (runOpts?.silent === true) {
        console.warn('[useGameCollection] operação de coleta falhou:', error);
        return null;
      }
      push('error', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      unsubscribe();
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
    }
  }

  return { busy, progress, run };
}
