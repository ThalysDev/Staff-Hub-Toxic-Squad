// Regras do MUNDO que afetam o agendador (v3.5.0). Cada mundo tem as suas
// (BR142 ≠ BR143 ≠ BR144…) e nada fica fixo no código: tudo sai do
// interface.php?func=get_config do mundo atual (prefixo da URL). Verificado em
// 24/09/2026:
//   BR142: fake_limit 2 · snob/max_dist 100 · night active 1 (23h–7h)
//   BR143: fake_limit 1 · snob/max_dist 70  · night active 2 (por jogador)
//   BR144: fake_limit 1 · snob/max_dist 150 · night active 2 (por jogador)
// Parser puro por regex (fail-closed: campo ilegível = null, nunca chute).

import { pacedGet } from '../../core/net';

export type NightMode = 'desligado' | 'fixo' | 'jogador';

export interface NightBonus {
  /** 'fixo' = mesma janela para todos; 'jogador' = cada jogador escolhe 8 h. */
  mode: NightMode;
  /** Atalho: há bônus noturno (em qualquer modo). */
  active: boolean;
  startHour: number;
  endHour: number;
  /** Multiplicador de defesa (2 = +100%). */
  defFactor: number;
}

export interface WorldRules {
  /** % dos pontos da aldeia ATACANTE que um ataque precisa ter de população (0 = sem limite). */
  fakeLimitPct: number;
  /** Distância máxima do nobre em campos (null = sem limite conhecido). */
  snobMaxDist: number | null;
  /** Janela para cancelar ataques, em segundos. */
  cancelSeconds: number | null;
  night: NightBonus | null;
  /** Apoio só dentro da tribo. */
  noOtherSupport: boolean;
  /** Dias na tribo para poder enviar apoio. */
  allytimeSupportDays: number;
  /** Ataques contra membros da tribo chegam como visita (sem dano). */
  noHarm: boolean;
  /** Intervalo mínimo entre ataques/apoios (ms). */
  attackGapMs: number | null;
}

function block(xml: string, tag: string): string | null {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? null;
}

function num(scope: string | null, tag: string): number | null {
  if (scope === null) return null;
  const raw = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(scope)?.[1];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** <night> do get_config: 0 desligado, 1 janela fixa, 2 cada jogador escolhe a sua. */
export function parseNightBonus(xml: string): NightBonus | null {
  const night = block(xml, 'night');
  if (night === null) return null;
  const active = num(night, 'active');
  const startHour = num(night, 'start_hour');
  const endHour = num(night, 'end_hour');
  if (active === null || startHour === null || endHour === null) return null;
  const mode: NightMode = active === 1 ? 'fixo' : active === 2 ? 'jogador' : 'desligado';
  return { mode, active: mode !== 'desligado', startHour, endHour, defFactor: num(night, 'def_factor') ?? 2 };
}

export function parseWorldRules(xml: string): WorldRules | null {
  if (!/<config>/.test(xml) && block(xml, 'game') === null) return null;
  const game = block(xml, 'game');
  const snob = block(xml, 'snob');
  const ally = block(xml, 'ally');
  const commands = block(xml, 'commands');
  return {
    fakeLimitPct: num(game, 'fake_limit') ?? 0,
    snobMaxDist: num(snob, 'max_dist'),
    cancelSeconds: num(commands, 'command_cancel_time'),
    night: parseNightBonus(xml),
    noOtherSupport: (num(ally, 'no_other_support') ?? 0) > 0,
    allytimeSupportDays: num(ally, 'allytime_support') ?? 0,
    noHarm: (num(ally, 'no_harm') ?? 0) > 0,
    attackGapMs: num(commands, 'attack_gap'),
  };
}

let rulesCache: WorldRules | null | undefined;

/** Regras do mundo atual (cache da sessão; null = get_config ilegível). */
export async function worldRules(): Promise<WorldRules | null> {
  if (rulesCache !== undefined) return rulesCache;
  try {
    rulesCache = parseWorldRules(await pacedGet('/interface.php?func=get_config'));
  } catch {
    rulesCache = null;
  }
  return rulesCache;
}

/** Regras já lidas (sem rede) — para desenhar cartões. */
export function cachedWorldRules(): WorldRules | null {
  return rulesCache ?? null;
}

/** População mínima de um ataque: % dos pontos da aldeia ATACANTE (arredonda para cima). */
export function minimumAttackPopulationFor(attackerPoints: number, fakeLimitPct: number): number {
  if (!(fakeLimitPct > 0) || !(attackerPoints > 0)) return 0;
  return Math.ceil((attackerPoints * fakeLimitPct) / 100);
}

/** A hora (relógio do servidor) cai no bônus noturno FIXO do mundo? */
export function inNightBonus(serverMs: number, nb: NightBonus | null): boolean {
  if (nb === null || nb.mode !== 'fixo') return false;
  const h = new Date(serverMs).getHours();
  const start = nb.startHour % 24;
  const end = nb.endHour % 24;
  return start > end ? h >= start || h < end : h >= start && h < end;
}
