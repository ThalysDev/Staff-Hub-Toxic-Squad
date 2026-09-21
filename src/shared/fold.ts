// Fonte única de comparação acento/caixa-insensível (jogadores com caracteres
// especiais). Todas as cópias antigas já migram para cá: sg5-view-filter,
// journal-filter e spy-report (cujo normalizeText legado era a última cópia —
// hoje é fold + opção de colapsar espaços).
//
// Regras: Unicode NFD para separar os diacríticos combinantes, strip da faixa
// U+0300–U+036F, lowercase e trim. Pura, sem dependências e sem estado —
// segura para qualquer camada (main/renderer/shared) e determinística.

export interface FoldOptions {
  /** Colapsa sequências de espaço em UMA (e aparas as bordas) — para casar
   *  nomes/Unidades em texto livre com espaços irregulares. */
  collapseSpaces?: boolean;
}

/**
 * Normaliza texto para comparação: NFD + strip de diacríticos + lowercase +
 * trim. "João" ≃ "joao" ≃ "JOAO" ≃ "  joÃo " — a busca do líder não depende
 * de ele acentuar certo nem de respeitar a caixa. Com `collapseSpaces`,
 * sequências de espaço viram um único espaço ("ZÉ com   ESPAÇO" ≃ "ze com espaco").
 */
export function fold(text: string, options?: FoldOptions): string {
  const folded = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return options?.collapseSpaces === true ? folded.replace(/\s+/g, ' ').trim() : folded.trim();
}
