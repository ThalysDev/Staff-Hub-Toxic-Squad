// Mecânica do bônus noturno do Tribal Wars: durante a janela configurada no
// get_config (bloco <night>), as tropas viajam com METADE da velocidade — na
// prática, cada minuto de percurso dentro da janela custa 2x. Regra pura e
// determinística: nada de Date.now(), o tempo entra sempre como parâmetro.
import type { WorldConfig } from './world-config';

/** Recorte do WorldConfig que a lógica de bônus noturno precisa conhecer. */
export type NightBonusCfg = Pick<
  WorldConfig,
  'nightBonusActive' | 'nightStartHour' | 'nightEndHour'
>;

const MS_PER_MINUTE = 60_000;
// Sobrado de arredondamento em ponto flutuante (< 1µs) já conta como chegada.
const EPS_MS = 1e-6;
// Rede de segurança contra laço infinito com config patológica (~1400 bordas/dia
// × anos de simulação nunca chega perto disso em viagem real).
const MAX_SEGMENTS = 100_000;

/**
 * A hora `hour` (0-24+, frações permitidas: 3.5 = 03:30) está dentro da janela?
 * Janela é meio-aberta [start, end):
 * - cruza meia-noite (ex.: BR142 23→7): h >= start OU h < end;
 * - normal (ex.: 13→18): start <= h < end;
 * - nula (start === end): nunca dispara.
 */
export function isNightBonusHour(hour: number, cfg: NightBonusCfg): boolean {
  if (!cfg.nightBonusActive) return false;
  if (!Number.isFinite(hour)) {
    throw new Error('Hora inválida para verificar o bônus noturno.');
  }
  const h = ((hour % 24) + 24) % 24;
  const { nightStartHour: start, nightEndHour: end } = cfg;
  if (start === end) return false;
  if (start > end) return h >= start || h < end;
  return h >= start && h < end;
}

export interface TravelTimeInput {
  /** Distância total da viagem, em campos do mapa (contínuo, aceita frações). */
  distanceFields: number;
  /** Minutos por campo na velocidade clássica (sem bônus). */
  minutesPerField: number;
  /** Partida — instantes fixos nas chamadas; nunca derivar daqui de Date.now(). */
  departureAt: Date | number;
  cfg: NightBonusCfg;
}

/** ms até a próxima borda da janela (abre ou fecha) depois de `atMs`.
 * Sempre existe borda futura (elas se repetem todos os dias), então devolve
 * número finito. Avaliado no relógio LOCAL porque as horas do get_config são
 * horas do servidor e os instantes das chamadas/testes são construídos no fuso
 * local (Brasil não tem horário de verão — sem saltos de relógio). */
function nextToggleIn(atMs: number, cfg: NightBonusCfg): number {
  const base = new Date(atMs);
  const year = base.getFullYear();
  const month = base.getMonth();
  const day = base.getDate();
  let best = Number.POSITIVE_INFINITY;
  // Candidatas em -1..+2 dias cobrem qualquer instante entre duas bordas.
  for (let dayOffset = -1; dayOffset <= 2; dayOffset++) {
    for (const hour of [cfg.nightStartHour, cfg.nightEndHour]) {
      if (!Number.isFinite(hour)) continue;
      const candidate = new Date(year, month, day + dayOffset, hour, 0, 0, 0).getTime();
      const delta = candidate - atMs;
      if (delta > 0 && delta < best) best = delta;
    }
  }
  return best;
}

/**
 * Tempo total de viagem em ms. Aproximação CONTÍNUA (documentada): a distância
 * é tratada como grandeza contínua, não por campos discretos — simulação por
 * segmentos avança de borda em borda da janela:
 * - "remainingDayMs" = distância que falta medida em ms de viagem diurna;
 * - num trecho noturno cada ms de relógio rende metade do progresso, logo um
 *   trecho que custaria N ms diurnos consome 2N ms de relógio.
 * Sem bônus ativo → distanceFields * minutesPerField * 60_000 puro.
 */
export function travelTimeMs(input: TravelTimeInput): number {
  const { distanceFields, minutesPerField, departureAt, cfg } = input;
  if (!Number.isFinite(distanceFields) || distanceFields < 0) {
    throw new Error('Distância em campos deve ser um número maior ou igual a zero.');
  }
  if (!Number.isFinite(minutesPerField) || minutesPerField <= 0) {
    throw new Error('Minutos por campo deve ser um número maior que zero.');
  }
  const departureMs = departureAt instanceof Date ? departureAt.getTime() : departureAt;
  if (!Number.isFinite(departureMs)) {
    throw new Error('Momento de partida inválido: informe uma Date ou timestamp válido.');
  }

  const classicMs = distanceFields * minutesPerField * MS_PER_MINUTE;
  if (!cfg.nightBonusActive) return classicMs;

  let elapsedMs = 0;
  let remainingDayMs = classicMs;
  let cursorMs = departureMs;
  for (let segment = 0; remainingDayMs > EPS_MS; segment++) {
    if (segment >= MAX_SEGMENTS) {
      throw new Error('Cálculo da viagem não convergiu: janela do bônus noturno inválida.');
    }
    const atCursor = new Date(cursorMs);
    const fractionalHour =
      atCursor.getHours() +
      atCursor.getMinutes() / 60 +
      atCursor.getSeconds() / 3600 +
      atCursor.getMilliseconds() / 3_600_000;
    const isNight = isNightBonusHour(fractionalHour, cfg);
    const untilToggleMs = nextToggleIn(cursorMs, cfg);
    // Quanto custaria terminar a viagem inteira permanecendo neste regime.
    const toFinishHereMs = isNight ? remainingDayMs * 2 : remainingDayMs;
    if (toFinishHereMs <= untilToggleMs) {
      elapsedMs += toFinishHereMs;
      break;
    }
    // Régime muda antes da chegada: consome a borda e continua no próximo regime.
    elapsedMs += untilToggleMs;
    remainingDayMs -= isNight ? untilToggleMs / 2 : untilToggleMs;
    cursorMs += untilToggleMs;
  }
  return elapsedMs;
}

export interface DepartureSolveInput {
  distanceFields: number;
  minutesPerField: number;
  /** Chegada desejada (Date ou epoch ms). */
  arrivalAt: Date | number;
  cfg: NightBonusCfg;
}

export interface DepartureSolve {
  /** Partida (epoch ms) tal que partida + viagem = chegada (ponto fixo). */
  departureAt: number;
  /** Tempo de viagem consistente com a partida (ms). */
  travelMs: number;
}

/**
 * Solver INVERSO: a que hora PARTIR para chegar exatamente em `arrivalAt`.
 * A função chegada(partida) é MONÓTONA não-decrescente (partir mais cedo nunca
 * chega mais cedo: dentro de um regime a chegada acompanha a partida 1:1 e
 * cruzar para dentro da janela noturna só atrasa) — por isso a raiz de
 * f(partida) = partida + viagem(partida) − chegada é achada por BISSEÇÃO
 * (robusta mesmo em viagens longas que mergulham na noite anterior, onde a
 * iteração amortecida anterior oscilava sem convergir). Sem bônus é exato.
 * Chegada inalcançável (caiu num "gap" de salto entre regimes): devolve a
 * melhor partida possível — a primeira cuja chegada REAL é ≥ à desejada; a
 * diferença fica a cargo do chamador exibir (nunca partida impossível).
 */
export function solveDepartureForArrival(input: DepartureSolveInput): DepartureSolve {
  const { distanceFields, minutesPerField, cfg } = input;
  const arrivalMs = input.arrivalAt instanceof Date ? input.arrivalAt.getTime() : input.arrivalAt;
  if (!Number.isFinite(arrivalMs)) {
    throw new Error('Chegada desejada inválida: informe uma Date ou timestamp válido.');
  }
  const classicMs = distanceFields * minutesPerField * MS_PER_MINUTE;
  if (!cfg.nightBonusActive) {
    return { departureAt: arrivalMs - classicMs, travelMs: classicMs };
  }
  // Pior viagem = o percurso inteiro dentro da janela (2× clássico). 1h de
  // folga cobre ruído de arredondamento nas bordas do bracket.
  const maxTravelMs = 2 * classicMs + 3_600_000;
  let lo = arrivalMs - maxTravelMs; // f(lo) < 0: nem viajando no pior ritmo chega
  let hi = arrivalMs; // f(hi) = 0: viagem nula chega na própria chegada
  const f = (departureMs: number): number => departureMs + travelTimeMs({ distanceFields, minutesPerField, departureAt: departureMs, cfg }) - arrivalMs;
  for (let step = 0; step < 100 && hi - lo > 1; step += 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (f(mid) >= 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  // Refino: no regime contínuo a partida exata é chegada − viagem(hi); quando
  // ela se verifica (≤ 50ms), devolve a partida EXATA (22:00:00.000, não .997).
  const travelHi = travelTimeMs({ distanceFields, minutesPerField, departureAt: hi, cfg });
  const refined = arrivalMs - travelHi;
  if (refined >= 0 && Math.abs(refined + travelHi - arrivalMs) <= 50) {
    const travelRefined = travelTimeMs({ distanceFields, minutesPerField, departureAt: refined, cfg });
    if (Math.abs(refined + travelRefined - arrivalMs) <= 50) {
      return { departureAt: refined, travelMs: travelRefined };
    }
  }
  return { departureAt: hi, travelMs: travelHi };
}
