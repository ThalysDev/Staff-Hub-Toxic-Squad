import { useCallback, useEffect, useRef, useState } from 'react';
import { usePreferences } from './usePreferences';

/**
 * usePrefsForm — formulário persistido por módulo, declarativo.
 *
 * Extrai o padrão hydrate-once/persist-per-field que as páginas SG copiavam à
 * mão (dezenas de useState + o useEffect de hidratação + um useEffect de
 * persistência por campo) sobre o usePreferences existente — mesmos escopo,
 * debounce de 800ms e cobertura de beforeunload/unmount:
 *
 * - Hidratação UMA vez por mount (guarda interna): cada chave salva passa pelo
 *   `onLoad` do seu campo (validação/normalização; sem `onLoad` = confia no
 *   valor salvo). O `onHydrated` (opcional, hook-level) roda uma única vez
 *   depois, para casos que gravam MAIS DE UMA chave (ex.: flag de migração).
 * - Persistência: `setValue`/`setValues` escrevem no estado E no store
 *   (debounce do usePreferences). Regra herdada do padrão manual: só depois
 *   da hidratação. ANTES, a edição atualiza a memória local (a UI responde)
 *   mas não persiste — e é descartada quando a hidratação substitui o estado
 *   pelo valor salvo.
 * - `resetPersisted` restaura os fallbacks na memória e apaga o escopo
 *   persistido (reset do usePreferences).
 *
 * A lógica pura (hidratação, merge, flag de hidratado, o que persistir) vive
 * em `createPrefsFormStore` — testável sem DOM (tests/renderer).
 */

/** Definição de um campo persistido: default + normalização de hidratação. */
export interface PrefsFieldDef<T> {
  /** Valor default (pré-hidratação). */
  fallback: T;
  /** Validação/normalização ao hidratar (ex.: normalizeAutoCollect). Omitir = confia no valor salvo. */
  onLoad?: (saved: T) => T;
}

/** Callback pós-hidratação: casos que gravam várias chaves (migração única). */
export type PrefsHydratedCallback<P extends Record<string, unknown>> = (
  values: P,
  save: (patch: Partial<P>) => void,
) => void;

/** Resultado de uma mutação do store: estado novo + o que persistir agora. */
export interface PrefsFormMutation<P extends Record<string, unknown>> {
  values: P;
  /** Patch para o savePrefs (null = nada a persistir — ex.: pré-hidratação). */
  persistPatch: Partial<P> | null;
}

/** Store puro do formulário (sem React): valores, flag de hidratado, mutações. */
export interface PrefsFormStore<P extends Record<string, unknown>> {
  getValues(): P;
  isHydrated(): boolean;
  /** Hidrata UMA vez: mapeia o salvo pelos onLoad e roda o callback pós-hidratação. Chamadas seguintes são no-op. */
  hydrate(
    stored: Partial<P> | null | undefined,
    onHydrated?: PrefsHydratedCallback<P>,
  ): PrefsFormMutation<P>;
  setValue<K extends keyof P>(key: K, value: P[K]): PrefsFormMutation<P>;
  setValues(patch: Partial<P>): PrefsFormMutation<P>;
  /** Restaura fallbacks na memória (a limpeza do escopo persistido fica por conta do reset do usePreferences). */
  reset(): PrefsFormMutation<P>;
}

/** Aplica o stored sobre os fallbacks — cada chave passa pelo onLoad do campo. */
export function hydratePrefsValues<P extends Record<string, unknown>>(
  defaults: { [K in keyof P]: PrefsFieldDef<P[K]> },
  stored: Partial<P> | null | undefined,
): P {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(defaults) as (keyof P & string)[]) {
    const def = defaults[key] as PrefsFieldDef<P[keyof P]>;
    const saved = stored?.[key];
    // usePreferences já entrega stored∨default mesclado; aqui o fallback só
    // entra quando a chave não existe em nenhum dos dois.
    const base = saved !== undefined ? saved : def.fallback;
    out[key] = def.onLoad !== undefined ? def.onLoad(base) : base;
  }
  return out as P;
}

/** Só os fallbacks, SEM onLoad — reset restaura o literal, não a normalização. */
export function fallbackPrefsValues<P extends Record<string, unknown>>(
  defaults: { [K in keyof P]: PrefsFieldDef<P[K]> },
): P {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(defaults) as (keyof P & string)[]) {
    out[key] = (defaults[key] as PrefsFieldDef<P[keyof P]>).fallback;
  }
  return out as P;
}

/**
 * Roda o callback pós-hidratação: os `save(patch)` acumulam num patch único
 * que o hook persiste (e aplica no estado) — caso da migração de 2 chaves.
 */
export function applyHydrationCallback<P extends Record<string, unknown>>(
  values: P,
  onHydrated: PrefsHydratedCallback<P>,
): { values: P; persisted: Partial<P> | null } {
  let persisted: Partial<P> = {};
  onHydrated(values, (patch) => {
    persisted = { ...persisted, ...patch };
  });
  if (Object.keys(persisted).length === 0) return { values, persisted: null };
  return { values: { ...values, ...persisted }, persisted };
}

/** Fábrica do store puro — o hook é só o adaptador React dele. */
export function createPrefsFormStore<P extends Record<string, unknown>>(
  defaults: { [K in keyof P]: PrefsFieldDef<P[K]> },
): PrefsFormStore<P> {
  let values: P = fallbackPrefsValues(defaults);
  let hydrated = false;

  return {
    getValues: () => values,
    isHydrated: () => hydrated,
    hydrate(stored, onHydrated) {
      if (hydrated) return { values, persistPatch: null };
      hydrated = true;
      let next = hydratePrefsValues(defaults, stored);
      let persistPatch: Partial<P> | null = null;
      if (onHydrated !== undefined) {
        const applied = applyHydrationCallback(next, onHydrated);
        next = applied.values;
        persistPatch = applied.persisted;
      }
      values = next;
      return { values, persistPatch };
    },
    setValue(key, value) {
      values = { ...values, [key]: value } as P;
      if (!hydrated) return { values, persistPatch: null };
      const patch: Partial<P> = {};
      Object.assign(patch, { [key]: value });
      // Pré-hidratação não persiste (o valor salvo chegando descarta a edição).
      return { values, persistPatch: patch };
    },
    setValues(patch) {
      values = { ...values, ...patch };
      return { values, persistPatch: hydrated ? patch : null };
    },
    reset() {
      values = fallbackPrefsValues(defaults);
      return { values, persistPatch: null };
    },
  };
}

/** Contrato do hook (fixo): valores prontos para espalhar na página. */
export interface PrefsFormApi<P extends Record<string, unknown>> {
  values: P;
  setValue: <K extends keyof P>(key: K, value: P[K]) => void;
  /** Substitui vários de uma vez (reset). */
  setValues: (patch: Partial<P>) => void;
  hydrated: boolean;
  /** Restaura fallbacks na memória E apaga o escopo persistido do módulo. */
  resetPersisted: () => Promise<void>;
}

export function usePrefsForm<P extends Record<string, unknown>>(
  scope: string,
  defaults: { [K in keyof P]: PrefsFieldDef<P[K]> },
  options?: { onHydrated?: PrefsHydratedCallback<P> },
): PrefsFormApi<P> {
  // Store único por mount (o literal `defaults` é recriado a cada render; o
  // conteúdo é estável na prática — mesmo tradeoff do usePreferences).
  const storeRef = useRef<PrefsFormStore<P> | null>(null);
  if (storeRef.current === null) storeRef.current = createPrefsFormStore(defaults);
  const store = storeRef.current;

  // Defaults crus (só fallbacks) para o usePreferences: hidratação base e o
  // restore interno do resetPrefs.
  const plainDefaultsRef = useRef<P | null>(null);
  if (plainDefaultsRef.current === null) plainDefaultsRef.current = fallbackPrefsValues(defaults);

  const onHydratedRef = useRef<PrefsHydratedCallback<P> | undefined>(options?.onHydrated);
  onHydratedRef.current = options?.onHydrated;

  const [values, setValuesState] = useState<P>(store.getValues());
  const [hydrated, setHydrated] = useState(store.isHydrated());

  const { prefs, savePrefs, resetPrefs } = usePreferences<P>(scope, plainDefaultsRef.current);

  const applyMutation = useCallback(
    (mutation: PrefsFormMutation<P>) => {
      setValuesState(mutation.values);
      if (mutation.persistPatch !== null) savePrefs(mutation.persistPatch);
    },
    [savePrefs],
  );

  const setValue = useCallback(
    <K extends keyof P>(key: K, value: P[K]) => {
      applyMutation(store.setValue(key, value));
    },
    [applyMutation, store],
  );

  const setValues = useCallback(
    (patch: Partial<P>) => {
      applyMutation(store.setValues(patch));
    },
    [applyMutation, store],
  );

  // Hidratação única: o prefs do usePreferences chega uma vez (null → valor);
  // o ref impede re-hidratar nos renders seguintes (e no restore do reset).
  const hydratedOnceRef = useRef(false);
  useEffect(() => {
    if (prefs === null || hydratedOnceRef.current) return;
    hydratedOnceRef.current = true;
    const mutation = store.hydrate(prefs, onHydratedRef.current);
    setValuesState(mutation.values);
    setHydrated(true);
    if (mutation.persistPatch !== null) savePrefs(mutation.persistPatch);
  }, [prefs, savePrefs, store]);

  const resetPersisted = useCallback(async (): Promise<void> => {
    setValuesState(store.reset().values);
    // O reset do usePreferences cancela patches pendentes, restaura os defaults
    // internos e apaga o escopo no processo principal.
    await resetPrefs();
  }, [resetPrefs, store]);

  return { values, setValue, setValues, hydrated, resetPersisted };
}
