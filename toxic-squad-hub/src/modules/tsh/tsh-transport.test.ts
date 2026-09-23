// Partes PURAS do transporte TSH (ambiente node, sem DOM): parse do alvo,
// normalização de id, achatamento do corpo da API (notação de colchetes do
// TribalWars.post) e os mapas de duração da coleta.
import { describe, expect, it } from 'vitest';
import {
  SCAVENGE_OPTION_BY_DURATION,
  flattenGameApiBody,
  isUncertainMutationError,
  normalizeVillageId,
  parseCommandTarget,
  scavengeDomIndex,
  scavengeOptionId,
  transportError,
} from './tsh-transport';

describe('parseCommandTarget', () => {
  it('parseia coordenada canônica "x|y"', () => {
    expect(parseCommandTarget('534|551')).toEqual({ x: 534, y: 551 });
    expect(parseCommandTarget(' 5|7 ')).toEqual({ x: 5, y: 7 });
  });

  it('rejeita formatos inválidos (fail-closed, mensagem pt-BR)', () => {
    for (const bad of ['534', 'abc', '534|551|1', '534|abc', '-1|5', '']) {
      expect(() => parseCommandTarget(bad)).toThrow(/Alvo inválido para o comando/);
    }
  });
});

describe('normalizeVillageId', () => {
  it('remove o prefixo n dos ids da extensão', () => {
    expect(normalizeVillageId('n238755')).toBe('238755');
    expect(normalizeVillageId('238755')).toBe('238755');
    expect(normalizeVillageId('')).toBe('');
  });
});

describe('flattenGameApiBody', () => {
  it('achata squad_requests na notação de colchetes do wire do jogo', () => {
    expect(
      flattenGameApiBody({
        squad_requests: [
          {
            village_id: 238755,
            candidate_squad: { unit_counts: { spear: 10, sword: 0 }, carry_max: 9_999_999_999 },
            option_id: 2,
            use_premium: false,
          },
        ],
      }),
    ).toEqual({
      'squad_requests[0][village_id]': '238755',
      'squad_requests[0][candidate_squad][unit_counts][spear]': '10',
      'squad_requests[0][candidate_squad][unit_counts][sword]': '0',
      'squad_requests[0][candidate_squad][carry_max]': '9999999999',
      'squad_requests[0][option_id]': '2',
      'squad_requests[0][use_premium]': 'false',
    });
  });

  it('mantém valores simples e descarta nulos/indefinidos', () => {
    expect(flattenGameApiBody({ village: '123', target_id: '456', wood: 100, lixo: null, outro: undefined })).toEqual({
      village: '123',
      target_id: '456',
      wood: '100',
    });
  });
});

describe('mapas de duração da coleta', () => {
  it('option_id da API: 1=Pequena..4=Extrema, default media', () => {
    expect(SCAVENGE_OPTION_BY_DURATION).toEqual({ pequena: 1, media: 2, grande: 3, extrema: 4 });
    expect(scavengeOptionId('extrema')).toBe(4);
    expect(scavengeOptionId('desconhecida')).toBe(2);
  });

  it('índice DOM: 0=Pequena..3=Extrema, default media', () => {
    expect(scavengeDomIndex('pequena')).toBe(0);
    expect(scavengeDomIndex('grande')).toBe(2);
    expect(scavengeDomIndex('x')).toBe(1);
  });
});

describe('transportError / isUncertainMutationError', () => {
  it('marca mutação inconclusiva para o chamador (sem retry)', () => {
    const err = transportError('Envio por API inconclusivo.', 'RESULT_UNCERTAIN', true);
    expect(isUncertainMutationError(err)).toBe(true);
    expect(isUncertainMutationError(transportError('Seletor sumiu.', 'PAGE_SELECTOR_CHANGED'))).toBe(false);
    expect(isUncertainMutationError(new Error('comum'))).toBe(false);
    expect(isUncertainMutationError('string')).toBe(false);
  });
});
