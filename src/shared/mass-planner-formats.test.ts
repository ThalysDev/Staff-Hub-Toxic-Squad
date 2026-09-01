// Testes dos formatos de exportação do Planner de OP em Massa (v0.29.0):
// Russian Planner e TW Mass Planner comparados BYTE-A-BYTE com os arquivos
// reais capturados de operações geradas no twmassplanner.pro com chave válida
// (tests/diag/twmp/operacao-real, prova2, prova3) + o formato colável do app.

import { describe, expect, it } from 'vitest';
import { formatColavel, formatRussianPlanner, formatTwMassPlanner } from './mass-planner-formats';
import type { MassPlanCommand } from './mass-planner-types';

/** Réplica da linha real da prova 1 (SALAZHAAR → Meni, ariete, 01/09 22:00). */
function realCommand(overrides?: Partial<MassPlanCommand>): MassPlanCommand {
  return {
    groupId: 'g1',
    groupName: 'nuke',
    origin: '560|365',
    originVillageId: 213,
    target: '502|483',
    targetVillageId: 42,
    targetOwner: 'Meni',
    originOwner: 'S A L A Z H A A R',
    unit: 'ram',
    distanceFields: 131.48,
    travelMinutes: 3506.5,
    arrivalMs: new Date(2026, 8, 1, 22, 0, 0, 0).getTime(),
    sendMs: new Date(2026, 7, 30, 11, 33, 45, 857).getTime(),
    catapultTargets: [],
    ...overrides,
  };
}

describe('formatRussianPlanner — byte-fiél ao arquivo real', () => {
  it('emite o bloco BBCode exato do russian_planner-planners.txt capturado', () => {
    const text = formatRussianPlanner([realCommand()], 'br142');
    const expected = [
      '[b]Mass plan for [player]S A L A Z H A A R[/player][/b]',
      '[spoiler=For premium account notebook][code][b]Mass plan for [player]S A L A Z H A A R[/player][/b]',
      '[b]Mass time arrival: 22:00:00:000 01.09.2026[/b]',
      '[table][**]#. Time send-->Attack type[||]Your coords-->Target coords[||]Target[||]Rally point direct link[/**]',
      '[*]1. 11:33:45:857 30.08.2026 --- nuke[|] 560|365 --> 502|483 [|]Meni[|][url=https://br142.tribalwars.com.br/game.php?village=213&screen=place&x=502&y=483&from=simulator]Link[/url]',
      '[/table][/code][/spoiler]',
      '',
      '[spoiler=your targets for custom calculation]',
      '[code]nuke targets: 502|483 ',
      '[/code][/spoiler]',
    ].join('\n');
    expect(text).toBe(expected);
  });

  it('TWMP acrescenta Time arrival e Attack building (default farm) — byte-fiél ao tw_mass_planner-planners.txt', () => {
    const text = formatTwMassPlanner([realCommand()], 'br142');
    const expected = [
      '[b]Mass plan for [player]S A L A Z H A A R[/player][/b]',
      '[spoiler=For premium account notebook][code][b]Mass plan for [player]S A L A Z H A A R[/player][/b]',
      '[b]Mass time arrival: 22:00:00:000 01.09.2026[/b]',
      '[table][**]#. Time send-->Attack type[||]Time arrival[||]Your coords-->Target coords[||]Target[||]Attack building[||]Rally point direct link[/**]',
      '[*]1. 11:33:45:857 30.08.2026 --- nuke[|]22:00:00:000 01.09.2026[|] 560|365 --> 502|483 [|]Meni[|]farm[|][url=https://br142.tribalwars.com.br/game.php?village=213&screen=place&x=502&y=483&from=simulator]Link[/url]',
      '[/table][/code][/spoiler]',
      '',
      '[spoiler=your targets for custom calculation]',
      '[code]nuke targets: 502|483 ',
      '[/code][/spoiler]',
    ].join('\n');
    expect(text).toBe(expected);
  });

  it('mira de catapulta escolhida substitui o farm na coluna Attack building', () => {
    const text = formatTwMassPlanner([realCommand({ catapultTargets: ['watchtower'], unit: 'catapult' })], 'br142');
    expect(text).toContain('[|]watchtower[|][url=');
  });

  it('blocos por jogador ordenados pela chegada mais cedo; linhas por envio; numeração por bloco', () => {
    // Prova 3 real: SALAZHAAR (2 grupos) vem antes de Maratutu (chegada 23:00).
    const salazaar1 = realCommand({ groupName: 'delay', sendMs: new Date(2026, 7, 30, 11, 34, 15, 857).getTime(), arrivalMs: new Date(2026, 8, 1, 22, 0, 30, 0).getTime(), origin: '560|365', target: '502|483' });
    const salazaar2 = realCommand({ groupName: 'porplayer', sendMs: new Date(2026, 7, 30, 16, 20, 3, 726).getTime(), target: '506|473', origin: '560|365' });
    const maratutu = realCommand({
      groupName: 'porplayer',
      originOwner: 'Maratutu',
      origin: '498|652',
      originVillageId: 1108,
      sendMs: new Date(2026, 7, 29, 19, 52, 4, 270).getTime(), // envio ANTES, mas bloco vem depois (chegada 23:00)
      arrivalMs: new Date(2026, 8, 1, 23, 0, 0, 0).getTime(),
    });
    const text = formatTwMassPlanner([maratutu, salazaar1, salazaar2], 'br142');
    const lines = text.split('\n');
    // Bloco do Maratutu NÃO abre o arquivo: SALAZHAAR tem a chegada mais cedo.
    expect(lines[0]).toBe('[b]Mass plan for [player]S A L A Z H A A R[/player][/b]');
    // Linhas do SALAZHAAR em ordem de ENVIO (11:34 antes de 16:20) e numeração própria.
    expect(text).toContain('[*]1. 11:34:15:857 30.08.2026 --- delay[|]22:00:30:000 01.09.2026[|] 560|365 --> 502|483');
    expect(text).toContain('[*]2. 16:20:03:726 30.08.2026 --- porplayer[|]22:00:00:000 01.09.2026[|] 560|365 --> 506|473');
    // Recap por template dentro do bloco (2 linhas), como na prova 3.
    expect(text).toContain('[code]delay targets: 502|483 \nporplayer targets: 506|473 \n[/code]');
    // Bloco do Maratutu por último, com numeração recomeçada e ID da vila dele.
    expect(text.lastIndexOf('[b]Mass plan for [player]Maratutu[/player][/b]')).toBeGreaterThan(0);
    expect(text).toContain('village=1108&screen=place&x=502&y=483');
  });

  it('sem ID de vila conhecido, o link sai sem o parâmetro village (degradado, nunca quebrado)', () => {
    const text = formatRussianPlanner([realCommand({ originVillageId: null })], 'br142');
    expect(text).toContain('game.php?screen=place&x=502&y=483&from=simulator');
  });

  it('caracteres de BBCode no nome do modelo/dono são saneados', () => {
    const text = formatRussianPlanner(
      [realCommand({ groupName: 'nuke|x', originOwner: null, targetOwner: null })],
      'br142',
    );
    expect(text).toContain('--- nuke x[|]');
    expect(text).toContain('[b]Mass plan for [player]Grupo nuke x[/player][/b]');
    expect(text).toContain('[|]—[|][url=');
  });
});

describe('formatColavel', () => {
  it('usa o formato do app "nick;alvo;HH:MM:SS" com cabeçalho da chegada', () => {
    const text = formatColavel([realCommand()]);
    const lines = text.split('\n');
    expect(lines[0]).toBe('# Chegada desejada: 22:00:00 (01/09)');
    expect(lines[1]).toBe('S A L A Z H A A R;502|483;11:33:45 @30/08');
  });

  it('sem dono conhecido cai para o nome do grupo (com ";" saneado e teto de 40)', () => {
    const longName = 'x'.repeat(50);
    const text = formatColavel([realCommand({ originOwner: null, groupName: `fake;${longName}` })]);
    const nick = text.split('\n')[1]?.split(';')[0] ?? '';
    expect(nick.startsWith('Grupo fake−xxx')).toBe(true);
    expect(nick.length).toBeLessThanOrEqual(40);
  });
});

describe('exportações com bloco gigante (sem dump = 1 executor)', () => {
  // v0.32: OPs na escala real da staff ficaram possíveis (teto 1M de pares) e
  // um bloco único pode passar de 65k linhas — Math.min(...rows) com spread
  // estourava a call stack (RangeError: Maximum call stack size exceeded).
  it('bloco de 80k comandos exporta sem RangeError', () => {
    const big = Array.from({ length: 80_000 }, (_, i) =>
      realCommand({ originOwner: null, origin: `${100 + (i % 500)}|${100 + Math.floor(i / 500)}` }),
    );
    let russian = '';
    expect(() => {
      russian = formatRussianPlanner(big, 'br142');
    }).not.toThrow();
    expect(russian.length).toBeGreaterThan(100_000);
    expect(() => formatTwMassPlanner(big, 'br142')).not.toThrow();
    expect(() => formatColavel(big)).not.toThrow();
  }, 60_000);
});
