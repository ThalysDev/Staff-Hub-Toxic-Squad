import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiplomacyRelations } from '@shared/types';

const DUMP_STALE_MS = 6 * 60 * 60 * 1000;

/** Dump com mais de 6h é atualizado (aldeias mudam de dono); best-effort. */
async function ensureFreshDump(): Promise<void> {
  const status = await window.staffhub.world.status();
  const stale =
    status.fetchedAt === null ||
    status.villageCount === 0 ||
    Date.now() - Date.parse(status.fetchedAt) > DUMP_STALE_MS;
  if (stale) await window.staffhub.world.refresh();
}

// Carga única compartilhada entre as páginas SG: todas são keep-mounted e
// montam juntas no boot — sem coalescer, dois loads simultâneos disputam a
// fila do main e o segundo cai no "Uma operação está em andamento".
let inflight: Promise<DiplomacyRelations> | null = null;

/** Diplomacia com coalescência: chamadas simultâneas esperam a MESMA carga. */
export function loadRelationsShared(): Promise<DiplomacyRelations> {
  if (inflight !== null) return inflight;
  const promise = (async (): Promise<DiplomacyRelations> => {
    // Dump ANTES da diplomacia: a tag verdadeira da própria tribo vem do
    // ally.txt — sem ele, a página de contratos só expõe o NOME. Falha do
    // dump não bloqueia a diplomacia (a análise refaz o ensure na hora dela).
    try {
      await ensureFreshDump();
    } catch {
      // best-effort: segue sem dump atualizado
    }
    return window.staffhub.world.relations();
  })();
  inflight = promise;
  void promise
    .catch(() => undefined)
    .then(() => {
      if (inflight === promise) inflight = null;
    });
  return promise;
}

export interface DiplomacyRelationsState {
  relations: DiplomacyRelations | null;
  relationsFailed: boolean;
  relationsBusy: boolean;
  retryRelations: () => Promise<void>;
  setRelations: (next: DiplomacyRelations) => void;
}

/**
 * Diplomacia da tribo (inimigas/aliadas/PNAs) para as páginas SG.
 * As páginas são keep-mounted e montam no BOOT do app — muitas vezes ANTES do
 * login sid —, então a primeira carga pode falhar por sessão inexistente e,
 * sem retry, o "Diplomacia indisponível" ficava eterno mesmo logado. O hook:
 *   - carrega na montagem (dump garantido antes da primeira leitura);
 *   - REFaz sozinho quando a sessão entra em logged-in (login/restauração),
 *     se ainda não tiver dados;
 *   - expõe retryRelations() para as demais falhas (fila ocupada, rede);
 *   - não descarta diplomacia já carregada quando uma recarga falha.
 */
export function useDiplomacyRelations(): DiplomacyRelationsState {
  const [relations, setRelationsState] = useState<DiplomacyRelations | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(true);
  const requestId = useRef(0);
  const hasData = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const id = ++requestId.current;
    setBusy(true);
    try {
      const current = await loadRelationsShared();
      if (id !== requestId.current) return;
      hasData.current = true;
      setRelationsState(current);
      setFailed(false);
    } catch {
      if (id !== requestId.current) return;
      if (!hasData.current) setFailed(true);
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  const setRelations = useCallback((next: DiplomacyRelations): void => {
    hasData.current = true;
    setRelationsState(next);
    setFailed(false);
  }, []);

  useEffect(() => {
    void load();
    const unsubscribe = window.staffhub.events.onSessionChanged((status) => {
      // Recarregar só quando falta dado: login/restore tardios derrubam a
      // carga do boot, e é exatamente esse o caso que precisa de reprise.
      if (status.state === 'logged-in' && !hasData.current) void load();
    });
    return unsubscribe;
  }, [load]);

  return { relations, relationsFailed: failed, relationsBusy: busy, retryRelations: load, setRelations };
}
