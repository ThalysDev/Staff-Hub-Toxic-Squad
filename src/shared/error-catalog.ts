/**
 * Catálogo de erros canônicos (PT-BR) compartilhado main/services/fila.
 * Os services rodavam variantes divergentes da mesma mensagem ("faça login
 * antes de…", "faça login novamente e tente de novo"…); aqui cada situação
 * tem UMA redação canônica — a UI e os testes podem apostar no texto exato.
 */

/** Tipos de sentinela de conteúdo (iguais aos QueueFailureKind de conteúdo). */
export type SentinelKind = 'session-expired' | 'captcha-suspected';

const SESSAO_BASE = 'Nenhuma sessão ativa no jogo — faça login no jogo ou importe a sessão na tela Sessão.';

/**
 * Sessão inativa (fail-closed antes de qualquer acesso ao jogo). O contexto
 * opcional é anexado entre parênteses quando a tela precisa explicitar a
 * operação que dependia da sessão.
 */
export function erroSessao(contexto?: string): string {
  return contexto === undefined ? SESSAO_BASE : `${SESSAO_BASE} (${contexto})`;
}

/**
 * Fila ocupada (single-flight C4): outra coleta/mutação/download está em
 * andamento. O contexto opcional completa o "antes de…" (ex.: "usar o fórum").
 */
export function erroFilaOcupada(contexto?: string): string {
  const base = 'Uma operação está em andamento — aguarde terminar (ou cancele na barra de progresso)';
  return contexto === undefined ? `${base} antes de iniciar outra.` : `${base} antes de ${contexto}.`;
}

/**
 * Sentinela de conteúdo detectada no corpo da página (detect-pause-notify):
 * sessão é checada antes de captcha — página de login com captcha é, antes de
 * tudo, sessão caída. Redação em verso-e-maiúscula normal (as tabelas de
 * resultado do SG_6 mantêm o bloco em MAIÚSCULAS por ser estilo de tabela).
 */
export function erroSentinela(kind: SentinelKind): string {
  return kind === 'session-expired'
    ? 'Sessão expirada — operação interrompida. Faça login novamente.'
    : 'Captcha detectado — operação pausada. Resolva manualmente na janela de login.';
}
