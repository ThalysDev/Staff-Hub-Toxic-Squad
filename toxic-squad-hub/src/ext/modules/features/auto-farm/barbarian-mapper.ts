// Mapeador de Bárbaras (Onda 4) — engine PURA do Auto Farm pelo Mapa.
//
// A origem da extensão descobria bárbaras em BACKGROUND sobre abas gerenciadas;
// aqui o mapa público (/map/village.txt) é lido pelo usuário e ESTA engine
// pontua/filtra os alvos por região, distância e janela de pontos, guardando o
// resultado numa lista única que o Auto Farm consome. Nenhum dado é inventado:
// só entram aldeias bárbaras (ownerId 0) com coordenadas e pontos reais, e
// alvo sem exploração registrada continua exigindo exploração (fail-closed).

import { z } from 'zod';

export interface BarbarianTarget {
  id: number;
  x: number;
  y: number;
  points: number;
  /** Dono da aldeia no dump do mapa: 0 = bárbara. */
  ownerId: number;
}

export const MAPPER_TEMPLATES = Object.freeze(['A', 'B', 'C'] as const);
export const MAPPER_UPDATE_MODES = Object.freeze(['horas', 'ciclos'] as const);

/**
 * Estimativa de duração de um CICLO do Hub (15 min = intervalo padrão do Auto
 * Farm): o modo 'ciclos' da reexploração precisa de uma régua em ms, e ciclos
 * não têm duração fixa no motor puro.
 */
export const MAPPER_CYCLE_ESTIMATE_MS = 15 * 60 * 1000;

/** Configuração do Mapeador (form do Auto Farm pelo Mapa). */
export const mapperConfigSchema = z.object({
  groupId: z.string().trim().max(20).catch('0'),
  maxDistance: z.number().int().min(1).max(1_000).catch(30),
  minScore: z.number().int().min(0).max(1_000_000).catch(0),
  maxScore: z.number().int().min(0).max(1_000_000).catch(10_000),
  template: z.enum(MAPPER_TEMPLATES).catch('C'),
  updateMode: z.enum(MAPPER_UPDATE_MODES).catch('horas'),
  updateValue: z.number().int().min(1).max(1_000).catch(6),
});

export type MapperConfig = z.infer<typeof mapperConfigSchema>;

export const MAPPER_CONFIG_DEFAULTS: MapperConfig = Object.freeze({
  groupId: '0',
  maxDistance: 30,
  minScore: 0,
  maxScore: 10_000,
  template: 'C',
  updateMode: 'horas',
  updateValue: 6,
});

export interface ScoredTarget extends BarbarianTarget {
  /** Pontuação do alvo na janela [minScore, maxScore] (o valor do alvo). */
  score: number;
  distanceFields: number;
  /** Instante (epoch ms) da última exploração comprovada; null = sem dado fresco. */
  lastScoutedAt: number | null;
}

/**
 * Normaliza a configuração do Mapeador: campo com tipo/faixa errada cai no
 * default do campo. `minScore > maxScore` é invertido (janela invertida
 * filtraria TODOS os alvos — fail-closed do lado útil).
 */
export function normalizeMapperConfig(raw: unknown): MapperConfig {
  const parsed = mapperConfigSchema.safeParse(raw);
  const config = parsed.success ? parsed.data : MAPPER_CONFIG_DEFAULTS;
  const minScore = Math.min(config.minScore, config.maxScore);
  const maxScore = Math.max(config.minScore, config.maxScore);
  return Object.freeze({
    groupId: config.groupId === '' ? MAPPER_CONFIG_DEFAULTS.groupId : config.groupId,
    maxDistance: config.maxDistance,
    minScore,
    maxScore,
    template: config.template,
    updateMode: config.updateMode,
    updateValue: config.updateValue,
  });
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function barbarianTarget(value: BarbarianTarget): BarbarianTarget | null {
  const id = finiteNumber(value.id);
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const points = finiteNumber(value.points);
  const ownerId = finiteNumber(value.ownerId);
  if (id === null || x === null || y === null || points === null || ownerId === null) return null;
  return { id, x, y, points, ownerId };
}

/**
 * Aldeia do dump do mapa → alvo do Mapeador. Devolve null quando id/coordenada/
 * pontos não são numéricos (fail-closed: linha estranha nunca vira alvo) e
 * aceita qualquer dono — o filtro de bárbara é do `scoreBarbarianTargets`.
 */
export function toBarbarianTarget(
  village: Readonly<{ id: string | number; x: number; y: number; points: number }>,
  ownerId = 0,
): BarbarianTarget | null {
  const id = typeof village.id === 'string' ? (village.id.trim() === '' ? null : Number(village.id)) : village.id;
  return barbarianTarget({ id: id ?? Number.NaN, x: village.x, y: village.y, points: village.points, ownerId });
}

/**
 * Pontua as bárbaras elegíveis: DONO 0 (bárbara comprovada), pontos dentro de
 * [minScore, maxScore] e distância em campos até `maxDistance`. `score` é o
 * próprio valor do alvo (pontos) — a janela é o filtro. Ordena por distância
 * crescente (empate: mais pontos primeiro, depois id) para o Auto Farm
 * consumir a lista na ordem de preferência. Origem não finita = lista vazia.
 * Instante de exploração no futuro (relógio para trás) NÃO vira frescor:
 * `lastScoutedAt` fica null e o alvo volta a exigir exploração.
 */
export function scoreBarbarianTargets(
  targets: readonly BarbarianTarget[],
  origin: Readonly<{ x: number; y: number }>,
  config: MapperConfig,
  nowMs: number,
  scoutedAtByTargetId: Readonly<Record<string, number | null>> = {},
): readonly ScoredTarget[] {
  const policy = normalizeMapperConfig(config);
  const originX = finiteNumber(origin.x);
  const originY = finiteNumber(origin.y);
  if (originX === null || originY === null) return Object.freeze([]);
  const now = finiteNumber(nowMs);
  const scored: ScoredTarget[] = [];
  for (const candidate of targets) {
    const target = barbarianTarget(candidate);
    if (target === null || target.ownerId !== 0) continue;
    if (target.points < policy.minScore || target.points > policy.maxScore) continue;
    const distanceFields = Math.hypot(target.x - originX, target.y - originY);
    if (distanceFields > policy.maxDistance) continue;
    const scouted = finiteNumber(scoutedAtByTargetId[String(target.id)] ?? null);
    scored.push({
      ...target,
      score: target.points,
      distanceFields,
      lastScoutedAt: scouted !== null && now !== null && scouted <= now ? scouted : null,
    });
  }
  scored.sort(
    (left, right) =>
      left.distanceFields - right.distanceFields || right.points - left.points || left.id - right.id,
  );
  return Object.freeze(scored.map((target) => Object.freeze(target)));
}

/**
 * O alvo precisa de nova exploração? Sem instante de exploração (null), com
 * data no futuro/ inválida ou mais velha que o horizonte do modo
 * (`horas` = updateValue horas; `ciclos` = updateValue ciclos estimados) a
 * resposta é SIM — o motor nunca assume que um dado é fresco.
 */
export function needsRescout(target: ScoredTarget, config: MapperConfig, nowMs: number): boolean {
  const policy = normalizeMapperConfig(config);
  const scouted = finiteNumber(target.lastScoutedAt);
  if (scouted === null) return true;
  const now = finiteNumber(nowMs);
  if (now === null) return true;
  const ageMs = now - scouted;
  if (ageMs < 0) return true; // relógio para trás / data futura: não confia
  const horizonMs =
    policy.updateMode === 'horas' ? policy.updateValue * 60 * 60 * 1000 : policy.updateValue * MAPPER_CYCLE_ESTIMATE_MS;
  return ageMs >= horizonMs;
}

// ── Lista persistida do Mapper (ponte map-farm → auto-farm) ────────────────

/** De onde saiu a coordenada de origem usada na pontuação. */
export const MAPPER_ORIGIN_SOURCES = Object.freeze(['aldeia aberta', 'aldeia própria', 'centro da região'] as const);

const scoredTargetSchema = z
  .object({
    id: z.number().int().nonnegative(),
    x: z.number().int().min(0).max(999),
    y: z.number().int().min(0).max(999),
    points: z.number().int().nonnegative(),
    ownerId: z.number().int().nonnegative(),
    score: z.number(),
    distanceFields: z.number().nonnegative(),
    lastScoutedAt: z.number().nullable(),
  })
  .strict();

/** Contrato da lista compartilhada entre o Mapa e o Auto Farm. */
export const mapperTargetListSchema = z
  .object({
    generatedAt: z.string().datetime({ offset: true }),
    origin: z.object({ x: z.number().int().min(0).max(999), y: z.number().int().min(0).max(999) }).strict(),
    originSource: z.enum(MAPPER_ORIGIN_SOURCES),
    config: mapperConfigSchema,
    targets: z.array(scoredTargetSchema).max(50_000),
  })
  .strict();

export type MapperTargetList = z.infer<typeof mapperTargetListSchema>;

/** Coordenada canônica de um alvo (mesmo formato do Assistente de Saque). */
export function targetCoordinate(target: Readonly<{ x: number; y: number }>): string {
  return `${target.x}|${target.y}`;
}

/** Monta a lista persistida (valida, remove coordenadas repetidas e congela). */
export function buildMapperTargetList(input: {
  generatedAt: string;
  origin: Readonly<{ x: number; y: number }>;
  originSource: (typeof MAPPER_ORIGIN_SOURCES)[number];
  config: MapperConfig;
  targets: readonly ScoredTarget[];
}): MapperTargetList {
  const seen = new Set<string>();
  const targets: ScoredTarget[] = [];
  for (const target of input.targets) {
    const coordinate = targetCoordinate(target);
    if (seen.has(coordinate)) continue;
    seen.add(coordinate);
    targets.push(target);
  }
  return mapperTargetListSchema.parse({
    generatedAt: input.generatedAt,
    origin: { x: input.origin.x, y: input.origin.y },
    originSource: input.originSource,
    config: normalizeMapperConfig(input.config),
    targets,
  });
}

/**
 * A lista do Mapper está velha para uso pelo Auto Farm? Data inválida conta
 * como VELHA (fail-closed: sem comprovar frescor, o alvo é pulado).
 */
export function isMapperListStale(
  list: Readonly<Pick<MapperTargetList, 'generatedAt'>>,
  nowMs: number,
  maxAgeHours: number,
): boolean {
  const generatedAt = Date.parse(list.generatedAt);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(nowMs)) return true;
  const ageMs = nowMs - generatedAt;
  if (ageMs < 0) return false; // gerada "no futuro": relógio local atrás do que gravou
  return ageMs > Math.max(0, maxAgeHours) * 60 * 60 * 1000;
}

/** Índice de coordenadas da lista (uso do Auto Farm no modo lista do mapper). */
export function mapperCoordinates(list: Readonly<Pick<MapperTargetList, 'targets'>>): ReadonlySet<string> {
  return new Set(list.targets.map((target) => targetCoordinate(target)));
}
