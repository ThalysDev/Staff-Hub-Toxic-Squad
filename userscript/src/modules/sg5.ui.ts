// UI da seção "Conferência" (SG_5 in-game): renderização DOM dentro do Shadow
// DOM do shell (classes shs-*). Glue fino — os motores puros (@shared) fazem o
// trabalho; aqui só montagem de DOM. Dados do jogo NUNCA viram HTML (só
// textContent) e todos os textos são PT-BR.

import type { IncomingCommandRow } from '@shared/parsers/village-parsers';
import { buildArrivalTimeline } from '@shared/sg5-arrivals';
import type { ConferenceCommand, ConferenceDiff, ConferenceSnapshot } from '@shared/sg5-diff';
import { EMPTY_SG5_VIEW_FILTER, filterSg5Result, type Sg5ViewFilter } from '@shared/sg5-view-filter';
import type { VillageThreat } from '@shared/incoming-risk';
import { formatHms } from '@shared/sg4-timing';

/** Uma conferência obtida de uma página info_village (não persistida). */
export interface ConferenceRound {
  villageId: string;
  /** "x|y" do alvo; null quando a página não permite determinar (salvo bloqueado). */
  coord: string | null;
  /** Momento do fetch (epoch ms) — âncora de fallback da agenda de chegadas. */
  fetchedAt: number;
  /** Âncora real das chegadas: Timing.init da página quando existe; senão fetchedAt. */
  loadedAt: number;
  rows: IncomingCommandRow[];
  /** Triagem "vai cair?" do motor incoming-risk (defaults do app). */
  threat: VillageThreat;
}

/** Rodada persistida (GM storage): snapshot no formato do motor sg5-diff. */
export interface StoredRound {
  savedAt: number;
  snapshot: ConferenceSnapshot;
}

export interface SavedRoundsState {
  rounds: StoredRound[];
  /** diffConferences entre as duas últimas rodadas; null quando < 2 rodadas. */
  diff: ConferenceDiff | null;
  /** Erro PT-BR do motor quando o snapshot persistido está estruturalmente quebrado. */
  diffError: string | null;
}

export type MessageKind = 'info' | 'ok' | 'erro';

export interface ConferenceCallbacks {
  onConferir(): void;
  onSalvar(): void;
}

export interface ConferenceUi {
  setBusy(busy: boolean): void;
  setMessage(text: string, kind: MessageKind): void;
  showRound(round: ConferenceRound): void;
  showSaved(state: SavedRoundsState): void;
}

const MESSAGE_CLASS: Record<MessageKind, string> = { info: 'shs-muted', ok: 'shs-ok', erro: 'shs-danger' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stamp(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR');
}

function riskLabel(level: VillageThreat['level']): string {
  if (level === 'vai-cair') return 'Vai cair';
  if (level === 'pressionada') return 'Pressionada';
  if (level === 'resistente') return 'Resistente';
  return 'Sem dados';
}

function riskClass(level: VillageThreat['level']): string {
  if (level === 'vai-cair') return 'shs-danger';
  if (level === 'resistente') return 'shs-ok';
  if (level === 'sem-dados') return 'shs-muted';
  return '';
}

/**
 * Composição conhecida da linha (o widget do jogo não expõe a lista exata de
 * unidades — só os data-icon-hint). Nobre primeiro (unidade lenta decisiva).
 */
function unitsLabel(row: IncomingCommandRow): string {
  if (row.type === 'support') return 'Suporte';
  const parts: string[] = [];
  if (row.sizeHint !== null) parts.push(`Ataque ${row.sizeHint}`);
  if (row.hasNoble) parts.push('Nobre');
  if (parts.length > 0) return parts.join(' + ');
  return row.hints.length > 0 ? row.hints.join(' · ') : row.type;
}

/** Tipo resumido do comando (mesma régua do Sg5DiffSection do app). */
function describeTipo(command: ConferenceCommand | undefined): string {
  if (command === undefined) return '—';
  if (command.hasNoble) return 'Nobre';
  if (command.sizeHint === 'pequeno') return 'Fake';
  return 'Ataque';
}

function commandsById(snapshot: ConferenceSnapshot): Map<number, ConferenceCommand> {
  const map = new Map<number, ConferenceCommand>();
  for (const village of snapshot.villages) {
    for (const command of village.commands) map.set(command.commandId, command);
  }
  return map;
}

interface DisplayRow {
  row: IncomingCommandRow;
  /** Chegada absoluta (epoch ms); null = linha sem atributo de máquina. */
  arrivalAt: number | null;
}

/** Filtro de visualização pelo motor puro (busca fold-based) + agenda de chegadas. */
function displayRows(round: ConferenceRound, query: string): { rows: DisplayRow[]; unresolved: number } {
  const result = {
    generatedAt: new Date(round.fetchedAt).toISOString(),
    villages: [{ coord: round.coord ?? '', loadedAt: round.loadedAt, commands: round.rows }],
    unknown: [],
  };
  const filter: Sg5ViewFilter = { ...EMPTY_SG5_VIEW_FILTER, query };
  const filtered = filterSg5Result(result, filter, new Date());
  const commands = filtered.villages[0]?.commands ?? [];
  const timeline = buildArrivalTimeline([{ coord: round.coord ?? '', commands, loadedAt: round.loadedAt }]);
  const arrivalById = new Map<number, number>();
  for (const entry of timeline.entries) arrivalById.set(entry.commandId, entry.arrivalAt);
  const rows: DisplayRow[] = commands.map((row) => ({ row, arrivalAt: arrivalById.get(row.commandId) ?? null }));
  // Chegadas em ordem crescente; sem horário de máquina por último (nunca inventado).
  rows.sort(
    (a, b) =>
      (a.arrivalAt ?? Number.POSITIVE_INFINITY) - (b.arrivalAt ?? Number.POSITIVE_INFINITY) ||
      a.row.commandId - b.row.commandId,
  );
  return { rows, unresolved: timeline.unresolved };
}

function appendCommandTable(
  parent: HTMLElement,
  title: string,
  rows: readonly { coord: string; playerName: string; commandId: number }[],
  tipoById: Map<number, ConferenceCommand>,
): void {
  if (rows.length === 0) return;
  parent.appendChild(el('strong', undefined, title));
  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const label of ['Jogador', 'Alvo', 'Tipo']) headRow.appendChild(el('th', undefined, label));
  thead.appendChild(headRow);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', undefined, row.playerName));
    tr.appendChild(el('td', undefined, row.coord));
    tr.appendChild(el('td', undefined, describeTipo(tipoById.get(row.commandId))));
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  parent.appendChild(table);
}

/** Monta a seção no container (Shadow DOM do shell) e devolve os controles. */
export function mountConferenceUi(container: HTMLElement, callbacks: ConferenceCallbacks): ConferenceUi {
  const controls = el('div', 'shs-row');
  const conferirBtn = el('button', 'shs-btn', 'Conferir agora');
  conferirBtn.type = 'button';
  conferirBtn.addEventListener('click', () => callbacks.onConferir());
  const searchInput = el('input', 'shs-input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Filtrar por jogador, aldeia ou x|y…';
  searchInput.disabled = true;
  searchInput.addEventListener('input', () => redrawTable());
  controls.append(conferirBtn, searchInput);

  const messageEl = el('span', 'shs-muted');
  const messageRow = el('div', 'shs-row');
  messageRow.appendChild(messageEl);

  const summaryBox = el('div');
  const tableBox = el('div');

  const saveRow = el('div', 'shs-row');
  const salvarBtn = el('button', 'shs-btn shs-btn-ghost', 'Salvar rodada');
  salvarBtn.type = 'button';
  salvarBtn.addEventListener('click', () => callbacks.onSalvar());
  saveRow.appendChild(salvarBtn);

  const savedBox = el('div');

  container.append(controls, messageRow, summaryBox, tableBox, saveRow, savedBox);

  let current: ConferenceRound | null = null;

  function redrawTable(): void {
    tableBox.innerHTML = '';
    const round = current;
    if (round === null) return;
    if (round.rows.length === 0) {
      tableBox.appendChild(
        el('p', 'shs-muted', 'Nenhum comando compartilhado chegando a esta aldeia (ou os membros não compartilham comandos com a liderança).'),
      );
      return;
    }
    const { rows, unresolved } = displayRows(round, searchInput.value);
    if (rows.length === 0) {
      tableBox.appendChild(el('p', 'shs-muted', 'Nenhum comando passa pelo filtro atual.'));
      return;
    }
    const table = el('table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const label of ['Chegada (HH:MM:SS)', 'Jogador', 'Origem', 'Unidades (lento→rápido)', 'Risco']) {
      headRow.appendChild(el('th', undefined, label));
    }
    thead.appendChild(headRow);
    const tbody = el('tbody');
    const threat = round.threat;
    for (const display of rows) {
      const tr = el('tr');
      if (display.arrivalAt === null) {
        const chegada = el('td', 'shs-muted', '—');
        chegada.title = 'Sem horário de máquina na página (data-endtime/data-duration ausentes).';
        tr.appendChild(chegada);
      } else {
        tr.appendChild(el('td', undefined, formatHms(new Date(display.arrivalAt))));
      }
      tr.appendChild(el('td', undefined, display.row.playerName));
      const origem = display.row.origin.coord === '' ? display.row.origin.name : display.row.origin.coord;
      const origemCell = el('td', undefined, origem === '' ? '—' : origem);
      if (display.row.origin.name !== '') origemCell.title = display.row.origin.name;
      tr.appendChild(origemCell);
      tr.appendChild(el('td', undefined, unitsLabel(display.row)));
      if (display.row.type !== 'attack') {
        tr.appendChild(el('td', 'shs-muted', '—'));
      } else {
        const riskCell = el('td', riskClass(threat.level), riskLabel(threat.level));
        riskCell.title = threat.detail;
        tr.appendChild(riskCell);
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    tableBox.appendChild(table);
    tableBox.appendChild(
      el('p', 'shs-muted', `${rows.length} comando(s) · ${unresolved} sem horário de máquina (mostrados como “—”).`),
    );
  }

  return {
    setBusy(busy: boolean): void {
      conferirBtn.disabled = busy;
      salvarBtn.disabled = busy;
      conferirBtn.textContent = busy ? 'Conferindo…' : 'Conferir agora';
    },
    setMessage(text: string, kind: MessageKind): void {
      messageEl.textContent = text;
      messageEl.className = MESSAGE_CLASS[kind];
    },
    showRound(round: ConferenceRound): void {
      current = round;
      searchInput.disabled = false;
      searchInput.value = '';
      summaryBox.innerHTML = '';
      summaryBox.appendChild(
        el(
          'p',
          'shs-muted',
          `${round.coord !== null ? `Alvo ${round.coord}` : 'Alvo (coordenada não identificada)'} · ${round.rows.length} comando(s) · conferido às ${formatHms(new Date(round.fetchedAt))}`,
        ),
      );
      const risk = el('p', riskClass(round.threat.level), `Risco do alvo: ${riskLabel(round.threat.level)}`);
      risk.title = round.threat.detail;
      summaryBox.appendChild(risk);
      redrawTable();
    },
    showSaved(state: SavedRoundsState): void {
      savedBox.innerHTML = '';
      if (state.rounds.length === 0) {
        savedBox.appendChild(
          el('p', 'shs-muted', 'Nenhuma rodada salva para esta aldeia — “Salvar rodada” guarda a conferência atual e permite comparar com a próxima.'),
        );
        return;
      }
      const last = state.rounds[0];
      savedBox.appendChild(
        el('p', 'shs-muted', last === undefined ? '' : `Rodadas salvas: ${state.rounds.length} — última em ${stamp(last.savedAt)}`),
      );
      if (state.diffError !== null) {
        savedBox.appendChild(el('p', 'shs-danger', `Falha ao comparar rodadas: ${state.diffError}`));
        return;
      }
      const diff = state.diff;
      if (diff === null) {
        savedBox.appendChild(el('p', 'shs-muted', 'Salve outra rodada para habilitar a comparação entre as duas últimas.'));
        return;
      }
      const totalDelta = diff.coverageDelta.reduce((sum, entry) => sum + (entry.after - entry.before), 0);
      savedBox.appendChild(
        el(
          'p',
          undefined,
          `Comparação (últimas 2 rodadas) — novos: ${diff.newCommands.length} · cancelados: ${diff.cancelledCommands.length} · alvos novos: ${diff.newTargets.length} · alvos perdidos: ${diff.lostTargets.length} · Δ cobertura: ${totalDelta > 0 ? `+${totalDelta}` : totalDelta}`,
        ),
      );
      const unchanged =
        diff.newCommands.length === 0 &&
        diff.cancelledCommands.length === 0 &&
        diff.newTargets.length === 0 &&
        diff.lostTargets.length === 0 &&
        diff.coverageDelta.length === 0;
      if (unchanged) {
        savedBox.appendChild(el('p', 'shs-muted', 'Nenhuma mudança — todos os comandos e alvos da rodada anterior seguem presentes.'));
        return;
      }
      if (diff.coverageDelta.length > 0) {
        savedBox.appendChild(
          el('p', 'shs-muted', `Cobertura por alvo: ${diff.coverageDelta.map((entry) => `${entry.coord} ${entry.before}→${entry.after}`).join(' · ')}`),
        );
      }
      if (diff.newTargets.length > 0) savedBox.appendChild(el('p', 'shs-muted', `Alvos novos: ${diff.newTargets.join(' · ')}`));
      if (diff.lostTargets.length > 0) savedBox.appendChild(el('p', 'shs-muted', `Alvos perdidos: ${diff.lostTargets.join(' · ')}`));
      const currentCommands = state.rounds[0] === undefined ? new Map<number, ConferenceCommand>() : commandsById(state.rounds[0].snapshot);
      const previousCommands = state.rounds[1] === undefined ? new Map<number, ConferenceCommand>() : commandsById(state.rounds[1].snapshot);
      appendCommandTable(savedBox, `Comandos novos (${diff.newCommands.length})`, diff.newCommands, currentCommands);
      appendCommandTable(savedBox, `Comandos cancelados (${diff.cancelledCommands.length})`, diff.cancelledCommands, previousCommands);
    },
  };
}
