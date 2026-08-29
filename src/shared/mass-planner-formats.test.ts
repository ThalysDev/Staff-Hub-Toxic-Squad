// Testes dos formatos de exportação do Planner de OP em Massa: Russian Planner,
// TW Mass Planner e o formato colável do app (reuso de formatSendSchedule —
// mesma gramática do T-minus/comms/SG_6).

import { describe, expect, it } from 'vitest';
import { formatColavel, formatRussianPlanner, formatTwMassPlanner } from './mass-planner-formats';
import type { MassPlanCommand } from './mass-planner-types';

function command(overrides?: Partial<MassPlanCommand>): MassPlanCommand {
  return {
    groupId: 'g1',
    groupName: 'nuke',
    origin: '500|500',
    target: '600|600',
    targetOwner: 'Defensor',
    originOwner: 'Atacante',
    unit: 'ram',
    distanceFields: 141.42,
    travelMinutes: 377.21,
    arrivalMs: new Date(2026, 7, 29, 22, 0, 0, 0).getTime(),
    sendMs: new Date(2026, 7, 29, 15, 42, 47, 0).getTime(),
    catapultTargets: [],
    ...overrides,
  };
}

describe('formatRussianPlanner', () => {
  it('emite "origem alvo unidade aaaa-mm-dd hh:mm:ss" com o horário de ENVIO', () => {
    const text = formatRussianPlanner([command()]);
    expect(text).toBe('500|500 600|600 Ariete 2026-08-29 15:42:47');
  });

  it('uma linha por comando, na ordem recebida', () => {
    const text = formatRussianPlanner([
      command({ target: '600|600' }),
      command({ target: '601|601', unit: 'snob' }),
    ]);
    expect(text.split('\n')).toHaveLength(2);
    expect(text.split('\n')[1]).toBe('500|500 601|601 Nobre 2026-08-29 15:42:47');
  });
});

describe('formatTwMassPlanner', () => {
  it('emite "origem alvo unidade dd.mm.aaaa hh:mm:ss"', () => {
    expect(formatTwMassPlanner([command()])).toBe('500|500 600|600 Ariete 29.08.2026 15:42:47');
  });
});

describe('formatColavel', () => {
  it('usa o formato do app "nick;alvo;HH:MM:SS" com cabeçalho da chegada', () => {
    const text = formatColavel([command()]);
    const lines = text.split('\n');
    expect(lines[0]).toBe('# Chegada desejada: 22:00:00 (29/08)');
    expect(lines[1]).toBe('Atacante;600|600;15:42:47');
  });

  it('sem dono conhecido cai para o nome do grupo (com ";" saneado)', () => {
    const text = formatColavel([command({ originOwner: null, groupName: 'fake;teste' })]);
    expect(text.split('\n')[1]).toBe('Grupo fake−teste;600|600;15:42:47');
  });

  it('partida fora do dia da chegada ganha sufixo @dd/MM', () => {
    // Partida no dia 28, chegada no dia 29 → linha com @28/08.
    const text = formatColavel([
      command({ sendMs: new Date(2026, 7, 28, 23, 0, 0).getTime() }),
    ]);
    expect(text.split('\n')[1]).toBe('Atacante;600|600;23:00:00 @28/08');
  });
});
