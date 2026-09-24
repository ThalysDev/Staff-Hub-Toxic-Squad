// Cravar da Confirmação (Onda E) — bloco próprio do Toxic Squad na tela
// "Confirmar ataque/apoio" da Praça (screen=place&try=confirm): o jogador
// monta o comando (inclusive o TREM do jogo em "Adicionar ataque adicional"),
// digita a CHEGADA (ou o envio) com milissegundos e clica "Cravar". O bloco
// vira um registro do Agendador de Comandos, que mira NESTA página e dá o
// clique final no ms (relógio medido + compensação — Onda A). Os ataques
// adicionais preenchidos seguem juntos no mesmo clique.
//
// Regras: fail-closed (tela desconhecida → não monta; duração ilegível →
// recusa), zero innerHTML com dado dinâmico, relógio = Hora do servidor.

import { registerVanta } from './vanta-registry';
import type { ModuleScope } from './vanta-lifecycle';
import { icon } from '../../core/icons';
import { aimIsHot, calibrateClock, clockInfo, serverNowMs } from '../../core/game-clock';
import { clockLabelMs } from '../../ext/core/timing/precise-fire';
import { deriveSchedulerCommandStatus, parseSchedulerCommandRecord, SCHEDULER_DEFAULT_WINDOW } from '../../ext/core/scheduler-state';
import type { UnitType } from '../../ext/modules/shared/module-types';
import { createScheduledCommand } from '../tsh/plugins/command-scheduler';
import { appendSchedulerRecords, formatEta, loadSchedulerState, parseMillisInput, saveSchedulerState, toDatetimeLocalValue, parseDatetimeLocal } from '../tsh/tsh-commands-ui';
import { readNativeTrainFromScreen, normalizeVillageId } from '../tsh/tsh-transport';
import { isTshEnabled, runTshCycle, setTshEnabled } from '../tsh/tsh-runtime';
import { currentWorld } from '../../core/page';

const UI_ID = 'vanta-cravar-ui';
const UNITS: readonly UnitType[] = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];

/** "0:31:07" / "12:05:09" → ms; null = ilegível. Puro (testado). */
export function parseDurationText(text: string): number | null {
  const match = /(\d+):(\d{2}):(\d{2})/.exec(text);
  if (match === null) return null;
  const [h, m, s] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m > 59 || s > 59) return null;
  return ((h * 60 + m) * 60 + s) * 1000;
}

function confirmForm(): HTMLFormElement | null {
  const form = document.querySelector<HTMLFormElement>('form#command-data-form');
  return form !== null && form.querySelector('input[name="submit_confirm"]') !== null ? form : null;
}

function isConfirmScreen(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get('screen') === 'place' && confirmForm() !== null;
}

/** Duração exibida na tabela do comando ("Duração:"). */
function readDurationMs(form: HTMLFormElement): number | null {
  for (const cell of Array.from(form.querySelectorAll('td'))) {
    if ((cell.textContent ?? '').trim().replace(/:$/, '') === 'Duração') {
      return parseDurationText(cell.nextElementSibling?.textContent ?? '');
    }
  }
  return null;
}

interface ScreenCommand {
  kind: 'attack' | 'noble' | 'support';
  sourceVillageId: string;
  target: { x: number; y: number };
  units: Partial<Record<UnitType, number>>;
  train: Record<string, number>[];
  durationMs: number;
}

/** Lê o comando que ESTA tela vai enviar (fail-closed: null com o motivo). */
function readScreenCommand(): { ok: true; command: ScreenCommand } | { ok: false; message: string } {
  const form = confirmForm();
  if (form === null) return { ok: false, message: 'Tela de confirmação não encontrada.' };
  const num = (name: string): number => Number.parseInt(form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value ?? '', 10);
  const x = num('x');
  const y = num('y');
  const source = form.querySelector<HTMLInputElement>('input[name="source_village"]')?.value ?? '';
  if (!Number.isInteger(x) || !Number.isInteger(y) || source === '') return { ok: false, message: 'Alvo/origem ilegíveis nesta tela.' };
  const units: Partial<Record<UnitType, number>> = {};
  for (const unit of UNITS) {
    const amount = num(unit);
    if (Number.isFinite(amount) && amount > 0) units[unit] = amount;
  }
  if (Object.keys(units).length === 0) return { ok: false, message: 'Nenhuma tropa lida nesta confirmação.' };
  const isSupport = form.querySelector('input[name="support"]') !== null;
  const train = readNativeTrainFromScreen();
  if (isSupport && train.length > 0) return { ok: false, message: 'Apoio não tem trem.' };
  const durationMs = readDurationMs(form);
  if (durationMs === null) return { ok: false, message: 'Não consegui ler a Duração desta tela.' };
  return {
    ok: true,
    command: {
      kind: isSupport ? 'support' : (units.snob ?? 0) > 0 ? 'noble' : 'attack',
      sourceVillageId: normalizeVillageId(source),
      target: { x, y },
      units,
      train,
      durationMs,
    },
  };
}

const CSS = `
  #${UI_ID} { margin: 10px 0; padding: 10px 12px; max-width: 520px; border-radius: 10px;
    background: var(--shs-bg-card, #fffdf3); border: 1px solid var(--shs-border-strong, #cbb384);
    font-family: var(--shs-font, Verdana, sans-serif); font-size: 12px; color: var(--shs-ink, #5a3a16); }
  #${UI_ID} .vcc-title { display: flex; align-items: center; gap: 6px; font-weight: 700; color: var(--shs-ink-strong, #3c250a); margin-bottom: 8px; }
  #${UI_ID} .vcc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 5px 0; }
  #${UI_ID} input[type=datetime-local] { padding: 3px 5px; }
  #${UI_ID} input.vcc-ms { width: 64px; padding: 3px 5px; }
  #${UI_ID} button { display: inline-flex; align-items: center; gap: 5px; padding: 4px 11px; border-radius: 6px; cursor: pointer;
    font: inherit; font-weight: 700; border: 1px solid var(--shs-action-dark, #4a2708);
    background: var(--shs-action, #6d3c14); color: var(--shs-on-action, #f7ecd2); }
  #${UI_ID} button.vcc-ghost { background: transparent; color: var(--shs-danger, #c04038); border-color: var(--shs-danger, #c04038); }
  #${UI_ID} .vcc-status { font-weight: 600; }
  #${UI_ID} .vcc-eta { font-family: var(--shs-font-mono, monospace); color: var(--shs-info, #2f66c0); font-weight: 700; }
  #${UI_ID} .vcc-note { color: var(--shs-muted, #6f5e40); font-size: 11px; }
  #${UI_ID} .vcc-err { color: var(--shs-danger, #c04038); font-weight: 600; }
`;

const RECORD_KEY = 'tsh-vanta:cravar-record';

function mount(scope: ModuleScope): void {
  if (!isConfirmScreen() || document.getElementById(UI_ID) !== null) return;
  const form = confirmForm();
  if (form === null) return;
  const world = currentWorld();

  const box = document.createElement('div');
  box.id = UI_ID;
  const style = document.createElement('style');
  style.textContent = CSS;
  const title = document.createElement('div');
  title.className = 'vcc-title';
  title.append(icon('crosshair', 14), document.createTextNode('Cravar daqui — Toxic Squad'));

  const modeRow = document.createElement('div');
  modeRow.className = 'vcc-row';
  const mkRadio = (label: string, checked: boolean): HTMLInputElement => {
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'vcc-mode';
    // Fora do formulário do jogo: nada deste bloco vai junto no envio.
    radio.setAttribute('form', 'vcc-sem-formulario');
    radio.checked = checked;
    const wrap = document.createElement('label');
    wrap.append(radio, document.createTextNode(` ${label}`));
    modeRow.appendChild(wrap);
    return radio;
  };
  const arrivalRadio = mkRadio('Chegar às', true);
  mkRadio('Enviar às', false);

  const timeRow = document.createElement('div');
  timeRow.className = 'vcc-row';
  const timeInput = document.createElement('input');
  timeInput.type = 'datetime-local';
  timeInput.step = '1';
  const msInput = document.createElement('input');
  msInput.type = 'number';
  msInput.min = '0';
  msInput.max = '999';
  msInput.value = '0';
  msInput.className = 'vcc-ms';
  msInput.setAttribute('aria-label', 'Milissegundos');
  const duration = readDurationMs(form);
  timeInput.value = toDatetimeLocalValue(new Date(serverNowMs() + (duration ?? 0) + 5 * 60_000));
  const cravar = document.createElement('button');
  cravar.type = 'button';
  cravar.append(icon('crosshair', 12), document.createTextNode('Cravar'));
  timeRow.append(timeInput, msInput, document.createTextNode('ms'), cravar);

  const status = document.createElement('div');
  status.className = 'vcc-row';
  const note = document.createElement('div');
  note.className = 'vcc-note';
  note.textContent =
    'Hora do SERVIDOR. Os ataques adicionais preenchidos abaixo vão juntos (trem do jogo, chegadas a cada 100 ms). Deixe esta aba aberta até o envio.';

  box.append(style, title, modeRow, timeRow, status, note);
  // P0 (revisão Onda E): o bloco fica FORA do formulário do jogo — Enter num
  // campo dele jamais pode submeter a confirmação (enviaria na hora).
  form.parentNode?.insertBefore(box, form);
  if (!box.isConnected) return;
  for (const input of [timeInput, msInput]) input.setAttribute('form', 'vcc-sem-formulario');
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  scope.owns(box);

  const setError = (message: string): void => {
    status.replaceChildren();
    const err = document.createElement('span');
    err.className = 'vcc-err';
    err.textContent = message;
    status.appendChild(err);
  };

  const cancelRecord = (id: string): void => {
    const state = loadSchedulerState(world);
    saveSchedulerState(world, {
      ...state,
      commands: state.commands.filter((command) => command.id !== id),
    });
  };

  const render = (): void => {
    if (aimIsHot()) return; // reta final do clique: a interface espera
    const id = sessionStorage.getItem(RECORD_KEY);
    if (id === null) return;
    const record = loadSchedulerState(world).commands.find((command) => command.id === id);
    if (record === undefined) {
      sessionStorage.removeItem(RECORD_KEY);
      status.replaceChildren();
      return;
    }
    const view = deriveSchedulerCommandStatus(record, new Date(serverNowMs()), SCHEDULER_DEFAULT_WINDOW);
    const sendAt = Date.parse(record.sendAt);
    status.replaceChildren();
    const txt = document.createElement('span');
    txt.className = 'vcc-status';
    txt.textContent = `Cravado: envio às ${clockLabelMs(sendAt)}${record.arrivalAt !== undefined ? ` · chegada ${clockLabelMs(Date.parse(record.arrivalAt))}` : ''} · ${view}`;
    const eta = document.createElement('span');
    eta.className = 'vcc-eta';
    eta.textContent = formatEta(sendAt - serverNowMs());
    status.append(txt, eta);
    if (view !== 'enviado' && view !== 'falhou' && view !== 'incerto') {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'vcc-ghost';
      cancel.append(icon('x', 12), document.createTextNode('Cancelar'));
      cancel.addEventListener('click', () => {
        cancelRecord(record.id);
        sessionStorage.removeItem(RECORD_KEY);
        status.replaceChildren();
      });
      status.appendChild(cancel);
    }
  };

  /** Registro deste bloco ainda vivo (não enviado/falho/removido)? */
  const liveRecordId = (): string | null => {
    const id = sessionStorage.getItem(RECORD_KEY);
    if (id === null) return null;
    const record = loadSchedulerState(world).commands.find((command) => command.id === id);
    if (record === undefined) return null;
    const view = deriveSchedulerCommandStatus(record, new Date(serverNowMs()), SCHEDULER_DEFAULT_WINDOW);
    return view === 'enviado' || view === 'falhou' || view === 'incerto' || view === 'removido' ? null : id;
  };

  const doCravar = (): void => {
    // P1 (revisão Onda E): um cravado por tela — nunca dois registros vivos.
    if (liveRecordId() !== null) {
      setError('Esta tela já tem um cravado ativo — cancele-o antes de cravar de novo.');
      return;
    }
    const read = readScreenCommand();
    if (!read.ok) {
      setError(read.message);
      return;
    }
    const base = parseDatetimeLocal(timeInput.value);
    if (base === null) {
      setError('Informe data e hora (com segundos).');
      return;
    }
    const when = base.getTime() + parseMillisInput(msInput.value);
    const cmd = read.command;
    const sendAtMs = arrivalRadio.checked ? when - cmd.durationMs : when;
    if (sendAtMs <= serverNowMs() + 2_000) {
      setError('O envio precisa ser pelo menos 2 segundos no futuro (hora do servidor).');
      return;
    }
    const record = createScheduledCommand({
      kind: cmd.kind,
      sourceVillageId: cmd.sourceVillageId,
      target: cmd.target,
      units: cmd.units,
      ...(cmd.train.length > 0 ? { trainUnits: cmd.train } : {}),
      timingMode: arrivalRadio.checked ? 'arrival' : 'send',
      sendAt: new Date(sendAtMs).toISOString(),
      arrivalAt: new Date(sendAtMs + cmd.durationMs).toISOString(),
      detail: `Cravado pela tela de confirmação${cmd.train.length > 0 ? ` (trem de ${cmd.train.length + 1})` : ''}.`,
    });
    const valid = parseSchedulerCommandRecord(record);
    if (!valid.ok) {
      setError(valid.message);
      return;
    }
    if (loadSchedulerState(world).commands.some((command) => command.id === valid.record.id)) {
      setError('Este mesmo comando já está agendado.');
      return;
    }
    appendSchedulerRecords(world, [valid.record]);
    sessionStorage.setItem(RECORD_KEY, valid.record.id);
    render();
    // O agendador mira nesta própria página (tela de confirmação aberta).
    void runTshCycle('command-scheduler', { ignoreCooldown: true });
  };

  cravar.addEventListener('click', () => {
    if (!isTshEnabled('command-scheduler')) {
      setError('O Agendador de Comandos está desligado.');
      const ligar = document.createElement('button');
      ligar.type = 'button';
      ligar.append(icon('zap', 12), document.createTextNode('Ligar o Agendador e cravar'));
      ligar.addEventListener('click', () => {
        setTshEnabled('command-scheduler', true);
        doCravar();
      });
      status.appendChild(ligar);
      return;
    }
    doCravar();
  });

  render();
  scope.every(render, 250);
  // Revisão Onda E: se um ciclo já estava em voo quando o Cravar foi clicado,
  // o disparo imediato é ignorado — re-tenta a cada 5s na reta final (o guard
  // de ciclo em voo torna isto inofensivo durante a mira).
  scope.every(() => {
    const id = liveRecordId();
    if (id === null) return;
    const record = loadSchedulerState(world).commands.find((command) => command.id === id);
    const falta = record !== undefined ? Date.parse(record.sendAt) - serverNowMs() : -1;
    if (falta > 0 && falta <= 55_000) void runTshCycle('command-scheduler', { ignoreCooldown: true });
  }, 5_000);
  // Mede o relógio já ao abrir a confirmação (o cravado vai precisar).
  if (clockInfo().source !== 'http') void calibrateClock();
}

registerVanta({
  id: 'vanta-cravar-confirmacao',
  label: 'Cravar da Confirmação',
  icon: 'crosshair',
  desc: 'Na tela "Confirmar ataque", crava a chegada/envio com milissegundos direto dali — inclusive o trem do jogo (Adicionar ataque adicional).',
  group: 'defesa',
  match: isConfirmScreen,
  url: () => `/game.php?village=${new URLSearchParams(window.location.search).get('village') ?? ''}&screen=place`,
  mount,
});
