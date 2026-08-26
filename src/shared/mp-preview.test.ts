import { describe, expect, it } from 'vitest';
import { previewMps, validateNicks } from './mp-preview';

const TEMPLATE = 'Olá! Alvos: #alvos#. Confirme.';
const ENTRIES = [
  { playerName: 'Thalys', coords: ['455|505', '490|512'] },
  { playerName: 'bruno', coords: ['500|500'] },
];

describe('previewMps', () => {
  it('substitui #alvos# múltiplas vezes na mesma MP (mesmo join com espaço do sendMps)', () => {
    expect(previewMps('Reservas', '#alvos# → #alvos#', [{ playerName: 'Thalys', coords: ['1|2', '3|4'] }])).toEqual([
      { playerName: 'Thalys', subject: 'Reservas', body: '1|2 3|4 → 1|2 3|4' },
    ]);
  });

  it('gera uma prévia por entrada com o assunto intocado (espelho exato do sendMps)', () => {
    const preview = previewMps('Assunto SG_6', TEMPLATE, ENTRIES);
    expect(preview).toEqual([
      { playerName: 'Thalys', subject: 'Assunto SG_6', body: 'Olá! Alvos: 455|505 490|512. Confirme.' },
      { playerName: 'bruno', subject: 'Assunto SG_6', body: 'Olá! Alvos: 500|500. Confirme.' },
    ]);
    // O template NÃO pode ser alterado (prévia não consome o original).
    expect(TEMPLATE).toBe('Olá! Alvos: #alvos#. Confirme.');
  });

  it('coords vazias viram string vazia no lugar de cada #alvos#', () => {
    const preview = previewMps('s', TEMPLATE, [{ playerName: 'x', coords: [] }]);
    expect(preview[0]?.body).toBe('Olá! Alvos: . Confirme.');
  });

  it('limit corta para as N primeiras entradas; sem limit gera todas', () => {
    expect(previewMps('s', TEMPLATE, ENTRIES)).toHaveLength(2);
    const primeira = previewMps('s', TEMPLATE, ENTRIES, 1);
    expect(primeira).toHaveLength(1);
    expect(primeira[0]?.playerName).toBe('Thalys');
  });

  it('#horarios# vira bloco "alvo → HH:MM:SS" na mesma ordem das coords (fonte única horariosBlock)', () => {
    const preview = previewMps('OP', 'Alvos: #alvos#\nHorários:\n#horarios#', [
      { playerName: 'Thalys', coords: ['455|505', '490|512'], horarios: ['22:00:00', '21:45:30'] },
    ]);
    expect(preview[0]?.body).toBe('Alvos: 455|505 490|512\nHorários:\n455|505 → 22:00:00\n490|512 → 21:45:30');
  });

  it('#horarios# no corpo sem horários na entrada → ERRO antes de qualquer confirmação (fail-closed)', () => {
    expect(() =>
      previewMps('OP', 'Horários:\n#horarios#', [{ playerName: 'Thalys', coords: ['455|505'] }]),
    ).toThrow(/não trouxe horários/);
  });

  it('#horarios# com quantidade diferente das coords → ERRO de dessincronização', () => {
    expect(() =>
      previewMps('OP', '#horarios#', [{ playerName: 'Thalys', coords: ['455|505', '490|512'], horarios: ['22:00:00'] }]),
    ).toThrow(/dessincronizados/);
  });

  it('entrada com horários mas template só com #alvos# → horários ignorados, sem erro', () => {
    const preview = previewMps('OP', TEMPLATE, [
      { playerName: 'Thalys', coords: ['455|505'], horarios: ['22:00:00'] },
    ]);
    expect(preview[0]?.body).toBe('Olá! Alvos: 455|505. Confirme.');
  });
});

describe('validateNicks', () => {
  const DUMP = ['Thalys', 'bruno', 'carla'];

  it('classifica nick válido, caseMismatch e unknown', () => {
    expect(
      validateNicks(
        [{ playerName: 'Thalys' }, { playerName: 'thalys' }, { playerName: 'desconhecido' }],
        DUMP,
      ),
    ).toEqual({
      valid: ['Thalys'],
      caseMismatch: [{ given: 'thalys', known: 'Thalys' }],
      unknown: ['desconhecido'],
    });
  });

  it('"Joao" e "JOAO" no dump → "joao" é AMBÍGUO (unknown), nunca caseMismatch sugestivo', () => {
    const dumpAmbiguo = ['Joao', 'JOAO'];
    expect(validateNicks([{ playerName: 'joao' }, { playerName: 'Joao' }], dumpAmbiguo)).toEqual({
      valid: ['Joao'],
      caseMismatch: [],
      unknown: ['joao'],
    });
  });

  it('nada a validar → buckets vazios', () => {
    expect(validateNicks([], DUMP)).toEqual({ valid: [], caseMismatch: [], unknown: [] });
  });
});
