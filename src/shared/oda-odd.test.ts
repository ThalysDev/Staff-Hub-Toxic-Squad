// Testes do motor puro do Painel de Guerra ODA/ODD: parse fail-closed do
// kill_*_tribe.txt (TSV rank\ttribeId\tnome\tkills), diff entre snapshots e
// montagem/cap do histórico. Formato real documentado no product brief —
// colunas numéricas podem vir com zeros à esquerda ("007").
import { describe, expect, it } from 'vitest';
import {
  MAX_ODA_ODD_HISTORY,
  buildOdaOddHistory,
  capOdaOddHistory,
  diffTribeKills,
  parseKillsTribeFile,
  type TribeKillsSnapshot,
} from './oda-odd';

describe('parseKillsTribeFile', () => {
  it('parseia o TSV completo de 4 colunas (com \n final e zeros à esquerda)', () => {
    const body = '1\t007\tToxic Squad\t912345\n2\t42\tRivais BR\t809001\n3\t1234\tGuerra Semi\t12\n';
    expect(parseKillsTribeFile(body)).toEqual([
      { rank: 1, tribeId: 7, name: 'Toxic Squad', kills: 912345 },
      { rank: 2, tribeId: 42, name: 'Rivais BR', kills: 809001 },
      { rank: 3, tribeId: 1234, name: 'Guerra Semi', kills: 12 },
    ]);
  });

  it('aceita CRLF como fim de linha', () => {
    const body = '1\t10\tTribo\t2\r\n2\t20\tOutra\t20\r\n';
    expect(parseKillsTribeFile(body)).toEqual([
      { rank: 1, tribeId: 10, name: 'Tribo', kills: 2 },
      { rank: 2, tribeId: 20, name: 'Outra', kills: 20 },
    ]);
  });

  it('falha com o conteúdo da linha malformada (3 colunas)', () => {
    expect(() => parseKillsTribeFile('1\t7\tSó Três Colunas\n')).toThrow('Só Três Colunas');
  });

  it('falha quando coluna numérica não é inteiro decimal', () => {
    expect(() => parseKillsTribeFile('1\t7\tTribo\tmuitos\n')).toThrow('Coluna "kills"');
    expect(() => parseKillsTribeFile('primeiro\t7\tTribo\t10\n')).toThrow('Coluna "rank"');
    expect(() => parseKillsTribeFile('1\t-7\tTribo\t10\n')).toThrow('Coluna "tribeId"');
  });

  it('falha em linha vazia no meio do arquivo (truncamento)', () => {
    expect(() => parseKillsTribeFile('1\t7\tTribo\t10\n\n2\t8\tOutra\t20\n')).toThrow('Linha 2 vazia');
  });

  it('falha em tribeId duplicado no mesmo dump (corrompido)', () => {
    expect(() => parseKillsTribeFile('1\t7\tTribo\t10\n2\t7\tTribo de novo\t20\n')).toThrow('duplicada');
  });

  it('falha em nome vazio e em arquivo sem nenhuma tribo', () => {
    expect(() => parseKillsTribeFile('1\t7\t\t10\n')).toThrow('Nome da tribo vazio');
    expect(() => parseKillsTribeFile('\n')).toThrow('sem nenhuma tribo');
    expect(() => parseKillsTribeFile('')).toThrow('sem nenhuma tribo');
  });
});

describe('diffTribeKills', () => {
  const base: TribeKillsSnapshot = { fetchedAt: '2026-09-20T10:00:00.000Z', kills: 1_000 };

  it('sem leitura anterior não inventa delta (null)', () => {
    expect(diffTribeKills(null, 500)).toBeNull();
  });

  it('delta positivo, negativo e estável vs o snapshot arquivado', () => {
    expect(diffTribeKills(base, 1_234)).toEqual({ delta: 234 });
    expect(diffTribeKills(base, 999)).toEqual({ delta: -1 });
    expect(diffTribeKills(base, 1_000)).toEqual({ delta: 0 });
  });

  it('fail-closed: kills não inteiro/negativo lança (arquivado ou novo)', () => {
    expect(() => diffTribeKills(base, -1)).toThrow('Kills fora do formato');
    expect(() => diffTribeKills({ fetchedAt: base.fetchedAt, kills: 1.5 }, 10)).toThrow('Kills fora do formato');
  });
});

describe('buildOdaOddHistory', () => {
  it('delta de cada linha é contra a leitura imediatamente anterior (1ª = null)', () => {
    const rows: TribeKillsSnapshot[] = [
      { fetchedAt: '2026-09-18T10:00:00.000Z', kills: 100 },
      { fetchedAt: '2026-09-19T10:00:00.000Z', kills: 350 },
      { fetchedAt: '2026-09-20T10:00:00.000Z', kills: 300 },
    ];
    expect(buildOdaOddHistory(rows, 'TWS')).toEqual([
      { date: '2026-09-18T10:00:00.000Z', kills: 100, delta: null },
      { date: '2026-09-19T10:00:00.000Z', kills: 350, delta: 250 },
      { date: '2026-09-20T10:00:00.000Z', kills: 300, delta: -50 },
    ]);
  });

  it('fail-closed: histórico vazio, nome vazio e data inválida lançam PT-BR', () => {
    expect(() => buildOdaOddHistory([], 'TWS')).toThrow('Histórico de OD vazio para a tribo TWS');
    expect(() => buildOdaOddHistory([{ fetchedAt: 'x', kills: 1 }], '  ')).toThrow('não identificada');
    expect(() => buildOdaOddHistory([{ fetchedAt: 'não é data', kills: 1 }], 'TWS')).toThrow('data inválida');
  });
});

describe('capOdaOddHistory', () => {
  it('mantém as últimas MAX_ODA_ODD_HISTORY leituras (ordem cronológica, recente no fim)', () => {
    const rows: TribeKillsSnapshot[] = Array.from({ length: MAX_ODA_ODD_HISTORY + 5 }, (_, i) => ({
      fetchedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      kills: i,
    }));
    const capped = capOdaOddHistory(rows);
    expect(capped).toHaveLength(MAX_ODA_ODD_HISTORY);
    expect(capped[0]).toEqual({ fetchedAt: '2026-01-01T00:00:05.000Z', kills: 5 });
    expect(capped[capped.length - 1]).toEqual(rows[rows.length - 1]);
  });

  it('abaixo do teto devolve cópia integral', () => {
    const rows: TribeKillsSnapshot[] = [{ fetchedAt: '2026-09-20T10:00:00.000Z', kills: 1 }];
    const capped = capOdaOddHistory(rows);
    expect(capped).toEqual(rows);
    expect(capped).not.toBe(rows);
  });
});
