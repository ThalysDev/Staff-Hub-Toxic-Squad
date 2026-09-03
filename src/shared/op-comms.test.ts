// MPs da OP gerada no Planner em Massa (v0.33): comandos → insumos do
// comms-package → PlayerComms por executor. Prova o caminho completo que a
// UI usa (prévia + envio via sg6.sendMps com {playerName, coords, horarios}).
import { describe, expect, it } from 'vitest';
import { buildOpComms, executorNick, opCommsInputs } from './op-comms';
import { renderTemplate } from './comms-package';
import type { MassPlanCommand } from './mass-planner-types';

function command(overrides?: Partial<MassPlanCommand>): MassPlanCommand {
  return {
    groupId: 'g1',
    groupName: 'nuke',
    origin: '500|500',
    originVillageId: 1,
    target: '600|600',
    targetVillageId: 2,
    targetOwner: 'Inimigo',
    originOwner: 'S A L A Z H A A R',
    unit: 'ram',
    distanceFields: 141.42,
    travelMinutes: 1414.2,
    arrivalMs: new Date(2026, 8, 17, 22, 0, 0).getTime(),
    sendMs: new Date(2026, 8, 17, 20, 0, 0).getTime(),
    catapultTargets: [],
    ...overrides,
  };
}

describe('executorNick', () => {
  it('usa o dono da origem; sem dono cai para o grupo com ";" saneado e teto 40', () => {
    expect(executorNick(command())).toBe('S A L A Z H A A R');
    expect(executorNick(command({ originOwner: null }))).toBe('Grupo nuke');
    expect(executorNick(command({ originOwner: null, groupName: 'fake;especial' }))).toBe('Grupo fake−especial');
    expect(executorNick(command({ originOwner: null, groupName: 'x'.repeat(60) })).length).toBe(40);
  });
});

describe('opCommsInputs', () => {
  it('distribution agrupa alvos por executor na ordem da 1ª aparição', () => {
    const inputs = opCommsInputs([
      command({ target: '600|600' }),
      command({ originOwner: 'Bia', target: '601|601' }),
      command({ target: '602|602' }),
    ]);
    expect(inputs.distribution.split('\n')).toEqual([
      'S A L A Z H A A R;600|600 602|602',
      'Bia;601|601',
    ]);
  });

  it('sendSchedule é a agenda colável com cabeçalho da chegada desejada', () => {
    const { sendSchedule } = opCommsInputs([command()]);
    expect(sendSchedule.split('\n')[0]).toContain('# Chegada desejada: 22:00:00');
    expect(sendSchedule.split('\n')[1]).toBe('S A L A Z H A A R;600|600;20:00:00');
  });
});

describe('buildOpComms', () => {
  it('produz PlayerComms por executor com alvos e horários alinhados', () => {
    const players = buildOpComms(
      [command(), command({ originOwner: 'Bia', target: '601|601', sendMs: new Date(2026, 8, 17, 20, 30, 0).getTime() })],
      'Cerco Norte',
      'Seus alvos: #alvos#\nQuando enviar:\n#horarios#',
    );
    expect(players).toEqual([
      { playerName: 'S A L A Z H A A R', coords: ['600|600'], horarios: ['20:00:00'] },
      { playerName: 'Bia', coords: ['601|601'], horarios: ['20:30:00'] },
    ]);
    const rendered = renderTemplate('Alvos #alvos#\n#horarios#', players[0]!);
    expect(rendered).toBe('Alvos 600|600\n600|600 → 20:00:00');
  });

  it('template sem placeholder é fail-closed no RENDER (validação do comms-package)', () => {
    const players = buildOpComms([command()], 'OP', 'mensagem fixa sem placeholders');
    expect(() => renderTemplate('mensagem fixa', players[0]!)).toThrow(/placeholder/i);
  });
});
