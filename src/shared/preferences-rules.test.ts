import { describe, expect, it } from 'vitest';
import {
  MAX_PREFS_PER_MODULE,
  MAX_PREF_STRING_LENGTH,
  PREFERENCE_MODULES,
  type PrefValue,
  type PreferenceModule,
  isPreferenceModule,
  mergePrefs,
  prefKeyCount,
  sanitizePrefPatch,
  validatePrefMerge,
} from './preferences-rules';

/** Patch com N chaves escalares numeradas (para testar o cap sem poluir os outros testes). */
function patchComChaves(quantidade: number): Record<string, PrefValue> {
  const patch: Record<string, PrefValue> = {};
  for (let i = 0; i < quantidade; i++) patch[`chave-${String(i).padStart(3, '0')}`] = i;
  return patch;
}

describe('isPreferenceModule', () => {
  it('aceita exatamente os 12 módulos do contrato (inclui captures desde a v0.24)', () => {
    expect(PREFERENCE_MODULES).toHaveLength(12);
    expect(PREFERENCE_MODULES).toContain('captures');
    for (const modulo of PREFERENCE_MODULES) {
      expect(isPreferenceModule(modulo)).toBe(true);
    }
  });

  it('rejeita nomes fora da lista (case-sensitive, sem espaço e sem variante)', () => {
    for (const nome of ['sg8', 'sg0', 'SG1', '', ' geral', 'guerras', 'dashboard2', 'Journal']) {
      expect(isPreferenceModule(nome)).toBe(false);
    }
  });

  it('funciona como type guard (estreita string → PreferenceModule)', () => {
    const bruto: string = 'guerra';
    if (!isPreferenceModule(bruto)) {
      throw new Error('type guard deveria aceitar módulo do contrato');
    }
    const modulo: PreferenceModule = bruto;
    expect(modulo).toBe('guerra');
  });
});

describe('sanitizePrefPatch (tolerante, nunca lança)', () => {
  it('mantém valores JSON puros e devolve objeto NOVO (inputs intocados, sem referência compartilhada)', () => {
    const patch = {
      nome: 'Operação Norte',
      limite: 25,
      ativo: false,
      observacao: null,
      coords: ['402|303', '512|498'],
      unitInputs: { axe: '10', club: '20' },
    } as Record<string, unknown>;

    const limpo = sanitizePrefPatch(patch);

    expect(limpo).toEqual(patch);
    expect(limpo).not.toBe(patch);
    expect(limpo['coords']).not.toBe(patch['coords']);
    expect(limpo['unitInputs']).not.toBe(patch['unitInputs']);
  });

  it('descarta silenciosamente função, undefined, símbolo, bigint e número não finito', () => {
    const sujo: Record<string, unknown> = {
      texto: 'fica',
      ausente: undefined,
      calculo: () => 1,
      rotulo: Symbol('rotulo'),
      gigante: 1n,
      vazio: Number.NaN, // NaN/Infinity virariam null no JSON.stringify — não são JSON puro
      infinito: Number.POSITIVE_INFINITY,
    };

    expect(sanitizePrefPatch(sujo)).toEqual({ texto: 'fica' });
  });

  it('descarta objetos que não são JSON puro (Date, Map, Set e instância de classe)', () => {
    class InstanciaDeClasse {
      valor = 1;
    }
    const sujo: Record<string, unknown> = {
      quando: new Date('2026-01-01T00:00:00.000Z'),
      conjunto: new Set([1, 2]),
      mapa: new Map([['a', 1]]),
      criado: new InstanciaDeClasse(),
    };

    expect(sanitizePrefPatch(sujo)).toEqual({});
  });

  it('profundidade além do raso descarta a CHAVE INTEIRA (não sanitiza parcial)', () => {
    const limpo = sanitizePrefPatch({
      unitInputs: { axe: '10' }, // raso: OK
      fundo: { a: { b: 1 } }, // nível 2 → 'fundo' inteiro fora
      misto: { ok: 'sim', fundo: { x: 1 } }, // um ramo fundo derruba a chave toda
      comArrayDentro: { itens: [1, 2] }, // objeto do patch só aceita escalares
    });

    expect(limpo).toEqual({ unitInputs: { axe: '10' } });
  });

  it('array com 499 itens passa; com 500+ a chave é descartada', () => {
    const limpo = sanitizePrefPatch({
      pequeno: Array.from({ length: 499 }, (_, i) => i),
      grande: Array.from({ length: 500 }, (_, i) => i),
    });

    expect(limpo['pequeno']).toHaveLength(499);
    expect(limpo['grande']).toBeUndefined();
  });

  it('array sanitiza ITEM a ITEM: objeto raso fica; item fundo, array aninhado ou função cai', () => {
    const limpo = sanitizePrefPatch({
      lista: [1, 'dois', null, true, { axe: '10' }, { fundo: { x: 1 } }, ['aninhado'], () => 'fn'],
    });

    expect(limpo['lista']).toEqual([1, 'dois', null, true, { axe: '10' }]);
  });

  it('BAN de credenciais: chave com sid/senha/password/token (case-insensitive) cai em qualquer nível', () => {
    const limpo = sanitizePrefPatch({
      sid: 'abc',
      SID: 'abc',
      Token: 'abc',
      MINHA_SENHA: 'abc',
      apiPassword: 'abc',
      session_Sid: 'abc',
      modulo: 'sg1', // vizinha válida fica
    });
    expect(limpo).toEqual({ modulo: 'sg1' });

    // o ban vale dentro de objeto raso e de item de array também
    const aninhado = sanitizePrefPatch({
      unitInputs: { sid: 'x', axe: '10' },
      lista: [{ token: 't', nome: 'x' }],
    });
    expect(aninhado).toEqual({ unitInputs: { axe: '10' }, lista: [{ nome: 'x' }] });
  });

  it('BAN não pega FALSOS POSITIVOS: "consider" contém sid — política é sid EXATO como chave', () => {
    // Regressão real: enemyCoordsConsiderText/allyCoordsConsiderText do SG_1
    // eram descartadas silenciosamente pelo ban de substring "sid".
    const limpo = sanitizePrefPatch({
      enemyCoordsConsiderText: '123|456',
      allyCoordsConsiderText: '654|321',
      consideracaoGeral: 'ok',
      sessionId: 'vaza?', // session BANE (substring legítima do ban)
      authToken: 'vaza?', // auth BANE
    });
    expect(limpo).toEqual({
      enemyCoordsConsiderText: '123|456',
      allyCoordsConsiderText: '654|321',
      consideracaoGeral: 'ok',
    });
  });

  it('NUNCA lança, nem com lixo exótico ou estrutura cíclica', () => {
    const ciclico: unknown[] = [];
    ciclico.push(ciclico);

    expect(() =>
      sanitizePrefPatch({
        ciclico,
        quando: new Date(),
        mapa: new Map(),
        profundo: { a: { b: { c: { d: 1 } } } },
      }),
    ).not.toThrow();
    // o array cíclico é reduzido a [] (o único item — ele mesmo — não é JSON puro raso)
    expect(sanitizePrefPatch({ ciclico })).toEqual({ ciclico: [] });
  });

  it('patch vazio devolve objeto vazio', () => {
    expect(sanitizePrefPatch({})).toEqual({});
  });
});

describe('mergePrefs (merge raso por chave)', () => {
  it('chave do patch substitui a chave INTEIRA do atual (sem merge profundo)', () => {
    const atual: Record<string, PrefValue> = { unitInputs: { axe: '10', club: '20' }, tema: 'escuro' };

    const mesclado = mergePrefs(atual, { unitInputs: { sword: '5' } });

    expect(mesclado).toEqual({ unitInputs: { sword: '5' }, tema: 'escuro' });
  });

  it('nunca muta current nem patch, e devolve objeto novo', () => {
    const atual: Record<string, PrefValue> = { unitInputs: { axe: '10' }, tema: 'escuro' };
    const patch: Record<string, PrefValue> = { tema: 'claro', novo: [1, 2] };
    const atualAntes = structuredClone(atual);
    const patchAntes = structuredClone(patch);

    const mesclado = mergePrefs(atual, patch);

    expect(mesclado).not.toBe(atual);
    expect(mesclado).not.toBe(patch);
    expect(atual).toEqual(atualAntes);
    expect(patch).toEqual(patchAntes);
  });
});

describe('prefKeyCount', () => {
  it('conta só chaves do topo (aninhamento não conta) e vazio é 0', () => {
    expect(prefKeyCount({})).toBe(0);
    expect(prefKeyCount({ a: 1, b: ['x'], c: { d: 2 }, e: null })).toBe(4);
  });
});

describe('validatePrefMerge (fail-closed nos caps)', () => {
  it('sanitiza o patch antes de mesclar: lixo de runtime e credencial não viram chave', () => {
    const atual = patchComChaves(10);
    const patch = {
      notas: 'texto válido',
      calculo: () => 1,
      senha: '123',
      fundo: { a: { b: 1 } },
    } as unknown as Record<string, PrefValue>;

    const mesclado = validatePrefMerge(atual, patch);

    expect(prefKeyCount(mesclado)).toBe(11);
    expect(mesclado['notas']).toBe('texto válido');
    expect(mesclado['calculo']).toBeUndefined();
    expect(mesclado['senha']).toBeUndefined();
    expect(mesclado['fundo']).toBeUndefined();
    expect(mesclado['chave-000']).toBe(0); // atual preservado
  });

  it('cap de 200 chaves por módulo: 201 no merge lança PT-BR; 200 exatos passam e editar continua possível', () => {
    const cheio = patchComChaves(MAX_PREFS_PER_MODULE);
    expect(() => validatePrefMerge(cheio, { extra: true })).toThrow(/200 preferências por módulo/);
    expect(() => validatePrefMerge(cheio, { extra: true })).toThrow(/ficaria com 201/);

    // 199 + 1 = 200: no limite exato passa
    expect(prefKeyCount(validatePrefMerge(patchComChaves(199), { ultima: true }))).toBe(200);

    // substituir chave existente NÃO aumenta a contagem — módulo cheio continua editável
    const editado = validatePrefMerge(cheio, { 'chave-000': 'novo valor' });
    expect(prefKeyCount(editado)).toBe(MAX_PREFS_PER_MODULE);
  });

  it('string acima de 20.000 caracteres lança PT-BR (no topo e dentro de array/objeto); no limite passa', () => {
    expect(() => validatePrefMerge({}, { notas: 'x'.repeat(MAX_PREF_STRING_LENGTH + 1) })).toThrow(/"notas".*20000/);
    expect(() => validatePrefMerge({}, { lista: ['y'.repeat(MAX_PREF_STRING_LENGTH + 1)] })).toThrow(/20000/);
    expect(() =>
      validatePrefMerge({}, { unitInputs: { texto: 'z'.repeat(MAX_PREF_STRING_LENGTH + 1) } }),
    ).toThrow(/20000/);

    const noLimite = validatePrefMerge({}, { notas: 'x'.repeat(MAX_PREF_STRING_LENGTH) });
    expect(noLimite['notas']).toHaveLength(MAX_PREF_STRING_LENGTH);
  });
});

describe('roundtrip com o disco', () => {
  it('JSON.stringify → parse → sanitize é idempotente (estado lido do disco re-sanitiza igual)', () => {
    const original = sanitizePrefPatch({
      nome: 'Operação Norte',
      limite: 25,
      ativo: true,
      observacao: null,
      coords: ['402|303', '512|498'],
      unitInputs: { axe: '10' },
      notas: 'x'.repeat(1000),
    } as Record<string, unknown>);

    const doDisco = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    expect(sanitizePrefPatch(doDisco)).toEqual(original);
    expect(sanitizePrefPatch(original)).toEqual(original); // sanitizar 2x não muda nada
  });
});
