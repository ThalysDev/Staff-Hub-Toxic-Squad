import { session } from 'electron';
import { TW_PARTITION, type TwSessionManager } from '../tw/session';
import type { Journal } from '../journal';
import { JsonStore } from '../stores/json-store';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc-types';
import { parseEditForm, parseForumThread } from '@shared/parsers/forum-parsers';
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
}

/**
 * Blindagem no fórum (SG_7): conferência dos posts + ajuste do post da tabela.
 * MUTAÇÃO no ajuste: confirmação dupla, 1 tentativa, journal, dry-run.
 * A conferência em si é leitura (1 página do tópico).
 */
export class Sg7Service {
  private readonly settingsStore: JsonStore<AppSettings>;

  constructor(
    private readonly twSession: TwSessionManager,
    private readonly journal: Journal,
  ) {
    this.settingsStore = new JsonStore<AppSettings>('settings', DEFAULT_SETTINGS);
  }

  private async dryRun(): Promise<boolean> {
    const raw = await this.settingsStore.load();
    return raw.dryRun === false ? false : true;
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
    const path = threadUrl.replace(/^https?:\/\/[^/]+\//, '');
    const html = await this.getHtml(`${path}${path.includes('?') ? '&' : '?'}page=last`);
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
    };
  }

  /** MUTAÇÃO: aplica o BBCode atualizado no primeiro post (Ajustar Conforme Script). */
  async adjust(threadUrl: string, confirm: boolean): Promise<{ dryRun: boolean; ok: boolean | null; detail: string }> {
    if (!confirm) throw new Error('Confirmação dupla necessária — revise a conferência e confirme na tela.');
    const dryRun = await this.dryRun();
    const conference = await this.conference(threadUrl);
    if (!conference.changed) {
      return { dryRun, ok: true, detail: 'Nada a ajustar — nenhum envio reconhecido altera a tabela.' };
    }
    if (dryRun) {
      await this.journal.append('mutation', 'forum-adjust-dry-run', `thread=${conference.threadId} ajuste SIMULADO`, true);
      return { dryRun: true, ok: null, detail: 'Simulado (DRY-RUN ativo) — nada foi enviado ao fórum.' };
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
    return { dryRun: false, ok, detail };
  }
}
