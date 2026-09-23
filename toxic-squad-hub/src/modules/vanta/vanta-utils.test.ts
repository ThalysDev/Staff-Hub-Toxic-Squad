import { describe, expect, it } from 'vitest';

import {
  coordFromXy,
  coordKey,
  escapeHtml,
  fmtLead,
  parseCountdown,
  parseNumLoose,
  parsePtBrInt,
  parseServerNow,
  toLocalDatetimeValue,
} from './vanta-utils';

describe('escapeHtml (P1-1)', () => {
  it('escapa os 5 caracteres perigosos', () => {
    expect(escapeHtml(`<img src=x onerror="a">&'</img>`)).toBe(
      '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;&lt;/img&gt;',
    );
  });
  it('não altera texto comum', () => {
    expect(escapeHtml('Jogador Tranquilo')).toBe('Jogador Tranquilo');
  });
});

describe('parsePtBrInt (P1-2)', () => {
  it('"8.532" vira 8532 (o Vanta fazia 8)', () => {
    expect(parsePtBrInt('8.532')).toBe(8532);
  });
  it('"1.234.567" vira 1234567', () => {
    expect(parsePtBrInt('1.234.567')).toBe(1234567);
  });
  it('texto vio/traço/zero → 0', () => {
    expect(parsePtBrInt('')).toBe(0);
    expect(parsePtBrInt('–')).toBe(0);
    expect(parsePtBrInt('0')).toBe(0);
    expect(parsePtBrInt(null)).toBe(0);
    expect(parsePtBrInt(undefined)).toBe(0);
  });
  it('número simples sem separador', () => {
    expect(parsePtBrInt('999')).toBe(999);
  });
});

describe('toLocalDatetimeValue (P1-3)', () => {
  it('formata no fuso LOCAL (não UTC)', () => {
    const d = new Date(2026, 8, 21, 14, 5, 9); // 21/09/2026 14:05:09 local
    expect(toLocalDatetimeValue(d)).toBe('2026-09-21T14:05:09');
  });
  it('cola zero à esquerda', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    expect(toLocalDatetimeValue(d)).toBe('2026-01-02T03:04:05');
  });
});

describe('parseServerNow', () => {
  it('monta Date local a partir de dd/mm/aaaa + hh:mm:ss', () => {
    const d = parseServerNow('21/09/2026', '14:05:09');
    expect(d).not.toBeNull();
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(8);
    expect(d?.getHours()).toBe(14);
  });
  it('aceita hh:mm sem segundos', () => {
    const d = parseServerNow('01/01/2026', '09:30');
    expect(d?.getSeconds()).toBe(0);
  });
  it('retorna null em lixo', () => {
    expect(parseServerNow('', '')).toBeNull();
    expect(parseServerNow('xx', 'yy')).toBeNull();
  });
});

describe('coordFromXy / coordKey (P2 coords <100)', () => {
  it('aldeia 5|7 (xy=5007) decodifica certa (o slice do Vanta dava "500|7")', () => {
    expect(coordFromXy(5007)).toEqual({ x: 5, y: 7 });
    expect(coordKey(5, 7)).toBe('5|7');
  });
  it('coordenadas de 3 dígitos continuam corretas', () => {
    expect(coordFromXy(500500)).toEqual({ x: 500, y: 500 });
    expect(coordKey(999, 999)).toBe('999|999');
  });
  it('x<100 com y grande', () => {
    expect(coordFromXy(99_942)).toEqual({ x: 99, y: 942 });
  });
});

describe('parseCountdown / fmtLead', () => {
  it('parse "0:41:23"', () => {
    expect(parseCountdown('0:41:23')).toBe(2483);
  });
  it('parse "12:05:00"', () => {
    expect(parseCountdown('12:05:00')).toBe(43500);
  });
  it('não casa sem o formato', () => {
    expect(Number.isNaN(parseCountdown('em andamento'))).toBe(true);
  });
  it('fmtLead 2483 → "00:41 hrs"', () => {
    expect(fmtLead(2483)).toBe('00:41 hrs');
  });
  it('fmtLead negativo → 0', () => {
    expect(fmtLead(-30)).toBe('00:00 hrs');
  });
});

describe('parseNumLoose', () => {
  it('float com vírgula', () => {
    expect(parseNumLoose('1,5')).toBe(1.5);
  });
  it('lixo → 0', () => {
    expect(parseNumLoose('abc')).toBe(0);
    expect(parseNumLoose('')).toBe(0);
  });
});
