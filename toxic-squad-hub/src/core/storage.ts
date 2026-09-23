// Storage persistente do userscript: GM_setValue/GM_getValue com JSON e
// namespacing por mundo (cada mundo tem seus snapshots/históricos).
// Assinaturas mínimas no espírito do JsonStore do app (atomicidade não se
// aplica aqui — GM storage já é single-writer do navegador).

export const gm = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = GM_getValue(key, undefined) as string | undefined;
      if (raw === undefined) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set<T>(key: string, value: T): void {
    GM_setValue(key, JSON.stringify(value));
  },
  remove(key: string): void {
    GM_deleteValue(key);
  },
};

/** Chave com sufixo de mundo: `shs-in-game:<world>:<nome>`. */
export function worldKey(world: string | null, name: string): string {
  return `shs-in-game:${world ?? 'sem-mundo'}:${name}`;
}

/** Store simples persistido (load/save/remove) — substituto do JsonStore. */
export interface SimpleStore<T> {
  load(): Promise<T>;
  save(value: T): Promise<void>;
}

export function simpleStore<T>(key: string, empty: T): SimpleStore<T> {
  return {
    async load(): Promise<T> {
      return gm.get<T>(key, structuredClone(empty));
    },
    async save(value: T): Promise<void> {
      gm.set(key, value);
    },
  };
}
