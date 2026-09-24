// Regras por grupo no formato ANTIGO em texto ("grupoId:duração:lote:min") —
// Onda 5b. Desde a 3.6.0 a tela usa cartões (collection-groups.ts); este
// parser segue para o modo "Só na tela" e para converter o texto em cartões.
// Arquivo à parte para não criar import circular com collection.ts.

import type { ScavengeDuration } from '../tsh-transport';


/** Lote da regra: número fixo por unidade ou 'tudo' (todas as disponíveis). */
export type GroupRuleLot = number | 'tudo';

export interface CollectionGroupRule {
  groupId: number;
  duration: ScavengeDuration;
  lot: GroupRuleLot;
  minUnits: number;
}

const DURATION_ALIASES: Readonly<Record<string, ScavengeDuration>> = {
  pequena: 'pequena',
  media: 'media',
  média: 'media',
  grande: 'grande',
  extrema: 'extrema',
};

/**
 * Parser PURO das regras por grupo (Onda 5b): uma regra por linha, no formato
 * "grupoId:duração:lote:min" (ex.: "182608:grande:200:50" ou
 * "182608:media:tudo:10"). Duração aceita pequena/média/grande/extrema
 * (acento opcional); lote é inteiro ≥ 1 (quantidade FIXA por unidade) ou a
 * palavra 'tudo'; min é inteiro ≥ 1. Linhas vazias são ignoradas; grupo
 * repetido é inválido (a última regra venceria em silêncio). Qualquer linha
 * ruim derruba o parse INTEIRO com o motivo da primeira — o chamador segue
 * com os settings atuais (fail-closed: uma regra malformada não pode rotear a
 * aldeia errada para uma coleta diferente).
 */
export function parseGroupRules(
  text: string,
): { ok: true; rules: CollectionGroupRule[] } | { ok: false; reason: string } {
  const rules: CollectionGroupRule[] = [];
  const seen = new Set<number>();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(':').map((part) => part.trim());
    const bad = (detail: string): { ok: false; reason: string } => ({
      ok: false,
      reason: `linha ${index + 1} ("${line}") ${detail} — use "grupoId:duração:lote:min" (ex.: 182608:grande:200:50).`,
    });
    if (parts.length !== 4) return bad('não tem os 4 campos');
    const [rawGroup, rawDuration, rawLot, rawMin] = parts;
    const groupId = Number(rawGroup);
    if (!Number.isInteger(groupId) || groupId <= 0) return bad('tem grupo inválido');
    const duration = DURATION_ALIASES[(rawDuration ?? '').toLowerCase()];
    if (duration === undefined) return bad('tem duração inválida (pequena/média/grande/extrema)');
    let lot: GroupRuleLot;
    if ((rawLot ?? '').toLowerCase() === 'tudo') {
      lot = 'tudo';
    } else {
      const parsedLot = Number(rawLot);
      if (!Number.isInteger(parsedLot) || parsedLot < 1) return bad("tem lote inválido (inteiro ≥ 1 ou 'tudo')");
      lot = parsedLot;
    }
    const minUnits = Number(rawMin);
    if (!Number.isInteger(minUnits) || minUnits < 1) return bad('tem mínimo inválido (inteiro ≥ 1)');
    if (seen.has(groupId)) return bad(`repete o grupo ${groupId}`);
    seen.add(groupId);
    rules.push({ groupId, duration, lot, minUnits });
  }
  return { ok: true, rules };
}

/** Regra do grupo da aldeia (null = nenhuma regra para ela). */
export function ruleForGroup(rules: CollectionGroupRule[], groupId: number | null): CollectionGroupRule | null {
  if (groupId === null) return null;
  return rules.find((rule) => rule.groupId === groupId) ?? null;
}

