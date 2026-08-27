import { useCallback, useEffect, useRef, useState } from 'react';

/** Atraso do debounce de salvamento: agrupa rajadas de mudanças em um único IPC. */
const SAVE_DEBOUNCE_MS = 800;

export interface UsePreferencesResult<T extends Record<string, unknown>> {
  /** Preferências hidratadas; null enquanto carrega. */
  prefs: T | null;
  /** Salva patch (merge raso por chave) com debounce de 800ms. Retorna void; falha é silenciosa no console. */
  savePrefs: (patch: Partial<T>) => void;
  /** Salva IMEDIATAMENTE (sem debounce) — para desmontagem/beforeunload. */
  savePrefsNow: (patch: Partial<T>) => Promise<void>;
  /** Apaga as preferências do módulo e limpa o estado local. */
  resetPrefs: () => Promise<void>;
  /** true entre o mount e a hidratação terminar. */
  loading: boolean;
}

/**
 * Preferências por módulo (formulários que sobrevivem a F5/reinício).
 *
 * - Mount: hidrata `window.staffhub.preferences.get(module)` sobre `defaults`
 *   (stored vence; merge raso). Falha → usa defaults (fail-soft, console.warn).
 * - `savePrefs` aplica o patch no estado local OTIMISTAMENTE e agenda o save
 *   com debounce de 800ms; chamadas repetidas acumulam as chaves num único patch.
 * - O merge final acontece no main (raso por chave) — o patch aqui carrega só
 *   as chaves mudadas.
 * - Desmonte/troca de módulo descarrega patch pendente best-effort, sem
 *   setState após o unmount.
 */
export function usePreferences<T extends Record<string, unknown>>(
  module: string,
  defaults: T,
): UsePreferencesResult<T> {
  const [prefs, setPrefs] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  // Patch acumulado ainda não enviado ao main (merge raso entre chamadas).
  const pendingRef = useRef<Partial<T>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `defaults` costuma ser literal inline (identidade nova a cada render); o ref
  // evita re-hidratar a cada render e sempre espelha o valor mais recente.
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  /** Envia o patch pendente AGORA (cancela o debounce). Nunca faz setState — seguro no unmount. */
  const flushPending = useCallback((): Promise<void> => {
    const timer = timerRef.current;
    if (timer !== null) {
      clearTimeout(timer);
      timerRef.current = null;
    }
    const patch = pendingRef.current;
    if (Object.keys(patch).length === 0) return Promise.resolve();
    pendingRef.current = {};
    const bridge = window.staffhub.preferences;
    if (!bridge) {
      // Preload ainda não expõe o contrato de preferences: fail-soft.
      console.warn(`[usePreferences] bridge sem "preferences"; patch de "${module}" descartado.`);
      return Promise.resolve();
    }
    return bridge
      .save(module, patch as Record<string, unknown>)
      .then(() => undefined)
      .catch((error) => {
        // Persistência falhou, mas o estado local já reflete o patch (fail-soft).
        console.warn(`[usePreferences] falha ao salvar preferências de "${module}":`, error);
      });
  }, [module]);

  /** Merge raso do patch no estado local (ignorado enquanto não hidratado). */
  const mergeLocal = useCallback((patch: Partial<T>) => {
    setPrefs((prev) => (prev === null ? prev : { ...prev, ...patch }));
  }, []);

  const savePrefs = useCallback(
    (patch: Partial<T>) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      mergeLocal(patch);
      const timer = timerRef.current;
      if (timer !== null) clearTimeout(timer);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flushPending();
      }, SAVE_DEBOUNCE_MS);
    },
    [flushPending, mergeLocal],
  );

  const savePrefsNow = useCallback(
    (patch: Partial<T>): Promise<void> => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      mergeLocal(patch);
      return flushPending();
    },
    [flushPending, mergeLocal],
  );

  const resetPrefs = useCallback((): Promise<void> => {
    const timer = timerRef.current;
    if (timer !== null) {
      clearTimeout(timer);
      timerRef.current = null;
    }
    pendingRef.current = {};
    setPrefs({ ...defaultsRef.current });
    const bridge = window.staffhub.preferences;
    if (!bridge) {
      console.warn(`[usePreferences] bridge sem "preferences"; reset de "${module}" ignorado.`);
      return Promise.resolve();
    }
    return bridge.reset(module).catch((error) => {
      // Estado local já voltou ao default; falha de persistência é só warn.
      console.warn(`[usePreferences] falha ao resetar preferências de "${module}":`, error);
    });
  }, [module]);

  // Hidratação no mount/troca de módulo: stored vence defaults (merge raso).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPrefs(null);
    const bridge = window.staffhub.preferences;
    if (!bridge) {
      console.warn(`[usePreferences] bridge sem "preferences"; usando defaults para "${module}".`);
      setPrefs({ ...defaultsRef.current });
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    bridge
      .get(module)
      .then((stored) => {
        if (cancelled) return;
        setPrefs({ ...defaultsRef.current, ...stored } as T);
        setLoading(false);
      })
      .catch((error) => {
        console.warn(`[usePreferences] falha ao carregar preferências de "${module}"; usando defaults:`, error);
        if (cancelled) return;
        setPrefs({ ...defaultsRef.current });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [module]);

  // Desmonte/troca de módulo: descarrega patch pendente best-effort (sem setState).
  useEffect(() => {
    return () => {
      void flushPending();
    };
  }, [flushPending]);

  // Fechamento do app/janela: as páginas SG são keep-mounted (nunca desmontam),
  // então o flush do unmount NÃO roda no F5/fechar — sem isso, os últimos
  // 800ms de digitação seriam perdidos.
  useEffect(() => {
    const onBeforeUnload = (): void => {
      void flushPending();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [flushPending]);

  return { prefs, savePrefs, savePrefsNow, resetPrefs, loading };
}
