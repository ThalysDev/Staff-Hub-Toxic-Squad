import { session } from 'electron';
import { TW_PARTITION, type TwSessionManager } from '../tw/session';
import type { Journal } from '../journal';
import type { JsonStore } from '../stores/json-store';
import type { RequestQueue } from '../tw/request-queue';
import { forumTokens, parseEditForm, parseForumThread, decodeHtmlEntities } from '@shared/parsers/forum-parsers';
import { applyBlindUpdate, recognizeComments, recognizedSummary, sumByPedido } from '@shared/sg7-engine';
import { detectPageSentinels } from '../tw/request-queue';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc-types';

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
 * Blindagem no fórum (SG_7): conferência dos posts + ajuste do post da tabela
 * + post do plano da OP (P0-8). MUTAÇÕES com confirmação dupla, 1 tentativa,
 * pacing das settings, journal SEMPRE (inclusive resultado incerto pós-POST)
 * e ocupação real da fila (single-flight global C4). Modo real permanente
 * (AGENTS.md) — sem dry-run.
 */
export class Sg7Service {
  constructor(
    private readonly twSession: TwSessionManager,
    private readonly journal: Journal,
    /** Single-flight global (C4): mutação não corre junto com coleta da fila. */
    private readonly queue: RequestQueue,
    /** Instância COMPARTILHADA com o index — pacing das settings do usuário. */
    private readonly settingsStore: JsonStore<AppSettings>,
  ) {}

  /** C4: coleta/mutação em andamento = esta operação NÃO executa. */
  private assertQueueIdle(): void {
    if (this.queue.isRunning) {
      throw new Error('Uma operação está em andamento — aguarde terminar antes de usar o fórum.');
    }
  }

  /** Pacing das SETTINGS do usuário (nunca abaixo do piso humano de 350ms). */
  private async pacingMs(withJitter: boolean): Promise<number> {
    const raw = await this.settingsStore.load();
    const minInterval = Number(raw.requestMinIntervalMs);
    const base = Number.isFinite(minInterval) && minInterval >= 350 ? minInterval : DEFAULT_SETTINGS.requestMinIntervalMs;
    if (!withJitter) return base;
    const jitter = Number(raw.requestJitterMs);
    const jitterMs = Number.isFinite(jitter) && jitter >= 0 ? jitter : DEFAULT_SETTINGS.requestJitterMs;
    return base + Math.random() * jitterMs;
  }

  private world(): string {
    const { state, world } = this.twSession.getStatus();
    if (state !== 'logged-in' || world === null) {
      throw new Error('Nenhuma sessão ativa no jogo — faça login antes de usar o fórum.');
    }
    return world;
  }

  private lastFetchAt = 0;

  /** GET com pacing das settings + sentinela de sessão/captcha (detect-pause-notify). */
  private async getHtml(path: string): Promise<string> {
    const world = this.world();
    const elapsed = Date.now() - this.lastFetchAt;
    const pacing = await this.pacingMs(false);
    if (elapsed < pacing) await sleep(pacing - elapsed);
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

  /** Lê o tópico (page=last) e roda a conferência sobre os posts. Leitura com
   * ocupação da fila (C4): 2 GETs diretos não correm junto com coleta. */
  async conference(threadUrl: string): Promise<ForumConferenceResult> {
    this.assertQueueIdle();
    this.queue.beginOperation();
    try {
      return await this.doConference(threadUrl);
    } finally {
      this.queue.endOperation();
    }
  }

  /** Corpo da conferência SEM guards — reusado pelo adjust (que já ocupa). */
  private async doConference(threadUrl: string): Promise<ForumConferenceResult> {
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
    this.assertQueueIdle();
    this.queue.beginOperation();
    try {
      const conference = await this.doConference(threadUrl);
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
      await sleep(await this.pacingMs(true));
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
      // Após o POST disparado, toda falha (sentinela/verificação) ainda é
      // journalada — mutação disparada nunca fica sem registro de auditoria.
      try {
        // Verificação REAL: reabre o formulário e confere o BBCode gravado.
        let ok = response.ok;
        let detail = ok ? 'Post da tabela atualizado (verificado).' : `HTTP ${response.status}`;
        if (ok) {
          const check = await this.openEditForm(thread.threadId, firstPost.postId, Number(forumId));
          if (decodeHtmlEntities(check.form.message).trim() !== conference.updatedMessage.trim()) {
            ok = false;
            detail = 'Envio aceito, mas o post NÃO refletiu o novo conteúdo — confira manualmente.';
          }
        }
        await this.journal.append('mutation', 'forum-adjust', `thread=${conference.threadId} → ${detail}`, false);
        return { ok, detail };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.journal.append('mutation', 'forum-adjust-erro', `POST disparado (thread=${conference.threadId}) — resultado incerto: ${message}`, false);
        throw error;
      }
    } finally {
      this.queue.endOperation();
    }
  }

  /**
   * MUTAÇÃO: apaga os posts informados (moderação "Apagar mensagens").
   * Confirmação dupla + journal; 1 tentativa; verificação real
   * (relê o tópico e confere que os posts sumiram).
   */
  async deletePosts(threadUrl: string, postIds: number[], confirm: boolean): Promise<{ ok: boolean; detail: string }> {
    if (!confirm) throw new Error('Confirmação dupla necessária — selecione os posts e confirme na tela.');
    if (postIds.length === 0) throw new Error('Nenhum post selecionado.');
    this.assertQueueIdle();
    this.queue.beginOperation();
    try {
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
      await sleep(await this.pacingMs(true));
      const response = await ses.fetch(
        `https://${world}.tribalwars.com.br/game.php?screen=forum&screenmode=view_thread&action=del_posts&thread_id=${thread.threadId}&page=0&forum_id=${forumId}&h=${csrf}`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'follow' },
      );
      try {
        // Verificação real: os posts não podem mais aparecer no tópico.
        await sleep(await this.pacingMs(false));
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.journal.append('mutation', 'forum-delete-posts-erro', `POST disparado (thread=${thread.threadId} posts=${postIds.length}) — resultado incerto: ${message}`, false);
        throw error;
      }
    } finally {
      this.queue.endOperation();
    }
  }

  /**
   * MUTAÇÃO (P0-8): posta o PLANO BBCode no PRIMEIRO post do tópico informado
   * (SUBSTITUI o conteúdo atual — o dono aponta para o tópico de planos da
   * OP). Mesma maquinaria de edição do adjust: formulário validado contra
   * fixture real (parseEditForm), 1 tentativa, pacing, sentinelas e
   * verificação REAL pós-envio (reabre o formulário e confere o BBCode
   * gravado). Título do tópico não é editável pelo formulário do jogo.
   */
  async postPlanToThread(threadUrl: string, bbcode: string, confirm: boolean): Promise<{ ok: boolean; detail: string }> {
    if (!confirm) throw new Error('Confirmação dupla necessária — revise o plano e confirme na tela.');
    if (bbcode.trim() === '') throw new Error('Plano vazio — gere o Pacote de Comunicação antes de postar.');
    this.assertQueueIdle();
    this.queue.beginOperation();
    try {
      const world = this.world();
      if (!threadUrl.includes(`${world}.tribalwars.com.br`)) {
        throw new Error(`A URL do tópico deve apontar para ${world}.tribalwars.com.br — a sessão atual é do mundo ${world}.`);
      }
      const path = threadUrl.replace(/^https?:\/\/[^/]+\//, '');
      const forumId = /forum_id=(\d+)/.exec(path)?.[1] ?? '0';
      // Lê o tópico para achar o primeiro post + abre o formulário de edição
      // com a action EXATA que o jogo espera.
      const html = await this.getHtml(path);
      const thread = parseForumThread(html);
      const firstPost = thread.posts[0];
      if (firstPost === undefined) throw new Error('Tópico sem posts.');
      const { form } = await this.openEditForm(thread.threadId, firstPost.postId, Number(forumId));
      const ses = session.fromPartition(TW_PARTITION);
      await sleep(await this.pacingMs(true));
      const body = new URLSearchParams({
        message: bbcode,
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
      const responseText = await response.text();
      // Após o POST disparado, toda falha (sentinela/verificação) ainda é
      // journalada — mutação disparada nunca fica sem registro de auditoria.
      try {
        const sentinel = detectPageSentinels(responseText);
        if (sentinel !== null) {
          throw new Error(sentinel === 'session-expired' ? 'Sessão expirada no meio do envio — confira o tópico manualmente.' : 'Captcha detectado — confira o tópico manualmente.');
        }
        // Sem heurística de "erro" no HTML: a PROVA é a verificação real
        // abaixo (reabre o formulário e confere o BBCode gravado) — marcador
        // visual de erro sem fixture que o sustente já causou journal falso.
        let ok = response.ok;
        let detail = ok ? 'Plano postado no primeiro post do tópico (verificado).' : `HTTP ${response.status}`;
        if (ok) {
          const check = await this.openEditForm(thread.threadId, firstPost.postId, Number(forumId));
          if (decodeHtmlEntities(check.form.message).trim() !== bbcode.trim()) {
            ok = false;
            detail = 'Envio aceito, mas o post NÃO refletiu o plano — confira manualmente.';
          }
        }
        await this.journal.append('mutation', 'forum-post-plan', `thread=${thread.threadId} (${bbcode.length} chars BBCode) → ${detail}`, false);
        return { ok, detail };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.journal.append('mutation', 'forum-post-plan-erro', `POST disparado (thread=${thread.threadId}) — resultado incerto: ${message}`, false);
        throw error;
      }
    } finally {
      this.queue.endOperation();
    }
  }
}
