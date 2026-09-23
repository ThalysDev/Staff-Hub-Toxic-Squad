// P2-2 da revisão: parseCancelableRows é PURA e exportada — a linha de
// cancelamento casa com `id=` ANTES ou DEPOIS de `action=cancel` (a ordem não é
// contrato do template), o destino é conferido pela coordenada do link
// info_village da própria linha e linha sem par (sem destino / sem id) é
// ignorada. Fixtures HTML mínimas no formato do modo=commands
// (Destino | Origem | ação).
import { describe, expect, it } from 'vitest';
import { parseCancelableRows } from './tsh-transport';

const VILLAGE = '/game.php?village=238755';

/** Linha canônica: destino (x|y) + origem + link de cancelamento (com h). */
function row(dest: string, cancelHref: string, origemId = '222'): string {
  return (
    '<tr>' +
    `<td><a href="${VILLAGE}&amp;screen=info_village&amp;id=111">Barbaraville (${dest})</a></td>` +
    `<td><a href="${VILLAGE}&amp;screen=info_village&amp;id=${origemId}">Minha aldeia (500|500)</a></td>` +
    `<td><a href="${cancelHref}">Cancelar</a></td>` +
    '</tr>'
  );
}

describe('parseCancelableRows', () => {
  it('casa action=cancel ANTES do id (ordem canônica do template)', () => {
    const html = row('534|551', `${VILLAGE}&amp;action=cancel&amp;id=4242&amp;h=deadbeef`);
    expect(parseCancelableRows(html, { x: 534, y: 551 })).toEqual([
      { commandId: '4242', url: `${VILLAGE}&action=cancel&id=4242&h=deadbeef` },
    ]);
  });

  it('casa id ANTES de action=cancel (ordem agnóstica)', () => {
    const html = row('600|600', `${VILLAGE}&amp;id=7777&amp;action=cancel&amp;h=cafe`);
    expect(parseCancelableRows(html, { x: 600, y: 600 })).toEqual([
      { commandId: '7777', url: `${VILLAGE}&id=7777&action=cancel&h=cafe` },
    ]);
  });

  it('ignora linha cujo destino NÃO é a coordenada-alvo', () => {
    const html = row('700|700', `${VILLAGE}&amp;action=cancel&amp;id=8888&amp;h=beef`);
    expect(parseCancelableRows(html, { x: 534, y: 551 })).toEqual([]);
  });

  it('ignora linha sem o link de destino (par incompleto)', () => {
    const html = `<tr><td><span>—</span></td><td><a href="${VILLAGE}&amp;action=cancel&amp;id=9999&amp;h=f00d">Cancelar</a></td></tr>`;
    expect(parseCancelableRows(html, { x: 534, y: 551 })).toEqual([]);
  });

  it('ignora link de cancelamento sem id (nada canônico a clicar)', () => {
    const html = row('534|551', `${VILLAGE}&amp;action=cancel&amp;h=f00d`);
    expect(parseCancelableRows(html, { x: 534, y: 551 })).toEqual([]);
  });

  it('devolve só as linhas que casam, na ordem do documento', () => {
    const html = [
      '<table><tr><th>Destino</th><th>Origem</th><th></th></tr>',
      row('534|551', `${VILLAGE}&amp;action=cancel&amp;id=1&amp;h=a`),
      row('700|700', `${VILLAGE}&amp;action=cancel&amp;id=2&amp;h=b`),
      row('534|551', `${VILLAGE}&amp;id=3&amp;action=cancel&amp;h=c`),
      '</table>',
    ].join('');
    expect(parseCancelableRows(html, { x: 534, y: 551 })).toEqual([
      { commandId: '1', url: `${VILLAGE}&action=cancel&id=1&h=a` },
      { commandId: '3', url: `${VILLAGE}&id=3&action=cancel&h=c` },
    ]);
  });
});
