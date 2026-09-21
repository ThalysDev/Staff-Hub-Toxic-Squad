// Digesto do Quartel: resumo diário do hub enviado para um webhook externo
// (formato Discord — POST {content}; Telegram-style {text} é o próximo
// denominador comum). Puro e sem I/O: monta a mensagem PT-BR (markdown simples,
// sem menções), filtra o journal por dia local e resume os sinais da
// Auditoria de Membros. O aggregator/main (src/main/ipc-digest.ts) decide
// QUANDO enviar; aqui nunca há rede.

import type { AuditSignal, StagnationSignal } from './member-audit';
import { AUDIT_SIGNAL_LABEL, STAGNATION_LABEL } from './member-audit';

/** Teto de caracteres da mensagem (Discord corta em 2000 — folga para headers). */
export const DIGEST_MAX_CHARS = 1800;

/** Entrada do construtor da mensagem — tudo já resolvido pelo main. */
export interface DigestInput {
  /** Dia do resumo no formato local 'YYYY-MM-DD' (ver {@link localDateKey}). */
  date: string;
  /** Jogador da sessão do jogo; null = sem sessão. */
  playerName: string | null;
  /** Sinais de auditoria já contados ({@link summarizeAuditSignals}). */
  signals: { label: string; count: number }[];
  /** Ações 'collect-*' do journal no dia. */
  collectionsToday: number;
  /** Ações de MP/cobrança (sg6) do journal no dia. */
  mutationsToday: number;
  /** Rótulo 'HH:MM' da próxima coleta automática; null = não configurada. */
  nextAutoCollect: string | null;
}

/** Chave do dia LOCAL ('YYYY-MM-DD') — o fuso do usuário manda em "hoje". */
export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 'YYYY-MM-DD' → 'DD/MM/AAAA'; formato inesperado volta cru (best-effort). */
export function formatBrDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) return isoDate;
  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return isoDate;
  return `${day}/${month}/${year}`;
}

/**
 * Mensagem do digesto PT-BR, formato Discord-friendly (markdown simples, sem
 * menções), com formato FIXO — linha ausente vira "—" de estado, nunca some:
 * "🔔 **Digesto do Quartel — 04/09/2026**…" (ver exemplo nos testes). Teto de
 * {@link DIGEST_MAX_CHARS} caracteres: acima disso corta com reticência
 * (webhook recusa corpo maior e o digesto não pode falhar por causa de uma
 * enxurrada de sinais).
 */
export function buildDigestMessage(input: DigestInput): string {
  const staff = input.playerName === null ? 'sem sessão' : input.playerName;
  const signals =
    input.signals.length > 0
      ? input.signals.map((signal) => `${signal.count} ${signal.label}`).join(', ')
      : 'sem sinais no período';
  const lines = [
    `🔔 **Digesto do Quartel — ${formatBrDate(input.date)}**`,
    `**Staff Hub — ${staff}**`,
    `🕵️ Auditoria: ${signals}`,
    `📦 Coletas hoje: ${input.collectionsToday}`,
    `✉️ MPs/cobranças hoje: ${input.mutationsToday}`,
    `⏰ Próxima coleta automática: ${input.nextAutoCollect ?? 'não configurada'}`,
    '— Staff Hub Toxic Squad',
  ];
  const message = lines.join('\n');
  if (message.length <= DIGEST_MAX_CHARS) return message;
  return `${message.slice(0, DIGEST_MAX_CHARS - 1)}…`;
}

/**
 * Conta as entradas do journal do DIA LOCAL dado cujo `action` começa com um
 * dos prefixos (ex.: ['collect-'] para coletas, ['mp-', 'charge-'] para
 * MPs/cobranças). O ts do journal é ISO UTC — a comparação usa o fuso LOCAL
 * para "hoje" bater com o dia do usuário. Data malformada → 0 (nunca contar
 * errado); ts ilegível é pulado.
 */
export function filterJournalToday(
  entries: readonly { ts: string; action: string }[],
  date: string,
  prefixes: readonly string[],
): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let count = 0;
  for (const entry of entries) {
    const ts = new Date(entry.ts);
    if (Number.isNaN(ts.getTime())) continue;
    if (ts.getFullYear() !== year || ts.getMonth() + 1 !== month || ts.getDate() !== day) continue;
    if (prefixes.some((prefix) => entry.action.startsWith(prefix))) count += 1;
  }
  return count;
}

/**
 * Plural de apresentação para count > 1 — chaves são os MESMOS rótulos
 * minúsculos gerados acima (derivados dos constants de member-audit); rótulo
 * ausente do mapa volta invariável ("1 em declínio, 2 em declínio" lê certo).
 */
const LABEL_PLURAL: Record<string, string> = {
  'em declínio': 'em declínio',
  estagnado: 'estagnados',
  'recrutamento massivo': 'recrutamentos massivos',
  'queda acentuada': 'quedas acentuadas',
  'entrou na tribo': 'entraram na tribo',
  'saiu da tribo': 'sairam da tribo',
  'inativo no período': 'inativos no período',
};

/**
 * Resume os sinais da Auditoria de Membros em contagens por rótulo PT-BR
 * (labels REUSADOS de AUDIT_SIGNAL_LABEL/STAGNATION_LABEL, minúsculos e no
 * plural quando count > 1 — caem no meio da frase "1 em declínio, 2
 * estagnados"). Ordem canônica: estagnação primeiro (em declínio →
 * estagnado), depois os sinais A→B na ordem do union type. Só rótulos com
 * contagem > 0 voltam; dia sem nada → [].
 */
export function summarizeAuditSignals(
  audit: readonly AuditSignal[],
  stagnation: readonly StagnationSignal[],
): { label: string; count: number }[] {
  const lower = (value: string): string => value.toLocaleLowerCase('pt-BR');
  const order = [
    ...(Object.keys(STAGNATION_LABEL) as (keyof typeof STAGNATION_LABEL)[]).map((kind) => ({
      label: lower(STAGNATION_LABEL[kind]),
      count: 0,
    })),
    ...(Object.keys(AUDIT_SIGNAL_LABEL) as (keyof typeof AUDIT_SIGNAL_LABEL)[]).map((kind) => ({
      label: lower(AUDIT_SIGNAL_LABEL[kind]),
      count: 0,
    })),
  ];
  const counts = new Map<string, number>(order.map((entry) => [entry.label, entry.count]));
  for (const signal of stagnation) {
    const label = lower(STAGNATION_LABEL[signal.kind]);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  for (const signal of audit) {
    const label = lower(AUDIT_SIGNAL_LABEL[signal.kind]);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return order
    .map((entry) => {
      const count = counts.get(entry.label) ?? 0;
      const label = count > 1 ? (LABEL_PLURAL[entry.label] ?? entry.label) : entry.label;
      return { label, count };
    })
    .filter((entry) => entry.count > 0);
}
