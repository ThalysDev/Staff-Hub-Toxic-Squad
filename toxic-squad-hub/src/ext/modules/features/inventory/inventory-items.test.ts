// Testes do parser PURO do inventário (Onda 5, Parte A) e das decisões puras
// do Agendador de Itens: categorização, pacote abrível, itens ignorados
// (fail-closed) e a agenda por aldeia (criar/vencer/marcar).
import { describe, expect, it } from 'vitest';

import {
  categorizeItem,
  findInventoryItem,
  groupItemsByCategory,
  isResourcePackage,
  parseInventoryItems,
  pickResourcePackage,
  summarizeInventory,
} from './inventory-items';
import {
  blockedActivation,
  dueActivation,
  markActivation,
  parseScheduleDate,
  syncScheduledActivation,
  type AtivadorItensSettings,
  type ScheduledItemActivation,
} from '../../../../modules/tsh/plugins/ativador-itens';

const ROW = (id: string, attrs: string, extra = ''): string =>
  `<table><tr data-item-id="${id}" ${attrs}>${extra}</tr></table>`;

const SETTINGS: AtivadorItensSettings = { itemId: '', itemNome: '', quando: '' };

describe('parseInventoryItems', () => {
  it('lê nome, quantidade, categoria e ação declarados pelo bloco', () => {
    const html = ROW(
      '4711',
      'data-item-name="Pacote de recursos médio" data-item-count="3" data-item-category="recurso" data-action-url="/game.php?village=1&amp;screen=inventory&amp;action=open&amp;id=4711"',
    );

    expect(parseInventoryItems(html)).toEqual([
      {
        id: '4711',
        name: 'Pacote de recursos médio',
        count: 3,
        category: 'recurso',
        package: true,
        actionUrl: '/game.php?village=1&screen=inventory&action=open&id=4711',
      },
    ]);
  });

  it('cai para célula/alt/quantidade padrão e ignora bloco sem nome', () => {
    const comCelulas =
      '<tr data-item-id="7"><td class="item-name">Bandeira tribal</td><td class="amount">1.234</td></tr>';
    const semNome = '<tr data-item-id="8"><td class="x">-</td></tr>';

    const itens = parseInventoryItems(`${comCelulas}${semNome}`);
    expect(itens).toHaveLength(1);
    expect(itens[0]?.name).toBe('Bandeira tribal');
    expect(itens[0]?.count).toBe(1234);
    expect(itens[0]?.actionUrl).toBeUndefined();
  });

  it('ignora bloco sem data-item-id e não duplica o mesmo id', () => {
    const html =
      '<tr data-item-name="Sem id"><td>nada</td></tr>' +
      ROW('5', 'data-item-name="Item A"') +
      ROW('5', 'data-item-name="Item A repetido"');

    const itens = parseInventoryItems(html);
    expect(itens).toHaveLength(1);
    expect(itens[0]?.name).toBe('Item A');
  });

  it('deduz a categoria do nome quando o bloco não declara', () => {
    const itens = parseInventoryItems(
      `${ROW('1', 'data-item-name="Recrutamento instantâneo"')}${ROW('2', 'data-item-name="Item lendário"')}${ROW('3', 'data-item-category="tempo" data-item-name="Coisa qualquer"')}`,
    );

    expect(itens.map((item) => item.category)).toEqual(['tropas', 'outro', 'tempo']);
  });
});

describe('categorização e seleção de pacote', () => {
  it('categorizeItem reconhece os rótulos do jogo (com e sem acento)', () => {
    expect(categorizeItem('Pacote de recursos')).toBe('recurso');
    expect(categorizeItem('Baú de recursos')).toBe('recurso');
    expect(categorizeItem('Construção instantânea')).toBe('construcao');
    expect(categorizeItem('Redução de tempo')).toBe('tempo');
    expect(categorizeItem('')).toBe('outro');
  });

  it('só é pacote quem tem nome de pacote/baú/caixa na categoria de recurso', () => {
    const pacote = parseInventoryItems(ROW('1', 'data-item-name="Pacote de recursos grande"'))[0];
    const itemComum = parseInventoryItems(ROW('2', 'data-item-name="Bandeira"'))[0];

    expect(pacote !== undefined && isResourcePackage(pacote)).toBe(true);
    expect(itemComum !== undefined && isResourcePackage(itemComum)).toBe(false);
  });

  it('pickResourcePackage devolve o primeiro pacote COM ação de abrir', () => {
    const html =
      ROW('1', 'data-item-name="Pacote de recursos pequeno"') +
      ROW('2', 'data-item-name="Pacote de recursos grande" data-action-url="/game.php?action=open&amp;id=2"');

    const itens = parseInventoryItems(html);
    expect(pickResourcePackage(itens)?.id).toBe('2');
    expect(findInventoryItem(itens, '1')?.name).toBe('Pacote de recursos pequeno');
    expect(findInventoryItem(itens, '99')).toBeUndefined();
  });

  it('agrupa por categoria e resume em pt-BR', () => {
    const itens = parseInventoryItems(
      `${ROW('1', 'data-item-name="Pacote de recursos"')}${ROW('2', 'data-item-name="Recrutamento instantâneo"')}`,
    );
    const agrupado = groupItemsByCategory(itens);

    expect(agrupado.recurso).toHaveLength(1);
    expect(agrupado.tropas).toHaveLength(1);
    expect(agrupado.tempo).toHaveLength(0);
    expect(summarizeInventory(itens)).toBe('2 item(ns): 1 recursos, 1 tropas.');
    expect(summarizeInventory([])).toBe('Nenhum item reconhecido no inventário.');
  });
});

describe('agenda do Agendador de Itens', () => {
  it('parseScheduleDate aceita datetime-local e recusa texto/data inválida', () => {
    expect(parseScheduleDate('2026-09-23T20:30')).toBe(Date.parse('2026-09-23T20:30'));
    expect(parseScheduleDate('23/09/2026 20:30')).toBeNull();
    expect(parseScheduleDate('   ')).toBeNull();
  });

  it('cria registro para horário futuro e não duplica o mesmo par (item, horário)', () => {
    const agora = Date.parse('2026-09-23T10:00');
    const settings: AtivadorItensSettings = { itemId: '4711', itemNome: 'Pacote', quando: '2026-09-23T20:30' };

    const primeiro = syncScheduledActivation([], settings, '42', agora);
    expect(primeiro.erro).toBeNull();
    expect(primeiro.criado).toMatchObject({ itemId: '4711', itemName: 'Pacote', villageId: '42', status: 'agendado' });
    expect(primeiro.agenda).toHaveLength(1);

    const segundo = syncScheduledActivation(primeiro.agenda, settings, '42', agora);
    expect(segundo.criado).toBeNull();
    expect(segundo.agenda).toHaveLength(1);
  });

  it('recusa horário no passado e configuração vazia não cria nada', () => {
    const agora = Date.parse('2026-09-23T10:00');
    const passado = syncScheduledActivation(
      [],
      { itemId: '1', itemNome: '', quando: '2026-09-23T09:00' },
      '42',
      agora,
    );
    const vazio = syncScheduledActivation([], SETTINGS, '42', agora);

    expect(passado.criado).toBeNull();
    expect(passado.erro).toContain('já passou');
    expect(vazio).toEqual({ agenda: [], criado: null, erro: null });
  });

  it('vence só na aldeia do item; outra aldeia fica bloqueada', () => {
    const registro: ScheduledItemActivation = {
      id: '42-7-1',
      itemId: '7',
      itemName: '',
      villageId: '42',
      at: 1_000,
      status: 'agendado',
    };
    const agora = 2_000;

    expect(dueActivation([registro], '42', agora)?.id).toBe('42-7-1');
    expect(dueActivation([registro], '99', agora)).toBeUndefined();
    expect(blockedActivation([registro], '99', agora)?.villageId).toBe('42');
    expect(dueActivation([registro], '42', 500)).toBeUndefined();
  });

  it('markActivation marca executado com firedAt e falha com observação', () => {
    const agenda: ScheduledItemActivation[] = [
      { id: 'a', itemId: '1', itemName: '', villageId: '42', at: 10, status: 'agendado' },
      { id: 'b', itemId: '2', itemName: '', villageId: '42', at: 20, status: 'agendado' },
    ];

    const executado = markActivation(agenda, 'a', 'executado', { firedAt: 999 });
    expect(executado[0]).toMatchObject({ id: 'a', status: 'executado', firedAt: 999 });
    expect(executado[1]?.status).toBe('agendado');

    const falha = markActivation(executado, 'b', 'falha', { note: 'item fora do inventário' });
    expect(falha[1]).toMatchObject({ status: 'falha', note: 'item fora do inventário' });
  });
});
