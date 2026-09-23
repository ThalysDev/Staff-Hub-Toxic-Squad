// Auto Farm pelo Mapa (userscript) — porta da frente da extensão
// toxic-squad-hub-ext (src/modules/features/map-farm/plugin.ts) rebaixada a
// PRÉVIA LOCAL + ALIMENTAÇÃO DO MAPPER (Onda 4). Na origem o módulo roda em
// BACKGROUND sobre abas gerenciadas e descobre bárbaras novas dentro da região
// configurada a partir do snapshot compartilhado (que o page-adapter nunca
// popula). Sem service worker/abas gerenciadas no userscript, o ciclo:
//   1. lê o dump público /map/village.txt (mesma fila/pacing do resto do
//      script) e mantém a PRÉVIA da região em status/'last-preview';
//   2. pontua as bárbaras da região com a engine PURA do Mapper
//      (scoreBarbarianTargets: dono 0, janela de pontos, distância máxima) e
//      GRAVA a lista compartilhada no namespace do plugin Auto Farm
//      ('tsh-auto:<mundo>:auto-farm:targets') — contrato consumido por ele
//      quando a "Fonte dos alvos" é o Mapper.
// Nenhum alvo é registrado no jogo e nenhum ataque é enviado: mutating=false.
// A lista leva `lastScoutedAt: null` (o userscript não tem fonte de exploração
// comprovada — o Mapper nunca inventa frescor); quem decide re-explorar é o
// consumidor (needsRescout), nunca este módulo.

import { z } from 'zod';
import { registerTsh } from '../tsh-runtime';
import { pacedGet } from '../../../core/net';
import { gm } from '../../../core/storage';
import { ownVillages } from '../tsh-game-data';
import { serverNowIso } from './op-generator';
import {
  MAPPER_CONFIG_DEFAULTS,
  MAPPER_ORIGIN_SOURCES,
  MAPPER_TEMPLATES,
  MAPPER_UPDATE_MODES,
  buildMapperTargetList,
  normalizeMapperConfig,
  scoreBarbarianTargets,
  toBarbarianTarget,
  type BarbarianTarget,
  type MapperConfig,
  type MapperTargetList,
  type ScoredTarget,
} from '../../../ext/modules/features/auto-farm/barbarian-mapper';

/** De onde saiu a coordenada de origem usada na pontuação. */
export type MapperOriginSource = (typeof MAPPER_ORIGIN_SOURCES)[number];

export const mapFarmSettingsSchema = z.object({
  xMin: z.number().int().min(0).max(1000).default(0),
  xMax: z.number().int().min(0).max(1000).default(1000),
  yMin: z.number().int().min(0).max(1000).default(0),
  yMax: z.number().int().min(0).max(1000).default(1000),
  maxTargetsPerCycle: z.number().int().positive().default(20),
  // Configuração do Mapper (mesmos campos/faixas do mapperConfigSchema):
  // campo com tipo/valor estranho cai no default do campo (fail-soft, igual à
  // engine do Mapper) em vez de derrubar o ciclo inteiro.
  maxDistance: z.number().int().min(1).max(1_000).catch(MAPPER_CONFIG_DEFAULTS.maxDistance),
  minScore: z.number().int().min(0).max(1_000_000).catch(MAPPER_CONFIG_DEFAULTS.minScore),
  maxScore: z.number().int().min(0).max(1_000_000).catch(MAPPER_CONFIG_DEFAULTS.maxScore),
  template: z.enum(MAPPER_TEMPLATES).catch(MAPPER_CONFIG_DEFAULTS.template),
  updateMode: z.enum(MAPPER_UPDATE_MODES).catch(MAPPER_CONFIG_DEFAULTS.updateMode),
  updateValue: z.number().int().min(1).max(1_000).catch(MAPPER_CONFIG_DEFAULTS.updateValue),
});
export type MapFarmSettings = z.infer<typeof mapFarmSettingsSchema>;

/** Defaults efetivos do schema (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: MapFarmSettings = {
  xMin: 0,
  xMax: 1000,
  yMin: 0,
  yMax: 1000,
  maxTargetsPerCycle: 20,
  maxDistance: MAPPER_CONFIG_DEFAULTS.maxDistance,
  minScore: MAPPER_CONFIG_DEFAULTS.minScore,
  maxScore: MAPPER_CONFIG_DEFAULTS.maxScore,
  template: MAPPER_CONFIG_DEFAULTS.template,
  updateMode: MAPPER_CONFIG_DEFAULTS.updateMode,
  updateValue: MAPPER_CONFIG_DEFAULTS.updateValue,
};

/**
 * CONTRATO com o plugin Auto Farm (arquivo de OUTRO dono): a lista do Mapper
 * mora no namespace DELE (`tsh-auto:<mundo>:auto-farm:targets`) e é lida por
 * `gm.get` no modo "Fonte dos alvos = Mapper". O ctx.storage deste módulo
 * prefixaria a chave com 'map-farm', então a gravação é feita com `gm.set` na
 * chave COMPLETA (mesma forma que o runtime monta o namespace dos plugins).
 */
export const autoFarmTargetsKey = (world: string): string => `tsh-auto:${world}:auto-farm:targets`;

/** Config do Mapper derivada dos settings (normalizada pela engine pura). */
export function mapperConfigFromSettings(settings: MapFarmSettings): MapperConfig {
  return normalizeMapperConfig({
    groupId: MAPPER_CONFIG_DEFAULTS.groupId,
    maxDistance: settings.maxDistance,
    minScore: settings.minScore,
    maxScore: settings.maxScore,
    template: settings.template,
    updateMode: settings.updateMode,
    updateValue: settings.updateValue,
  });
}

export interface MapFarmBarbarian {
  id: string;
  x: number;
  y: number;
  points: number;
}

/**
 * Parser puro do /map/village.txt (formato id,nome,x,y,playerId,pontos,bonus;
 * bárbaras têm playerId 0). Fail-closed: linha malformada lança erro apontando
 * o número da linha — nunca retorna dado errado silenciosamente.
 */
export function parseBarbarianVillages(villageTxt: string): MapFarmBarbarian[] {
  const barbarians: MapFarmBarbarian[] = [];
  const numeric = (value: string | undefined): number | undefined =>
    value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
  const lines = villageTxt.trim() === '' ? [] : villageTxt.trim().split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fields = line.split(',');
    const id = fields[0] ?? '';
    const x = numeric(fields[2]);
    const y = numeric(fields[3]);
    const playerId = numeric(fields[4]);
    const points = numeric(fields[5]);
    if (id === '' || !/^\d+$/.test(id) || x === undefined || y === undefined || playerId === undefined || points === undefined) {
      throw new Error(`Linha ${index + 1} do /map/village.txt não foi reconhecida: ${line}`);
    }
    if (playerId !== 0) continue; // aldeia de jogador — não é bárbara
    barbarians.push({ id, x, y, points });
  }
  return barbarians;
}

/** Bárbaras dentro do retângulo configurado (sem teto — o teto é da prévia). */
export function barbariansInRegion(
  barbarians: readonly MapFarmBarbarian[],
  settings: MapFarmSettings,
): MapFarmBarbarian[] {
  return barbarians.filter(
    (candidate) =>
      candidate.x >= settings.xMin && candidate.x <= settings.xMax && candidate.y >= settings.yMin && candidate.y <= settings.yMax,
  );
}

export interface MapFarmSelection {
  selected: MapFarmBarbarian[];
  totalInRegion: number;
}

/** Seleção pura: bárbaras dentro do retângulo configurado, no teto do ciclo. */
export function selectMapFarmTargets(
  barbarians: readonly MapFarmBarbarian[],
  settings: MapFarmSettings,
): MapFarmSelection {
  const inRegion = barbariansInRegion(barbarians, settings);
  return { selected: inRegion.slice(0, settings.maxTargetsPerCycle), totalInRegion: inRegion.length };
}

// ── Ponte com o Mapper (Onda 4): origem, pontuação e lista compartilhada ────

export interface MapFarmOrigin {
  x: number;
  y: number;
  source: MapperOriginSource;
}

/**
 * Coordenadas da aldeia ABERTA no jogo (#menu_row2, mesmo seletor do Auto
 * Farm). `null` fora da página do jogo (ex.: testes em node) — nunca chuta.
 */
export function openVillageCoordinates(): { x: number; y: number } | null {
  if (typeof document === 'undefined') return null;
  const match = document.querySelector('#menu_row2')?.textContent?.match(/\((\d{1,3})\|(\d{1,3})\)/);
  if (!match) return null;
  const x = Number(match[1] ?? '');
  const y = Number(match[2] ?? '');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x > 999 || y > 999) return null;
  return { x, y };
}

/** Centro do retângulo configurado, preso a 0..999 (contrato do Mapper). */
export function mapFarmRegionCenter(settings: MapFarmSettings): { x: number; y: number } {
  const clamp = (value: number): number => Math.min(999, Math.max(0, Math.round(value)));
  return { x: clamp((settings.xMin + settings.xMax) / 2), y: clamp((settings.yMin + settings.yMax) / 2) };
}

/**
 * Origem da pontuação: a aldeia ABERTA vence (custo zero); sem ela, a 1ª
 * aldeia PRÓPRIA do jogador; sem nenhuma, o centro do retângulo. Falha de
 * leitura nunca derruba o ciclo (mesma postura do Auto Farm).
 */
export async function resolveMapFarmOrigin(settings: MapFarmSettings): Promise<MapFarmOrigin> {
  const open = openVillageCoordinates();
  if (open !== null) return { ...open, source: 'aldeia aberta' };
  try {
    const own = await ownVillages();
    const first = own.find(
      (village) => Number.isInteger(village.x) && Number.isInteger(village.y) && village.x <= 999 && village.y <= 999,
    );
    if (first !== undefined) return { x: first.x, y: first.y, source: 'aldeia própria' };
  } catch {
    // /map/village.txt indisponível — queda para o centro da região abaixo.
  }
  return { ...mapFarmRegionCenter(settings), source: 'centro da região' };
}

/**
 * Alvos da região → alvos pontuados do Mapper (dono 0 comprovado pela região,
 * janela de pontos e distância da config), ordenados por distância e limitados
 * pelo teto do ciclo — a lista compartilhada guarda os N melhores, não o dump
 * inteiro (teto de armazenamento do GM storage).
 */
export function scoreMapFarmTargets(
  barbarians: readonly MapFarmBarbarian[],
  origin: Readonly<{ x: number; y: number }>,
  config: MapperConfig,
  nowMs: number,
  limit: number,
): readonly ScoredTarget[] {
  const targets: BarbarianTarget[] = [];
  for (const village of barbarians) {
    const target = toBarbarianTarget(village, 0);
    if (target !== null) targets.push(target);
  }
  const capped = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : targets.length;
  return scoreBarbarianTargets(targets, origin, config, nowMs).slice(0, capped);
}

/** Lista compartilhada do Mapper no formato do contrato (validada e congelada). */
export function buildMapFarmTargetList(input: {
  generatedAt: string;
  origin: MapFarmOrigin;
  config: MapperConfig;
  targets: readonly ScoredTarget[];
}): MapperTargetList {
  return buildMapperTargetList({
    generatedAt: input.generatedAt,
    origin: { x: input.origin.x, y: input.origin.y },
    originSource: input.origin.source,
    config: input.config,
    targets: input.targets,
  });
}

/** Resumo do Mapper publicado na prévia (visível no painel, sem HTML). */
export interface MapFarmMapperPreview {
  origin: { x: number; y: number };
  originSource: MapperOriginSource;
  config: MapperConfig;
  /** Alvos gravados na lista compartilhada. */
  storedTargets: number;
  /** Chave do contrato no namespace do Auto Farm. */
  storageKey: string;
  /** null = lista gravada; string = motivo honesto da falha. */
  error: string | null;
}

registerTsh({
  id: 'map-farm',
  label: 'Auto Farm pelo Mapa',
  desc: 'Prévia local (sem execução) + lista do Mapper: pontua as bárbaras de /map/village.txt dentro da região e da janela configuradas e grava a lista que o Auto Farm consome no modo "Fonte dos alvos = Mapper".',
  category: 'planejamento',
  screen: null,
  mutating: false,
  settingsDefaults: DEFAULT_SETTINGS,
  // A região é lida como 4 escalares (xMin/xMax/yMin/yMax), não como texto
  // "x1|y1 x2|y2" — da forma que o plugin consome. Os campos do Mapper são os
  // mesmos da engine (janela de pontos, distância e horizonte de re-exploração)
  // e viajam na lista compartilhada como `config`.
  settingsForm: [
    { key: 'xMin', label: 'Região — X mínimo', type: 'number', min: 0, max: 1000 },
    { key: 'xMax', label: 'Região — X máximo', type: 'number', min: 0, max: 1000 },
    { key: 'yMin', label: 'Região — Y mínimo', type: 'number', min: 0, max: 1000 },
    { key: 'yMax', label: 'Região — Y máximo', type: 'number', min: 0, max: 1000 },
    {
      key: 'maxTargetsPerCycle',
      label: 'Teto de alvos por ciclo',
      type: 'number',
      min: 1,
      help: 'Quantas bárbaras da região entram no relatório e na lista compartilhada a cada ciclo (as mais próximas da origem).',
    },
    {
      key: 'maxDistance',
      label: 'Mapper — Distância máxima (campos)',
      type: 'number',
      min: 1,
      max: 1000,
      help: 'Bárbaras mais longe que isto ficam fora da lista do Mapper.',
    },
    {
      key: 'minScore',
      label: 'Mapper — Pontos mínimos',
      type: 'number',
      min: 0,
      max: 1_000_000,
      help: 'Janela de pontos do alvo: abaixo do mínimo não entra na lista.',
    },
    {
      key: 'maxScore',
      label: 'Mapper — Pontos máximos',
      type: 'number',
      min: 0,
      max: 1_000_000,
      help: 'Acima do máximo o alvo também não entra (janela invertida é corrigida pela engine).',
    },
    {
      key: 'template',
      label: 'Mapper — Template',
      type: 'select',
      options: [
        { value: 'A', label: 'A' },
        { value: 'B', label: 'B' },
        { value: 'C', label: 'C' },
      ],
      help: 'Template anotado na lista; o lote real de cada alvo é decidido pelo Auto Farm.',
    },
    {
      key: 'updateMode',
      label: 'Mapper — Reexploração',
      type: 'select',
      options: [
        { value: 'horas', label: 'Em horas' },
        { value: 'ciclos', label: 'Em ciclos' },
      ],
      help: 'Régua do horizonte de frescor do alvo; o Auto Farm e o Cultivador usam needsRescout com esta config.',
    },
    {
      key: 'updateValue',
      label: 'Mapper — Valor da reexploração',
      type: 'number',
      min: 1,
      max: 1000,
      help: 'Horas (ou ciclos estimados de 15 min) até o alvo precisar de nova exploração.',
    },
  ],
  async runCycle(ctx): Promise<void> {
    const settings = mapFarmSettingsSchema.parse(ctx.storage.get('settings', DEFAULT_SETTINGS));
    const villageTxt = await pacedGet('/map/village.txt');
    const barbarians = parseBarbarianVillages(villageTxt);
    const inRegion = barbariansInRegion(barbarians, settings);
    const selection = selectMapFarmTargets(barbarians, settings);
    const generatedAt = serverNowIso();

    // Lista compartilhada do Mapper: a prévia é gravada SEMPRE; a lista, quando
    // o contrato aceitar (falha não derruba a prévia, só é reportada).
    const origin = await resolveMapFarmOrigin(settings);
    const config = mapperConfigFromSettings(settings);
    const scored = scoreMapFarmTargets(inRegion, origin, config, Date.parse(generatedAt), settings.maxTargetsPerCycle);
    const storageKey = autoFarmTargetsKey(ctx.world);
    let mapper: MapFarmMapperPreview;
    try {
      const list = buildMapFarmTargetList({ generatedAt, origin, config, targets: scored });
      gm.set(storageKey, list);
      mapper = {
        origin: { x: origin.x, y: origin.y },
        originSource: origin.source,
        config,
        storedTargets: list.targets.length,
        storageKey,
        error: null,
      };
    } catch (error) {
      mapper = {
        origin: { x: origin.x, y: origin.y },
        originSource: origin.source,
        config,
        storedTargets: 0,
        storageKey,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    ctx.storage.set('last-preview', {
      generatedAt,
      region: { xMin: settings.xMin, xMax: settings.xMax, yMin: settings.yMin, yMax: settings.yMax },
      totalInRegion: selection.totalInRegion,
      selected: selection.selected,
      mapper,
    });
    const mapperNote =
      mapper.error === null
        ? ` Lista do Mapper: ${mapper.storedTargets} alvo(s) gravados a partir de ${mapper.originSource} (${mapper.origin.x}|${mapper.origin.y}) para o Auto Farm.`
        : ` Falha ao gravar a lista do Mapper (${mapper.error}) — o Auto Farm segue com a lista anterior.`;
    if (selection.selected.length === 0) {
      ctx.status(`Nenhuma bárbara nova está dentro da região configurada. Prévia local, sem execução.${mapperNote}`, 'info');
      return;
    }
    const first = selection.selected[0];
    const firstLabel = first !== undefined ? ` (ex.: ${first.x}|${first.y})` : '';
    ctx.status(
      `Prévia Map Farm: ${selection.selected.length} de ${selection.totalInRegion} bárbaras na região${firstLabel} — prévia local, sem execução.${mapperNote}`,
      'ok',
    );
  },
});
