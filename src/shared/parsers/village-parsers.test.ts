import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseIncomingCommandRows, totalsByPlayer } from './village-parsers';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL('../../../tests/fixtures/br142/${name}'.replace('${name}', name), import.meta.url)), 'latin1');
}

// Montagem mínima de linha usando APENAS trechos reais das capturas BR142:
// esqueleto da <tr> igual ao de incomings-own.html e valores máquina
// (data-endtime/Timing.init) copiados VERBATIM de overview.html — nunca HTML
// inventado para validar comportamento.
const ROW_SKELETON = `
<table>
<tr class="row_a">
<td><input name="command_ids[492622028]" type="hidden" value="true" />
    <span class="quickedit" data-id="492622028"></span></td>
<td>Alvo compartilhado (543|551)</td>
<td>Origem real (612|606)</td>
<td>R O D R I G U E S</td>
<td>96.8</td>
<td>hoje às 01:11:07:<span class="grey small">212</span></td>
<td>{{TIMER}}</td>
</tr>
</table>`;
const PAGE_LOAD_OVERVIEW = 'Timing.init(1787622258.6229)';
const ENDTIME_REAL = '1787708994'; // overview.html: <span class="widget-command-timer" data-endtime="1787708994">24:05:36</span>

function pageWith(timerCellHtml: string, script: string): string {
  return `<html><body><script>${script}</script>${ROW_SKELETON.replace('{{TIMER}}', timerCellHtml)}</body></html>`;
}

describe('parseIncomingCommandRows (fixture real: 701 comandos)', () => {
  it('extrai todas as linhas com id/tipo/origem/destino/jogador', () => {
    const rows = parseIncomingCommandRows(fixture('incomings-own.html'));
    expect(rows).toHaveLength(701);
    const first = rows[0]!;
    expect(first.commandId).toBe(874042204);
    expect(first.type).toBe('support');
    expect(first.name).toBe('Suporte');
    expect(first.destination.coord).toBe('612|606');
    expect(first.origin.coord).toBe('533|550');
    expect(first.playerName).toBe('R O D R I G U E S');
    expect(first.fieldsDistance).toBeCloseTo(96.8, 1);
    expect(first.arrivesAtText).toContain('hoje');
    expect(first.arrivesInText).toBe('1:08:03');
  });

  it('contém a linha de ataque real (pequeno + com nobre) entre os suportes', () => {
    const rows = parseIncomingCommandRows(fixture('incomings-own.html'));
    const attacks = rows.filter((r) => r.type === 'attack');
    expect(attacks).toHaveLength(1);
    expect(attacks[0]?.hasNoble).toBe(true);
    expect(attacks[0]?.sizeHint).toBe('pequeno');
    expect(rows.filter((r) => r.type === 'support')).toHaveLength(700);
  });

  it('página sem o widget devolve vazio (não é erro)', () => {
    expect(parseIncomingCommandRows('<html>outra tela</html>')).toEqual([]);
  });
});

describe('arrivalSecFromLoad (formato máquina da chegada)', () => {
  it('village-commands.html real é página de erro ("Não existe tal aldeia.") — sem linhas', () => {
    // A captura de info_village salva em tests/fixtures/br142/village-commands.html
    // voltou com erro do jogo e NÃO contém a tabela de comandos (nem atributo máquina).
    const html = fixture('village-commands.html');
    // fixture lida em latin1: "Não" (UTF-8) vira "NÃ£o" (2 chars) — ASCII é à prova de mojibake.
    expect(html).toContain('existe tal aldeia');
    expect(parseIncomingCommandRows(html)).toEqual([]);
  });

  it('captura real incomings-own.html: 701 linhas SEM atributo máquina → tudo null (nada adivinhado)', () => {
    const rows = parseIncomingCommandRows(fixture('incomings-own.html'));
    expect(rows).toHaveLength(701);
    for (const row of rows) {
      expect(row.arrivalSecFromLoad).toBeNull();
      expect(row.arrivesInText).not.toBe('');
    }
  });

  it('data-endtime real do BR142 (overview.html) convertido com Timing.init da mesma página', () => {
    // 1787708994 − 1787622258.6229 = 86735.3771 → Math.round = 86735 s (>0)
    const rows = parseIncomingCommandRows(pageWith(`<span class="widget-command-timer" data-endtime="${ENDTIME_REAL}">24:05:36</span>`, PAGE_LOAD_OVERVIEW));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.arrivalSecFromLoad).toBe(86735);
  });

  it('data-duration (segundos a partir do carregamento) usado direto; texto mantido', () => {
    const rows = parseIncomingCommandRows(pageWith('<span class="timer" data-duration="1260">21:00</span>', PAGE_LOAD_OVERVIEW));
    expect(rows[0]?.arrivalSecFromLoad).toBe(1260);
    expect(rows[0]?.arrivesInText).toBe('21:00');
  });

  it('fail-closed: vazio, não-numérico, endtime < carregamento ou sem Timing.init → null', () => {
    for (const timer of ['<span class="timer" data-endtime=""></span>', '<span class="timer" data-endtime="nao-numero"></span>']) {
      expect(parseIncomingCommandRows(pageWith(timer, PAGE_LOAD_OVERVIEW))[0]?.arrivalSecFromLoad).toBeNull();
    }
    const beforeLoad = String(1787622257); // 1 segundo ANTES do Timing.init da página
    expect(parseIncomingCommandRows(pageWith(`<span class="timer" data-endtime="${beforeLoad}">-00:01</span>`, PAGE_LOAD_OVERVIEW))[0]?.arrivalSecFromLoad).toBeNull();
    expect(parseIncomingCommandRows(pageWith('<span class="timer" data-endtime="9999999999">x</span>', ''))[0]?.arrivalSecFromLoad).toBeNull();
  });
});

describe('totalsByPlayer', () => {
  it('agrega ataques/fakes/nobres/suportes por jogador', () => {
    const rows = parseIncomingCommandRows(fixture('incomings-own.html'));
    const totals = totalsByPlayer(rows);
    expect(totals[0]?.playerName).toBe('R O D R I G U E S');
    expect(totals[0]?.total).toBe(701);
    expect(totals[0]?.attacks).toBe(1);
    expect(totals[0]?.nobleAttacks).toBe(1);
    expect(totals.reduce((sum, t) => sum + t.fakes, 0)).toBe(0);
  });
});
