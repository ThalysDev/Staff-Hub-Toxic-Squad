import { session } from 'electron';
import { TW_PARTITION, type TwSessionManager } from '../tw/session';
import type { Journal } from '../journal';
import { JsonStore } from '../stores/json-store';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc-types';
import { forumTokens, parseEditForm, parseForumThread } from '@shared/parsers/forum-parsers';
import { applyBlindUpdate, recognizeComments, recognizedSummary, sumByPedido } from '@shared/sg7-engine';

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

  private async getHtml(path: string): Promise<string> {
    const world = this.world();
    const result = await this.twSession.fetchForQueue(`https://${world}.tribalwars.com.br/${path}`);
    if (!result.ok) throw new Error(`HTTP ${result.status} ao abrir ${path}`);
    return result.body;
  }

  /** Lê o tópico (page=last) e roda a conferência sobre os posts. */
  async conference(threadUrl: string): Promise<ForumConferenceResult> {
    const path = threadUrl.replace(/^https?:\/\/[^/]+\//, '');
    const html = await this.getHtml(`${path}${path.includes('?') ? '&' : '?'}page=last`);
    const thread = parseForumThread(html);
    const firstPost = thread.posts[0];
    if (firstPost === undefined) throw new Error('Tópico sem posts.');

    // BBCode fonte do primeiro post vem do FORMULÁRIO de edição (a leitura
    // renderiza HTML); 1 GET extra, cacheado em memória pela chamada do adjust.
    const { villageId } = forumTokens(html);
    const editPath = `game.php?village=${villageId}&screen=forum&screenmode=view_thread&thread_id=${thread.threadId}&edit_post_id=${firstPost.postId}&page=0`;
    const editHtml = await this.getHtml(editPath);
    const firstPostMessage = parseEditForm(editHtml).message;

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
    const world = this.world();
    const path = threadUrl.replace(/^https?:\/\/[^/]+\//, '');
    const html = await this.getHtml(path);
    const thread = parseForumThread(html);
    const firstPost = thread.posts[0];
    if (firstPost === undefined) throw new Error('Tópico sem posts.');
    const { csrf, villageId } = forumTokens(html);
    const ses = session.fromPartition(TW_PARTITION);
    const body = new URLSearchParams({
      message: conference.updatedMessage,
      send: 'Salvar',
      preview: '',
      'current_page': '0',
      do: 'edit',
    }).toString();
    const response = await ses.fetch(
      `https://${world}.tribalwars.com.br/game.php?village=${villageId}&screen=forum&screenmode=view_thread&thread_id=${conference.threadId}&action=edit_post&edit_post_id=${firstPost.postId}&h=${csrf}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'follow' },
    );
    const ok = response.ok;
    const detail = ok ? 'Post da tabela atualizado.' : `HTTP ${response.status}`;
    await this.journal.append('mutation', 'forum-adjust', `thread=${conference.threadId} → ${detail}`, false);
    return { dryRun: false, ok, detail };
  }
}
