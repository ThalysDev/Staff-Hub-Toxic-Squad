// Fonte única de comparação acento/caixa-insensível (jogadores com caracteres
// especiais). Hoje a mesma lógica vive duplicada em sg5-view-filter.ts (fold)
// e journal-filter.ts (normalizeText) — este módulo é a versão canônica; as
// cópias existentes serão migradas para cá em outra frente.
//
// Regras: Unicode NFD para separar os diacríticos combinantes, strip da faixa
// U+0300–U+036F, lowercase e trim. Pura, sem dependências e sem estado —
// segura para qualquer camada (main/renderer/shared) e determinística.

/**
 * Normaliza texto para comparação: NFD + strip de diacríticos + lowercase +
 * trim. "João" ≃ "joao" ≃ "JOAO" ≃ "  joÃo " — a busca do líder não depende
 * de ele acentuar certo nem de respeitar a caixa.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}
