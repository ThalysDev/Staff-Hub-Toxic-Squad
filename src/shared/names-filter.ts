// Filtro de jogadores do SG_2 (lista de nicks colada pelo usuário).
//
// Justificativa: o separador antigo (espaço) quebrava nicks que contêm espaço
// (ex.: "Jogador Um" virava dois filtros). O separador agora é EXCLUSIVAMENTE
// o ponto e vírgula (`;`) — espaço, tab, vírgula, acentos e caracteres
// especiais dentro de um nick são válidos e preservados intactos.
// Dedupe nunca descarta silenciosamente: duplicatas removidas são contadas.

import { fold } from './fold';

export interface ParsedPlayerNames {
  /** Nomes na ordem de digitação, preservando espaços internos e caixa original. */
  names: string[];
  /** Quantidade de repetições descartadas no dedupe (primeira aparição vence). */
  duplicatesRemoved: number;
}

/**
 * Separa a lista crua de jogadores APENAS por `;`, faz trim em cada item,
 * descarta vazios e remove duplicatas (comparação via `fold`, preservando a
 * primeira aparição e contando as removidas).
 */
export function parsePlayerNames(raw: string): ParsedPlayerNames {
  const names: string[] = [];
  const seen = new Set<string>();
  let duplicatesRemoved = 0;

  for (const part of raw.split(';')) {
    const name = part.trim();
    if (name === '') continue;

    const key = fold(name);
    if (seen.has(key)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(key);
    names.push(name);
  }

  return { names, duplicatesRemoved };
}

/** Set de chaves normalizadas (via `fold`) para consulta rápida. */
export function nameSet(names: readonly string[]): Set<string> {
  return new Set(names.map((name) => fold(name)));
}

/** True se o nome do jogador (normalizado) está no set. */
export function matchesName(set: Set<string>, playerName: string): boolean {
  return set.has(fold(playerName));
}
