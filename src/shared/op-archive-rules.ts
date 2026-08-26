// Regras PURAS do Arquivo de OPs (P0-9): criação/atualização de entradas,
// validação fail-closed da entrada colada, teto de 200 OPs e ordenação.
// Nada de electron nem persistência aqui — OpArchiveService
// (src/main/services/op-archive-service.ts) aplica estas funções sobre o
// JsonStore e journala cada evento.

import type {
  OpArchiveEntry,
  OpConferenceSnapshot,
  OpSaveInput,
  OpTotalsSnapshot,
} from './ipc-types';

/** Teto do arquivo: ao superar o limite, as OPs mais antigas caem fora. */
export const OP_ARCHIVE_LIMIT = 200;

/** Entrada validada e limpa (trim) pronta para gravar. */
export interface NormalizedOpInput {
  title: string;
  targets: string[];
}

/**
 * Há pelo menos UMA linha "nick;coords" útil: ';' presente com nick e coords
 * não vazios dos dois lados. Linhas vazias/extras são toleradas; zero linhas
 * válidas = distribuição rejeitada (fail-closed).
 */
export function hasDistributionRow(distribution: string): boolean {
  return distribution.split(/\r?\n/).some((line) => {
    const sep = line.indexOf(';');
    if (sep < 1) return false;
    return line.slice(0, sep).trim().length > 0 && line.slice(sep + 1).trim().length > 0;
  });
}

/**
 * Validação fail-closed compartilhada por criação e edição: título vazio,
 * nenhum alvo ou distribuição sem linha "nick;coords" lançam erro PT-BR claro.
 * Devolve título/alvos normalizados (trim; alvos em branco descartados).
 */
export function normalizeOpInput(input: OpSaveInput): NormalizedOpInput {
  const title = input.title.trim();
  if (title === '') {
    throw new Error('Título da OP vazio — informe um título para arquivar.');
  }
  const targets = input.targets.map((target) => target.trim()).filter((target) => target !== '');
  if (targets.length === 0) {
    throw new Error('Nenhum alvo informado — a OP precisa de ao menos uma coordenada.');
  }
  if (!hasDistributionRow(input.distribution)) {
    throw new Error('Distribuição sem nenhuma linha "nick;coords" — cole a saída da distribuição (SG_4) antes de arquivar.');
  }
  return { title, targets };
}

/** Erro padronizado para id que não existe mais no arquivo. */
export function opNotFoundError(id: string): Error {
  return new Error(`OP não encontrada no arquivo (id=${id}) — recarregue a lista e tente de novo.`);
}

export function findOpById(ops: OpArchiveEntry[], id: string): OpArchiveEntry | undefined {
  return ops.find((op) => op.id === id);
}

/** Nova OP: id, createdAt e distribution vêm prontos (o service gera/complementa). */
export function createOpEntry(
  data: NormalizedOpInput,
  distribution: string,
  sendSchedule: string | undefined,
  id: string,
  createdAt: string,
): OpArchiveEntry {
  const entry: OpArchiveEntry = {
    id,
    title: data.title,
    createdAt,
    targets: [...data.targets],
    distribution,
  };
  if (sendSchedule !== undefined) entry.sendSchedule = sendSchedule;
  return entry;
}

/**
 * Edição de OP existente: title/targets/distribution/sendSchedule são
 * substituídos (agenda ausente = agenda anterior removida); id, createdAt,
 * conference e totals são PRESERVADOS — histórico nunca se altera na edição.
 */
export function updateOpEntry(
  existing: OpArchiveEntry,
  data: NormalizedOpInput,
  distribution: string,
  sendSchedule: string | undefined,
): OpArchiveEntry {
  const next: OpArchiveEntry = {
    ...existing,
    title: data.title,
    targets: [...data.targets],
    distribution,
  };
  if (sendSchedule === undefined) delete next.sendSchedule;
  else next.sendSchedule = sendSchedule;
  return next;
}

/** Insere a OP nova ou substitui a de mesmo id, sem mutar o array original. */
export function upsertOp(ops: OpArchiveEntry[], entry: OpArchiveEntry): OpArchiveEntry[] {
  const index = ops.findIndex((op) => op.id === entry.id);
  if (index < 0) return [...ops, entry];
  return ops.map((op, position) => (position === index ? entry : op));
}

/**
 * Aplica o teto do arquivo removendo as OPs mais antigas (createdAt asc) até
 * voltar ao limite — mas a OP acabada de salvar/conferir NUNCA é removida,
 * mesmo sendo a mais antiga. Mantém a ordem relativa das sobreviventes.
 */
export function capOps(ops: OpArchiveEntry[], keepId: string, limit: number = OP_ARCHIVE_LIMIT): OpArchiveEntry[] {
  if (ops.length <= limit) return ops;
  const survivors = [...ops];
  while (survivors.length > limit) {
    let oldestIndex = -1;
    let oldestCreatedAt = '';
    for (let i = 0; i < survivors.length; i++) {
      const candidate = survivors[i];
      if (candidate === undefined || candidate.id === keepId) continue;
      if (oldestIndex < 0 || candidate.createdAt < oldestCreatedAt) {
        oldestIndex = i;
        oldestCreatedAt = candidate.createdAt;
      }
    }
    if (oldestIndex < 0) break; // só restou a própria OP salva — nada a remover
    survivors.splice(oldestIndex, 1);
  }
  return survivors;
}

/** Ordem de exibição: mais recente primeiro (createdAt desc, estável). */
export function sortNewestFirst(ops: OpArchiveEntry[]): OpArchiveEntry[] {
  return [...ops].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Anexa/substitui a conferência da OP. totals substitui o totalizador quando
 * informado; se omitido, um totalizador já arquivado é PRESERVADO (anexar a
 * conferência não pode apagar dado histórico).
 */
export function withConference(
  entry: OpArchiveEntry,
  conference: OpConferenceSnapshot,
  totals?: OpTotalsSnapshot[],
): OpArchiveEntry {
  const next: OpArchiveEntry = { ...entry, conference };
  if (totals !== undefined) next.totals = totals;
  return next;
}
