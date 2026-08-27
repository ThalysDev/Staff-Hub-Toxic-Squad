// Filtro de visualização do SG_5 (verify / scanOwnVillages): derivado puro e
// fail-soft do Sg5VerifyResult para a tabela da Sala de Guerra.
//
// CAMPO DE HORÁRIO REAL: IncomingCommandRow não tem Date/época absoluta de
// chegada. O único valor de máquina é `arrivalSecFromLoad` (segundos até a
// chegar, lidos do atributo data-endtime/data-duration da linha) e a âncora é
// o `loadedAt` da aldeia-alvo (Timing.init da página; fallback = hora do
// fetch). Chegada absoluta (epoch ms) = loadedAt + arrivalSecFromLoad * 1000
// — mesma fórmula do sg5-arrivals/Gantt. Os textos `arrivesAtText` ("hoje às
// 01:11:07:212") e `arrivesInText` ("1:08:03") são só exibição e NUNCA são
// parseados (doutrina do parser: nunca adivinhar a partir do texto visível).
import type { IncomingCommandRow } from './parsers/village-parsers';
import type { Sg5VerifyResult } from './ipc-types';

export interface Sg5ViewFilter {
  /** Contains acento/case-insensitive em playerName + destination.name + destination.coord. Vazio = todos. */
  query: string;
  /** Tipos incluídos (campo type, ex.: 'attack'/'support'). Vazio = todos. */
  types: string[];
  /** 'todos' | 'com' | 'sem' nobre (hasNoble). */
  noble: 'todos' | 'com' | 'sem';
  /** 'todos' | 'chegados' | 'pendentes' — usa o campo de horário REAL do row contra `now`. */
  status: 'todos' | 'chegados' | 'pendentes';
}

/** Filtro neutro: tudo passa (fail-soft por padrão). Congelado — espalhe para derivar. */
export const EMPTY_SG5_VIEW_FILTER: Sg5ViewFilter = Object.freeze({
  query: '',
  types: [],
  noble: 'todos',
  status: 'todos',
});

/** Minúsculas sem acento (NFD + strip de diacríticos): "São" ≃ "sao" ≃ "SAO". */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

interface Criteria {
  query: string;
  types: Set<string>;
  noble: 'todos' | 'com' | 'sem';
  status: 'todos' | 'chegados' | 'pendentes';
  nowMs: number;
}

/**
 * Chegada absoluta (epoch ms) da linha = loadedAt + arrivalSecFromLoad * 1000.
 * null quando a linha não tem o atributo de máquina (arrivalSecFromLoad null)
 * ou a âncora é inválida — ausência de dado nunca vira horário chutado.
 */
function arrivalAtMs(command: IncomingCommandRow, loadedAt: number): number | null {
  const sec = command.arrivalSecFromLoad;
  if (sec === null || !Number.isFinite(sec)) return null;
  const arrival = loadedAt + sec * 1000;
  return Number.isFinite(arrival) ? arrival : null;
}

function statusPasses(command: IncomingCommandRow, loadedAt: number, criteria: Criteria): boolean {
  if (criteria.status !== 'chegados' && criteria.status !== 'pendentes') return true;
  // now inválido (Date NaN) → fail-soft: sem corte por status.
  if (!Number.isFinite(criteria.nowMs)) return true;
  const arrival = arrivalAtMs(command, loadedAt);
  // Sem horário de máquina a linha não pode ser classificada — passa em ambos
  // (nunca escondida por falta de dado; o texto visível não é parseado).
  if (arrival === null) return true;
  return criteria.status === 'chegados' ? arrival <= criteria.nowMs : arrival > criteria.nowMs;
}

function rowPasses(command: IncomingCommandRow, loadedAt: number, criteria: Criteria): boolean {
  if (criteria.query !== '') {
    // Separador para o contains não vazar de um campo para outro.
    const haystack = [
      fold(command.playerName ?? ''),
      fold(command.destination?.name ?? ''),
      fold(command.destination?.coord ?? ''),
    ].join('\n');
    if (!haystack.includes(criteria.query)) return false;
  }
  if (criteria.types.size > 0 && !criteria.types.has(command.type)) return false;
  if (criteria.noble === 'com' && !command.hasNoble) return false;
  if (criteria.noble === 'sem' && command.hasNoble) return false;
  return statusPasses(command, loadedAt, criteria);
}

/**
 * Filtra os commands de cada village e o unknown. Fail-soft por design: filtro
 * vazio/inválido = tudo passa, nunca lança. Aldeias que ficam (ou nascem) sem
 * comandos são DESCARTADAS (coord/loadedAt preservados nas sobreviventes —
 * nada é renumerado). Comandos de `unknown` usam como âncora o loadedAt da
 * aldeia de origem quando o commandId também está em villages (o sg5-service
 * os extrai das mesmas páginas); sem âncora, o status não corta a linha.
 * `generatedAt` é preservado. O input não é mutado.
 */
export function filterSg5Result(result: Sg5VerifyResult, filter: Sg5ViewFilter, now: Date): Sg5VerifyResult {
  if (result === null || result === undefined) return { generatedAt: '', villages: [], unknown: [] };
  const rawQuery = typeof filter?.query === 'string' ? filter.query.trim() : '';
  const criteria: Criteria = {
    query: rawQuery === '' ? '' : fold(rawQuery),
    types: new Set(Array.isArray(filter?.types) ? filter.types.filter((t): t is string => typeof t === 'string') : []),
    noble: filter?.noble === 'com' || filter?.noble === 'sem' ? filter.noble : 'todos',
    status: filter?.status === 'chegados' || filter?.status === 'pendentes' ? filter.status : 'todos',
    nowMs: now instanceof Date ? now.getTime() : Number.NaN,
  };
  // Âncora por commandId para o unknown (primeira ocorrência vence): os
  // comandos desconhecidos vêm das mesmas páginas das villages.
  const loadedAtByCommandId = new Map<number, number>();
  for (const village of result.villages ?? []) {
    for (const command of village.commands ?? []) {
      if (!loadedAtByCommandId.has(command.commandId)) loadedAtByCommandId.set(command.commandId, village.loadedAt);
    }
  }
  const villages: Sg5VerifyResult['villages'] = [];
  for (const village of result.villages ?? []) {
    const commands = (village.commands ?? []).filter((command) => rowPasses(command, village.loadedAt, criteria));
    if (commands.length === 0) continue;
    villages.push({ ...village, commands });
  }
  const unknown = (result.unknown ?? []).filter((command) =>
    rowPasses(command, loadedAtByCommandId.get(command.commandId) ?? Number.NaN, criteria),
  );
  return { generatedAt: result.generatedAt, villages, unknown };
}

/**
 * Tipos distintos presentes em villages + unknown (ordenado pt-BR, sem
 * duplicatas; '' é ignorado) — alimenta o select da UI. Fail-soft: nunca lança.
 */
export function distinctCommandTypes(result: Sg5VerifyResult): string[] {
  const types = new Set<string>();
  const add = (command: IncomingCommandRow | undefined): void => {
    if (typeof command?.type === 'string' && command.type !== '') types.add(command.type);
  };
  for (const village of result?.villages ?? []) {
    for (const command of village.commands ?? []) add(command);
  }
  for (const command of result?.unknown ?? []) add(command);
  return [...types].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}
