// Motor da blindagem no fórum (SG_7): reconhece comentários no formato rígido
// "pedido/lanceiros/espadachins/arqueiros" (ex.: 243/100/0/0), soma por pedido e
// produz o BBCode atualizado da tabela (subtraindo os envios).

export interface BlindComment {
  postId: number;
  author: string;
  pedido: number;
  spear: number;
  sword: number;
  archer: number;
}

/** Comentários válidos no formato rígido — todas as 3 unidades informadas. */
export function recognizeComments(posts: { postId: number; author: string; text: string }[]): BlindComment[] {
  const comments: BlindComment[] = [];
  for (const post of posts) {
    const match = /(?:^|\s)(\d{1,4})\/(\d{1,6})\/(\d{1,6})\/(\d{1,6})(?=\s|$)/.exec(post.text);
    if (match === null) continue;
    comments.push({
      postId: post.postId,
      author: post.author,
      pedido: Number(match[1]),
      spear: Number(match[2]),
      sword: Number(match[3]),
      archer: Number(match[4]),
    });
  }
  return comments;
}

export interface PedidoSum {
  pedido: number;
  spear: number;
  sword: number;
  archer: number;
  authors: string[];
}

/** Soma os envios por pedido (a saída da ferramenta original: PEDIDOS RECONHECIDOS SOMADOS). */
export function sumByPedido(comments: BlindComment[]): PedidoSum[] {
  const map = new Map<number, PedidoSum>();
  for (const comment of comments) {
    const entry = map.get(comment.pedido) ?? { pedido: comment.pedido, spear: 0, sword: 0, archer: 0, authors: [] };
    entry.spear += comment.spear;
    entry.sword += comment.sword;
    entry.archer += comment.archer;
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
 * Subtrai os envios somados das linhas da tabela e devolve o BBCode atualizado
 * do primeiro post (linhas sem mudança permanecem idênticas).
 */
export function applyBlindUpdate(bbcode: string, sums: PedidoSum[]): string {
  const rows = parseBlindTable(bbcode);
  if (rows.length === 0) return bbcode;
  const sumsByPedido = new Map(sums.map((sum) => [sum.pedido, sum]));
  let updated = bbcode;
  for (const row of rows) {
    const sum = sumsByPedido.get(row.pedido);
    if (sum === undefined) continue;
    const parts: string[] = [];
    const newSpear = Math.max(0, (row.missing.spear ?? 0) - sum.spear);
    const newSword = Math.max(0, (row.missing.sword ?? 0) - sum.sword);
    const newArcher = Math.max(0, (row.missing.archer ?? 0) - sum.archer);
    if (newSpear > 0) parts.push(`Lanceiros ${ptBr(newSpear)}`);
    if (newSword > 0) parts.push(`Espadachins ${ptBr(newSword)}`);
    if (newArcher > 0) parts.push(`Arqueiros ${ptBr(newArcher)}`);
    const falta = parts.length > 0 ? parts.join(', ') : 'Completo ✔';
    const newLine = `[**]${row.pedido}[|]${row.villageLabel}[|]${falta}[/**]`;
    updated = updated.replace(row.rawLine, newLine);
  }
  return updated;
}

/** Painel "PEDIDOS RECONHECIDOS SOMADOS" no formato da ferramenta original. */
export function recognizedSummary(sums: PedidoSum[]): string {
  return sums.map((sum) => `${sum.pedido}/${sum.spear}/${sum.sword}/${sum.archer}`).join('\n');
}
