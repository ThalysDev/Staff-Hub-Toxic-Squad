// Motor da blindagem no fórum (SG_7): reconhece comentários no formato rígido
// "pedido/lanceiros/espadachins/arqueiros" (ex.: 243/100/0/0), soma por pedido e
// produz o BBCode atualizado da tabela (subtraindo os envios).

export interface BlindComment {
  postId: number;
  author: string;
  pedido: number;
  /** Campos numéricos após o pedido (4 campos = formato original do SG_3:
   * lanceiros/espadachins/arqueiros; 7 campos = formato estendido da tribo). */
  values: number[];
}

/**
 * Reconhece TODAS as linhas num formato de barras por post: "pedido/v1/v2/…/vN"
 * com 3..7 valores após o pedido (4 campos = formato original do SG_3; 7 campos
 * = convenção estendida usada pela tribo no BR142, ex.: 45/0/10000/3000/1000/0/0).
 * Várias linhas por post são reconhecidas individualmente.
 */
export function recognizeComments(posts: { postId: number; author: string; text: string }[]): BlindComment[] {
  const comments: BlindComment[] = [];
  for (const post of posts) {
    for (const match of post.text.matchAll(/(?:^|\s)(\d{1,4})((?:\/\d{1,6}){3,7})(?=\s|$)/g)) {
      const pedido = Number(match[1]);
      const values = (match[2] ?? '')
        .split('/')
        .filter((part) => part !== '')
        .map((part) => Number(part));
      if (!Number.isFinite(pedido) || pedido <= 0 || values.length < 3) continue;
      comments.push({ postId: post.postId, author: post.author, pedido, values });
    }
  }
  return comments;
}

export interface PedidoSum {
  pedido: number;
  /** Soma por coluna de valor (posições iguais às dos comentários). */
  values: number[];
  authors: string[];
}

/** Soma os envios por pedido (PEDIDOS RECONHECIDOS SOMADOS). */
export function sumByPedido(comments: BlindComment[]): PedidoSum[] {
  const map = new Map<number, PedidoSum>();
  for (const comment of comments) {
    const entry = map.get(comment.pedido) ?? { pedido: comment.pedido, values: [], authors: [] };
    comment.values.forEach((value, index) => {
      entry.values[index] = (entry.values[index] ?? 0) + value;
    });
    entry.authors.push(comment.author);
    map.set(comment.pedido, entry);
  }
  return [...map.values()].sort((a, b) => a.pedido - b.pedido);
}

export interface BlindTableRow {
  pedido: number;
  /** Linha BBCode original (para reconstrução). */
  rawLine: string;
  villageLabel: string;
  /** Faltas atuais por unidade, lidas da tabela. */
  missing: { spear?: number; sword?: number; archer?: number };
}

/**
 * Lê a tabela de pedidos do BBCode do primeiro post (formato gerado pelo SG_3:
 * [**]N[|]Aldeia (x|y)[|]Lanceiros 10.000, Espadachins 8.913[/**]).
 */
export function parseBlindTable(bbcode: string): BlindTableRow[] {
  const rows: BlindTableRow[] = [];
  for (const lineMatch of bbcode.matchAll(/\[\*\*\](\d{1,4})\[(\|\||\|)([\s\S]*?)\[\/\*\*\]/g)) {
    const pedido = Number(lineMatch[1]);
    if (!Number.isFinite(pedido) || pedido <= 0) continue;
    const rest = (lineMatch[3] ?? '').split(/\[(\|\||\|)/);
    const villageLabel = (rest[0] ?? '').replace(/^\]+/, '').trim();
    const faltaText = rest.slice(1).filter((part) => !/^\|\|?$/.test(part)).join(' ');
    const missing: BlindTableRow['missing'] = {};
    const spear = /Lanceiros\s*([\d.]+)/.exec(faltaText)?.[1];
    const sword = /Espadachins\s*([\d.]+)/.exec(faltaText)?.[1];
    const archer = /Arqueiros\s*([\d.]+)/.exec(faltaText)?.[1];
    if (spear !== undefined) missing.spear = Number(spear.replace(/\./g, ''));
    if (sword !== undefined) missing.sword = Number(sword.replace(/\./g, ''));
    if (archer !== undefined) missing.archer = Number(archer.replace(/\./g, ''));
    rows.push({ pedido, rawLine: lineMatch[0], villageLabel, missing });
  }
  return rows;
}

const ptBr = (value: number): string => value.toLocaleString('pt-BR');

/**
 * Subtrai os envios somados das linhas da tabela e devolve o BBcode atualizado.
 * Só aplica subtrações em comentários de 4 campos (formato do SG_3:
 * lanceiros/espadachins/arqueiros); comentários estendidos (7 campos, convenção
 * da tribo) são apenas conferidos. Linhas sem faltas parseáveis permanecem
 * intactas — nunca destruir conteúdo que não entendemos.
 */
export function applyBlindUpdate(bbcode: string, sums: PedidoSum[]): string {
  const rows = parseBlindTable(bbcode);
  if (rows.length === 0) return bbcode;
  const sumsByPedido = new Map(sums.filter((sum) => sum.values.length === 3).map((sum) => [sum.pedido, sum]));
  let updated = bbcode;
  for (const row of rows) {
    const sum = sumsByPedido.get(row.pedido);
    if (sum === undefined) continue;
    // Linha sem faltas legíveis: preserva original (fail-closed).
    if (row.missing.spear === undefined && row.missing.sword === undefined && row.missing.archer === undefined) continue;
    const parts: string[] = [];
    const newSpear = Math.max(0, (row.missing.spear ?? 0) - (sum.values[0] ?? 0));
    const newSword = Math.max(0, (row.missing.sword ?? 0) - (sum.values[1] ?? 0));
    const newArcher = Math.max(0, (row.missing.archer ?? 0) - (sum.values[2] ?? 0));
    if (newSpear > 0) parts.push(`Lanceiros ${ptBr(newSpear)}`);
    if (newSword > 0) parts.push(`Espadachins ${ptBr(newSword)}`);
    if (newArcher > 0) parts.push(`Arqueiros ${ptBr(newArcher)}`);
    const falta = parts.length > 0 ? parts.join(', ') : 'Completo ✔';
    const newLine = `[**]${row.pedido}[|]${row.villageLabel}[|]${falta}[/**]`;
    updated = updated.replace(row.rawLine, newLine);
  }
  return updated;
}

/** Painel "PEDIDOS RECONHECIDOS SOMADOS" (linhas no formato colocado pelos membros). */
export function recognizedSummary(sums: PedidoSum[]): string {
  return sums.map((sum) => `${sum.pedido}/${sum.values.join('/')}`).join('\n');
}
