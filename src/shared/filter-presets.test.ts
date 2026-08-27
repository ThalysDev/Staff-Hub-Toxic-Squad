import { describe, expect, it } from 'vitest';
import {
  MAX_PRESET_FIELDS,
  MAX_PRESET_NAME_LENGTH,
  MAX_PRESETS,
  MAX_PRESETS_JSON_LENGTH,
  type FilterPreset,
  listPresets,
  parsePresets,
  removePreset,
  serializePresets,
  upsertPreset,
} from './filter-presets';

const SALVED_AT_FIXO = '2026-08-26T00:00:00.000Z';

/** Preset de teste com defaults inocentes. */
function preset(
  nome: string,
  fields: Record<string, string> = {},
  savedAt: string = SALVED_AT_FIXO,
): FilterPreset {
  return { name: nome, fields, savedAt };
}

/** N campos numerados (campo-00…campo-N) para testar o cap de fields. */
function campos(quantidade: number): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 0; i < quantidade; i++) fields[`campo-${String(i).padStart(2, '0')}`] = `valor-${i}`;
  return fields;
}

/** Coleção com N presets nomeados preset-00…preset-N (todos válidos). */
function colecaoCom(quantidade: number): Record<string, FilterPreset> {
  const presets: Record<string, FilterPreset> = {};
  for (let i = 0; i < quantidade; i++) {
    const nome = `preset-${String(i).padStart(2, '0')}`;
    presets[nome] = preset(nome, campos(1));
  }
  return presets;
}

// Esqueleto de JSON válido com UM campo "pad" de 1 caractere — trocar o 'X' por
// N caracteres dá um JSON válido com o comprimento EXATO pedido (para testar o
// teto de 20k sem depender de contagem manual).
const ESQUELETO = JSON.stringify({ p: { name: 'p', fields: { pad: 'X' }, savedAt: SALVED_AT_FIXO } });

/** JSON VÁLIDO de um preset único com comprimento total exato. */
function jsonValidoComComprimento(total: number): string {
  const pad = total - ESQUELETO.length + 1;
  if (pad < 1) throw new Error(`comprimento ${total} é menor que o esqueleto (${ESQUELETO.length})`);
  return JSON.stringify({ p: { name: 'p', fields: { pad: 'X'.repeat(pad) }, savedAt: SALVED_AT_FIXO } });
}

/** JSON cru de presets (bypassa serializePresets — para testar o parse contra disco forjado). */
function jsonCru(corpo: Record<string, unknown>): string {
  return JSON.stringify(corpo);
}

describe('serializePresets', () => {
  it('roundtrip: serialize → parse devolve a coleção intacta (nomes, campos, savedAt)', () => {
    const original = upsertPreset(
      upsertPreset(
        upsertPreset({}, preset('Frente Norte', { raza: 'Operação Norte', alvo: '402|303' }, '2026-08-20T10:00:00.000Z')),
        preset('Sul', { raza: 'Sul', ignoraVazio: '' }, '2026-08-26T12:00:00.000Z'),
      ),
      preset('vazio', {}, '2026-08-01T00:00:00.000Z'),
    );

    const volta = parsePresets(serializePresets(original));

    expect(volta).toEqual(original);
  });

  it('roundtrip é idempotente: serialize(parse(serialize(x))) === serialize(x)', () => {
    const json = serializePresets(upsertPreset({}, preset('Norte', { raza: 'x' })));
    expect(serializePresets(parsePresets(json))).toBe(json);
  });

  it('serializa coleção vazia como {} e sem BOM', () => {
    const json = serializePresets({});
    expect(json).toBe('{}');
    expect(json.charCodeAt(0)).not.toBe(0xfeff);
    expect(parsePresets('{}')).toEqual({});
  });

  it('determinístico: ordem de inserção diferente produz a MESMA string (chaves e fields ordenados)', () => {
    const ordemA: Record<string, FilterPreset> = {};
    ordemA['Beta'] = preset('Beta', { z: '1', a: '2' });
    ordemA['Alfa'] = preset('Alfa', { m: '9', b: '8' });
    const ordemB: Record<string, FilterPreset> = {
      Alfa: preset('Alfa', { b: '8', m: '9' }),
      Beta: preset('Beta', { a: '2', z: '1' }),
    };

    const jsonA = serializePresets(ordemA);
    const jsonB = serializePresets(ordemB);

    expect(jsonA).toBe(jsonB);
    expect(jsonA.indexOf('"Alfa"')).toBeLessThan(jsonA.indexOf('"Beta"')); // presets ordenados
    expect(jsonA.indexOf('"a"')).toBeLessThan(jsonA.indexOf('"z"')); // fields ordenados
  });

  it('lança PT-BR quando o JSON final passa de 20k (upsert aceita, serialize barra na porta do disco)', () => {
    const gigante = upsertPreset({}, preset('gigante', { pad: 'z'.repeat(MAX_PRESETS_JSON_LENGTH + 100) }));
    expect(() => serializePresets(gigante)).toThrow(
      new RegExp(`serializados ficam com \\d+ caracteres — o máximo persistível é ${MAX_PRESETS_JSON_LENGTH}`),
    );
  });

  it('lança PT-BR quando a coleção tem mais de MAX_PRESETS', () => {
    const estourada: Record<string, FilterPreset> = {};
    for (let i = 0; i <= MAX_PRESETS; i++) estourada[`p-${i}`] = preset(`p-${i}`);
    expect(() => serializePresets(estourada)).toThrow(new RegExp(`${MAX_PRESETS + 1} presets — o máximo é ${MAX_PRESETS}`));
  });

  it('lança quando a chave do record difere do nome trimado do preset', () => {
    expect(() => serializePresets({ Foo: preset('Bar') })).toThrow(/não bate com o nome trimado "Bar"/);
  });
});

describe('parsePresets (fail-closed PT-BR)', () => {
  it('lixo lança citando JSON (texto solto, vazio, truncado)', () => {
    for (const lixo of ['não é json', '', 'undefined', '{"p": {name:']) {
      expect(() => parsePresets(lixo)).toThrow(/JSON/);
    }
  });

  it('raiz não-objeto lança (array, número, string, null, boolean)', () => {
    for (const raiz of ['[]', '[{"name":"x"}]', '42', '"texto"', 'null', 'true']) {
      expect(() => parsePresets(raiz)).toThrow(/não é um objeto/);
    }
  });

  it('entrada acima do teto lança antes mesmo de interpretar: 20001 não passa, 20000 passa', () => {
    expect(() => parsePresets(jsonValidoComComprimento(MAX_PRESETS_JSON_LENGTH + 1))).toThrow(
      new RegExp(`${MAX_PRESETS_JSON_LENGTH + 1} caracteres — o máximo persistível é ${MAX_PRESETS_JSON_LENGTH}`),
    );
    const noLimite = parsePresets(jsonValidoComComprimento(MAX_PRESETS_JSON_LENGTH));
    expect(noLimite['p']).toBeDefined();
  });

  it('mais de MAX_PRESETS presets lança; exatamente MAX_PRESETS passa', () => {
    expect(() => parsePresets(jsonCru(colecaoCom(MAX_PRESETS + 1)))).toThrow(
      new RegExp(`tem ${MAX_PRESETS + 1} presets — o máximo é ${MAX_PRESETS}`),
    );
    expect(Object.keys(parsePresets(jsonCru(colecaoCom(MAX_PRESETS))))).toHaveLength(MAX_PRESETS);
  });

  it('preset com mais de MAX_PRESET_FIELDS campos lança; exatamente 30 passa', () => {
    const com31 = jsonCru({ x: { name: 'x', fields: campos(MAX_PRESET_FIELDS + 1), savedAt: SALVED_AT_FIXO } });
    expect(() => parsePresets(com31)).toThrow(
      new RegExp(`tem ${MAX_PRESET_FIELDS + 1} campos — o máximo é ${MAX_PRESET_FIELDS}`),
    );
    const com30 = parsePresets(jsonCru({ x: { name: 'x', fields: campos(MAX_PRESET_FIELDS), savedAt: SALVED_AT_FIXO } }));
    expect(Object.keys(com30['x']?.fields ?? {})).toHaveLength(MAX_PRESET_FIELDS);
  });

  it('preset sem name (ausente ou não-string) lança', () => {
    expect(() => parsePresets(jsonCru({ x: { fields: {}, savedAt: SALVED_AT_FIXO } }))).toThrow(/sem name/);
    expect(() => parsePresets(jsonCru({ x: { name: 42, fields: {}, savedAt: SALVED_AT_FIXO } }))).toThrow(/sem name/);
  });

  it('preset que não é objeto lança', () => {
    for (const corpo of [42, 'texto', null, true]) {
      expect(() => parsePresets(jsonCru({ x: corpo }))).toThrow(/não é um objeto com name, fields e savedAt/);
    }
  });

  it('fields não-objeto (string, array, número) lança', () => {
    for (const fields of ['nada', ['a'], 42, null]) {
      expect(() => parsePresets(jsonCru({ x: { name: 'x', fields, savedAt: SALVED_AT_FIXO } }))).toThrow(/fields inválidos/);
    }
  });

  it('preset sem savedAt (ausente ou não-string) lança', () => {
    expect(() => parsePresets(jsonCru({ x: { name: 'x', fields: {} } }))).toThrow(/sem savedAt/);
    expect(() => parsePresets(jsonCru({ x: { name: 'x', fields: {}, savedAt: 123 } }))).toThrow(/sem savedAt/);
  });

  it('nome vazio após trim lança; 41 caracteres lança; 40 caracteres passa', () => {
    expect(() => parsePresets(jsonCru({ '': { name: '   ', fields: {}, savedAt: SALVED_AT_FIXO } }))).toThrow(
      /entre 1 e 40 caracteres/,
    );
    const comprido = 'n'.repeat(MAX_PRESET_NAME_LENGTH + 1);
    expect(() => parsePresets(jsonCru({ [comprido]: { name: comprido, fields: {}, savedAt: SALVED_AT_FIXO } }))).toThrow(
      new RegExp(`recebeu ${MAX_PRESET_NAME_LENGTH + 1}`),
    );
    const noLimite = 'n'.repeat(MAX_PRESET_NAME_LENGTH);
    expect(parsePresets(jsonCru({ [noLimite]: { name: ` ${noLimite} `, fields: {}, savedAt: SALVED_AT_FIXO } }))).toEqual({
      [noLimite]: preset(noLimite),
    });
  });

  it('chave que difere do nome trimado lança (trim é a identidade — re-keying silencioso esconderia colisão)', () => {
    expect(() => parsePresets(jsonCru({ Foo: { name: 'Bar', fields: {}, savedAt: SALVED_AT_FIXO } }))).toThrow(
      /Chave "Foo" não bate com o nome trimado "Bar"/,
    );
  });

  it('campo não-string é DESCARTADO (só a chave cai), o resto do preset sobrevive — decisão documentada', () => {
    const bruto = jsonCru({
      x: {
        name: 'x',
        fields: { raza: 'Operação Norte', pagina: '2', taxa: 0.5, antigo: null, lista: ['a'], certo: 'fica' },
        savedAt: SALVED_AT_FIXO,
      },
    });

    expect(parsePresets(bruto)).toEqual({ x: preset('x', { raza: 'Operação Norte', pagina: '2', certo: 'fica' }) });
  });

  it('props extras do preset (fora name/fields/savedAt) são descartadas', () => {
    const bruto = jsonCru({ x: { name: 'x', fields: { a: '1' }, savedAt: SALVED_AT_FIXO, lixo: 123, versao: '0.21' } });
    expect(parsePresets(bruto)).toEqual({ x: preset('x', { a: '1' }) });
  });

  it('tolera um BOM solitário no início (artefato de editor), mantendo o resto da validação', () => {
    const base = upsertPreset({}, preset('Norte', { raza: 'x' }));
    expect(parsePresets(`\uFEFF${serializePresets(base)}`)).toEqual(base);
  });

  it('entrada não-string lança (defesa de fronteira)', () => {
    expect(() => parsePresets(undefined as unknown as string)).toThrow(/string JSON/);
  });
});

describe('upsertPreset', () => {
  it('substitui pelo nome trimado ("  Frente Norte  " É o mesmo preset que "Frente Norte")', () => {
    const base = upsertPreset(upsertPreset({}, preset('Frente Norte', { raza: 'Norte' }, '2026-08-20T10:00:00.000Z')), preset('Sul', { raza: 'Sul' }));

    const apos = upsertPreset(base, preset('  Frente Norte  ', { raza: 'Norte 2' }, '2026-08-26T12:00:00.000Z'));

    expect(Object.keys(apos)).toEqual(['Frente Norte', 'Sul']);
    expect(apos['Frente Norte']).toEqual({ name: 'Frente Norte', fields: { raza: 'Norte 2' }, savedAt: '2026-08-26T12:00:00.000Z' });
  });

  it('cap: novo preset além de MAX_PRESETS lança PT-BR; substituir existente no limite continua permitido', () => {
    const cheia = colecaoCom(MAX_PRESETS);

    expect(() => upsertPreset(cheia, preset('Novo'))).toThrow(
      new RegExp(`Já existem ${MAX_PRESETS} presets salvos — remova um antes de salvar "Novo"`),
    );

    const substituida = upsertPreset(cheia, preset('  preset-00  ', { novo: 'sim' }, '2026-08-26T09:00:00.000Z'));
    expect(Object.keys(substituida)).toHaveLength(MAX_PRESETS);
    expect(substituida['preset-00']).toEqual({ name: 'preset-00', fields: { novo: 'sim' }, savedAt: '2026-08-26T09:00:00.000Z' });
  });

  it('nome vazio/apenas espaços ou com 41 caracteres lança PT-BR; com 40 passa trimado', () => {
    expect(() => upsertPreset({}, preset(''))).toThrow(/entre 1 e 40 caracteres/);
    expect(() => upsertPreset({}, preset('   '))).toThrow(/recebeu 0/);
    expect(() => upsertPreset({}, preset('n'.repeat(MAX_PRESET_NAME_LENGTH + 1)))).toThrow(
      new RegExp(`recebeu ${MAX_PRESET_NAME_LENGTH + 1}`),
    );
    const noLimite = 'n'.repeat(MAX_PRESET_NAME_LENGTH);
    expect(upsertPreset({}, preset(` ${noLimite} `))).toEqual({ [noLimite]: preset(noLimite) });
  });

  it('mais de MAX_PRESET_FIELDS campos lança; exatamente 30 passa', () => {
    expect(() => upsertPreset({}, preset('x', campos(MAX_PRESET_FIELDS + 1)))).toThrow(
      new RegExp(`tem ${MAX_PRESET_FIELDS + 1} campos — o máximo é ${MAX_PRESET_FIELDS}`),
    );
    expect(upsertPreset({}, preset('x', campos(MAX_PRESET_FIELDS)))['x']).toBeDefined();
  });

  it('não muta a coleção de entrada (devolve objeto novo)', () => {
    const base = colecaoCom(2);
    const antes = jsonCru(base);

    const apos = upsertPreset(base, preset('Novo'));
    removePreset(apos, 'preset-00');

    expect(apos).not.toBe(base);
    expect(jsonCru(base)).toBe(antes);
  });
});

describe('removePreset', () => {
  it('remove pelo nome trimado e devolve objeto novo sem mutar a entrada', () => {
    const base = colecaoCom(2);
    const antes = jsonCru(base);

    const apos = removePreset(base, '  preset-00  ');

    expect(Object.keys(apos)).toEqual(['preset-01']);
    expect(apos).not.toBe(base);
    expect(jsonCru(base)).toBe(antes);
  });

  it('remover inexistente é idempotente e não lança', () => {
    const base = colecaoCom(2);
    const primeira = removePreset(base, 'nao-existe');
    const segunda = removePreset(primeira, 'nao-existe');

    expect(segunda).toEqual(primeira);
    expect(() => removePreset(base, 'nao-existe')).not.toThrow();
  });
});

describe('listPresets', () => {
  it('ordena por savedAt desc (mais recente primeiro)', () => {
    const presets = {
      velho: preset('velho', {}, '2026-08-20T10:00:00.000Z'),
      recente: preset('recendente', {}, '2026-08-26T12:30:00.000Z'),
      medio: preset('medio', {}, '2026-08-26T10:00:00.000Z'),
    };

    expect(listPresets(presets).map((p) => p.name)).toEqual(['recendente', 'medio', 'velho']);
  });

  it('compara por timestamp (ISO com offset diferente do Z ordena pelo instante real)', () => {
    const presets = {
      meioDiaEMeiaZ: preset('meioDiaEMeiaZ', {}, '2026-08-26T12:30:00.000Z'),
      duasDaTardeMaisDois: preset('duasDaTardeMaisDois', {}, '2026-08-26T14:00:00+02:00'), // 12:00Z — ANTES do 12:30Z
    };

    expect(listPresets(presets).map((p) => p.name)).toEqual(['meioDiaEMeiaZ', 'duasDaTardeMaisDois']);
  });

  it('empate de savedAt desempata pelo nome em ordem alfabética (lista determinística)', () => {
    const presets = { b: preset('Beta', {}, '2026-08-26T00:00:00.000Z'), a: preset('Alfa', {}, '2026-08-26T00:00:00.000Z') };
    expect(listPresets(presets).map((p) => p.name)).toEqual(['Alfa', 'Beta']);
  });
});
