// Módulo "MPs (pré-preencher)" — visível em TODAS as telas, com ZERO envio
// automático: nenhum POST sai daqui (gamePost/net nem são importados). O
// Staff Hub gera as mensagens, abre a tela de nova mensagem do jogo com
// destino/assunto/corpo PRÉ-PREENCHIDOS e o HUMANO revisa e clica Enviar.
//
// Handoff entre páginas (o navegante perde o estado JS ao navegar):
//   1. "Abrir" grava a mensagem em GM storage 'shs-in-game:mp-pending'
//      e navega para game.php?…screen=mail&mode=new&player=<nick> (o jogo
//      preenche o destino; assunto/corpo NÃO passam por URL).
//   2. No boot seguinte, se screen=mail&mode=new e há pendência, preenche
//      o formulário, mostra o aviso "Pré-preenchido pelo Staff Hub…" e
//      limpa a pendência. A fila vive em 'shs-in-game:mp-queue' — uma
//      mensagem por navegação; ao voltar, a lista retoma na próxima linha.
//
// Seletores VERIFICADOS contra o fixture real tests/fixtures/br142/mail-new.html:
//   - destinatário: input#to[name="to"]  (class autocomplete, data-type=player)
//   - assunto:      #form input[name="subject"]
//   - corpo:        textarea#message[name="text"]
//   - o formulário de envio é <form id="form"> (action …mode=new&action=send…).
//
// Geração reusa os builders PUROS do app (@shared): o modo "Pacote da OP"
// passa pelo previewMps (mp-preview, mesma fonte horariosBlock do
// comms-package), que aplica o fail-closed de placeholders (#alvos#/#horarios#)
// — o mesmo contrato do buildPlayerComms/renderTemplate, sem exigir a agenda
// de envio (formatSendSchedule). O modo primário aceita as linhas prontas do
// SG_6: "nick;assunto;corpo" (uma MP por linha; ";" extras pertencem ao corpo).

import { previewMps } from '@shared/mp-preview';
import { gm } from '../core/storage';
import { icon } from '../core/icons';
import { licenseState } from '../core/license';
import { gameContext, registerSection } from '../core/shell';
import { card, cardTitle, el, empty, iconButton, pill } from '../core/ui';

/** Uma MP gerada, pronta para pré-preencher o formulário do jogo. */
interface MpMessage {
  nick: string;
  subject: string;
  body: string;
}

const PENDING_KEY = 'shs-in-game:mp-pending';
const QUEUE_KEY = 'shs-in-game:mp-queue';

/** Gramática "nick;alvo alvo …" — espelha DISTRIBUTION_LINE_RE do
 *  comms-package (não exportada de lá; manter em sincronia). */
const DISTRIBUTION_LINE_RE = /^([^;]{2,40});((?:\d{1,3}\|\d{1,3})(?:\s+\d{1,3}\|\d{1,3})*\s*)$/;

// ---------------------------------------------------------------------------
// Fila e pendência (GM storage — sobrevive à navegação do jogo)
// ---------------------------------------------------------------------------

function loadQueue(): MpMessage[] {
  return gm.get<MpMessage[]>(QUEUE_KEY, []);
}

function saveQueue(queue: MpMessage[]): void {
  if (queue.length === 0) gm.remove(QUEUE_KEY);
  else gm.set(QUEUE_KEY, queue);
}

// ---------------------------------------------------------------------------
// Geração (pura; fail-closed com erro claro em PT-BR, como os builders do app)
// ---------------------------------------------------------------------------

/** Modo primário: linhas "nick;assunto;corpo" do formato corrente do SG_6.
 *  Só os dois primeiros ";" separam — ";" extras ficam no corpo. Linhas
 *  vazias e comentários (#) são ignorados; linha torta aborta citando-a. */
function parseChainLines(text: string): MpMessage[] {
  const messages: MpMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const first = trimmed.indexOf(';');
    const second = first === -1 ? -1 : trimmed.indexOf(';', first + 1);
    if (first === -1 || second === -1) {
      throw new Error(`Linha inválida (use "nick;assunto;corpo"): "${trimmed.slice(0, 60)}"`);
    }
    const nick = trimmed.slice(0, first).trim();
    const subject = trimmed.slice(first + 1, second).trim();
    const body = trimmed.slice(second + 1).trim();
    if (nick.length < 2 || nick.length > 40) {
      throw new Error(`Nick inválido na linha (2–40 caracteres): "${trimmed.slice(0, 60)}"`);
    }
    if (body === '') {
      throw new Error(`Corpo vazio na linha de "${nick}" — a MP sairia sem texto.`);
    }
    messages.push({ nick, subject, body });
  }
  if (messages.length === 0) {
    throw new Error('Nenhuma linha informada — cole as linhas "nick;assunto;corpo".');
  }
  return messages;
}

/** Modo "Pacote da OP": assunto + corpo-template (#jogador#/#alvos#/#horarios#)
 *  + distribuição "nick;123|456 456|789" → UMA mensagem por jogador, gerada
 *  pelo previewMps (builder puro do app — prévia e mensagem nunca divergem). */
function generateFromDistribution(subject: string, template: string, distribution: string): MpMessage[] {
  const entries: { playerName: string; coords: string[] }[] = [];
  for (const line of distribution.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = DISTRIBUTION_LINE_RE.exec(trimmed);
    if (match === null) {
      throw new Error(`Linha de distribuição inválida (use "nick;123|456 456|789"): "${trimmed.slice(0, 60)}"`);
    }
    const coords = (match[2] ?? '').trim().split(/\s+/).filter((coord) => coord !== '');
    entries.push({ playerName: match[1] ?? '', coords });
  }
  if (entries.length === 0) {
    throw new Error('Nenhuma linha de distribuição informada — cole as linhas "nick;coords" da OP.');
  }
  // previewMps aplica o fail-closed do pacote: template sem #alvos#/#horarios#
  // e #horarios# sem horários abortam ANTES de qualquer mensagem ser gerada.
  return previewMps(subject.trim(), template, entries).map((entry) => ({
    nick: entry.playerName,
    subject: entry.subject,
    body: entry.body,
  }));
}

// ---------------------------------------------------------------------------
// Navegação com handoff
// ---------------------------------------------------------------------------

/** Compose do jogo para o destinatário (o parâmetro player preenche o "Para";
 *  assunto/corpo vão pelo GM storage, não por URL). */
function composeUrl(nick: string): string {
  const { villageId } = gameContext();
  const village = villageId === '—' ? '' : `village=${encodeURIComponent(villageId)}&`;
  return `${window.location.origin}/game.php?${village}screen=mail&mode=new&player=${encodeURIComponent(nick)}`;
}

/** Tira a mensagem da fila, grava como pendente e navega — o clique em
 *  "Enviar" continua sendo do humano, na tela do jogo. */
function openMessage(index: number): void {
  const queue = loadQueue();
  const message = queue[index];
  if (message === undefined) return;
  saveQueue(queue.filter((_, position) => position !== index));
  gm.set(PENDING_KEY, message);
  window.location.href = composeUrl(message.nick);
}

function copyMessage(message: MpMessage): Promise<void> {
  const text = message.subject === '' ? message.body : `${message.subject}\n\n${message.body}`;
  if (navigator.clipboard !== undefined) return navigator.clipboard.writeText(text);
  // Fallback (clipboard API indisponível): seleção + execCommand.
  return new Promise((resolve, reject) => {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (ok) resolve();
    else reject(new Error('Não foi possível copiar — selecione o texto manualmente.'));
  });
}

// ---------------------------------------------------------------------------
// Pós-navegação: preencher o formulário da tela mail&mode=new
// ---------------------------------------------------------------------------

function fillPendingOnMailNew(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('screen') !== 'mail' || params.get('mode') !== 'new') return;
  const pending = gm.get<MpMessage | null>(PENDING_KEY, null);
  if (pending === null) return;

  // Seletores conferidos contra tests/fixtures/br142/mail-new.html.
  const to = document.querySelector<HTMLInputElement>('input#to[name="to"]');
  const subject = document.querySelector<HTMLInputElement>('#form input[name="subject"]');
  const body = document.querySelector<HTMLTextAreaElement>('textarea#message[name="text"]');
  if (subject === null || body === null) {
    // Markup inesperado: mantém a pendência para tentar de novo na próxima
    // visita a mail&mode=new (nada é perdido, nada é enviado).
    console.warn('[Staff Hub] Formulário de MP não encontrado — pendência mantida.');
    return;
  }

  subject.value = pending.subject;
  body.value = pending.body;
  // Destino: a URL ?player= já pré-preenche; se não preencheu, garante aqui.
  if (to !== null && to.value.trim() === '') to.value = pending.nick;
  for (const field of [subject, body, to]) {
    field?.dispatchEvent(new Event('input', { bubbles: true })); // autosize/autocomplete do jogo
  }

  if (document.querySelector('.shs-mail-prefill-note') === null) {
    const note = document.createElement('div');
    // Fora do Shadow DOM o CSS do shell não alcança: classes shs-* + estilo inline.
    note.className = 'shs-muted shs-mail-prefill-note';
    note.setAttribute(
      'style',
      'margin:6px 0;padding:6px 8px;border:1px dashed #6b5d3f;border-radius:6px;' +
        'background:#efe5cc;color:#7a6b55;font-family:Verdana,Arial,sans-serif;font-size:12px;',
    );
    note.textContent = 'Pré-preenchido pelo Staff Hub — revise e clique Enviar.';
    const form = document.querySelector('#form');
    form?.parentNode?.insertBefore(note, form);
  }

  gm.remove(PENDING_KEY);
}

// ---------------------------------------------------------------------------
// Seção do shell (renderiza no Shadow DOM — aí sim o CSS shs-* do shell vale)
// ---------------------------------------------------------------------------

function renderQueueList(container: HTMLElement, status: HTMLElement): void {
  container.innerHTML = '';
  const queue = loadQueue();
  // Cabeçalho do cartão da fila: contagem + ações + linha de status (o status
  // mora AQUI, dentro do cartão — não flutuando fora dele).
  const head = document.createElement('div');
  head.className = 'shs-row';
  const label = document.createElement('strong');
  label.textContent = queue.length === 1 ? '1 mensagem na fila' : `${queue.length} mensagens na fila`;
  head.appendChild(label);
  if (queue.length > 0) {
    const skip = iconButton('Pular esta', 'trash', { variant: 'danger', small: true, tip: 'Remover da fila' });
    skip.addEventListener('click', () => {
      const current = loadQueue();
      const [dropped] = current;
      saveQueue(current.slice(1));
      status.className = 'shs-muted';
      status.textContent = dropped === undefined ? '' : `Mensagem de "${dropped.nick}" pulada.`;
      renderQueueList(container, status);
    });
    const cancel = iconButton('Cancelar fila', 'x', {
      variant: 'danger',
      small: true,
      tip: 'Descartar todas as mensagens',
    });
    cancel.addEventListener('click', () => {
      if (window.confirm('Cancelar a fila inteira? Todas as mensagens geradas serão descartadas.')) {
        saveQueue([]);
        status.className = 'shs-muted';
        status.textContent = 'Fila cancelada.';
        renderQueueList(container, status);
      }
    });
    head.appendChild(skip);
    head.appendChild(cancel);
  }
  head.appendChild(status);
  container.appendChild(head);

  if (queue.length === 0) {
    container.appendChild(
      empty('Nenhuma mensagem na fila — gere acima. Nada é enviado: você revisa e clica Enviar no jogo.'),
    );
    return;
  }

  for (const [index, message] of queue.entries()) {
    const row = document.createElement('div');
    row.className = 'shs-row';
    row.appendChild(el('span', { className: 'shs-muted', text: `${index + 1}.` }));
    row.appendChild(pill(message.nick));
    const open = iconButton('Abrir', 'arrowRight', {
      small: true,
      tip: 'Abre a MP no jogo para revisar e enviar',
    });
    open.addEventListener('click', () => openMessage(index));
    row.appendChild(open);
    const copy = iconButton('Copiar', 'copy', { variant: 'ghost', small: true, tip: 'Copiar o texto da mensagem' });
    copy.addEventListener('click', () => {
      copyMessage(message)
        .then(() => {
          copy.replaceChildren(icon('check'), document.createTextNode('Copiado!'));
          setTimeout(() => {
            copy.replaceChildren(icon('copy'), document.createTextNode('Copiar'));
          }, 1200);
        })
        .catch((error: unknown) => {
          status.className = 'shs-danger';
          status.textContent = error instanceof Error ? error.message : String(error);
        });
    });
    row.appendChild(copy);
    const preview = document.createElement('span');
    preview.className = 'shs-muted';
    preview.textContent = message.subject === '' ? '(sem assunto)' : message.subject;
    row.appendChild(preview);
    container.appendChild(row);
  }

  const hint = document.createElement('div');
  hint.className = 'shs-muted';
  hint.textContent =
    'Uma mensagem por navegação: clique Abrir, revise no jogo e envie; ao voltar, a fila retoma na próxima linha.';
  container.appendChild(hint);
}

function renderMailSection(container: HTMLElement): void {
  container.innerHTML = ''; // idempotente: reabrir o painel não duplica o formulário
  const intro = document.createElement('div');
  intro.className = 'shs-muted';
  intro.textContent =
    'Pré-preenche as MPs na tela do jogo — o envio é SEMPRE manual (nenhum POST aqui). ' +
    'Gere por linhas prontas do SG_6 ou pelo pacote da OP.';
  container.appendChild(intro);

  // Cartão do gerador: modo + entradas + botão Gerar.
  const formCard = card(cardTitle('send', 'Gerador de MPs'));
  container.appendChild(formCard);

  const modeRow = document.createElement('div');
  modeRow.className = 'shs-row';
  const modeLabel = document.createElement('span');
  modeLabel.textContent = 'Modo:';
  const modeSelect = document.createElement('select');
  const chainOption = new Option('Linhas prontas (nick;assunto;corpo)', 'chain');
  const packOption = new Option('Pacote da OP (nick;alvos + template)', 'pack');
  modeSelect.add(chainOption);
  modeSelect.add(packOption);
  modeSelect.className = 'shs-input';
  modeSelect.style.width = 'auto';
  modeRow.appendChild(modeLabel);
  modeRow.appendChild(modeSelect);
  formCard.appendChild(modeRow);

  // Modo A — linhas prontas do SG_6.
  const chainBox = document.createElement('div');
  const chainArea = document.createElement('textarea');
  chainArea.className = 'shs-input';
  chainArea.rows = 6;
  chainArea.placeholder = 'fulano;Assunto da MP;Corpo da mensagem, pode ter ; e quebras…\nbeltrano;Assunto;Outro corpo';
  chainBox.appendChild(chainArea);
  formCard.appendChild(chainBox);

  // Modo B — pacote da OP (assunto + template + distribuição).
  const packBox = document.createElement('div');
  packBox.style.display = 'none';
  const subjectInput = document.createElement('input');
  subjectInput.className = 'shs-input';
  subjectInput.placeholder = 'Assunto (ex.: OP Ferrovias do Norte — suas alvos)';
  const templateArea = document.createElement('textarea');
  templateArea.className = 'shs-input';
  templateArea.rows = 5;
  templateArea.placeholder =
    'Corpo com placeholders: #jogador#, #alvos# e/ou #horarios# — cada jogador recebe os dados dele.';
  const distributionArea = document.createElement('textarea');
  distributionArea.className = 'shs-input';
  distributionArea.rows = 5;
  distributionArea.placeholder = 'fulano;123|456 456|789\nbeltrano;234|567';
  packBox.appendChild(subjectInput);
  packBox.appendChild(templateArea);
  packBox.appendChild(distributionArea);
  formCard.appendChild(packBox);

  modeSelect.addEventListener('change', () => {
    const chain = modeSelect.value === 'chain';
    chainBox.style.display = chain ? '' : 'none';
    packBox.style.display = chain ? 'none' : '';
  });

  const actions = document.createElement('div');
  actions.className = 'shs-row';
  const generate = iconButton('Gerar mensagens', 'plus', { tip: 'Gera as mensagens e encaixa na fila' });
  const status = document.createElement('span');
  status.className = 'shs-muted';
  actions.appendChild(generate);
  formCard.appendChild(actions);

  generate.addEventListener('click', () => {
    status.className = 'shs-muted';
    status.textContent = '';
    let messages: MpMessage[];
    try {
      messages =
        modeSelect.value === 'chain'
          ? parseChainLines(chainArea.value)
          : generateFromDistribution(subjectInput.value, templateArea.value, distributionArea.value);
    } catch (error) {
      status.className = 'shs-danger';
      status.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    const current = loadQueue();
    if (current.length > 0 && !window.confirm(`Já existem ${current.length} mensagem(ns) na fila — substituir?`)) {
      return;
    }
    saveQueue(messages);
    status.className = 'shs-ok';
    status.textContent = `${messages.length} mensagem(ns) gerada(s).`;
    renderQueueList(queueBox, status);
  });

  // Cartão da fila: cabeçalho (contagem + ações + status) e linhas por mensagem.
  const queueCard = card(cardTitle('list', 'Fila de MPs'));
  container.appendChild(queueCard);
  const queueBox = document.createElement('div');
  queueCard.appendChild(queueBox);
  renderQueueList(queueBox, status);
}

// Autorregistro (importado por main.ts): seção global + fill pós-navegação.
registerSection({ id: 'mp', label: 'MPs (pré-preencher)', icon: 'mail', render: renderMailSection });
// O fill pré-licença era brecha (P3 da revisão): só preenche com licença válida/graça.
if (licenseState().kind !== 'ausente') fillPendingOnMailNew();
