import { describe, expect, it } from 'vitest';
import type { UnitType } from '../../../ext/modules/shared/module-types';
import { DEFAULT_SETTINGS, decideCollectionLot } from './collection';

const AVAILABLE: Partial<Record<UnitType, number>> = { spear: 300, sword: 150, axe: 80, spy: 5 };

describe('decisão do lote da Coleta (modo "tudo")', () => {
  it('envia TODAS as tropas disponíveis da tela (comportamento do plugin original)', () => {
    const decision = decideCollectionLot(AVAILABLE, {}, { lotMode: 'tudo', minUnits: 10 });

    expect(decision).toEqual({
      kind: 'send',
      units: { spear: 300, sword: 150, axe: 80, spy: 5 },
    });
  });

  it('respeita o mínimo: nenhuma unidade atingindo-o vira skip (nada é enviado)', () => {
    const decision = decideCollectionLot({ spy: 5 }, {}, { lotMode: 'tudo', minUnits: 10 });

    expect(decision).toEqual({ kind: 'skip', reason: 'Tropas insuficientes para o mínimo configurado.' });
  });

  it('leitura ilegível/vazia nunca inventa tropa (fail-closed)', () => {
    const decision = decideCollectionLot({}, {}, { lotMode: 'tudo', minUnits: 1 });

    expect(decision.kind).toBe('skip');
  });

  it('ignora entradas zeradas/negativas das disponíveis', () => {
    const decision = decideCollectionLot({ spear: 0, axe: -3, sword: 20 }, {}, { lotMode: 'tudo', minUnits: 10 });

    expect(decision).toEqual({ kind: 'send', units: { sword: 20 } });
  });
});

describe('decisão do lote da Coleta (modo "fixo")', () => {
  it('usa o lote configurado limitado pelas disponíveis (nunca manda mais do que existe)', () => {
    const decision = decideCollectionLot(AVAILABLE, { spear: 500, sword: 100, spy: 2 }, {
      lotMode: 'fixo',
      minUnits: 10,
    });

    expect(decision).toEqual({ kind: 'send', units: { spear: 300, sword: 100, spy: 2 } });
  });

  it('lote vazio cai para todas as disponíveis (comportamento de hoje preservado)', () => {
    const decision = decideCollectionLot(AVAILABLE, {}, { lotMode: 'fixo', minUnits: 10 });

    expect(decision).toEqual({ kind: 'send', units: { spear: 300, sword: 150, axe: 80, spy: 5 } });
  });

  it('cap ilegível na tela envia o configurado (o jogo satura no servidor)', () => {
    const decision = decideCollectionLot({ spear: 300 }, { axe: 100 }, { lotMode: 'fixo', minUnits: 10 });

    expect(decision).toEqual({ kind: 'send', units: { axe: 100 } });
  });

  it('unidade zerada/não reconhecida no lote não entra', () => {
    const decision = decideCollectionLot(AVAILABLE, { spear: 0, catapulta: 50, sword: 100 }, {
      lotMode: 'fixo',
      minUnits: 10,
    });

    expect(decision).toEqual({ kind: 'send', units: { sword: 100 } });
  });

  it('lote fixo inteiro abaixo do mínimo vira skip', () => {
    const decision = decideCollectionLot(AVAILABLE, { spy: 5 }, { lotMode: 'fixo', minUnits: 10 });

    expect(decision).toEqual({ kind: 'skip', reason: 'Tropas insuficientes para o mínimo configurado.' });
  });
});

describe('settings da Coleta', () => {
  it('default é modo fixo (compatibilidade: não muda o comportamento atual)', () => {
    expect(DEFAULT_SETTINGS.lotMode).toBe('fixo');
  });
});
