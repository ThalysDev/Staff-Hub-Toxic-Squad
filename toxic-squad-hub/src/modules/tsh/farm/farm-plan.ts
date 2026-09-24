// Decisão PURA da Central de Farm (v3.7.0): para cada linha do Assistente de
// Saque, qual botão usar (A, B, C ou nenhum), a partir do último relatório —
// "Ações por relatório". Sem rede, sem DOM: testável.

import { z } from 'zod';
import type { FarmPage, FarmRow, FarmTemplates } from './farm-page';

/** Tipo de relatório como o jogador vê na lista (cor + saque). */
export const REPORT_KINDS = ['verde-cheio', 'verde-parcial', 'amarelo-cheio', 'amarelo-parcial', 'azul', 'vermelho-azul', 'vermelho'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const FARM_ACTIONS = ['A', 'B', 'C', 'ignorar'] as const;
export type FarmAction = (typeof FARM_ACTIONS)[number];

const DEFAULT_ACTIONS: Record<ReportKind, FarmAction> = {
  'verde-cheio': 'C',
  'verde-parcial': 'A',
  'amarelo-cheio': 'B',
  'amarelo-parcial': 'B',
  azul: 'C',
  'vermelho-azul': 'ignorar',
  vermelho: 'ignorar',
};

export const farmConfigSchema = z.object({
  actions: z
    .object({
      'verde-cheio': z.enum(FARM_ACTIONS).default('C'),
      'verde-parcial': z.enum(FARM_ACTIONS).default('A'),
      'amarelo-cheio': z.enum(FARM_ACTIONS).default('B'),
      'amarelo-parcial': z.enum(FARM_ACTIONS).default('B'),
      azul: z.enum(FARM_ACTIONS).default('C'),
      'vermelho-azul': z.enum(FARM_ACTIONS).default('ignorar'),
      vermelho: z.enum(FARM_ACTIONS).default('ignorar'),
    })
    .default(DEFAULT_ACTIONS),
  /** C indisponível (sem exploração) ou vazio: usar outro modelo? */
  cFallback: z.enum(['A', 'B', 'ignorar']).default('A'),
  maxDistance: z.number().min(1).max(200).default(20),
  /** Muralha acima disto = não farma (vai para "muralhas para quebrar"). -1 = não olha a muralha. */
  maxWall: z.number().int().min(-1).max(20).default(2),
  /** Pula alvo que já tem ataque a caminho. */
  skipAttacked: z.boolean().default(true),
  /** Minutos mínimos entre dois farms no MESMO alvo (ledger desta Central). */
  targetIntervalMin: z.number().min(0).max(1440).default(10),
  /** Tropas que ficam em casa em toda aldeia. */
  keepHome: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Pausa entre ataques (ms) — o jogo exige ≥ 200. */
  pauseMs: z.number().int().min(250).max(10_000).default(400),
  /** Pausa entre aldeias (ms). */
  villagePauseMs: z.number().int().min(250).max(60_000).default(1200),
  /** Variação aleatória das pausas (%). */
  jitterPct: z.number().int().min(0).max(100).default(25),
  /** Minutos entre o fim de uma rodada e o começo da próxima. */
  roundPauseMin: z.number().min(1).max(240).default(5),
  /** Grupo de aldeias de origem (0 = todas). */
  groupId: z.number().int().min(0).default(0),
  /** Respeitar comandos do Agendador (tropas reservadas ficam em casa). */
  respectScheduler: z.boolean().default(true),
  /** Farmar também aldeias de JOGADORES que aparecem no Assistente (padrão: só bárbaras). */
  farmPlayers: z.boolean().default(false),
});
export type FarmConfig = z.infer<typeof farmConfigSchema>;

export const DEFAULT_FARM_CONFIG: FarmConfig = farmConfigSchema.parse({});

export function readFarmConfig(raw: unknown): FarmConfig {
  const r = farmConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_FARM_CONFIG;
}

export function reportKind(row: Pick<FarmRow, 'color' | 'fullHaul'>): ReportKind | null {
  switch (row.color) {
    case 'green':
      return row.fullHaul === true ? 'verde-cheio' : 'verde-parcial';
    case 'yellow':
      return row.fullHaul === true ? 'amarelo-cheio' : 'amarelo-parcial';
    case 'blue':
      return 'azul';
    case 'red_blue':
    case 'red_yellow':
      return 'vermelho-azul';
    case 'red':
      return 'vermelho';
    default:
      return null;
  }
}

export type FarmDecision =
  | { kind: 'A' | 'B'; templateId: string; units: Record<string, number> }
  | { kind: 'C'; reportId: string; units: Record<string, number> }
  | { kind: 'pular'; reason: FarmSkip };

/** Motivos de pular (contados no Monitoramento). */
export type FarmSkip = 'longe' | 'muralha' | 'a-caminho' | 'intervalo' | 'ignorar' | 'sem-tropa' | 'sem-modelo' | 'jogador' | 'sem-relatorio';

/** Cabe no que está em casa (menos o que fica em casa)? */
export function fits(units: Record<string, number>, free: Record<string, number>): boolean {
  const keys = Object.keys(units);
  return keys.length > 0 && keys.every((u) => (units[u] ?? 0) <= (free[u] ?? 0));
}

/** Tropas livres = em casa − fica em casa − reservadas (nunca negativo). */
export function freeUnits(home: Record<string, number>, keep: Record<string, number>, reserved: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [u, n] of Object.entries(home)) out[u] = Math.max(0, n - (keep[u] ?? 0) - (reserved[u] ?? 0));
  return out;
}

export function decideRow(
  row: FarmRow,
  cfg: FarmConfig,
  templates: FarmTemplates,
  free: Record<string, number>,
  lastSentAt: (targetId: string) => number | null,
  nowMs: number,
): FarmDecision {
  if (!cfg.farmPlayers && !row.barbarian) return { kind: 'pular', reason: 'jogador' };
  if (row.distance > cfg.maxDistance) return { kind: 'pular', reason: 'longe' };
  if (cfg.maxWall >= 0 && row.wall !== null && row.wall > cfg.maxWall) return { kind: 'pular', reason: 'muralha' };
  if (cfg.skipAttacked && row.attacked) return { kind: 'pular', reason: 'a-caminho' };
  const last = lastSentAt(row.targetId);
  if (last !== null && nowMs - last < cfg.targetIntervalMin * 60_000) return { kind: 'pular', reason: 'intervalo' };
  const kind = reportKind(row);
  if (kind === null) return { kind: 'pular', reason: 'sem-relatorio' };
  let action: FarmAction = cfg.actions[kind];
  if (action === 'C') {
    const forecast = row.cForecast ?? {};
    if (row.cReportId !== null && Object.keys(forecast).length > 0) {
      return fits(forecast, free) ? { kind: 'C', reportId: row.cReportId, units: forecast } : { kind: 'pular', reason: 'sem-tropa' };
    }
    action = cfg.cFallback;
  }
  if (action === 'ignorar') return { kind: 'pular', reason: 'ignorar' };
  const tpl = templates[action];
  if (tpl === null || Object.keys(tpl.units).length === 0) return { kind: 'pular', reason: 'sem-modelo' };
  return fits(tpl.units, free) ? { kind: action, templateId: tpl.id, units: tpl.units } : { kind: 'pular', reason: 'sem-tropa' };
}

/** Nada mais cabe? (nem A nem B cabem nas tropas livres) — a aldeia acabou. */
export function outOfTroops(templates: FarmTemplates, free: Record<string, number>): boolean {
  const a = templates.A !== null && fits(templates.A.units, free);
  const b = templates.B !== null && fits(templates.B.units, free);
  return !a && !b;
}

/** Tira as tropas enviadas do que está livre. */
export function spend(free: Record<string, number>, units: Record<string, number>): Record<string, number> {
  const out = { ...free };
  for (const [u, n] of Object.entries(units)) out[u] = Math.max(0, (out[u] ?? 0) - n);
  return out;
}

/** Linhas da página que ainda interessam (a lista vem ordenada por distância). */
export function pageBeyondRange(page: Pick<FarmPage, 'rows'>, maxDistance: number): boolean {
  const last = page.rows[page.rows.length - 1];
  return last !== undefined && last.distance > maxDistance;
}

/** Pausa com variação (ms). */
export function jittered(baseMs: number, pct: number, rnd: () => number = Math.random): number {
  const spread = (baseMs * pct) / 100;
  return Math.max(250, Math.round(baseMs - spread + rnd() * 2 * spread));
}
