import { describe, expect, it } from 'vitest';
import { parseGroupedVillages, parseGroupOptions, parseVillageRows } from './groups-parser';

// Fixtures no markup real do jogo BR (br142): dropdown do overview_villages,
// links de grupo do place&mode=call e blocos da tela de edição de grupos.

const OVERVIEW_HTML = `<!DOCTYPE html>
<html>
<body>
<form method="post" action="/game.php?village=238755&amp;screen=overview_villages">
  <select name="group" onchange="this.form.submit();">
    <option value="">todas</option>
    <option value="182608" selected>🚨 Ataque a caminho 🚨</option>
    <option value="182618">👑 Contém nobre 👑</option>
    <option value="182622">🌾 Farm 🌾</option>
    <option value="0">Sem grupo</option>
  </select>
</form>
<table class="vis" width="100%">
  <tr><th>Aldeia</th><th>Pontos</th><th>Recursos</th></tr>
  <tr class="row_a">
    <td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=238743">747 - Nobre, Toxic Squad! (533|550) K55</a></td>
    <td>12.345</td><td>1.000 2.000 3.000</td>
  </tr>
</table>
</body>
</html>`;

const PLACE_HTML = `<div id="group_select" class="vis">
  <a href="/game.php?village=238755&amp;screen=place&amp;mode=call&amp;group=182622">[🌾 Farm 🌾]</a>
  <a href="/game.php?village=238755&amp;screen=place&amp;mode=call&amp;group=182608">[🚨 Ataque a caminho 🚨]</a>
  <a href="/game.php?village=238755&amp;screen=place&amp;mode=call&amp;group=182622">[🌾 Farm 🌾]</a>
  <a href="/game.php?village=238755&amp;screen=place&amp;mode=call">[Todas]</a>
  <span class="group_id">(182622)</span>
</div>`;

const GROUPS_SCREEN_HTML = `<table class="vis" width="100%">
  <tr><th colspan="2">Grupos de aldeias</th></tr>
  <tr><th colspan="2"><span class="group_id">(182622)</span> 🌾 Farm 🌾 <a href="/game.php?village=238755&amp;screen=groups&amp;action=delete_group&amp;group=182622&amp;h=abc123">apagar</a></th></tr>
  <tr><td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=238743">747 - Nobre, Toxic Squad! (533|550) K55</a></td><td>12.345</td></tr>
  <tr><td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=238744">Bárbaros &amp; Cia (498|501) K54</a></td><td>2.003</td></tr>
  <tr><td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=238743">747 - Nobre, Toxic Squad! (533|550) K55</a></td><td>12.345</td></tr>
  <tr><th colspan="2"><span class="group_id">(182608)</span> 🚨 Ataque a caminho 🚨</th></tr>
  <tr><td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=238750">Bárbara K55 (540|560) K55</a></td><td>106</td></tr>
  <tr><td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=abc">Lixo sem id (1|2)</a></td><td>0</td></tr>
  <tr><td><a href="/game.php?village=238755&amp;screen=overview_villages">Voltar à visão geral</a></td><td></td></tr>
</table>`;

describe('parseGroupOptions — dropdown do overview_villages', () => {
  it('extrai id e nome (emoji preservado) e ignora os filtros internos do jogo', () => {
    expect(parseGroupOptions(OVERVIEW_HTML)).toEqual([
      { groupId: 182608, name: '🚨 Ataque a caminho 🚨' },
      { groupId: 182618, name: '👑 Contém nobre 👑' },
      { groupId: 182622, name: '🌾 Farm 🌾' },
    ]);
  });
});

describe('parseGroupOptions — links do place&mode=call', () => {
  it('lê o nome do texto do link (colchetes de decoração fora) e deduplica link repetido', () => {
    expect(parseGroupOptions(PLACE_HTML)).toEqual([
      { groupId: 182622, name: '🌾 Farm 🌾' },
      { groupId: 182608, name: '🚨 Ataque a caminho 🚨' },
    ]);
  });

  it('deduplica o mesmo grupo lido em telas diferentes (dropdown + link)', () => {
    expect(parseGroupOptions(`${OVERVIEW_HTML}${PLACE_HTML}`)).toHaveLength(3);
  });

  it('preserva o nome cru quando não há colchetes e mantém desempate por nome', () => {
    expect(parseGroupOptions('<a href="/game.php?screen=place&mode=call&group=182622">🌾 Farm 🌾</a>')).toEqual([
      { groupId: 182622, name: '🌾 Farm 🌾' },
    ]);
    // Id repetido com nome diferente: as telas rotulam diferente, os dois ficam.
    const doisRotulos = [
      '<option value="182622">🌾 Farm 🌾</option>',
      '<a href="/game.php?screen=place&mode=call&group=182622">[Fazenda]</a>',
    ].join('');
    expect(parseGroupOptions(doisRotulos)).toEqual([
      { groupId: 182622, name: '🌾 Farm 🌾' },
      { groupId: 182622, name: 'Fazenda' },
    ]);
  });

  it('ignora lixo: value não numérico, sem value, comentário, span group_id e link sem group=', () => {
    const lixo = [
      '<option value="abc">Fantasma</option>',
      '<option>Sem value</option>',
      '<option value="182700"></option>',
      '<!-- <option value="182800">Comentado</option> -->',
      '<span class="group_id">(182900)</span>',
      '<a href="/game.php?screen=place&mode=call&group=lixo">Texto</a>',
      '<a href="/game.php?screen=place&mode=call">[Todas]</a>',
      '<a href="/game.php?screen=info_village&id=238743">Aldeia (533|550)</a>',
      '<div><b>nenhum grupo aqui</b></div>',
    ].join('');
    expect(parseGroupOptions(lixo)).toEqual([]);
    expect(parseGroupOptions('')).toEqual([]);
  });
});

describe('parseGroupedVillages — tela de edição de grupos', () => {
  it('atribui cada aldeia ao seu bloco, com nome legível e coordenada', () => {
    expect(parseGroupedVillages(GROUPS_SCREEN_HTML)).toEqual([
      { groupId: 182622, villageId: 238743, name: '747 - Nobre, Toxic Squad!', x: 533, y: 550 },
      { groupId: 182622, villageId: 238744, name: 'Bárbaros & Cia', x: 498, y: 501 },
      { groupId: 182608, villageId: 238750, name: 'Bárbara K55', x: 540, y: 560 },
    ]);
  });

  it('links de ação com group= não deslocam o bloco e marcador por atributo funciona', () => {
    const html = [
      '<tr><th><span class="group_id">(182622)</span> 🌾 Farm 🌾 ',
      '<a href="/game.php?village=238755&screen=groups&action=delete_group&group=182622&h=abc">apagar</a></th></tr>',
      '<tr><td><a href="/game.php?screen=info_village&id=238743">Aldeia A (533|550)</a></td></tr>',
      '<tr data-group-id="182608"><td><a href="/game.php?screen=info_village&id=238750">Aldeia B (540|560)</a></td></tr>',
      '<tr><td><a href="/game.php?screen=info_village&id=238751">Aldeia C (541|561)</a></td></tr>',
    ].join('');
    expect(parseGroupedVillages(html)).toEqual([
      { groupId: 182622, villageId: 238743, name: 'Aldeia A', x: 533, y: 550 },
      { groupId: 182608, villageId: 238750, name: 'Aldeia B', x: 540, y: 560 },
      { groupId: 182608, villageId: 238751, name: 'Aldeia C', x: 541, y: 561 },
    ]);
  });

  it('sem marcador de grupo devolve vazio (não chuta o grupo das aldeias)', () => {
    const semMarcador = '<tr><td><a href="/game.php?screen=info_village&id=238743">Aldeia A (533|550)</a></td></tr>';
    expect(parseGroupedVillages(semMarcador)).toEqual([]);
    expect(parseGroupedVillages('')).toEqual([]);
  });
});

describe('parseVillageRows — overview_villages&group=<id>', () => {
  it('lê a tabela filtrada, deduplica por aldeia e ignora linhas que não são de aldeia', () => {
    const html = [
      '<table class="vis">',
      '<tr><th>Aldeia</th><th>Pontos</th></tr>',
      '<tr><td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=238743">747 - Nobre, Toxic Squad! (533|550) K55</a></td><td>12.345</td></tr>',
      '<tr><td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=238744">Bárbaros &amp; Cia (498|501) K54</a></td><td>2.003</td></tr>',
      '<tr><td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=238743">747 - Nobre, Toxic Squad! (533|550) K55</a></td><td>12.345</td></tr>',
      '<tr><td><a href="/game.php?village=238755&amp;screen=overview_villages">Voltar à visão geral</a></td><td></td></tr>',
      '<tr><td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=abc">Sem id numérico (1|2)</a></td><td>0</td></tr>',
      '<tr><td>Total</td><td>14.348</td></tr>',
      '<!-- <tr><td><a href="/game.php?screen=info_village&id=999999">Comentado (1|1)</a></td></tr> -->',
      '</table>',
    ].join('');
    expect(parseVillageRows(html)).toEqual([
      { villageId: 238743, name: '747 - Nobre, Toxic Squad!', x: 533, y: 550 },
      { villageId: 238744, name: 'Bárbaros & Cia', x: 498, y: 501 },
    ]);
  });

  it('aceita a coordenada fora do link e descarta linha de aldeia sem coordenada legível', () => {
    const html = [
      '<tr><td class="village"><a href="/game.php?screen=info_village&amp;id=238745">Aldeia Sem Coord no Link</a> (500|500) K45</td></tr>',
      '<tr><td class="village"><a href="/game.php?screen=info_village&amp;id=238746">Aldeia Sem Coordenada Nenhuma</a></td></tr>',
    ].join('');
    expect(parseVillageRows(html)).toEqual([{ villageId: 238745, name: 'Aldeia Sem Coord no Link', x: 500, y: 500 }]);
  });

  it('não confunde a coordenada da aldeia seguinte com a linha anterior', () => {
    const html = [
      '<tr><td><a href="/game.php?screen=info_village&amp;id=238745">Aldeia Com Coord</a> (500|500) K45</td></tr>',
      '<tr><td><a href="/game.php?screen=info_village&amp;id=238746">Aldeia Sem Coord</a></td></tr>',
    ].join('');
    // A segunda linha herda o teto do `</tr>`: nenhuma coordenada para ela.
    expect(parseVillageRows(html)).toHaveLength(1);
  });
});

describe('parseVillageRows — formato REAL do overview_villages (BR142, 23/09)', () => {
  // A tabela liga cada aldeia a `village=NNN&screen=overview` (não info_village):
  // antes o leitor devolvia 0 aldeias em todo grupo.
  const html = `
    <div id="menu_row2"><a href="/game.php?village=111&amp;screen=overview">Aldeia atual</a> (500|500)</div>
    <table id="combined_table" class="vis overview_table">
      <tr><th>Aldeia</th></tr>
      <tr class="nowrap row_a"><td><span class="quickedit-vn" data-id="111">
        <a href="/game.php?village=111&amp;screen=overview"><span class="quickedit-label" data-text="225 - Nobre">225 - Nobre (553|453) K45</span></a>
      </span></td></tr>
      <tr class="nowrap row_b"><td><span class="quickedit-vn" data-id="222">
        <a href="/game.php?village=222&amp;screen=overview"><span class="quickedit-label">Vila B (54|7) K05</span></a>
      </span></td></tr>
      <tr><td><a href="/game.php?village=111&amp;screen=overview_villages&amp;mode=combined">Combinado</a></td></tr>
    </table>`;

  it('lê as aldeias do link village=&screen=overview com coordenada no texto', () => {
    expect(parseVillageRows(html)).toEqual([
      { villageId: 111, name: '225 - Nobre', x: 553, y: 453 },
      { villageId: 222, name: 'Vila B', x: 54, y: 7 },
    ]);
  });

  it('modo Edifícios/Pesquisa: link aponta para main/smith e ainda é lido', () => {
    const edificios = `<table id="buildings_table"><tr class="row_a"><td>
      <a href="/game.php?village=333&amp;screen=main"><span>Vila C (100|200) K21</span></a></td></tr></table>`;
    expect(parseVillageRows(edificios)).toEqual([{ villageId: 333, name: 'Vila C', x: 100, y: 200 }]);
  });

  it('link de menu da aldeia atual SEM coordenada no texto não vira linha', () => {
    const soMenu = '<a href="/game.php?village=999&amp;screen=overview">Aldeia</a> (1|2)';
    expect(parseVillageRows(soMenu)).toEqual([]);
  });
});
