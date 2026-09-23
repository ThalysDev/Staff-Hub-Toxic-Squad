import { describe, expect, it } from 'vitest';
import {
  SUPPORT_LINE_UNITS,
  formatSupportLine,
  lineTiming,
  parseSupportLine,
  parseSupportLines,
  supportLineSchema,
  type SupportLine,
} from './support-line-codec';

/** 23/09/2026 12:00:00.000 UTC — relógio fixo dos testes. */
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0, 0);

const unitsOf = (values: Partial<Record<string, number>> = {}): Record<string, number> => {
  const units: Record<string, number> = {};
  for (const unit of SUPPORT_LINE_UNITS) units[unit] = values[unit] ?? 0;
  return units;
};

const lineText = (values: Partial<Record<string, number>> = {}, tail = ''): string =>
  `500|500 ${SUPPORT_LINE_UNITS.map((unit) => values[unit] ?? 0).join('/')}${tail === '' ? '' : ` ${tail}`}`;

const parse = (text: string, yearHint?: number): SupportLine => {
  const parsed = yearHint === undefined ? parseSupportLine(text, NOW) : parseSupportLine(text, NOW, yearHint);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
};

const errorOf = (text: string): string => {
  const parsed = parseSupportLine(text, NOW);
  if (!('error' in parsed)) throw new Error('esperava erro de parse');
  return parsed.error;
};

describe('support-line-codec', () => {
  it('lê linha imediata (sem datas) com as 10 unidades na ordem fixa', () => {
    const line = parse(lineText({ spear: 100, sword: 50, light: 20 }));
    expect(SUPPORT_LINE_UNITS).toEqual([
      'spear',
      'sword',
      'axe',
      'archer',
      'spy',
      'light',
      'marcher',
      'heavy',
      'ram',
      'catapult',
    ]);
    expect(line.target).toEqual({ x: 500, y: 500 });
    expect(line.units.spear).toBe(100);
    expect(line.units.sword).toBe(50);
    expect(line.units.light).toBe(20);
    expect(line.units.catapult).toBe(0);
    expect(line.earliestArrivalMs).toBeNull();
    expect(line.exactArrivalMs).toBeNull();
    expect(lineTiming(line)).toBe('imediato');
  });

  it('lê linha cravada com uma data', () => {
    const line = parse(lineText({ spear: 100 }, '24/09-21:30:00:500'));
    expect(line.exactArrivalMs).toBe(Date.UTC(2026, 8, 24, 21, 30, 0, 500));
    expect(line.earliestArrivalMs).toBeNull();
    expect(lineTiming(line)).toBe('cravado');
  });

  it('lê janela com i<início> e a data-alvo', () => {
    const line = parse(lineText({ spear: 100 }, 'i24/09-21:30:00:000 25/09-02:00:00:000'));
    expect(line.earliestArrivalMs).toBe(Date.UTC(2026, 8, 24, 21, 30, 0, 0));
    expect(line.exactArrivalMs).toBe(Date.UTC(2026, 8, 25, 2, 0, 0, 0));
    expect(lineTiming(line)).toBe('janela');
  });

  it('aceita milissegundos de 1 a 3 dígitos e rejeita 4', () => {
    expect(parse(lineText({}, '24/09-21:30:00:5')).exactArrivalMs).toBe(Date.UTC(2026, 8, 24, 21, 30, 0, 5));
    expect(parse(lineText({}, '24/09-21:30:00:50')).exactArrivalMs).toBe(Date.UTC(2026, 8, 24, 21, 30, 0, 50));
    expect(parse(lineText({}, '24/09-21:30:00:500')).exactArrivalMs).toBe(Date.UTC(2026, 8, 24, 21, 30, 0, 500));
    expect(errorOf(lineText({}, '24/09-21:30:00:5000'))).toMatch(/Data inválida/);
  });

  it('infere o ano pelo instante de referência e rola data passada para o ano seguinte', () => {
    // 30 minutos atrás ainda é o MESMO ano (graça de 1h).
    expect(parse(lineText({}, '23/09-11:30:00:000')).exactArrivalMs).toBe(Date.UTC(2026, 8, 23, 11, 30, 0, 0));
    // Data do passado distante rola um ano.
    expect(parse(lineText({}, '01/01-10:00:00:000')).exactArrivalMs).toBe(Date.UTC(2027, 0, 1, 10, 0, 0, 0));
    // yearHint manda no ano.
    expect(parse(lineText({}, '01/01-10:00:00:000'), 2030).exactArrivalMs).toBe(Date.UTC(2030, 0, 1, 10, 0, 0, 0));
  });

  it('janela que cruza o Ano Novo usa o início como piso do fim', () => {
    const line = parse(lineText({}, 'i31/12-23:00:00:000 01/01-00:30:00:000'));
    expect(line.earliestArrivalMs).toBe(Date.UTC(2026, 11, 31, 23, 0, 0, 0));
    expect(line.exactArrivalMs).toBe(Date.UTC(2027, 0, 1, 0, 30, 0, 0));
    expect(lineTiming(line)).toBe('janela');
  });

  it('rejeita lixo com erro em pt-BR', () => {
    expect(errorOf('lixo total')).toMatch(/Coordenada inválida/);
    expect(errorOf('500|500')).toMatch(/Linha incompleta/);
    expect(errorOf('1000|500 1/2/3/4/5/6/7/8/9/10')).toMatch(/Coordenada inválida/);
  });

  it('rejeita lista de unidades diferente de 10 valores', () => {
    expect(errorOf('500|500 1/2/3')).toMatch(/exatamente 10 valores/);
    expect(errorOf('500|500 1/2/3/4/5/6/7/8/9/10/11')).toMatch(/exatamente 10 valores/);
    expect(errorOf(lineText({}).replace(/\//, ''))).toMatch(/exatamente 10 valores/);
  });

  it('rejeita quantidade não inteira ou negativa', () => {
    expect(errorOf('500|500 100/-5/0/0/0/0/0/0/0/0')).toMatch(/Quantidade inválida em espada/);
    expect(errorOf('500|500 100/2.5/0/0/0/0/0/0/0/0')).toMatch(/Quantidade inválida em espada/);
    expect(errorOf('500|500 100/2/0.5/0/0/0/0/0/0/0')).toMatch(/Quantidade inválida em machado/);
  });

  it('exige a data-alvo na janela e a marca i na primeira data', () => {
    expect(errorOf(lineText({}, 'i24/09-21:30:00:000'))).toMatch(/JANELA/);
    expect(errorOf(lineText({}, '24/09-21:30:00:000 25/09-02:00:00:000'))).toMatch(/marca "i"/);
    expect(errorOf(lineText({}, 'i24/09-21:30:00:000 i25/09-02:00:00:000'))).toMatch(/data de INÍCIO/);
    expect(errorOf(lineText({}, '24/09-21:30:00:000 25/09-02:00:00:000 26/09-02:00:00:000'))).toMatch(
      /no máximo duas datas/,
    );
  });

  it('rejeita data fora do calendário', () => {
    expect(errorOf(lineText({}, '31/02-10:00:00:000'))).toMatch(/fora do calendário/);
    expect(errorOf(lineText({}, '24/13-10:00:00:000'))).toMatch(/fora do calendário/);
    expect(errorOf(lineText({}, '24/09-25:00:00:000'))).toMatch(/fora do calendário/);
  });

  it('faz roundtrip format → parse estável nos três tempos', () => {
    const immediate = parse(lineText({ spear: 12, catapult: 3 }));
    const exact = parse(lineText({ spear: 12 }, '24/09-21:30:00:500'));
    const window = parse(lineText({ spear: 12 }, 'i24/09-21:30:00:000 25/09-02:00:00:000'));
    for (const line of [immediate, exact, window]) {
      const text = formatSupportLine(line);
      expect(parse(text)).toEqual(line);
      expect(formatSupportLine(parse(text))).toBe(text);
    }
    expect(formatSupportLine(immediate)).toBe(lineText({ spear: 12, catapult: 3 }));
    expect(formatSupportLine(window)).toBe(lineText({ spear: 12 }, 'i24/09-21:30:00:000 25/09-02:00:00:000'));
  });

  it('tolera espaços múltiplos e ignora linhas vazias', () => {
    const line = parse(`   500|500    100/50/0/0/0/20/0/0/0/0    24/09-21:30:00:500   `);
    expect(line.units.spear).toBe(100);
    expect(line.exactArrivalMs).toBe(Date.UTC(2026, 8, 24, 21, 30, 0, 500));
    const { lines, errors } = parseSupportLines(
      `\n${lineText({ spear: 1 })}\n\n   \n${lineText({ spear: 2 }, 'i24/09-20:00:00:000 24/09-21:00:00:000')}\n`,
      NOW,
    );
    expect(lines).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(lineTiming(lines[0]!)).toBe('imediato');
    expect(lineTiming(lines[1]!)).toBe('janela');
  });

  it('separa linhas válidas dos erros, preservando o texto cru', () => {
    const { lines, errors } = parseSupportLines(
      [
        lineText({ spear: 10 }),
        '500|500 1/2/3',
        lineText({ sword: 5 }, '24/09-21:30:00:500'),
        'lixo',
      ].join('\n'),
      NOW,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.units.spear).toBe(10);
    expect(lines[1]!.units.sword).toBe(5);
    expect(errors.map((entry) => entry.raw)).toEqual(['500|500 1/2/3', 'lixo']);
    expect(errors[0]!.error).toMatch(/exatamente 10 valores/);
    expect(errors[1]!.error).toMatch(/Linha incompleta/);
  });

  it('schema aceita a linha válida e rejeita negativo, unidade faltando e janela invertida', () => {
    const valid = parse(lineText({ spear: 100 }, 'i24/09-21:30:00:000 25/09-02:00:00:000'));
    expect(supportLineSchema.safeParse(valid).success).toBe(true);
    expect(supportLineSchema.safeParse({ ...valid, units: unitsOf({ spear: -1 }) }).success).toBe(false);
    const missing = unitsOf({ spear: 1 }) as Partial<Record<string, number>>;
    delete missing.catapult;
    expect(supportLineSchema.safeParse({ ...valid, units: missing }).success).toBe(false);
    expect(
      supportLineSchema.safeParse({
        ...valid,
        earliestArrivalMs: Date.UTC(2026, 8, 25),
        exactArrivalMs: Date.UTC(2026, 8, 24),
      }).success,
    ).toBe(false);
    expect(supportLineSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});
