// Parser de tópicos do fórum de tribo (screen=forum&screenmode=view_thread).
// Validado contra tests/fixtures/br142/forum-thread-real.html (tópico de teste
// do BR142, fórum 597 "Arquivo/Blindagem Preventiva").

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export interface ForumPost {
  postId: number;
  author: string;
  /** Texto visível do post (BBCode fonte não é exposto na leitura — HTML renderizado). */
  text: string;
}

export interface ForumThread {
  threadId: number;
  /** Posts na ordem da página (a primeira mensagem = tabela de blindagem da staff). */
  posts: ForumPost[];
}

const TAG_STRIP = /<[^>]+>/g;

function visible(value: string): string {
  return value
    .replace(TAG_STRIP, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cada post tem link "Editar" com edit_post_id=N e o conteúdo num div class="text".
 * O autor vem do cabeçalho do post (link info_player mais próximo antes do texto).
 */
export function parseForumThread(html: string): ForumThread {
  const threadId = /thread_id=(\d+)/.exec(html)?.[1];
  if (threadId === undefined) {
    throw new ParseError('Página sem thread_id — não parece um tópicos do fórum.');
  }
  const posts: ForumPost[] = [];
  // Blocos de post: do link de citação (quote_id) até o próximo, ou fim da tabela.
  const chunks = html.split(/quote_id=\d+/).slice(1);
  for (const chunk of chunks) {
    const postId = /edit_post_id=(\d+)/.exec(chunk)?.[1];
    if (postId === undefined) continue;
    const textDiv = /<div class="text">([\s\S]*?)<\/div>/.exec(chunk)?.[1];
    if (textDiv === undefined) continue;
    // autor: último link info_player antes do div de texto
    const before = chunk.slice(0, chunk.indexOf('<div class="text">'));
    const author = [...before.matchAll(/screen=info_player[^>]*id=\d+[^>]*>([\s\S]*?)<\/a>/g)].pop()?.[1];
    posts.push({
      postId: Number(postId),
      author: author === undefined ? '' : visible(author),
      text: visible(textDiv),
    });
  }
  if (posts.length === 0) {
    throw new ParseError('Nenhum post encontrado no tópico (estrutura inesperada).');
  }
  return { threadId: Number(threadId), posts };
}

/** Extrai o csrf e a aldeia atual dos dados embutidos da página do fórum.
 * Validado contra fixtures reais: o BR142 embute "village":{"id":N,…}. */
export function forumTokens(html: string): { csrf: string; villageId: string } {
  const csrf = /"csrf":"([a-f0-9]+)"/.exec(html)?.[1];
  const villageId = /"village":\{"id":(\d+)/.exec(html)?.[1];
  if (csrf === undefined || villageId === undefined) {
    throw new ParseError('Página do fórum sem csrf/aldeia — formato inesperado.');
  }
  return { csrf, villageId };
}

export interface EditFormDetails {
  message: string;
  /** action exata do formulário (com edit_post_id/post_id/forum_id/h). */
  action: string;
  /** Valor do input oculto "do" (send) e "current_page". */
  doValue: string;
  currentPage: string;
}

/** Extrai o <textarea name="message"> (BBCode) + action/campos ocultos da edição. */
export function parseEditForm(html: string): EditFormDetails {
  const match = /<textarea[^>]*name="message"[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
  const action = /action="([^"]*action=edit_post[^"]*)"/.exec(html)?.[1];
  const doValue = /name="do"[^>]*value="([^"]*)"/.exec(html)?.[1];
  const currentPage = /name="current_page"[^>]*value="([^"]*)"/.exec(html)?.[1];
  if (match === null || action === undefined) {
    throw new ParseError('Formulário de edição sem o campo "message"/action.');
  }
  return {
    message: match[1] ?? '',
    action: action.replace(/&amp;/g, '&').replace(/#.*$/, ''),
    doValue: doValue ?? 'send',
    currentPage: currentPage ?? '0',
  };
}
