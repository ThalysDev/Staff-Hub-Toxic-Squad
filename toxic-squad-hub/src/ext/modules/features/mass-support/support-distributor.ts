import { SUPPORT_LINE_UNITS, lineTiming, type SupportLine } from './support-line-codec';

/**
 * Distribuidor de Apoios (aba "Apoio em massa") — engine PURA e determinística:
 * recebe as origens (aldeias de um grupo, com o que cada uma tem disponível) e
 * a lista de linhas de apoio já decodificada (`support-line-codec`), e decide
 * QUEM manda O QUÊ para cada destino. Nenhum DOM, nenhuma rede e nenhum
 * relógio próprio: o instante do ciclo entra por parâmetro e a viagem é
 * injetada pelo chamador.
 *
 * Disponibilidade de uma origem = tropas − agendadas (quando `ignoreScheduled`)
 * − reserva, nunca abaixo de zero. Origens com paladino (`skipVillagesWithPaladin`),
 * sob ataque (`allowAttackedVillages`) ou na PRÓPRIA coordenada do destino
 * ficam fora — as três são regras de produto, não heurística.
 *
 * Modos:
 * - `minimo`: cada origem manda o MÍNIMO que fecha a cota (nada de sobra);
 * - `maximo`: cada origem manda TUDO o que tem das unidades pedidas até a cota
 *   fechar (pode passar do pedido — a origem é esvaziada, como o operador pediu);
 * - `pacotes`: a linha inteira sai de UMA origem, escolhida pela preferência,
 *   que tenha TODAS as unidades pedidas (tudo ou nada).
 *
 * Composição: só as unidades PEDIDAS entram na linha. Com
 * `includeSlowerUnits`, uma sobra de cota é completada com unidades mais
 * lentas que a mais lenta pedida (o comboio passa a viajar nessa velocidade, e
 * a partida é recalculada para chegar no mesmo instante) — sem a flag, cota
 * incompleta vira `unmet`.
 *
 * Tempo: `travelMinutes(from, to)` é injetada para o comboio na velocidade
 * MAIS LENTA do jogo (referência = maior minutos/campo de
 * `unitSpeedsMinutesPerField`); a engine escala pela unidade mais lenta do
 * comboio REAL. `departAtMs = chegada − viagem`: null no imediato (envio
 * agora), `exactArrivalMs` é o alvo do cravado e da janela (chegar no limite
 * da janela é o que protege o alvo). Com `avoidMsConflicts`, as partidas
 * agendadas são espaçadas em >= 300ms na ordem de criação (o jogo recusa
 * comandos no mesmo milissegundo).
 *
 * Fail-closed: linha que não fecha vai para `unmet` com o que faltou; o que
 * coube continua planejado (apoio parcial é apoio).
 */

export type DistributionMode = 'minimo' | 'maximo' | 'pacotes';
export type OriginPreference = 'mais_perto' | 'mais_longe';

export interface DistributorOrigin {
  villageId: number;
  x: number;
  y: number;
  units: Readonly<Record<string, number>>;
  hasPaladin: boolean;
  underAttack: boolean;
  scheduledUnits: Readonly<Record<string, number>>;
}

export interface DistributorInput {
  readonly origins: readonly DistributorOrigin[];
  /** Linhas do codec, na ordem do texto colado — a ordem é a prioridade de atendimento. */
  readonly lines: readonly SupportLine[];
  readonly mode: DistributionMode;
  readonly preference: OriginPreference;
  /** Permite completar cota com unidades mais lentas que a mais lenta pedida. */
  readonly includeSlowerUnits: boolean;
  readonly skipVillagesWithPaladin: boolean;
  /** Não contar tropas já agendadas como disponíveis. */
  readonly ignoreScheduled: boolean;
  readonly allowAttackedVillages: boolean;
  /** Espaçar envios agendados em >= 300ms entre si (ordem de criação). */
  readonly avoidMsConflicts: boolean;
  /** Tropas que ficam DE FORA em toda origem (reserva do operador). */
  readonly reserveUnits: Readonly<Record<string, number>>;
  /** Viagem em minutos na velocidade mais lenta do jogo (a engine escala pelo comboio). */
  readonly travelMinutes: (from: { x: number; y: number }, to: { x: number; y: number }) => number;
  /** Minutos por campo por unidade (dados do jogo) — fillers e velocidade do comboio. */
  readonly unitSpeedsMinutesPerField: Readonly<Record<string, number>>;
}

export interface SupportAssignment {
  originVillageId: number;
  lineIndex: number;
  units: Record<string, number>;
  /** Envio agendado (epoch ms) ou null no imediato. */
  departAtMs: number | null;
}

export interface DistributionResult {
  readonly assignments: readonly SupportAssignment[];
  readonly unmet: readonly { lineIndex: number; missing: Readonly<Record<string, number>> }[];
  readonly totalAssignedUnits: Readonly<Record<string, number>>;
}

const MS_PER_MINUTE = 60_000;

/** Espaçamento mínimo entre envios agendados (o jogo recusa o mesmo milissegundo). */
export const SUPPORT_SEND_GAP_MS = 300;

const quantity = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const zeroUnits = (): Record<string, number> => {
  const units: Record<string, number> = {};
  for (const unit of SUPPORT_LINE_UNITS) units[unit] = 0;
  return units;
};

const copyUnits = (source: Readonly<Record<string, number>>): Record<string, number> => {
  const units = zeroUnits();
  for (const unit of SUPPORT_LINE_UNITS) units[unit] = quantity(source[unit]);
  return units;
};

const totalUnits = (units: Readonly<Record<string, number>>): number => {
  let total = 0;
  for (const unit of SUPPORT_LINE_UNITS) total += units[unit] ?? 0;
  return total;
};

const hasAnyUnits = (units: Readonly<Record<string, number>>): boolean => totalUnits(units) > 0;

const isFulfilled = (units: Readonly<Record<string, number>>): boolean =>
  SUPPORT_LINE_UNITS.every((unit) => (units[unit] ?? 0) <= 0);

const minutesPerField = (speeds: Readonly<Record<string, number>>, unit: string): number => {
  const value = speeds[unit];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
};

/** Velocidade de referência da viagem injetada: a unidade MAIS LENTA da tabela do jogo. */
const slowestMinutesPerField = (speeds: Readonly<Record<string, number>>): number => {
  let slowest = 0;
  for (const unit of SUPPORT_LINE_UNITS) slowest = Math.max(slowest, minutesPerField(speeds, unit));
  return slowest;
};

/** Velocidade do comboio: a unidade mais lenta PRESENTE nas tropas enviadas. */
const slowestMinutesPerFieldOf = (
  units: Readonly<Record<string, number>>,
  speeds: Readonly<Record<string, number>>,
): number => {
  let slowest = 0;
  for (const unit of SUPPORT_LINE_UNITS) {
    if ((units[unit] ?? 0) <= 0) continue;
    slowest = Math.max(slowest, minutesPerField(speeds, unit));
  }
  return slowest;
};

const travelMsFor = (
  input: DistributorInput,
  referenceMinutesPerField: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  units: Readonly<Record<string, number>>,
): number => {
  const baseMinutes = input.travelMinutes(from, to);
  if (!Number.isFinite(baseMinutes) || baseMinutes <= 0) return 0;
  const convoySlowest = slowestMinutesPerFieldOf(units, input.unitSpeedsMinutesPerField);
  // Velocidade desconhecida do comboio ou da tabela: fica a viagem injetada.
  const factor = referenceMinutesPerField > 0 && convoySlowest > 0 ? convoySlowest / referenceMinutesPerField : 1;
  return Math.round(baseMinutes * factor * MS_PER_MINUTE);
};

const isEligible = (origin: DistributorOrigin, input: DistributorInput, target: { x: number; y: number }): boolean => {
  if (input.skipVillagesWithPaladin && origin.hasPaladin) return false;
  if (!input.allowAttackedVillages && origin.underAttack) return false;
  // Apoio para a própria aldeia não existe no jogo (mesma regra do planner).
  return origin.x !== target.x || origin.y !== target.y;
};

const availableUnits = (origin: DistributorOrigin, input: DistributorInput): Record<string, number> => {
  const available = zeroUnits();
  for (const unit of SUPPORT_LINE_UNITS) {
    const scheduled = input.ignoreScheduled ? quantity(origin.scheduledUnits[unit]) : 0;
    available[unit] = Math.max(0, quantity(origin.units[unit]) - scheduled - quantity(input.reserveUnits[unit]));
  }
  return available;
};

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

interface Take {
  originIndex: number;
  units: Record<string, number>;
}

/**
 * Distribui as tropas das origens entre as linhas de apoio, na ordem das
 * linhas (prioridade) e das origens (preferência de distância).
 */
export function distributeSupport(input: DistributorInput, nowMs: number): DistributionResult {
  if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be a finite epoch in milliseconds');
  const speeds = input.unitSpeedsMinutesPerField;
  const referenceMinutesPerField = slowestMinutesPerField(speeds);
  const stock = input.origins.map((origin) => availableUnits(origin, input));

  const assignments: SupportAssignment[] = [];
  const unmet: { lineIndex: number; missing: Record<string, number> }[] = [];
  const totalAssignedUnits = zeroUnits();
  let lastScheduledDepartMs: number | null = null;

  input.lines.forEach((line, lineIndex) => {
    const requested = zeroUnits();
    let hasRequest = false;
    for (const unit of SUPPORT_LINE_UNITS) {
      const amount = quantity(line.units[unit]);
      requested[unit] = amount;
      if (amount > 0) hasRequest = true;
    }
    if (!hasRequest) {
      // Linha vazia: nada a enviar — reportada para o operador corrigir o texto.
      unmet.push({ lineIndex, missing: zeroUnits() });
      return;
    }

    const candidates = input.origins
      .map((origin, originIndex) => ({
        origin,
        originIndex,
        available: stock[originIndex]!,
        travelMinutes: isEligible(origin, input, line.target)
          ? input.travelMinutes({ x: origin.x, y: origin.y }, line.target)
          : Number.NaN,
      }))
      .filter((candidate) => Number.isFinite(candidate.travelMinutes))
      .sort((left, right) =>
        input.preference === 'mais_perto'
          ? left.travelMinutes - right.travelMinutes
          : right.travelMinutes - left.travelMinutes,
      );

    const remaining = copyUnits(requested);
    const takes: Take[] = [];
    let fillerCovered = 0;

    if (input.mode === 'pacotes') {
      const chosen = candidates.find((candidate) =>
        SUPPORT_LINE_UNITS.every((unit) => candidate.available[unit]! >= requested[unit]!),
      );
      if (chosen !== undefined) {
        takes.push({ originIndex: chosen.originIndex, units: copyUnits(requested) });
        // Pacote fechado: a cota da linha sai inteira, nada falta.
        for (const unit of SUPPORT_LINE_UNITS) remaining[unit] = 0;
      }
    } else {
      for (const candidate of candidates) {
        if (isFulfilled(remaining)) break;
        const take = zeroUnits();
        for (const unit of SUPPORT_LINE_UNITS) {
          if (remaining[unit]! <= 0) continue;
          const amount =
            input.mode === 'minimo'
              ? Math.min(candidate.available[unit]!, remaining[unit]!)
              : candidate.available[unit]!;
          if (amount <= 0) continue;
          take[unit] = amount;
          remaining[unit] = Math.max(0, remaining[unit]! - amount);
        }
        if (!hasAnyUnits(take)) continue;
        for (const unit of SUPPORT_LINE_UNITS) {
          candidate.available[unit] = Math.max(0, candidate.available[unit]! - take[unit]!);
        }
        takes.push({ originIndex: candidate.originIndex, units: take });
      }

      // Sobra de cota: completa com unidades mais lentas que a mais lenta
      // pedida (a mais próxima da velocidade pedida primeiro), 1 tropa por 1.
      if (input.includeSlowerUnits) {
        const slowestRequested = slowestMinutesPerFieldOf(requested, speeds);
        const fillers =
          slowestRequested > 0
            ? SUPPORT_LINE_UNITS.filter(
                (unit) => requested[unit] === 0 && minutesPerField(speeds, unit) > slowestRequested,
              ).sort((left, right) => minutesPerField(speeds, left) - minutesPerField(speeds, right))
            : [];
        let shortfall = totalUnits(remaining);
        for (const candidate of candidates) {
          if (shortfall <= 0 || fillers.length === 0) break;
          const take = zeroUnits();
          for (const unit of fillers) {
            if (shortfall <= 0) break;
            const amount = Math.min(candidate.available[unit]!, shortfall);
            if (amount <= 0) continue;
            take[unit] = amount;
            shortfall -= amount;
            candidate.available[unit] = candidate.available[unit]! - amount;
          }
          if (!hasAnyUnits(take)) continue;
          fillerCovered += totalUnits(take);
          const existing = takes.find((entry) => entry.originIndex === candidate.originIndex);
          if (existing === undefined) takes.push({ originIndex: candidate.originIndex, units: take });
          else {
            for (const unit of SUPPORT_LINE_UNITS) {
              existing.units[unit] = (existing.units[unit] ?? 0) + (take[unit] ?? 0);
            }
          }
        }
      }
    }

    const missing = zeroUnits();
    let cover = fillerCovered;
    for (const unit of SUPPORT_LINE_UNITS) {
      if (remaining[unit]! <= 0) continue;
      let amount = remaining[unit]!;
      if (cover > 0) {
        const consumed = Math.min(amount, cover);
        amount -= consumed;
        cover -= consumed;
      }
      missing[unit] = amount;
    }
    if (hasAnyUnits(missing)) unmet.push({ lineIndex, missing });

    const timing = lineTiming(line);
    for (const take of takes) {
      const origin = input.origins[take.originIndex]!;
      const units = copyUnits(take.units);
      let departAtMs: number | null = null;
      if (timing !== 'imediato' && line.exactArrivalMs !== null) {
        departAtMs = Math.round(line.exactArrivalMs - travelMsFor(input, referenceMinutesPerField, origin, line.target, units));
        if (input.avoidMsConflicts) {
          if (lastScheduledDepartMs !== null && departAtMs < lastScheduledDepartMs + SUPPORT_SEND_GAP_MS) {
            departAtMs = lastScheduledDepartMs + SUPPORT_SEND_GAP_MS;
          }
          lastScheduledDepartMs = departAtMs;
        }
      }
      assignments.push({ originVillageId: origin.villageId, lineIndex, units, departAtMs });
      for (const unit of SUPPORT_LINE_UNITS) totalAssignedUnits[unit] = totalAssignedUnits[unit]! + units[unit]!;
    }
  });

  return deepFreeze({ assignments, unmet, totalAssignedUnits });
}
