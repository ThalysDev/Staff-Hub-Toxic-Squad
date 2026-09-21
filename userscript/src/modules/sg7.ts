// SG_7 — Blindagem no fórum (aba do Staff Hub In-Game na screen=forum).
// Espelho do fluxo do app (src/main/mutations/sg7-service.ts + Sg7Page):
// - "Conferenciar tópico": lê os posts DA PÁGINA ABERTA (DOM atual) com os
//   parsers do fórum, reconhece os comentários "pedido/valores" (sg7-engine)
//   e abre o formulário de edição do 1º post para pegar o BBCode fonte.
// - Mutações REAIS via gamePost (gateway do jogo, 1 tentativa, SEM retry),
//   cada uma com confirmação dupla (window.confirm com o texto exato da
//   consequência): editar a tabela do 1º post e apagar os comentários
//   processados (1 gamePost por comentário, pacing da core/net).
// - Débito de blind por jogador (blind-debt) + última conferência persistidos
//   em GM storage por threadId: worldKey(world, `blind:<threadId>`) e
//   worldKey(world, `blind-last:<threadId>`).

import { gamePost, pacedGet } from '../core/net';
import { gameContext } from '../core/shell';
import { gm, worldKey } from '../core/storage';
import {
  decodeHtmlEntities,
  parseEditForm,
  parseForumThread,
  type EditFormDetails,
} from '@shared/parsers/forum-parsers';
import {
  applyBlindUpdate,
  parseBlindTable,
  recognizeComments,
  recognizedSummary,
  sumByPedido,
  type PedidoSum,
} from '@shared/sg7-engine';
import {
  blindBalance,
  mergeBlindDebtRound,
  type BlindDebtEntry,
  type BlindDebtRoundEntry,
} from '@shared/blind-debt';

// ---------------------------------------------------------------------------
// Tipos locais
// ---------------------------------------------------------------------------

/** Linha da rodada de débito da conferência (mesma forma da Sg7Page; `pedido`
 * é interno — liga a linha à linha da tabela para aplicar o diff do ajuste). */
interface DebtRoundRow {
  pedido: number;
  playerName: string;
  requested: number;
  sent: number;
}

/** Última conferência persistida por threadId (tudo JSON-safe). */
interface ConferenceSnapshot {
  at: string;
  threadId: number;
  firstPostId: number;
  /** BBCode fonte do 1º post na hora da conferência (base do diff do ajuste). */
  firstPostMessage: string;
  /** Resumo "pedido/valores" reconhecido (formato colocado pelos membros). */
  recognized: string;
  /** BBCode da tabela com os envios subtraídos (prévia do ajuste). */
  updatedMessage: string;
  /** false quando o ajuste já foi aplicado (ou nada mudou). */
  changed: boolean;
  /** Posts com comentários reconhecidos (fila da exclusão). */
  recognizedPostIds: number[];
  sums: PedidoSum[];
  round: DebtRoundRow[];
}

// ---------------------------------------------------------------------------
// Detecção do tópico e leitura
// ---------------------------------------------------------------------------

/** Contexto do tópico aberto (URL da página): thread_id + forum_id da URL. */
export function detectThreadContext(): { threadId: number; forumId: string } | null {
  const params = new URLSearchParams(window.location.search);
  const threadId = Number(params.get('thread_id'));
  if (!Number.isFinite(threadId) || threadId <= 0) return null;
  return { threadId, forumId: params.get('forum_id') ?? '0' };
}

/** Abre o formulário de edição do post (BBCode fonte + action exata do jogo).
 * Mesmos params do sg7-service.openEditForm. Leitura sempre fresh (o cache de
 * 60s da core/net não pode devolver formulário de antes de uma mutação). */
async function openEditForm(threadId: number, postId: number, forumId: string): Promise<EditFormDetails> {
  const html = await pacedGet(
    `game.php?screen=forum&screenmode=view_thread&thread_id=${threadId}&edit_post_id=${postId}&page=0&forum_id=${forumId}`,
    { fresh: true },
  );
  return parseEditForm(html);
}

/** Faltas totais publicadas numa linha da tabela (o que o pedido ainda pede). */
function missingTotal(missing: { spear?: number; sword?: number; archer?: number }): number {
  return (missing.spear ?? 0) + (missing.sword ?? 0) + (missing.archer ?? 0);
}

/** Rodada de débito da conferência: 1 linha por pedido reconhecido COM linha na
 * tabela (identidade = aldeia do pedido; requested = faltas publicadas). */
function buildDebtRound(firstPostMessage: string, sums: PedidoSum[]): DebtRoundRow[] {
  const tableRows = new Map(parseBlindTable(firstPostMessage).map((row) => [row.pedido, row]));
  const round: DebtRoundRow[] = [];
  for (const sum of sums) {
    const row = tableRows.get(sum.pedido);
    if (row === undefined) continue; // reconhecido sem linha na tabela: o ajuste nunca toca
    round.push({
      pedido: sum.pedido,
      playerName: row.villageLabel.trim().slice(0, 40) || `Pedido ${sum.pedido}`,
      requested: missingTotal(row.missing),
      sent: 0,
    });
  }
  return round;
}

/** Conferência: posts da página aberta (DOM) + BBCode do 1º post (formulário). */
async function conferThread(forumId: string): Promise<ConferenceSnapshot> {
  const html = document.documentElement.outerHTML;
  const thread = parseForumThread(html);
  const firstPost = thread.posts[0];
  if (firstPost === undefined) throw new Error('Tópico sem posts.');
  const comments = recognizeComments(thread.posts.slice(1));
  const sums = sumByPedido(comments);
  // BBCode fonte do 1º post vem do FORMULÁRIO de edição (a leitura renderiza HTML).
  const form = await openEditForm(thread.threadId, firstPost.postId, forumId);
  const updatedMessage = applyBlindUpdate(form.message, sums);
  return {
    at: new Date().toISOString(),
    threadId: thread.threadId,
    firstPostId: firstPost.postId,
    firstPostMessage: form.message,
    recognized: recognizedSummary(sums),
    updatedMessage,
    changed: updatedMessage !== form.message,
    recognizedPostIds: [...new Set(comments.map((comment) => comment.postId))],
    sums,
    round: buildDebtRound(form.message, sums),
  };
}

/** Enviado por pedido = diff das faltas do 1º post → tabela atualizada
 * (mesma métrica da Sg7Page.appliedByPedido — o que o ajuste aplicou). */
function appliedByPedido(snapshot: ConferenceSnapshot): Map<number, number> {
  const before = new Map(
    parseBlindTable(snapshot.firstPostMessage).map((row) => [row.pedido, missingTotal(row.missing)]),
  );
  const applied = new Map<number, number>();
  for (const row of parseBlindTable(snapshot.updatedMessage)) {
    const sent = (before.get(row.pedido) ?? 0) - missingTotal(row.missing);
    if (sent > 0) applied.set(row.pedido, sent);
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Helpers de DOM (classes shs-* do shell; nada de innerHTML com dados do jogo)
// ---------------------------------------------------------------------------

const INT_FMT = new Intl.NumberFormat('pt-BR');

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function elButton(label: string, className: string, onClick: () => Promise<void> | void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener('click', () => {
    void onClick();
  });
  return btn;
}

function elTable(headers: string[], rows: string[][]): HTMLTableElement {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of headers) headRow.appendChild(el('th', undefined, header));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const cells of rows) {
    const tr = document.createElement('tr');
    for (const cell of cells) tr.appendChild(el('td', undefined, cell));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function elPre(text: string): HTMLPreElement {
  const pre = document.createElement('pre');
  pre.textContent = text;
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.wordBreak = 'break-word';
  return pre;
}

// ---------------------------------------------------------------------------
// Aba "Blindagem" (SG_7)
// ---------------------------------------------------------------------------

export function renderSg7(container: HTMLElement): void {
  container.innerHTML = '';

  const head = el('div', 'shs-row');
  head.appendChild(el('strong', undefined, 'Blindagem (SG_7)'));
  container.appendChild(head);

  const ctx = detectThreadContext();
  if (ctx === null) {
    container.appendChild(
      el('p', 'shs-muted', 'Abra um tópico do fórum de blindagem (screen=forum&screenmode=view_thread) para conferir.'),
    );
    return;
  }
  // Locais não-nulos (o narrowing de `ctx` não entra nas closures abaixo).
  const threadId = ctx.threadId;
  const forumId = ctx.forumId;

  const world = gameContext().world;
  const ledgerKey = worldKey(world, `blind:${threadId}`); // débito acumulado do tópico
  const lastKey = worldKey(world, `blind-last:${threadId}`); // última conferência

  const sub = el('div', 'shs-row');
  sub.appendChild(el('span', 'shs-muted', `Tópico #${threadId} · fórum ${forumId} — a conferência lê os posts da página aberta (paginação do jogo).`));
  container.appendChild(sub);

  const controls = el('div', 'shs-row');
  const status = el('span', 'shs-muted');
  const conferBtn = elButton('Conferenciar tópico', 'shs-btn', () => runConference());
  controls.appendChild(conferBtn);
  controls.appendChild(status);
  container.appendChild(controls);

  const resultBox = el('div');
  container.appendChild(resultBox);

  const ledgerBox = el('div');
  container.appendChild(ledgerBox);

  /** Snapshot corrente (hidratado do GM storage na abertura da aba). */
  let snapshot: ConferenceSnapshot | null = gm.get<ConferenceSnapshot | null>(lastKey, null);
  if (snapshot !== null && snapshot.threadId !== threadId) snapshot = null;

  async function runConference(): Promise<void> {
    conferBtn.disabled = true;
    status.textContent = 'Conferindo posts…';
    try {
      snapshot = await conferThread(forumId);
      gm.set(lastKey, snapshot);
      status.textContent = `Última conferência: ${new Date(snapshot.at).toLocaleString('pt-BR')}.`;
      renderResult();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      conferBtn.disabled = false;
    }
  }

  // --- MUTAÇÃO 1: editar a tabela do 1º post (espelho do sg7-service.adjust) ---
  async function runAdjust(current: ConferenceSnapshot): Promise<void> {
    if (
      !window.confirm(
        `Blindagem 1/2 — atualizar a tabela do PRIMEIRO POST do tópico ${current.threadId}? ` +
          'O post da tabela será sobrescrito com o conteúdo da prévia exibida. Revise a prévia antes de continuar.',
      )
    ) {
      return;
    }
    if (
      !window.confirm(
        'Blindagem 2/2 — CONFIRMAÇÃO FINAL: executar a edição REAL do primeiro post no fórum do jogo? ' +
          'Ação destrutiva (sobrescreve o conteúdo atual do post), UMA única tentativa, sem repetição automática — não pode ser desfeita.',
      )
    ) {
      return;
    }
    setMutationStatus('Atualizando a tabela do 1º post…');
    try {
      // Action EXATA que o jogo espera: reabre o formulário e reusa os params
      // da action (village/thread_id/edit_post_id/post_id/page/forum_id) —
      // o corpo leva message/do/current_page/send, como o sg7-service.
      const form = await openEditForm(current.threadId, current.firstPostId, forumId);
      const fields: Record<string, string> = {};
      const query = form.action.includes('?') ? form.action.slice(form.action.indexOf('?') + 1) : '';
      for (const [key, value] of new URLSearchParams(query)) {
        if (key !== 'h' && key !== 'screen' && key !== 'action') fields[key] = value;
      }
      fields.message = current.updatedMessage;
      fields.do = form.doValue;
      fields.current_page = form.currentPage;
      fields.send = 'Enviar';
      await gamePost('forum', 'edit_post', fields); // 1 tentativa, sem retry
      // Verificação REAL (leitura): reabre o formulário e compara o BBCode gravado.
      const check = await openEditForm(current.threadId, current.firstPostId, forumId);
      const verified = decodeHtmlEntities(check.message).trim() === current.updatedMessage.trim();
      const applied = appliedByPedido(current);
      current.changed = false;
      current.round = current.round.map((row) => ({ ...row, sent: applied.get(row.pedido) ?? row.sent }));
      gm.set(lastKey, current);
      renderResult();
      setMutationStatus(
        verified
          ? 'Tabela do 1º post atualizada (verificado).'
          : 'Envio aceito, mas o post NÃO refletiu o novo conteúdo — confira manualmente.',
        verified,
      );
    } catch (error) {
      setMutationStatus(`Falha no ajuste (nada reenviado): ${error instanceof Error ? error.message : String(error)}`, false);
    }
  }

  // --- MUTAÇÃO 2: apagar os comentários processados (sg7-service.deletePosts) ---
  async function runDelete(current: ConferenceSnapshot): Promise<void> {
    const total = current.recognizedPostIds.length;
    if (total === 0) return;
    if (
      !window.confirm(
        `Blindagem 1/2 — remover os ${total} comentário(s) processado(s) do tópico ${current.threadId}? ` +
          'Cada comentário reconhecido será EXCLUÍDO do fórum (1 requisição por comentário, com pausa entre elas).',
      )
    ) {
      return;
    }
    if (
      !window.confirm(
        `Blindagem 2/2 — você realmente deseja excluir as ${total} mensagem(ns) selecionadas? ` +
          'CONFIRMAÇÃO FINAL: exclusão REAL no fórum, UMA tentativa por mensagem, sem repetição — não pode ser desfeita.',
      )
    ) {
      return;
    }
    setMutationStatus(`Removendo ${total} comentário(s)…`);
    const targets = [...current.recognizedPostIds];
    const failures: string[] = [];
    for (const postId of targets) {
      try {
        // Mesmos campos do fluxo del_posts do sg7-service (chk_del_posts[] +
        // submit_del_posts); h vai injetado pelo gamePost. 1 post por chamada.
        await gamePost('forum', 'del_posts', {
          screenmode: 'view_thread',
          thread_id: String(current.threadId),
          page: '0',
          forum_id: forumId,
          'chk_del_posts[]': String(postId),
          submit_del_posts: 'Apagar mensagens',
        });
      } catch (error) {
        // Sem retry: para no 1º erro e reporta o que ficou pendente.
        failures.push(`Post #${postId}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    // Verificação REAL: relê a última página do tópico e confere o que sumiu.
    let remaining = targets;
    try {
      const after = await pacedGet(
        `game.php?screen=forum&screenmode=view_thread&thread_id=${current.threadId}&forum_id=${forumId}&page=last`,
        { fresh: true },
      );
      const ids = new Set(targets);
      remaining = parseForumThread(after).posts.filter((post) => ids.has(post.postId)).map((post) => post.postId);
    } catch {
      // Verificação indisponível: assume o que não falhou explicitamente.
      remaining = failures.length > 0 ? targets : [];
    }
    current.recognizedPostIds = remaining;
    gm.set(lastKey, current);
    renderResult();
    const deleted = total - remaining.length;
    const detail =
      failures.length > 0
        ? `Removidos ${deleted} de ${total} — parou sem repetir em: ${failures[0] ?? ''}`
        : `Removidos ${deleted} de ${total} comentário(s) processado(s).`;
    setMutationStatus(detail, failures.length === 0 && remaining.length === 0);
  }

  const mutationStatus = el('div', 'shs-row');
  resultBox.appendChild(mutationStatus);

  function setMutationStatus(text: string, ok = true): void {
    mutationStatus.innerHTML = '';
    mutationStatus.appendChild(el('span', ok ? 'shs-ok' : 'shs-danger', text));
  }

  function renderResult(): void {
    renderLedger();
    resultBox.innerHTML = '';
    resultBox.appendChild(mutationStatus);
    if (snapshot === null) return;
    const current = snapshot;

    const summary = el('div', 'shs-row');
    summary.appendChild(el('span', 'shs-ok', `${current.sums.length} pedidos processados`));
    summary.appendChild(el('span', 'shs-muted', `${current.recognizedPostIds.length} post(s) com comentários reconhecidos.`));
    resultBox.appendChild(summary);

    resultBox.appendChild(el('div', 'shs-row', 'Pedidos reconhecidos somados (formato dos comentários)'));
    resultBox.appendChild(elPre(current.recognized === '' ? 'Nenhum comentário no formato reconhecido.' : current.recognized));

    // Tabela da blindagem: o que os comentários pediram, por pedido.
    resultBox.appendChild(el('div', 'shs-row', 'Blindagem pedida (dos comentários)'));
    const tableRows = new Map(parseBlindTable(current.firstPostMessage).map((row) => [row.pedido, row]));
    const rows = current.sums.map((sum) => [
      tableRows.get(sum.pedido)?.villageLabel ?? `Pedido ${sum.pedido}`,
      INT_FMT.format(sum.values[0] ?? 0),
      INT_FMT.format(sum.values[1] ?? 0),
      INT_FMT.format(sum.values[2] ?? 0),
      INT_FMT.format(sum.values[3] ?? 0), // 4º campo do formato estendido da tribo
    ]);
    resultBox.appendChild(
      elTable(['Aldeia', 'Lanceiros', 'Espadachins', 'Arqueiros', 'Arqueiros cav'], rows),
    );

    resultBox.appendChild(el('div', 'shs-row', 'Tabela atualizada (prévia do BBCode)'));
    resultBox.appendChild(elPre(current.updatedMessage));

    const mutations = el('div', 'shs-row');
    const adjustBtn = elButton('Atualizar tabela do 1º post', 'shs-btn', () => runAdjust(current));
    adjustBtn.disabled = !current.changed;
    mutations.appendChild(adjustBtn);
    const deleteBtn = elButton(
      `Remover comentários processados (${current.recognizedPostIds.length})`,
      'shs-btn',
      () => runDelete(current),
    );
    deleteBtn.disabled = current.recognizedPostIds.length === 0;
    mutations.appendChild(deleteBtn);
    resultBox.appendChild(mutations);

    if (current.round.length > 0) {
      const pending = el('div', 'shs-row');
      const totalRequested = current.round.reduce((sum, row) => sum + row.requested, 0);
      const totalSent = current.round.reduce((sum, row) => sum + row.sent, 0);
      pending.appendChild(
        el(
          'span',
          'shs-muted',
          `Rodada da conferência: ${current.round.length} jogador(es) · pediu ${INT_FMT.format(totalRequested)} · enviou ${INT_FMT.format(totalSent)}.`,
        ),
      );
      pending.appendChild(
        elButton('Somar esta rodada ao débito', 'shs-btn', () => {
          mergeRound(current);
        }),
      );
      resultBox.appendChild(pending);
    }
  }

  /** Mescla a rodada reconhecida no débito acumulado (storage local — sem POST). */
  function mergeRound(current: ConferenceSnapshot): void {
    const round: BlindDebtRoundEntry[] = current.round.map((row) => ({
      playerName: row.playerName,
      requested: row.requested,
      sent: row.sent,
    }));
    const merged = mergeBlindDebtRound(gm.get<BlindDebtEntry[]>(ledgerKey, []), round, new Date());
    gm.set(ledgerKey, merged);
    current.round = [];
    gm.set(lastKey, current);
    renderResult();
  }

  function renderLedger(): void {
    ledgerBox.innerHTML = '';
    const entries = gm.get<BlindDebtEntry[]>(ledgerKey, []);
    const headRow = el('div', 'shs-row');
    headRow.appendChild(el('strong', undefined, 'Débito de blind do tópico'));
    if (entries.length > 0) {
      headRow.appendChild(
        elButton('Zerar débito', 'shs-btn shs-btn-ghost', () => {
          if (!window.confirm(`Zerar o débito de blind dos ${entries.length} jogador(es) deste tópico? Esta ação não pode ser desfeita.`)) return;
          gm.set(ledgerKey, []);
          renderLedger();
        }),
      );
    }
    ledgerBox.appendChild(headRow);
    if (entries.length === 0) {
      ledgerBox.appendChild(el('p', 'shs-muted', 'Nenhuma rodada somada ainda — conferencie o tópico e some a rodada.'));
      return;
    }
    const rows = entries.map((entry) => {
      const balance = blindBalance(entry);
      const saldo =
        balance > 0
          ? `${INT_FMT.format(balance)} (deve)`
          : balance < 0
            ? `${INT_FMT.format(balance)} (credor)`
            : `${INT_FMT.format(balance)} (em dia)`;
      return [entry.playerName, INT_FMT.format(entry.requested), INT_FMT.format(entry.sent), saldo];
    });
    ledgerBox.appendChild(elTable(['Jogador', 'Pediu', 'Enviou', 'Saldo'], rows));
  }

  if (snapshot !== null) {
    status.textContent = `Última conferência: ${new Date(snapshot.at).toLocaleString('pt-BR')}.`;
    renderResult();
  } else {
    renderLedger();
  }
}

// registro: coordinator adiciona em main.ts → registerSection({ id:'sg7', label:'Blindagem', matchScreen:'forum', render: renderSg7 })
