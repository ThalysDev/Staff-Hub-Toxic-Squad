// Dados do jogo obtidos PELO PRÓPRIO script (decisão do dono, Onda 10): nada
// de pedir ao usuário o que dá para ler do jogo — aldeias próprias (com
// coordenadas e pontos), aldeia por coordenada (nome/pontos p/ alvos),
// velocidades do mundo e tempo de viagem. Fontes: /map/village.txt (público),
// interface.php get_config/get_unit_info, game_data. Cache por sessão.

import { pacedGet } from '../../core/net';
import { gameData } from '../vanta/vanta-net';

export interface OwnVillage {
  id: string;
  name: string;
  x: number;
  y: number;
  points: number;
  /** Player dono (player_id do village.txt; = próprio jogador nas ownVillages). */
  playerId: string;
}

export interface VillageAt {
  id: string;
  name: string;
  points: number;
}

const VILLAGE_TXT_TTL_MS = 10 * 60 * 1000;
let villagesCache: OwnVillage[] | null = null;
let villagesAt = 0;

function decodeName(raw: string): string {
  // village.txt vem URL-encoded ("%2C" vírgula, "%20"/"+" espaço) — decodifica
  // para exibir nomes legíveis (P3 revisão Onda 9).
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%20'));
  } catch {
    return raw;
  }
}

function parseVillageTxt(text: string): OwnVillage[] {
  const out: OwnVillage[] = [];
  for (const line of text.trim().split('\n')) {
    const parts = line.split(',');
    if (parts.length < 6) continue;
    const id = parts[0] ?? '';
    const x = Number(parts[2]);
    const y = Number(parts[3]);
    const playerId = parts[4] ?? '';
    const points = Number(parts[5]);
    if (id === '' || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(points)) continue;
    out.push({ id, name: decodeName(parts[1] ?? ''), x, y, points, playerId });
  }
  return out;
}

/** player_id do jogo (game_data). */
export function currentPlayerId(): string {
  const gd = gameData() as { player?: { id?: unknown } };
  return String(gd.player?.id ?? '');
}

/** Todas as aldeias do MAPA (sem cache cruzado de mundos — hostname na chave implícita da sessão). */
export async function allVillages(): Promise<OwnVillage[]> {
  if (villagesCache !== null && Date.now() - villagesAt < VILLAGE_TXT_TTL_MS) return villagesCache;
  const text = await pacedGet('/map/village.txt');
  villagesCache = parseVillageTxt(text);
  villagesAt = Date.now();
  return villagesCache;
}

/** Aldeias do JOGADOR LOGADO (via player_id do game_data + village.txt). */
export async function ownVillages(): Promise<OwnVillage[]> {
  const pid = currentPlayerId();
  if (pid === '') return [];
  const all = await allVillages();
  return all.filter((v) => v.playerId === pid);
}

/** Aldeia em uma coordenada (nome/pontos — para validar alvos e fakes). */
export async function villageAt(x: number, y: number): Promise<VillageAt | null> {
  const all = await allVillages();
  const found = all.find((v) => v.x === x && v.y === y);
  return found === undefined ? null : { id: found.id, name: found.name, points: found.points };
}

export interface WorldSpeeds {
  /** Velocidade do mundo (get_config <speed>). */
  speed: number;
  /** Velocidade de unidades (get_config <unit_speed>). */
  unitSpeed: number;
}

const BR142_SPEEDS: WorldSpeeds = { speed: 1.5, unitSpeed: 0.75 };

let speedsCache: WorldSpeeds | null = null;

/** Velocidades do mundo via get_config (fallback br142, como o mass-support). */
export async function worldSpeeds(): Promise<WorldSpeeds> {
  if (speedsCache !== null) return speedsCache;
  try {
    const doc = new DOMParser().parseFromString(await pacedGet('/interface.php?func=get_config'), 'text/xml');
    if (doc.querySelector('parsererror') === null) {
      const read = (tag: string): number | undefined => {
        const value = Number((doc.querySelector(tag)?.textContent ?? '').trim().replace(',', '.'));
        return Number.isFinite(value) && value > 0 ? value : undefined;
      };
      const speed = read('speed');
      const unitSpeed = read('unit_speed');
      if (speed !== undefined && unitSpeed !== undefined) {
        speedsCache = { speed, unitSpeed };
        return speedsCache;
      }
    }
  } catch {
    /* fica o fallback */
  }
  speedsCache = BR142_SPEEDS;
  return speedsCache;
}

const UNIT_KEYS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'] as const;

let unitSpeedsCache: Record<string, number> | null = null;

/**
 * Minutos por campo de cada unidade (get_unit_info <config><unit><speed>).
 * Estranho/vazio → null (o chamador decide o fallback).
 */
export async function unitSpeedsMinutesPerField(): Promise<Record<string, number> | null> {
  if (unitSpeedsCache !== null) return unitSpeedsCache;
  try {
    const doc = new DOMParser().parseFromString(await pacedGet('/interface.php?func=get_unit_info'), 'text/xml');
    if (doc.querySelector('parsererror') !== null) return null;
    const result: Record<string, number> = {};
    for (const unit of UNIT_KEYS) {
      const node = doc.querySelector(unit);
      const speed = Number((node?.querySelector('speed')?.textContent ?? '').trim().replace(',', '.'));
      if (Number.isFinite(speed) && speed > 0) result[unit] = speed;
    }
    if (Object.keys(result).length === 0) return null;
    unitSpeedsCache = result;
    return result;
  } catch {
    return null;
  }
}

/**
 * Tempo de viagem (MINUTOS) entre duas coordenadas para o conjunto de
 * unidades dado (vale a MAIS LENTA). null = dados indisponíveis (chamador
 * exige modo "enviar às" em vez de converter chegada).
 */
export async function travelMinutes(
  from: { x: number; y: number },
  to: { x: number; y: number },
  units: Partial<Record<string, number>>,
): Promise<number | null> {
  const speeds = await unitSpeedsMinutesPerField();
  if (speeds === null) return null;
  const world = await worldSpeeds();
  let slowest = 0;
  for (const [unit, amount] of Object.entries(units)) {
    if ((amount ?? 0) <= 0) continue;
    const s = speeds[unit];
    if (s !== undefined && s > slowest) slowest = s;
  }
  if (slowest <= 0) return null;
  const dist = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
  // P1 (revisão Onda 9): fórmula do repo (support-planner:385) divide pelos
  // DOIS fatores — min = dist × base / (world.speed × world.unit_speed).
  return (dist * slowest) / (world.speed * world.unitSpeed);
}
