// SG_6 — Reservas & MPs: MUTAÇÕES REAIS no jogo (maior superfície de risco do
// userscript; aprovado pelo dono com o conjunto completo de guardas). Espelha o
// motor do app (src/main/mutations/sg6-service.ts — reserveMass/sendMps):
// - Reserva em massa no Planejador da tribo: screen=ally, action=new_reservation.
//   Formulário REAL (tests/fixtures/br142/ally-reservations.html): form
//   action=".../game.php?village=…&screen=ally&mode=reservations&action=new_reservation
//   &group_id=all&filter=&h=…" method=post; hidden name="x[]" / name="y[]";
//   radio name="target_type" value="coord"; submit id="save_reservations"
//   value="Reservar esta aldeia".
// - MPs em cadeia: screen=mail, action=send. Formulário REAL
//   (tests/fixtures/br142/mail-new.html): form action=".../game.php?village=…
//   &screen=mail&mode=new&action=send&h=…"; input name="to"; input
//   name="subject"; textarea name="text" (id="message"); submit name="send"
//   value="Enviar". Os POSTs passam pelo gateway canônico core/net gamePost
//   (TribalWars.post + h do DOM), uma tentativa, nunca retry.
//
// Guardas (política AGENTS.md / modo real permanente — decisão do dono):
// 1. Confirmação DUPLA por lote: confirm #1 com contagem exata + lista COMPLETA
//    de destinatários (+ prévia da 1ª MP); confirm #2 com o texto do envio real.
//    Cancelar em qualquer confirmação aborta sem enviar e sem journalar.
// 2. Pacing entre itens: 350ms + jitter 0–250ms (sleep local; o core/net ainda
//    serializa ≥200ms entre QUALQUER par de requisições).
// 3. UMA tentativa por item, NUNCA retry. Sentinela de sessão/captcha no corpo
//    da resposta (core/net lança SessionRequiredError/CaptchaDetectedError)
//    INTERROMPE a cadeia inteira; os itens restantes ficam explícitos como
//    "Não tentada" na tabela — nunca POST depois de página de login/captcha.
// 4. Journal local: cada resultado vai para GM storage
//    worldKey(world, 'sg6-journal'), teto 500 entradas
//    ({ts, kind:'mp'|'reserva'|'cancel', nick, ok, detail}). Itens nunca
//    tentados (halt por sentinela) NÃO geram entrada — nada aconteceu com eles.
// 5. TRIAGEM DE DESTINATÁRIOS — LIMITAÇÃO CONSCIENTE (v1): a triagem automática
//    do app (canal world:screen-recipients + dump de players) é exclusiva do
//    Electron e NÃO existe no userscript. Destinatários fora da tribo NÃO são
//    bloqueados aqui. O controle é o confirm #1 (líder vê a lista completa
//    antes de qualquer envio) + o aviso vermelho fixo no topo da seção. Não
//    remover o aviso sem substituir a triagem por mecanismo equivalente.

import { CaptchaDetectedError, SessionRequiredError, gamePost } from '../core/net';
import { gameContext } from '../core/shell';
import { gm, worldKey } from '../core/storage';
import { card, cardTitle, empty, iconButton, pill, spinner, table } from '../core/ui';
import { icon } from '../core/icons';
import { formatCoord, parseCoordList } from '@shared/coords';
import { previewMps } from '@shared/mp-preview';

const MIN_INTERVAL_MS = 350;
const JITTER_MS = 250;
const JOURNAL_CAP = 500;
const JOURNAL_NAME = 'sg6-journal';

interface JournalEntry {
  ts: string;
  kind: 'mp' | 'reserva' | 'cancel';
  nick: string;
  ok: boolean;
  detail: string;
}

/** Entrada "nick;coord coord[;HH:MM:SS,HH:MM:SS]" (formato do pacote SG_4). */
interface MpEntry {
  playerName: string;
  coords: string[];
  horarios?: string[];
}

interface ItemOutcome {
  nick: string;
  ok: boolean;
  detail: string;
}

const CANCELADO = 'Cancelado pelo usuário';
const NAO_TENTADA = 'Não tentada (operação interrompida).';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pacing humano entre itens: 350ms + jitter 0–250ms (guarda 2). */
function pacingDelay(): number {
  return MIN_INTERVAL_MS + Math.random() * JITTER_MS;
}

function appendJournal(world: string, entry: JournalEntry): void {
  const key = worldKey(world, JOURNAL_NAME);
  const journal = gm.get<JournalEntry[]>(key, []);
  journal.push(entry);
  gm.set(key, journal.slice(-JOURNAL_CAP)); // teto: descarta as mais antigas
}

function journalCount(world: string): number {
  return gm.get<JournalEntry[]>(worldKey(world, JOURNAL_NAME), []).length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sentinela de sessão/captcha lançada pelo core/net no corpo da mutação. */
function sentinelDetail(error: unknown): string | null {
  if (error instanceof SessionRequiredError) return 'SESSÃO EXPIRADA — operação interrompida. Faça login e recomece.';
  if (error instanceof CaptchaDetectedError) return 'CAPTCHA — operação interrompida.';
  return null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Coordenadas da reserva: engine compartilhada (@shared/coords) para parse e
 * dedupe (1ª ocorrência vence), mas FAIL-CLOSED como o service: token inválido
 * aborta ANTES de qualquer envio (o renderer do app descarta em silêncio —
 * aqui a disciplina de mutação do sg6-service prevalece).
 */
function parseCoordsStrict(text: string): string[] {
  const tokens = text.split(/[\s,;]+/).filter((token) => token !== '');
  if (tokens.length === 0) throw new Error('Nenhuma coordenada informada.');
  const parsed = parseCoordList(text);
  if (parsed.length !== tokens.length) {
    const validas = new Set(parsed.map(formatCoord));
    const ruim = tokens.find((token) => !validas.has(token)) ?? '?';
    throw new Error(`Coordenada inválida na reserva em massa: "${ruim}" — abortado antes de qualquer envio.`);
  }
  return parsed.map(formatCoord);
}

/**
 * Parser das entradas de MPs — MESMA regex do Sg6Page.tsx do app (não há
 * parser disso em @shared): "nick;123|456 456|789[;HH:MM:SS,HH:MM:SS]".
 * Horários (3º bloco, separados por vírgula) alimentam #horarios#.
 */
const MP_ENTRY_RE =
  /^([^;]{2,40});((?:\d{1,3}\|\d{1,3})(?:\s+\d{1,3}\|\d{1,3})*\s*)(?:;((?:\d{2}:\d{2}:\d{2}(?:\s+@\d{2}\/\d{2})?)(?:,\d{2}:\d{2}:\d{2}(?:\s+@\d{2}\/\d{2})?)*))?$/;

function parseMpEntries(text: string): MpEntry[] {
  const entries: MpEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = MP_ENTRY_RE.exec(trimmed);
    if (match === null) {
      throw new Error(`Linha inválida (use "nick;coord coord[;HH:MM:SS,HH:MM:SS]"): "${trimmed.slice(0, 60)}"`);
    }
    const entry: MpEntry = {
      playerName: match[1] ?? '',
      coords: (match[2] ?? '').trim().split(/\s+/),
    };
    const horariosRaw = match[3];
    if (horariosRaw !== undefined) entry.horarios = horariosRaw.split(',');
    entries.push(entry);
  }
  return entries;
}

/**
 * Tabela de resultados por item (recriada a cada atualização) sobre o helper
 * table() do design system; a coluna Resultado recebe a pílula colorida
 * (OK/ERRO) por cima do texto plano — mesma informação, mesma ordem.
 */
function renderOutcomes(wrap: HTMLElement, outcomes: ItemOutcome[]): void {
  wrap.replaceChildren();
  if (outcomes.length === 0) return;
  const outcomesTable = table(
    ['Item', 'Resultado', 'Detalhe'],
    outcomes.map((outcome) => [outcome.nick, outcome.ok ? 'OK' : 'ERRO', outcome.detail]),
  );
  const body = outcomesTable.tBodies[0];
  outcomes.forEach((outcome, index) => {
    const cell = body?.rows[index]?.cells[1];
    if (cell !== undefined) {
      cell.textContent = '';
      cell.appendChild(pill(outcome.ok ? 'OK' : 'ERRO', outcome.ok ? 'ok' : 'error'));
    }
  });
  wrap.appendChild(outcomesTable);
}

function resumo(outcomes: ItemOutcome[]): string {
  const ok = outcomes.filter((outcome) => outcome.ok).length;
  const canceladas = outcomes.filter((outcome) => outcome.detail === CANCELADO).length;
  const naoTentadas = outcomes.filter((outcome) => outcome.detail === NAO_TENTADA).length;
  const falhas = outcomes.length - ok - canceladas - naoTentadas;
  const partes = [`${ok} ok`, `${falhas} falha(s)`];
  if (canceladas > 0) partes.push(`${canceladas} cancelada(s)`);
  if (naoTentadas > 0) partes.push(`${naoTentadas} não tentada(s)`);
  return partes.join(', ');
}

// ---------------------------------------------------------------------------
// Sub-formulário A: Reservar coordenadas (screen=ally action=new_reservation)
// ---------------------------------------------------------------------------

function setupReservas(container: HTMLElement, onJournalChange?: () => void): void {
  const reservasCard = card(cardTitle('lock', 'Reservar coordenadas'));
  reservasCard.appendChild(
    el('div', 'shs-muted', 'Coordenadas "123|456" separadas por espaço/vírgula/linha. POST real no planejador da tribo (screen=ally → new_reservation); "já reservada" é tolerado.'),
  );

  const textarea = el('textarea', 'shs-input');
  textarea.rows = 4;
  textarea.placeholder = '123|456 456|789 …';

  const btn = iconButton('Reservar', 'lock', {});
  const btnCancel = iconButton('Cancelar', 'x', { variant: 'ghost' });
  btnCancel.type = 'button';
  btn.type = 'button';
  btnCancel.disabled = true;

  const progress = el('span', 'shs-muted');
  const status = el('div', 'shs-danger');
  const journalInfo = el('span', 'shs-muted');
  const outcomesWrap = el('div', 'shs-tablewrap');

  const row1 = el('div', 'shs-row');
  row1.appendChild(textarea);
  const row2 = el('div', 'shs-row');
  row2.appendChild(btn);
  row2.appendChild(btnCancel);
  row2.appendChild(progress);
  reservasCard.appendChild(row1);
  reservasCard.appendChild(row2);
  reservasCard.appendChild(status);
  reservasCard.appendChild(journalInfo);
  reservasCard.appendChild(outcomesWrap);
  container.appendChild(reservasCard);

  btn.addEventListener('click', () => {
    void runReserva();
  });

  async function runReserva(): Promise<void> {
    status.textContent = '';
    renderOutcomes(outcomesWrap, []);

    let coords: string[];
    try {
      coords = parseCoordsStrict(textarea.value);
    } catch (error) {
      status.textContent = errorMessage(error); // fail-closed ANTES de confirmar
      return;
    }

    const world = gameContext().world;
    // Guarda 1 — confirmação dupla: contagem exata + lista completa. Cancelar
    // em qualquer ponto = aborta sem enviar e sem journalar (semântica do app:
    // nada tentado não é mutação).
    if (!window.confirm(`Reserva em massa — ${coords.length} coordenada(s):\n${coords.join(', ')}`)) return;
    if (!window.confirm(`Confirma a reserva de ${coords.length} coordenada(s)? (uma por aldeia — a reserva é real)`)) return;

    const cancelState = { cancelled: false };
    const onCancel = (): void => {
      cancelState.cancelled = true; // checado ENTRE itens — nunca interrompe um POST no meio
      btnCancel.disabled = true;
    };
    btnCancel.addEventListener('click', onCancel);
    btn.disabled = true;
    btn.replaceChildren(spinner(), document.createTextNode('Reservando…'));
    btnCancel.disabled = false;

    const outcomes: ItemOutcome[] = [];
    try {
      let halted = false;
      for (const [index, coord] of coords.entries()) {
        if (cancelState.cancelled) {
          // Restantes viram linha "Cancelado pelo usuário" + journal kind 'cancel'.
          for (const restante of coords.slice(index)) {
            outcomes.push({ nick: restante, ok: false, detail: CANCELADO });
            appendJournal(world, { ts: new Date().toISOString(), kind: 'cancel', nick: restante, ok: false, detail: CANCELADO });
          }
          renderOutcomes(outcomesWrap, outcomes);
          break;
        }
        progress.textContent = `Reservando ${index + 1}/${coords.length} — ${coord}`;
        await sleep(pacingDelay());
        // splitCoord do service: a coord já veio validada por parseCoordsStrict.
        const x = /^(\d{1,3})\|/.exec(coord)?.[1] ?? '';
        const y = /\|(\d{1,3})$/.exec(coord)?.[1] ?? '';
        let outcome: ItemOutcome;
        try {
          // Campos EXATOS do formulário real (fixture ally-reservations.html),
          // idênticos ao reserveMass do sg6-service; h é injetado pelo gamePost.
          const body = await gamePost('ally', 'new_reservation', {
            'target_type': 'coord',
            'x[]': x,
            'y[]': y,
            'save_reservations': 'Reservar esta aldeia',
          });
          const already = /já reserva(?:d[ao]|u)|already reserv/i.test(body);
          const erro = /class="error"|não existe tal aldeia/i.test(body);
          outcome = erro
            ? { nick: coord, ok: false, detail: 'Recusado pelo jogo (aldeia inexistente ou erro).' }
            : { nick: coord, ok: true, detail: already ? 'Já reservada por outro membro — tolerado.' : 'Pedido enviado.' };
        } catch (error) {
          // Uma tentativa só: falha de rede vira resultado do item e a cadeia
          // segue; SENTINELA (sessão/captcha) interrompe TUDO (guarda 3).
          const sentinel = sentinelDetail(error);
          outcome = { nick: coord, ok: false, detail: sentinel ?? `Falha de rede: ${errorMessage(error)}` };
          if (sentinel !== null) halted = true;
        }
        outcomes.push(outcome);
        appendJournal(world, { ts: new Date().toISOString(), kind: 'reserva', nick: coord, ok: outcome.ok, detail: outcome.detail });
        renderOutcomes(outcomesWrap, outcomes);
        if (halted) {
          // Nunca tentados: explícitos na tabela, SEM entrada no journal.
          for (const restante of coords.slice(index + 1)) outcomes.push({ nick: restante, ok: false, detail: NAO_TENTADA });
          renderOutcomes(outcomesWrap, outcomes);
          break;
        }
      }
    } finally {
      btnCancel.removeEventListener('click', onCancel);
      btnCancel.disabled = true;
      btn.replaceChildren(icon('lock'), document.createTextNode('Reservar'));
      btn.disabled = false;
      progress.textContent = `Reservas concluídas — ${resumo(outcomes)}.`;
      journalInfo.textContent = `Journal local: ${journalCount(world)} evento(s) — teto ${JOURNAL_CAP}.`;
      onJournalChange?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-formulário B: MPs em cadeia (screen=mail action=send)
// ---------------------------------------------------------------------------

function setupMps(container: HTMLElement, onJournalChange?: () => void): void {
  const mpsCard = card(cardTitle('send', 'MPs em cadeia'));
  mpsCard.appendChild(
    el('div', 'shs-muted', 'Uma MP REAL por jogador (screen=mail → send). Corpo com placeholders #jogador#, #alvos# e/ou #horarios#. Destinatários: uma linha "nick;123|456 456|789[;HH:MM:SS,HH:MM:SS]" por jogador (nick EXATO — a MP é case-sensitive).'),
  );

  const subject = el('input', 'shs-input');
  subject.placeholder = 'Assunto';

  const body = el('textarea', 'shs-input');
  body.rows = 5;
  body.placeholder = 'Olá #jogador#, seus alvos: #alvos#\n#horarios#';

  const recipients = el('textarea', 'shs-input');
  recipients.rows = 5;
  recipients.placeholder = 'Nick;123|456 456|789;21:30:00,21:45:00';

  const btn = iconButton('Enviar MPs', 'send', {});
  btn.type = 'button';
  const btnCancel = iconButton('Cancelar', 'x', { variant: 'ghost' });
  btnCancel.type = 'button';
  btnCancel.disabled = true;

  const progress = el('span', 'shs-muted');
  const status = el('div', 'shs-danger');
  const journalInfo = el('span', 'shs-muted');
  const outcomesWrap = el('div', 'shs-tablewrap');

  mpsCard.appendChild(subject);
  mpsCard.appendChild(body);
  mpsCard.appendChild(recipients);
  const row = el('div', 'shs-row');
  row.appendChild(btn);
  row.appendChild(btnCancel);
  row.appendChild(progress);
  mpsCard.appendChild(row);
  mpsCard.appendChild(status);
  mpsCard.appendChild(journalInfo);
  mpsCard.appendChild(outcomesWrap);
  container.appendChild(mpsCard);

  btn.addEventListener('click', () => {
    void runMps();
  });

  async function runMps(): Promise<void> {
    status.textContent = '';
    renderOutcomes(outcomesWrap, []);

    // Validações fail-closed do sendMps, na MESMA ordem, ANTES de qualquer
    // confirmação/envio. previewMps (@shared, engine única com a prévia do app)
    // já compila o corpo de TODOS os destinatários: #horarios# incoerente ou
    // template sem placeholder aborta aqui, nunca no meio da cadeia.
    let bodies: { playerName: string; subject: string; body: string }[];
    try {
      if (subject.value.trim() === '') throw new Error('Assunto vazio.');
      if (!body.value.includes('#alvos#') && !body.value.includes('#horarios#')) {
        throw new Error('O corpo precisa conter #alvos# e/ou #horarios# para personalizar a MP de cada jogador.');
      }
      const entries = parseMpEntries(recipients.value);
      if (entries.length === 0) throw new Error('Nenhuma entrada "nick;coords" informada.');
      bodies = previewMps(subject.value, body.value, entries);
    } catch (error) {
      status.textContent = errorMessage(error);
      return;
    }

    const world = gameContext().world;
    const nicks = bodies.map((entry) => entry.playerName);
    const primeira = bodies[0];
    const previa =
      primeira !== undefined ? `\n\nPrévia da 1ª MP (para ${primeira.playerName}):\n${primeira.body}` : '';

    // Guarda 1 — confirmação dupla (a lista completa É a triagem da v1, guarda 5).
    if (!window.confirm(`MPs em cadeia — ${bodies.length} destinatário(s):\n${nicks.join(', ')}${previa}`)) return;
    if (!window.confirm(`Confirma o envio de ${bodies.length} MP(s)? (uma por jogador — o envio é real)`)) return;

    const cancelState = { cancelled: false };
    const onCancel = (): void => {
      cancelState.cancelled = true; // checado ENTRE MPs — nunca interrompe um POST no meio
      btnCancel.disabled = true;
    };
    btnCancel.addEventListener('click', onCancel);
    btn.disabled = true;
    btn.replaceChildren(spinner(), document.createTextNode('Enviando…'));
    btnCancel.disabled = false;

    const outcomes: ItemOutcome[] = [];
    try {
      let halted = false;
      for (const [index, entry] of bodies.entries()) {
        if (cancelState.cancelled) {
          for (const restante of bodies.slice(index)) {
            outcomes.push({ nick: restante.playerName, ok: false, detail: CANCELADO });
            appendJournal(world, { ts: new Date().toISOString(), kind: 'cancel', nick: restante.playerName, ok: false, detail: CANCELADO });
          }
          renderOutcomes(outcomesWrap, outcomes);
          break;
        }
        progress.textContent = `Enviando MP ${index + 1}/${bodies.length} — ${entry.playerName}`;
        await sleep(pacingDelay());
        let outcome: ItemOutcome;
        try {
          // Campos EXATOS do formulário real (fixture mail-new.html): to,
          // subject, text e o submit send="Enviar" (mesmos campos do sendMps
          // do sg6-service); h é injetado pelo gamePost.
          const response = await gamePost('mail', 'send', {
            'to': entry.playerName,
            'subject': entry.subject,
            'text': entry.body,
            'send': 'Enviar',
          });
          const notFound = /não existe|destinatário inválido|unknown recipient/i.test(response);
          outcome = notFound
            ? { nick: entry.playerName, ok: false, detail: 'Nick não encontrado — confira o nome exato no jogo.' }
            : { nick: entry.playerName, ok: true, detail: 'MP enviada.' };
        } catch (error) {
          const sentinel = sentinelDetail(error);
          outcome = { nick: entry.playerName, ok: false, detail: sentinel ?? `Falha de rede: ${errorMessage(error)}` };
          if (sentinel !== null) halted = true;
        }
        outcomes.push(outcome);
        appendJournal(world, { ts: new Date().toISOString(), kind: 'mp', nick: entry.playerName, ok: outcome.ok, detail: outcome.detail });
        renderOutcomes(outcomesWrap, outcomes);
        if (halted) {
          for (const restante of bodies.slice(index + 1)) {
            outcomes.push({ nick: restante.playerName, ok: false, detail: NAO_TENTADA });
          }
          renderOutcomes(outcomesWrap, outcomes);
          break;
        }
      }
    } finally {
      btnCancel.removeEventListener('click', onCancel);
      btnCancel.disabled = true;
      btn.replaceChildren(icon('send'), document.createTextNode('Enviar MPs'));
      btn.disabled = false;
      progress.textContent = `MPs concluídas — ${resumo(outcomes)}.`;
      journalInfo.textContent = `Journal local: ${journalCount(world)} evento(s) — teto ${JOURNAL_CAP}.`;
      onJournalChange?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Journal local (teto 500) — visão compacta + limpeza com confirmação
// ---------------------------------------------------------------------------

/** Rótulos curtos do kind para a tabela compacta. */
function kindLabel(kind: JournalEntry['kind']): string {
  if (kind === 'mp') return 'MP';
  if (kind === 'reserva') return 'Reserva';
  return 'Cancel.';
}

/**
 * Cartão do journal: tabela compacta das entradas (mais recentes por último,
 * ordem de gravação) + botão "Limpar journal" (ghost-danger, com confirmação).
 * O refresh é ligado aos finally das cadeias para a tabela acompanhar a run.
 */
function createJournalView(): { node: HTMLElement; refresh(): void } {
  const world = gameContext().world;
  const key = worldKey(world, JOURNAL_NAME);

  const info = el('span', 'shs-muted');
  const clearBtn = iconButton('Limpar journal', 'trash', { variant: 'danger', tip: 'Apaga o journal local' });
  clearBtn.type = 'button';
  const list = el('div', 'shs-tablewrap');

  function render(): void {
    const journal = gm.get<JournalEntry[]>(key, []);
    info.textContent = `${journal.length} evento(s) — teto ${JOURNAL_CAP}.`;
    clearBtn.disabled = journal.length === 0;
    list.replaceChildren();
    if (journal.length === 0) {
      list.appendChild(empty('Journal vazio — nenhum evento registrado ainda.'));
      return;
    }
    const rows = journal.map((entry) => [
      new Date(entry.ts).toLocaleString('pt-BR'),
      kindLabel(entry.kind),
      entry.nick,
      entry.ok ? 'OK' : 'ERRO',
      entry.detail,
    ]);
    list.appendChild(table(['Quando', 'Tipo', 'Destino', 'Resultado', 'Detalhe'], rows));
  }

  clearBtn.addEventListener('click', () => {
    const journal = gm.get<JournalEntry[]>(key, []);
    if (journal.length === 0) return;
    if (!window.confirm(`Apagar o journal local (${journal.length} evento(s))? Esta ação não pode ser desfeita.`)) return;
    gm.set(key, []);
    render();
  });

  const head = el('div', 'shs-row');
  head.appendChild(clearBtn);
  head.appendChild(info);
  const journalCard = card(cardTitle('list', 'Journal (últimas 500)'));
  journalCard.appendChild(head);
  journalCard.appendChild(list);
  render();
  return { node: journalCard, refresh: render };
}

/**
 * Seção "Reservas & MPs" do Staff Hub In-Game. Registrada com
 * matchScreen: undefined (aparece em qualquer tela do jogo — as mutações não
 * dependem da tela atual: o gateway TribalWars.post monta o URL e o h vem do DOM).
 */
export function renderSg6(container: HTMLElement): void {
  container.textContent = '';
  const header = el('div');
  header.appendChild(el('strong', undefined, 'Reservas & MPs'));
  header.appendChild(
    el('div', 'shs-muted', 'Mutações REAIS no jogo (modo real permanente): 1 tentativa por item, sem retry, pacing humano, journal local. Confira as duas confirmações antes de executar.'),
  );
  container.appendChild(header);
  // Guarda 5 — aviso PERMANENTE de triagem: o script NÃO bloqueia destinatários
  // fora da tribo (a triagem world:screen-recipients é exclusiva do Electron).
  // Mesmo texto de antes, agora no warnbox do design system.
  container.appendChild(el('div', 'shs-warnbox', 'Confira: destinatários fora da tribo NÃO são bloqueados no script'));

  const journalView = createJournalView();
  setupReservas(container, journalView.refresh);
  setupMps(container, journalView.refresh);
  container.appendChild(journalView.node);
}

// registro: coordinator → registerSection({ id:'sg6', label:'Reservas & MPs', render: renderSg6 })
