// Grupos de aldeias do jogo: leitura PELO PRÓPRIO script (nada de pedir ao
// usuário o que dá para ler da tela) com cache em GM storage por mundo.
// Fontes: `overview_villages` (dropdown de grupos e tabela filtrada por
// `&group=<id>`); o parse é puro (ext/core/game-groups/groups-parser).
// Mesmo estilo de tsh-game-data: rede só pela fila do core (pacedGet) e TTL
// por tipo de leitura.

import { pacedGet } from '../../core/net';
import { gm } from '../../core/storage';
import { parseGroupOptions, parseVillageRows, type GameGroupOption } from '../../ext/core/game-groups/groups-parser';
import { currentVillageId } from '../vanta/vanta-net';

export interface GroupsCache {
  groups: GameGroupOption[];
  fetchedAt: number;
}

export interface GroupVillageRow {
  villageId: number;
  name: string;
  x: number;
  y: number;
}

export interface GroupVillagesCache {
  villages: GroupVillageRow[];
  fetchedAt: number;
}

/** Dropdown de grupos: muda quando o jogador cria/apaga grupo (raridade). */
const GROUPS_TTL_MS = 10 * 60 * 1000;
/** Aldeias de um grupo: muda quando o jogador edita a tela de grupos. */
const GROUP_VILLAGES_TTL_MS = 5 * 60 * 1000;

/** Mundo = subdomínio (br142.tribalwars.com.br → br142), padrão do runtime. */
const worldId = (): string => window.location.hostname.split('.')[0] ?? 'mundo';
const groupsKey = (): string => `tsh-groups:${worldId()}`;
const villagesKey = (groupId: number): string => `tsh-groups:${worldId()}:group:${groupId}`;

/** Grupos já lidos nesta sessão — usados só pela higiene do invalidate. */
const trackedGroupIds = new Set<number>();

function overviewPath(params = ''): string {
  const villageId = currentVillageId();
  const prefix = villageId === '' ? '' : `village=${encodeURIComponent(villageId)}&`;
  return `/game.php?${prefix}screen=overview_villages${params}`;
}

/**
 * Grupos do jogador no mundo atual (dropdown do `overview_villages`). Cache de
 * 10 min em GM storage. Leitura VAZIA não é gravada: uma página sem o dropdown
 * (redirect, tela diferente) não pode envenenar o cache por 10 min.
 */
export async function getGroupOptions(force = false): Promise<GameGroupOption[]> {
  const cached = gm.get<GroupsCache | null>(groupsKey(), null);
  if (cached !== null && !force && Date.now() - cached.fetchedAt < GROUPS_TTL_MS) return cached.groups;
  const groups = parseGroupOptions(await pacedGet(overviewPath(), force ? { fresh: true } : undefined));
  if (groups.length > 0) gm.set<GroupsCache>(groupsKey(), { groups, fetchedAt: Date.now() });
  return groups;
}

/**
 * Aldeias de um grupo (`overview_villages&group=<id>`), cache de 5 min POR
 * GRUPO. `groupId` fora do contrato (não inteiro/≤ 0) devolve vazio sem tocar
 * na rede — a tela já usa 0 como "sem filtro".
 */
export async function getGroupVillages(groupId: number, force = false): Promise<GroupVillageRow[]> {
  if (!Number.isInteger(groupId) || groupId <= 0) return [];
  const cached = gm.get<GroupVillagesCache | null>(villagesKey(groupId), null);
  if (cached !== null && !force && Date.now() - cached.fetchedAt < GROUP_VILLAGES_TTL_MS) return cached.villages;
  const villages = parseVillageRows(
    await pacedGet(overviewPath(`&group=${groupId}`), force ? { fresh: true } : undefined),
  );
  if (villages.length > 0) {
    gm.set<GroupVillagesCache>(villagesKey(groupId), { villages, fetchedAt: Date.now() });
    trackedGroupIds.add(groupId);
  }
  return villages;
}

/**
 * Esquece os grupos lidos (ex.: depois de o usuário editar grupos no jogo).
 * Chaves de grupos não lidos nesta sessão ficam para trás e expiram sozinhas
 * pelo TTL da própria leitura.
 */
export function invalidateGroupsCache(): void {
  gm.remove(groupsKey());
  for (const groupId of trackedGroupIds) gm.remove(villagesKey(groupId));
  trackedGroupIds.clear();
}
