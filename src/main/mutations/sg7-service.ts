import { session } from 'electron';
import { TW_PARTITION, type TwSessionManager } from '../tw/session';
import type { Journal } from '../journal';
import { forumTokens, parseEditForm, parseForumThread } from '@shared/parsers/forum-parsers';
import { applyBlindUpdate, recognizeComments, recognizedSummary, sumByPedido } from '@shared/sg7-engine';
import { detectPageSentinels } from '../tw/request-queue';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ForumConferenceResult {
  threadId: number;
  /** Texto (BBCode fonte) do primeiro post — base do ajuste. */
  firstPostMessage: string;
  recognized: string;
  updatedMessage: string;
  changed: boolean;
  /** Posts com comentários reconhecidos (para "Apagar mensagens"). */
  recognizedPostIds: number[];
}

/**
 * Blindagem no fórum (SG_7): conferência dos posts + ajuste do post da tabela.
 * MUTAÇÃO no ajuste: confirmação dupla, 1 tentativa, journal. Modo real
 * permanente (AGENTS.md) — sem dry-run. A conferência em si é leitura.
 */
export class Sg7Service {
  constructor(
    private readonly twSession: TwSessionManager,
    private readonly journal: Journal,
  ) {
  }

  private world(): string {
    const { state, world } = this.twSession.getStatus();
    if (state !== 'logged-in' || world === null) {
      throw new Error('Nenhuma sessão ativa no jogo — faça login antes de usar o fórum.');
    }
    return world;
  }

  private lastFetchAt = 0;

  /** GET com pacing humano + sentinela de sessão/captcha (detect-pause-notify). */
  private async getHtml(path: string): Promise<string> {
    const world = this.world();
    const elapsed = Date.now() - this.lastFetchAt;
    if (elapsed < 350) await sleep(350 - elapsed);
    this.lastFetchAt = Date.now();
    const result = await this.twSession.fetchForQueue(`https://${world}.tribalwars.com.br/${path}`);
    if (!result.ok) throw new Error(`HTTP ${result.status} ao abrir ${path}`);
    const sentinel = detectPageSentinels(result.body);
    if (sentinel === 'session-expired') throw new Error('Sessão expirada — faça login novamente.');
    if (sentinel === 'captcha-suspected') throw new Error('Captcha detectado — resolva na janela de login.');
    return result.body;
  }

  /** Abre o formulário de edição do primeiro post (BBCode fonte + action exata). */
  private async openEditForm(threadId: number, postId: number, forumId: number): Promise<{ html: string; form: ReturnType<typeof parseEditForm> }> {
    const html = await this.getHtml(
      `game.php?screen=forum&screenmode=view_thread&thread_id=${threadId}&edit_post_id=${postId}&page=0&forum_id=${forumId}`,
    );
    return { html, form: parseEditForm(html) };
  }

  /** Lê o tópico (page=last) e roda a conferência sobre os posts. */
  async conference(threadUrl: string): Promise<ForumConferenceResult> {
    const world = this.world();
    if (!threadUrl.includes(`${world}.tribalwars.com.br`)) {
      throw new Error(`A URL do tópico deve apontar para ${world}.tribalwars.com.br — a sessão atual é do mundo ${world}.`);
    }
    const path = threadUrl.replace(/^https?:\/\/[^/]+\//, '');
    const pathLast = path.replace(/[?&]page=[^&]*/g, '').replace(/\?$/, '');
    const html = await this.getHtml(`${pathLast}${pathLast.includes('?') ? '&' : '?'}page=last`);
    const thread = parseForumThread(html);
    const firstPost = thread.posts[0];
    if (firstPost === undefined) throw new Error('Tópico sem posts.');
    const forumId = /forum_id=(\d+)/.exec(path)?.[1] ?? '0';

    // BBCode fonte do primeiro post vem do FORMULÁRIO de edição (a leitura
    // renderiza HTML); 1 GET extra.
    const { form } = await this.openEditForm(thread.threadId, firstPost.postId, Number(forumId));
    const firstPostMessage = form.message;

    const comments = recognizeComments(thread.posts.slice(1));
    const sums = sumByPedido(comments);
    const updated = applyBlindUpdate(firstPostMessage, sums);
    await this.journal.append('read', 'sg7-conference', `thread=${thread.threadId} reconhecidos=${sums.length}`, true);
    return {
      threadId: thread.threadId,
      firstPostMessage,
      recognized: recognizedSummary(sums),
      updatedMessage: updated,
      changed: updated !== firstPostMessage,
      recognizedPostIds: [...new Set(comments.map((comment) => comment.postId))],
    };
  }

  /** MUTAÇÃO: aplica o BBCode atualizado no primeiro post (Ajustar Conforme Script). */
  async adjust(threadUrl: string, confirm: boolean): Promise<{ ok: boolean; detail: string }> {
    if (!confirm) throw new Error('Confirmação dupla necessária — revise a conferência e confirme na tela.');
    const conference = await this.conference(threadUrl);
    if (!conference.changed) {
      return { ok: true, detail: 'Nada a ajustar — nenhum envio reconhecido altera a tabela.' };
    }
    const path = threadUrl.replace(/^https?:\/\/[^/]+\//, '');
    const forumId = /forum_id=(\d+)/.exec(path)?.[1] ?? '0';
    // Recarrega o tópico para pegar o primeiro post + abre o formulário com a
    // action EXATA que o jogo espera (edit_post_id + post_id + forum_id + h).
    const html = await this.getHtml(path);
    const thread = parseForumThread(html);
    const firstPost = thread.posts[0];
    if (firstPost === undefined) throw new Error('Tópico sem posts.');
    const { form } = await this.openEditForm(thread.threadId, firstPost.postId, Number(forumId));
    const world = this.world();
    const ses = session.fromPartition(TW_PARTITION);
    await sleep(350 + Math.random() * 250);
    const body = new URLSearchParams({
      message: conference.updatedMessage,
      do: form.doValue,
      'current_page': form.currentPage,
      send: 'Enviar',
    }).toString();
    const response = await ses.fetch(`https://${world}.tribalwars.com.br/${form.action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'follow',
    });
    // Verificação REAL: reabre o formulário e confere o BBCode gravado.
    let ok = response.ok;
    let detail = ok ? 'Post da tabela atualizado (verificado).' : `HTTP ${response.status}`;
    if (ok) {
      const check = await this.openEditForm(thread.threadId, firstPost.postId, Number(forumId));
      if (check.form.message.trim() !== conference.updatedMessage.trim()) {
        ok = false;
        detail = 'Envio aceito, mas o post NÃO refletiu o novo conteúdo — confira manualmente.';
      }
    }
    await this.journal.append('mutation', 'forum-adjust', `thread=${conference.threadId} → ${detail}`, false);
    return { ok, detail };
  }

  /**
   * MUTAÇÃO: apaga os posts informados (moderação "Apagar mensagens").
   * Confirmação dupla + journal; 1 tentativa; verificação real
   * (relê o tópico e confere que os posts sumiram).
   */
  async deletePosts(threadUrl: string, postIds: number[], confirm: boolean): Promise<{ ok: boolean; detail: string }> {
    if (!confirm) throw new Error('Confirmação dupla necessária — selecione os posts e confirme na tela.');
    if (postIds.length === 0) throw new Error('Nenhum post selecionado.');
    const pathLast = threadUrl.replace(/^https?:\/\/[^/]+\//, '');
    const html = await this.getHtml(pathLast);
    const thread = parseForumThread(html);
    const forumId = /forum_id=(\d+)/.exec(pathLast)?.[1] ?? '0';
    const { csrf } = forumTokens(html);
    const body = new URLSearchParams();
    for (const postId of postIds) body.append('chk_del_posts[]', String(postId));
    body.append('submit_del_posts', 'Apagar mensagens');
    const world = this.world();
    const ses = session.fromPartition(TW_PARTITION);
    await sleep(350 + Math.random() * 250);
    const response = await ses.fetch(
      `https://${world}.tribalwars.com.br/game.php?screen=forum&screenmode=view_thread&action=del_posts&thread_id=${thread.threadId}&page=0&forum_id=${forumId}&h=${csrf}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'follow' },
    );
    // Verificação real: os posts não podem mais aparecer no tópico.
    await sleep(350);
    let ok = response.ok;
    let detail = ok ? 'Posts apagados (verificado).' : `HTTP ${response.status}`;
    if (ok) {
      const after = await this.getHtml(`${pathLast}${pathLast.includes('?') ? '&' : '?'}page=last`);
      const remaining = parseForumThread(after).posts.filter((post) => postIds.includes(post.postId));
      if (remaining.length > 0) {
        ok = false;
        detail = `${remaining.length} post(s) ainda presentes — confira manualmente.`;
      }
    }
    await this.journal.append('mutation', 'forum-delete-posts', `thread=${thread.threadId} posts=${postIds.length} → ${detail}`, false);
    return { ok, detail };
  }
}
