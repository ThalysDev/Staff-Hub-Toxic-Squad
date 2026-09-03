import { describe, expect, it } from 'vitest';
import {
  agendaToSg6Entries,
  buildPlayerComms,
  parseSendSchedule,
  planBbcode,
  renderTemplate,
  reservationList,
  sg6EntriesText,
  type CommsTemplateInput,
} from './comms-package';

// Fixture da OP: distribution vem do distributionSummary (SG_4) e a agenda do
// formatSendSchedule (SG_4-timing), com o cabeçalho "# Chegada desejada".
const INPUT: CommsTemplateInput = {
  opTitle: 'Ferrovias do Norte',
  template: 'Olá!\nSeus alvos: #alvos#\nHorários de envio:\n#horarios#',
  distribution: ['joao;402|303 512|498', 'maria;555|444'].join('\n'),
  sendSchedule: [
    '# Chegada desejada: 22:00:00',
    'joao;402|303;20:30:00',
    'joao;512|498;20:05:00',
    'maria;555|444;19:45:00',
  ].join('\n'),
};

describe('parseSendSchedule', () => {
  it('parseia linhas "nick;alvo;HH:MM:SS" ignorando comentário e vazias', () => {
    const text = [
      '# Chegada desejada: 22:00:00',
      '',
      'joao;402|303;20:30:00',
      'maria;555|444;19:45:00',
    ].join('\n');
    expect(parseSendSchedule(text)).toEqual([
      { playerName: 'joao', targetCoord: '402|303', time: '20:30:00' },
      { playerName: 'maria', targetCoord: '555|444', time: '19:45:00' },
    ]);
    // Sem linhas de dados, só o comentário → nada a processar.
    expect(parseSendSchedule('# Chegada desejada: 22:00:00')).toEqual([]);
  });

  it('linha fora do formato lança erro PT-BR citando a linha', () => {
    expect(() => parseSendSchedule('joao;402|303;2030')).toThrow(/joao;402\|303;2030/);
    expect(() => parseSendSchedule('joao;402|303')).toThrow(/Linha da agenda de envio inválida/);
    // Horário precisa bater com dd:dd:dd (validação /^\d{2}:\d{2}:\d{2}$/).
    expect(() => parseSendSchedule('joao;402|303;20:30')).toThrow(/agenda de envio inválida/);
    expect(() => parseSendSchedule('maria;alvo sem coord;19:45:00')).toThrow(/maria;alvo sem coord/);
  });
});

describe('buildPlayerComms', () => {
  it('(a) cruza distribuição e agenda: horários na mesma ordem das coords', () => {
    expect(buildPlayerComms(INPUT)).toEqual([
      { playerName: 'joao', coords: ['402|303', '512|498'], horarios: ['20:30:00', '20:05:00'] },
      { playerName: 'maria', coords: ['555|444'], horarios: ['19:45:00'] },
    ]);
  });

  it('(b) par nick+alvo sem horário na agenda lança erro citando alvo e jogador', () => {
    const input = {
      ...INPUT,
      sendSchedule: ['# Chegada desejada: 22:00:00', 'joao;402|303;20:30:00'].join('\n'),
    };
    expect(() => buildPlayerComms(input)).toThrow(
      /Alvo 512\|498 do jogador "joao" sem horário na agenda/,
    );
  });

  it('(c) jogador da distribuição sem NENHUMA linha na agenda → dessincronizadas', () => {
    const input = { ...INPUT, sendSchedule: 'maria;555|444;19:45:00' };
    expect(() => buildPlayerComms(input)).toThrow(/dessincronizadas[\s\S]*"joao"/);
  });
});

describe('renderTemplate', () => {
  it('(d) substitui #alvos# e #horarios# (bloco "alvo → HH:MM:SS" na ordem das coords)', () => {
    const [joao] = buildPlayerComms(INPUT);
    expect(joao).toBeDefined();
    expect(renderTemplate(INPUT.template, joao!)).toBe(
      [
        'Olá!',
        'Seus alvos: 402|303 512|498',
        'Horários de envio:',
        '402|303 → 20:30:00\n512|498 → 20:05:00',
      ].join('\n'),
    );
  });

  it('template só com #alvos# funciona (e todos os placeholders são substituídos)', () => {
    const [joao] = buildPlayerComms(INPUT);
    const body = renderTemplate('Aldeias: #alvos#. Boa OP!', joao!);
    expect(body).toBe('Aldeias: 402|303 512|498. Boa OP!');
    expect(body).not.toContain('#');
  });

  it('template sem nenhum placeholder lança erro', () => {
    const [joao] = buildPlayerComms(INPUT);
    expect(() => renderTemplate('Boa sorte na OP!', joao!)).toThrow(/sem placeholder/);
  });
});

describe('planBbcode', () => {
  it('(e) monta título, tabela Jogador|Alvo|Enviar às e chegada desejada', () => {
    const bbcode = planBbcode({ ...INPUT, arrivalHeader: 'Dia 15/08' });
    expect(bbcode).toContain('[b]OP Ferrovias do Norte[/b]');
    expect(bbcode).toContain('[table]');
    expect(bbcode).toContain('Jogador[||]Alvo[||]Enviar às');
    expect(bbcode).toContain('joao');
    expect(bbcode).toContain('402|303');
    expect(bbcode).toContain('20:30:00');
    expect(bbcode).toContain('[b]Chegada desejada: 22:00:00[/b]');
  });

  it('arrivalHeader é opcional e vai logo abaixo do título', () => {
    const semHeader = planBbcode(INPUT);
    expect(semHeader.startsWith('[b]OP Ferrovias do Norte[/b]\n[table]')).toBe(true);

    const comHeader = planBbcode({ ...INPUT, arrivalHeader: 'Dia 15/08' });
    expect(comHeader.startsWith('[b]OP Ferrovias do Norte[/b]\nDia 15/08\n[table]')).toBe(true);
  });

  it('agenda agrupada por jogador preserva a ordem da 1ª aparição na tabela', () => {
    const bbcode = planBbcode(INPUT);
    const joaoIndex = bbcode.indexOf('[**]joao[|]');
    const mariaIndex = bbcode.indexOf('[**]maria[|]');
    expect(joaoIndex).toBeGreaterThan(-1);
    expect(mariaIndex).toBeGreaterThan(joaoIndex);
  });
});

describe('reservationList', () => {
  it('(f) deduplica pela primeira ocorrência, um coord por linha, em todas as linhas', () => {
    const distribution = [
      'joao;402|303 512|498',
      'maria;555|444 402|303', // 402|303 repetido → entra só uma vez.
      'pedro;700|500 700|500', // mesmo coord duas vezes na própria linha.
    ].join('\n');
    expect(reservationList(distribution)).toBe(['402|303', '512|498', '555|444', '700|500'].join('\n'));
  });

  it('linha de distribuição inválida lança erro fail-closed', () => {
    expect(() => reservationList('joao sem ponto e virgula')).toThrow(/Linha de distribuição inválida/);
  });
});

describe('sg6EntriesText', () => {
  it('(g) uma linha por jogador no formato "nick;coord coord;HH:MM:SS,HH:MM:SS"', () => {
    const players = buildPlayerComms(INPUT);
    expect(sg6EntriesText(players)).toBe(
      ['joao;402|303 512|498;20:30:00,20:05:00', 'maria;555|444;19:45:00'].join('\n'),
    );
  });
});

describe('parseSendSchedule — sufixo @dd/MM (v0.27: envio fora do dia da chegada)', () => {
  it('aceita linha com sufixo @dd/MM e preserva o texto original', () => {
    const entries = parseSendSchedule('joao;402|303;20:30:00 @14/08');
    expect(entries).toEqual([{ playerName: 'joao', targetCoord: '402|303', time: '20:30:00 @14/08' }]);
  });

  it('continua rejeitando horário malformado mesmo com sufixo', () => {
    expect(() => parseSendSchedule('joao;402|303;2030 @14/08')).toThrow(/inválida/);
  });
});

describe('agendaToSg6Entries (v0.33 — cola da agenda da OP no SG_6)', () => {
  it('agrupa a agenda colável por jogador na ordem de 1ª aparição', () => {
    const agenda = [
      '# Chegada desejada: 22:00:00 (17/09)',
      'Zé;600|600;21:00:00',
      'Bia;601|601;21:30:00 @16/09',
      'Zé;602|602;21:05:00',
    ].join('\n');
    expect(agendaToSg6Entries(agenda)).toBe('Zé;600|600 602|602;21:00:00,21:05:00\nBia;601|601;21:30:00 @16/09');
  });

  it('agenda vazia (só comentários) devolve string vazia', () => {
    expect(agendaToSg6Entries('# Chegada desejada: 22:00:00')).toBe('');
  });

  it('linha torta é fail-closed citando a linha', () => {
    expect(() => agendaToSg6Entries('Zé;600|600')).toThrow(/inválida/i);
  });
});
