// RESERVA DE TROPAS dos comandos agendados (v3.5.0). As automações que
// mandam tropas para fora (Coleta, Auto-farm, Cultivador, Demolidor, Apoio em
// massa…) não podem levar o que um comando agendado DESTA aldeia vai
// precisar — a menos que as tropas voltem antes dele. Regra:
//   reservado = Σ tropas fixas dos comandos da aldeia que saem antes da volta
//               da automação (+ margem) · "Todas" reserva o tipo inteiro.
//   pode usar = em casa − reservado (nunca negativo).
// Comando pausado não reserva (não vai sair). Puro onde dá (testável).

import { gm } from '../../core/storage';
import { serverNowMs } from '../../core/game-clock';
import { clockLabelMs } from '../../ext/core/timing/precise-fire';
import type { HubSchedulerState, ScheduledCommandRecord } from '../../ext/core/scheduler-state';
import type { UnitType } from '../../ext/modules/shared/module-types';

export type Units = Partial<Record<UnitType, number>>;

/** Folga entre a volta da automação e a saída do comando. */
export const RESERVE_MARGIN_MS = 10 * 60_000;

export interface Reservation {
  /** Tropas fixas reservadas. */
  units: Units;
  /** Tipos reservados por inteiro ("Todas"). */
  all: UnitType[];
  /** Comandos que motivaram a reserva (mais cedo primeiro). */
  commands: ScheduledCommandRecord[];
}

const TERMINAL = new Set(['enviado', 'incerto', 'falhou', 'removido', 'enviando']);

/** Reserva pura: comandos vivos da aldeia com saída em [agora, até]. */
export function reservationFrom(
  commands: readonly ScheduledCommandRecord[],
  villageId: string,
  nowMs: number,
  untilMs: number,
): Reservation {
  const vid = villageId.replace(/^n/, '');
  const list = commands
    .filter(
      (c) =>
        c.sourceVillageId.replace(/^n/, '') === vid &&
        !c.paused &&
        !c.events.some((e) => TERMINAL.has(e.status)) &&
        Date.parse(c.sendAt) >= nowMs - 60_000 &&
        Date.parse(c.sendAt) <= untilMs,
    )
    .sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
  const units: Units = {};
  const all = new Set<UnitType>();
  for (const c of list) {
    if (c.percentMode === true) {
      // Percentual: reserva o tipo inteiro (não dá para saber a fração da automação).
      for (const u of Object.keys(c.unitsPercent ?? {})) all.add(u as UnitType);
      continue;
    }
    for (const [u, n] of Object.entries(c.units)) units[u as UnitType] = (units[u as UnitType] ?? 0) + (n ?? 0);
    for (const row of c.trainUnits ?? []) for (const [u, n] of Object.entries(row)) units[u as UnitType] = (units[u as UnitType] ?? 0) + (n ?? 0);
    for (const u of c.allUnits ?? []) all.add(u);
  }
  return { units, all: [...all], commands: list };
}

/**
 * Em casa − reservado (por tropa, nunca negativo; "Todas" zera o tipo). A
 * tropa reservada FICA com 0 (não some): nas automações, chave ausente quer
 * dizer "leitura desconhecida" e o modo fixo da Coleta enviaria o lote
 * configurado — 0 é "teto zero".
 */
export function subtractReservation(available: Units, res: Reservation): Units {
  const out: Units = {};
  for (const [u, n] of Object.entries(available)) {
    const unit = u as UnitType;
    out[unit] = res.all.includes(unit) ? 0 : Math.max(0, (n ?? 0) - (res.units[unit] ?? 0));
  }
  return out;
}

const NOMES: Partial<Record<UnitType, string>> = {
  spear: 'Lanceiro', sword: 'Espadachim', axe: 'Bárbaro', archer: 'Arqueiro', spy: 'Explorador', light: 'Cavalaria leve',
  marcher: 'Arqueiro a cavalo', heavy: 'Cavalaria pesada', ram: 'Aríete', catapult: 'Catapulta', knight: 'Paladino', snob: 'Nobre',
};

/** O envio pedido invade a reserva? (null = pode). */
export function conflictReason(requested: Units, available: Units | null, res: Reservation): string | null {
  if (res.commands.length === 0) return null;
  const first = res.commands[0];
  const quando = first !== undefined ? clockLabelMs(Date.parse(first.sendAt)).slice(0, 8) : '';
  for (const [u, n] of Object.entries(requested)) {
    const unit = u as UnitType;
    if ((n ?? 0) <= 0) continue;
    const nome = NOMES[unit] ?? unit;
    if (res.all.includes(unit)) return `${nome} está reservado ("Todas") para o comando agendado das ${quando}`;
    if (available !== null) {
      const livre = (available[unit] ?? 0) - (res.units[unit] ?? 0);
      if ((n ?? 0) > livre) return `${nome} está reservado para o comando agendado das ${quando} (livre: ${Math.max(0, livre)})`;
    } else if ((res.units[unit] ?? 0) > 0) {
      return `${nome} está reservado para o comando agendado das ${quando} (não consegui ler as tropas em casa nesta tela; na Praça dá para usar o excedente)`;
    }
  }
  return null;
}

/** Reserva da aldeia até a VOLTA estimada da automação (+ margem). */
export function reservationForVillage(world: string, villageId: string, returnAtServerMs: number): Reservation {
  const state = gm.get<Partial<HubSchedulerState>>(`tsh-auto:${world}:command-scheduler:scheduler`, {});
  const commands = Array.isArray(state.commands) ? state.commands : [];
  const now = serverNowMs();
  return reservationFrom(commands, villageId, now, returnAtServerMs + RESERVE_MARGIN_MS);
}

/** Tropas em casa lidas da Praça aberta (data-all-count); null = ilegível. */
export function placeAvailableUnits(doc: Document): Units | null {
  const out: Units = {};
  let found = 0;
  for (const input of Array.from(doc.querySelectorAll<HTMLInputElement>('input.unitsInput[data-all-count]'))) {
    const n = Number(input.getAttribute('data-all-count'));
    if (!Number.isFinite(n)) continue;
    out[input.name as UnitType] = n;
    found += 1;
  }
  return found > 0 ? out : null;
}

/** Horizonte da trava nas automações de ataque/apoio (ida+volta cabe folgado). */
export const AUTOMATION_RESERVE_HORIZON_MS = 6 * 60 * 60_000;

/**
 * Trava única para automações que enviam pela Praça: o pedido invade as
 * tropas reservadas para um comando agendado desta aldeia? (motivo | null)
 */
export function automationReserveBlock(world: string, villageId: string, requested: Units, doc: Document = document): string | null {
  const res = reservationForVillage(world, villageId, serverNowMs() + AUTOMATION_RESERVE_HORIZON_MS);
  const motivo = conflictReason(requested, placeAvailableUnits(doc), res);
  return motivo === null ? null : `Não enviado: ${motivo}.`;
}

/** Texto curto para o status das automações. */
export function reservationNote(res: Reservation): string {
  if (res.commands.length === 0) return '';
  const tipos = [...Object.keys(res.units).filter((u) => (res.units[u as UnitType] ?? 0) > 0), ...res.all];
  const primeiro = res.commands[0];
  const hora = primeiro !== undefined ? `, 1º às ${clockLabelMs(Date.parse(primeiro.sendAt)).slice(0, 8)}` : '';
  return ` ${[...new Set(tipos)].map((u) => NOMES[u as UnitType] ?? u).join(', ')} reservado(s) para ${res.commands.length} comando(s) agendado(s) desta aldeia${hora}.`;
}

// ── Coleta: duração estimada (fórmula da própria tela de coleta) ──

/** Capacidade de saque padrão (o jogo usa a mesma tabela; bandeira de saque aumenta — estimativa conservadora a favor de reservar). */
const CARRY: Partial<Record<UnitType, number>> = { spear: 25, sword: 15, axe: 10, archer: 10, light: 80, marcher: 50, heavy: 50, knight: 100 };

export interface ScavengeOptionCfg {
  loot_factor: number;
  duration_exponent: number;
  duration_initial_seconds: number;
  duration_factor: number;
}

/** Duração da coleta (s): ((cap² × 100 × fator²)^expoente + inicial) × fator_duração. */
export function estimateScavengeSeconds(units: Units, cfg: ScavengeOptionCfg): number {
  let cap = 0;
  for (const [u, n] of Object.entries(units)) cap += (n ?? 0) * (CARRY[u as UnitType] ?? 0);
  if (cap <= 0) return 0;
  return (Math.pow(cap * cap * 100 * cfg.loot_factor * cfg.loot_factor, cfg.duration_exponent) + cfg.duration_initial_seconds) * cfg.duration_factor;
}

/** Parâmetros das opções de coleta publicados pela tela (`new ScavengeScreen({...}`). */
export function readScavengeOptionCfg(html: string): Record<string, ScavengeOptionCfg> | null {
  const m = /new ScavengeScreen\(\s*(\{[\s\S]*?\})\s*,\s*village/.exec(html);
  if (m === null || m[1] === undefined) return null;
  try {
    const raw = JSON.parse(m[1]) as Record<string, Partial<ScavengeOptionCfg>>;
    const out: Record<string, ScavengeOptionCfg> = {};
    for (const [id, o] of Object.entries(raw)) {
      if (typeof o.loot_factor === 'number' && typeof o.duration_exponent === 'number' && typeof o.duration_initial_seconds === 'number' && typeof o.duration_factor === 'number') {
        out[id] = o as ScavengeOptionCfg;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
