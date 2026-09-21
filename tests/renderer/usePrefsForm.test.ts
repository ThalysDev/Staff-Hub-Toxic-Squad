import { describe, expect, it } from 'vitest';
import {
  applyHydrationCallback,
  createPrefsFormStore,
  fallbackPrefsValues,
  hydratePrefsValues,
  type PrefsFieldDef,
} from '../../src/renderer/src/hooks/usePrefsForm';

/**
 * Testes do usePrefsForm via o STORE PURO (createPrefsFormStore e helpers
 * exportados) — o hook é só o adaptador React dele, então a lógica inteira
 * (hidratação única, o que persiste, merge, reset) roda aqui sem DOM e sem
 * mockar usePreferences.
 *
 * Semântica de setValue PRÉ-hidratação (documentada no hook, exercitada aqui):
 * a edição atualiza a memória local mas NÃO persiste (persistPatch null) — e é
 * descartada quando hydrate() substitui o estado pelo valor salvo. É exatamente
 * o comportamento do padrão manual que o hook substituiu nas páginas SG.
 */

/** Espelho do caso SG_2: normalização de valor fora das opções conhecidas. */
function normalizeHoras(value: string): string {
  return ['0', '4', '6', '12', '24'].includes(value) ? value : '0';
}

type TestPrefs = {
  texto: string;
  horas: string;
  unidades: Record<string, string>;
  fonte: 'recrutadas' | 'agora';
  migrado?: boolean;
};

const DEFAULTS: { [K in keyof TestPrefs]: PrefsFieldDef<TestPrefs[K]> } = {
  texto: { fallback: '' },
  horas: { fallback: '0', onLoad: normalizeHoras },
  unidades: { fallback: { axe: '' }, onLoad: (saved) => ({ ...{ axe: '' }, ...saved }) },
  fonte: { fallback: 'recrutadas', onLoad: (saved) => (saved === 'agora' ? 'agora' : 'recrutadas') },
  migrado: { fallback: false },
};

describe('hydratePrefsValues', () => {
  it('stored vence fallback e o onLoad normaliza a chave salva', () => {
    const values = hydratePrefsValues(DEFAULTS, { horas: '37', fonte: 'agora' });
    expect(values.horas).toBe('0'); // valor fora das opções volta ao default (fail-soft)
    expect(values.fonte).toBe('agora');
  });

  it('chave ausente no stored cai no fallback — e o onLoad ainda roda sobre o fallback', () => {
    const values = hydratePrefsValues(DEFAULTS, { texto: 'salvo' });
    expect(values.texto).toBe('salvo');
    expect(values.horas).toBe('0');
    expect(values.fonte).toBe('recrutadas');
    expect(values.migrado).toBe(false);
  });

  it('objetos mesclam sobre o fallback (caso unitInputs) e stored null devolve os fallbacks', () => {
    const mesclado = hydratePrefsValues(DEFAULTS, { unidades: { axe: '50', sword: '10' } });
    expect(mesclado.unidades).toEqual({ axe: '50', sword: '10' });

    const semStored = hydratePrefsValues(DEFAULTS, null);
    expect(semStored).toEqual({ texto: '', horas: '0', unidades: { axe: '' }, fonte: 'recrutadas', migrado: false });
  });
});

describe('fallbackPrefsValues', () => {
  it('restaura os fallbacks LITERAIS (sem passar pelo onLoad)', () => {
    // "37" é inválido e o onLoad viraria "0"; o reset devolve o literal do campo.
    const defaultsComLixo: { [K in keyof TestPrefs]: PrefsFieldDef<TestPrefs[K]> } = {
      ...DEFAULTS,
      horas: { fallback: '0', onLoad: () => '0' },
    };
    expect(fallbackPrefsValues(defaultsComLixo).horas).toBe('0');
    expect(fallbackPrefsValues(DEFAULTS)).toEqual({
      texto: '',
      horas: '0',
      unidades: { axe: '' },
      fonte: 'recrutadas',
      migrado: false,
    });
  });
});

describe('applyHydrationCallback', () => {
  it('save acumula num patch único, aplica no values e devolve o patch para persistir (migração de 2 chaves)', () => {
    const hidratado = hydratePrefsValues(DEFAULTS, { texto: 'A B C', migrado: false });
    const { values, persisted } = applyHydrationCallback(hidratado, (vals, save) => {
      if (vals.migrado === true) return;
      save({ texto: 'A; B; C', migrado: true });
    });
    expect(values.texto).toBe('A; B; C'); // estado reflete o texto migrado
    expect(values.migrado).toBe(true);
    expect(persisted).toEqual({ texto: 'A; B; C', migrado: true }); // patch único p/ savePrefs
  });

  it('callback sem save não gera patch nem altera o values', () => {
    const hidratado = hydratePrefsValues(DEFAULTS, {});
    const { values, persisted } = applyHydrationCallback(hidratado, () => {});
    expect(values).toEqual(hidratado);
    expect(persisted).toBeNull();
  });

  it('callback que já viu a flag não re-migra (guarda da migração única)', () => {
    const hidratado = hydratePrefsValues(DEFAULTS, { texto: 'A; B', migrado: true });
    const { values, persisted } = applyHydrationCallback(hidratado, (vals, save) => {
      if (vals.migrado === true) return;
      save({ texto: 're-migrado' });
    });
    expect(values.texto).toBe('A; B');
    expect(persisted).toBeNull();
  });
});

describe('createPrefsFormStore', () => {
  it('começa nos fallbacks, não hidratado; setValue pré-hidratação atualiza a memória mas NÃO persiste', () => {
    const store = createPrefsFormStore(DEFAULTS);
    expect(store.getValues()).toEqual(fallbackPrefsValues(DEFAULTS));
    expect(store.isHydrated()).toBe(false);

    const mutation = store.setValue('texto', 'digitado antes da hidratação');
    expect(mutation.values.texto).toBe('digitado antes da hidratação');
    expect(mutation.persistPatch).toBeNull(); // regra herdada: só persiste depois de hidratado
  });

  it('hydrate roda UMA vez: mapeia os onLoad, executa o callback e devolve o patch de persistência', () => {
    const store = createPrefsFormStore(DEFAULTS);
    let callbackCount = 0;
    const mutation = store.hydrate({ texto: 'X Y', horas: '12' }, (values, save) => {
      callbackCount += 1;
      if (values.migrado !== true) save({ texto: 'X; Y', migrado: true });
    });

    expect(callbackCount).toBe(1);
    expect(mutation.values.texto).toBe('X; Y'); // patch do callback aplicado no estado
    expect(mutation.values.horas).toBe('12'); // onLoad deixou passar valor válido
    expect(mutation.values.fonte).toBe('recrutadas'); // fallback
    expect(mutation.persistPatch).toEqual({ texto: 'X; Y', migrado: true });

    // Segunda hidratação (re-render do prefs) é no-op — guarda hydrate-once.
    const deNovo = store.hydrate({ texto: 'outro', horas: '37' });
    expect(deNovo.persistPatch).toBeNull();
    expect(deNovo.values.texto).toBe('X; Y');
  });

  it('hidratação DESCARTA edições pré-hidratação (valor salvo vence), como no padrão manual', () => {
    const store = createPrefsFormStore(DEFAULTS);
    store.setValue('texto', 'rascunho perdido');
    const mutation = store.hydrate({ texto: 'salvo antes' });
    expect(mutation.values.texto).toBe('salvo antes');
  });

  it('setValue pós-hidratação persiste a chave; setValues aplica merge raso de vários campos', () => {
    const store = createPrefsFormStore(DEFAULTS);
    store.hydrate({});

    const um = store.setValue('horas', '6');
    expect(um.persistPatch).toEqual({ horas: '6' });

    const varios = store.setValues({ texto: 'a', fonte: 'agora' });
    expect(varios.values).toEqual({
      texto: 'a',
      horas: '6', // setValue anterior permanece (merge, não substituição)
      unidades: { axe: '' },
      fonte: 'agora',
      migrado: false,
    });
    expect(varios.persistPatch).toEqual({ texto: 'a', fonte: 'agora' });
  });

  it('reset restaura os fallbacks na memória; seguir editando volta a persistir', () => {
    const store = createPrefsFormStore(DEFAULTS);
    store.hydrate({});
    store.setValue('texto', 'editado');
    store.setValue('unidades', { axe: '99' });

    const reset = store.reset();
    expect(reset.persistPatch).toBeNull(); // limpeza do escopo é do resetPrefs (hook)
    expect(reset.values).toEqual(fallbackPrefsValues(DEFAULTS));
    expect(store.isHydrated()).toBe(true); // segue hidratado: próximas edições persistem

    const depois = store.setValue('horas', '4');
    expect(depois.persistPatch).toEqual({ horas: '4' });
  });
});
