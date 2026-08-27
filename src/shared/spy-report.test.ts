import { describe, expect, it } from 'vitest';
import { DEFAULT_POP_PER_FULL, parseSpyReport, suggestFulls } from './spy-report';

// Relatório sintético fiel ao TW BR: cabeçalho com sujeira (data/hora), tabela
// com nome e quantidade em linhas separadas, milhar com ponto, plural, muralha
// e a linha de perdas do próprio atacante (que não descreve o alvo).
const RELATORIO_COMPLETO = [
  'Relatório de batalhas',
  'Espionagem em Aldeia do Inimigo (471|463) no dia 26.08. às 12:34',
  '',
  'Tropas (na aldeia):',
  'Lanceiros 10.000',
  'Espadachim 5.500',
  'Bárbaro 5.500',
  'Arqueiro 3.000',
  'Explorador 50',
  'Cavalaria Leve 2.000',
  'Arqueiro a Cavalo 500',
  'Cavalaria Pesada 1.500',
  'Ariete 200',
  'Catapulta 100',
  'Paladino 1',
  'Nobre 3',
  'Milícia 1.000',
  '',
  'Muralha: 12',
  '',
  'Perdas do atacante:',
  'Explorador 1',
].join('\r\n');

describe('parseSpyReport (corpo do relatório colado)', () => {
  it('extrai alvo do cabeçalho, muralha e todas as unidades da tabela', () => {
    const report = parseSpyReport(RELATORIO_COMPLETO);
    expect(report.coord).toBe('471|463');
    expect(report.wallLevel).toBe(12);
    expect(report.units).toEqual({
      spear: 10000,
      sword: 5500,
      axe: 5500,
      archer: 3000,
      spy: 50, // 1ª ocorrência vence; "Explorador 1" da linha de perdas NÃO sobrescreve
      light: 2000,
      marcher: 500, // "Arqueiro a Cavalo" vence "Arqueiro" por prefixo mais longo
      heavy: 1500,
      ram: 200,
      catapult: 100,
      knight: 1,
      snob: 3,
      militia: 1000,
    });
  });

  it('defPop e offPop pelos pesos REAIS de units.ts (heavy×4; catapulta/spy/milícia fora)', () => {
    const { defPop, offPop } = parseSpyReport(RELATORIO_COMPLETO);
    // defesa = 10.000 + 5.500 + 3.000 + 4 × 1.500 = 24.500 (Milícia não conta)
    expect(defPop).toBe(24500);
    // ataque = 5.500 + 4×2.000 + 5×500 + 5×200 + 10×1 + 100×3 = 17.310
    // (Catapulta e Explorador ficam fora do score, igual à ferramenta original)
    expect(offPop).toBe(17310);
  });

  it('aceita "Muralha Nível X", "Muralha: X" e muralha ausente (null)', () => {
    expect(parseSpyReport('Espionagem em 1|1\nLanceiro 10\nMuralha Nível 7').wallLevel).toBe(7);
    expect(parseSpyReport('Espionagem em 2|2\nLanceiro 10\nMuralha: 20').wallLevel).toBe(20);
    expect(parseSpyReport('Espionagem em 3|3\nLanceiro 10').wallLevel).toBeNull();
    // Nível acima do teto do jogo não vira wallLevel
    expect(parseSpyReport('Espionagem em 4|4\nLanceiro 10\nMuralha: 99').wallLevel).toBeNull();
  });

  it('casca pares na MESMA linha, com caixa alta, acentos tortos e plural por prefixo', () => {
    const report = parseSpyReport(
      [
        'Espionagem em 90|90',
        'LANCEIROS 1.000 Espadachim 25 Bárbaros 2.000',
        'CAVALARIA LEVE 300 Arqueiro à Cavalo 100', // "à" normaliza para "a"
        'cavalaria pesada 50 MILÍCIAS 500',
        'Catapultas 20 Arietes 30 Paladinos 1 Nobres 2 Arqueiros 75',
      ].join('\n'),
    );
    expect(report.coord).toBe('90|90');
    expect(report.units).toEqual({
      spear: 1000,
      sword: 25,
      axe: 2000,
      archer: 75,
      light: 300,
      marcher: 100,
      heavy: 50,
      ram: 30,
      catapult: 20,
      knight: 1,
      snob: 2,
      militia: 500,
    });
  });

  it('sem linha "Espionagem em", usa a primeira coordenada do texto (normalizada)', () => {
    const report = parseSpyReport(['Aldeia 123 | 456 atacada', 'Bárbaro 5.000', 'Muralha: 3'].join('\n'));
    expect(report.coord).toBe('123|456');
    expect(report.units.axe).toBe(5000);
    expect(report.wallLevel).toBe(3);
  });

  it('coordenada da linha "Espionagem em" tem prioridade sobre lixo anterior', () => {
    const report = parseSpyReport(
      ['conferir a aldeia 111|111 antes de colar', 'Espionagem em 471|463 no dia 26.08.', 'Lanceiro 10.000'].join('\n'),
    );
    expect(report.coord).toBe('471|463');
  });

  it('ignora lixo antes/depois (datas, horas, textos de fórum) sem virar tropa', () => {
    const report = parseSpyReport(
      ['postado em 26.08.2026 às 12:34 pelo jogador X', 'Espionagem em 500|500 K55', 'Lanceiro 1.234', 'fim do relatório, boas caçadas'].join('\n'),
    );
    expect(report.coord).toBe('500|500');
    expect(report.units).toEqual({ spear: 1234 });
    expect(report.defPop).toBe(1234);
  });

  it('fail-closed: sem coordenada → erro PT-BR claro', () => {
    expect(() => parseSpyReport('Lanceiro 10.000\nEspadachim 5.000')).toThrowError(/nenhuma coordenada/i);
  });

  it('fail-closed: sem unidades reconhecidas → erro PT-BR claro (inclusive só com perdas)', () => {
    expect(() => parseSpyReport('Espionagem em 1|1 no dia 26.08.\nMuralha: 12')).toThrowError(/nenhuma unidade/i);
    // Linha de perdas é ignorada por completo: relatório só com perdas não valida.
    expect(() => parseSpyReport('Espionagem em 2|1\nPerdas: Lanceiro 999')).toThrowError(/nenhuma unidade/i);
    // "Espadachins" (plural m→ns) NÃO casa por prefixo com "Espadachim" → fail-closed.
    expect(() => parseSpyReport('Espionagem em 3|1\nEspadachins 500')).toThrowError(/nenhuma unidade/i);
  });

  it('aldeia espiada vazia (todas zero) é válida e não lança', () => {
    const report = parseSpyReport('Espionagem em 5|5\nLanceiro 0\nEspadachim 0\nMuralha: 0');
    expect(report.units).toEqual({ spear: 0, sword: 0 });
    expect(report.defPop).toBe(0);
    expect(report.offPop).toBe(0);
    expect(report.wallLevel).toBe(0);
  });
});

describe('suggestFulls (regra-de-polegar configurável)', () => {
  it('sem muralha: base = ceil(defPop / pop por full), mínimo 1', () => {
    expect(suggestFulls(24500, null).fulls).toBe(2); // 24.500/20.000 = 1,23 → 2
    expect(suggestFulls(40000, null).fulls).toBe(2); // exato, sem arredondar para cima
    expect(suggestFulls(20000, null).fulls).toBe(1);
    expect(suggestFulls(0, null).fulls).toBe(1); // mínimo de 1 full
  });

  it('muralha acima do nível 10 adiciona 10% por nível sobre a base', () => {
    expect(suggestFulls(40000, 11).fulls).toBe(3); // base 2 +10% → ceil(2,2) = 3
    expect(suggestFulls(40000, 15).fulls).toBe(3); // +50% → ceil(3,0) = 3
  });

  it('muralha 10 ou menor não altera a conta; bônus tem teto de +50%', () => {
    expect(suggestFulls(40000, 10).fulls).toBe(2);
    expect(suggestFulls(40000, 0).fulls).toBe(2);
    expect(suggestFulls(40000, 20).fulls).toBe(3); // mesmo 10 níveis acima: teto +50%
  });

  it('pop por full é parâmetro: base e bônus recalculados', () => {
    expect(suggestFulls(30000, 12, 10000).fulls).toBe(4); // base 3 +20% → ceil(3,6) = 4
    expect(suggestFulls(30000, null, 10000).fulls).toBe(3);
    expect(DEFAULT_POP_PER_FULL).toBe(20000);
  });

  it('detail em PT-BR explica o cálculo e avisa que é regra-de-polegar', () => {
    const semMuralha = suggestFulls(24500, null);
    expect(semMuralha.detail).toContain('24.500');
    expect(semMuralha.detail).toContain('20.000');
    expect(semMuralha.detail).toContain('base de 2 fulls');
    expect(semMuralha.detail).toContain('regra-de-polegar configurável');

    const comMuralha = suggestFulls(40000, 15);
    expect(comMuralha.detail).toContain('muralha nível 15');
    expect(comMuralha.detail).toContain('+50%');
    expect(comMuralha.detail).toContain('3 fulls');
    expect(comMuralha.detail).toContain('regra-de-polegar configurável, não uma mecânica do jogo');

    const muralhaBaixa = suggestFulls(40000, 8);
    expect(muralhaBaixa.detail).toContain('não altera a conta');
  });

  it('valida entradas: defPop negativo ou pop por full inválido → erro PT-BR', () => {
    expect(() => suggestFulls(-1, null)).toThrowError(/população defensiva inválida/i);
    expect(() => suggestFulls(1000, null, 0)).toThrowError(/população por full inválida/i);
  });

  it('ponte com o parser: sugestão a partir do relatório completo (24.500 de defesa, muralha 12)', () => {
    const report = parseSpyReport(RELATORIO_COMPLETO);
    const suggestion = suggestFulls(report.defPop, report.wallLevel);
    expect(suggestion.fulls).toBe(3); // base ceil(1,23)=2, muralha 12 → +20% → ceil(2,4)
  });
});
