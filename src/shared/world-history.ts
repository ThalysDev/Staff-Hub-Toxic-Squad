// Histórico de versões do mundo (SG_1): evolução das tribos ao longo do tempo.
//
// POR QUE SÓ AGREGADOS + DELTA: um dump completo do mundo tem ~270 mil aldeias
// (≈ 3 MB por coleta). Versionar o dump inteiro significaria ~30 MB só para 10
// versões e um diff O(270k) a cada comparação — inviável. Cada versão persiste
// então apenas o AGREGADO por tribo (o mundo ativo tem ~573 tribos, poucas
// centenas de linhas) e o DELTA de trocas de dono desde a versão IMEDIATAMENTE
// anterior: o suficiente para responder "quem cresceu/encolheu" e "quem
// conquistou o quê" sem armazenar o mundo inteiro.
//
// Puro e determinístico: nenhuma função aqui toca disco/rede ou muta entradas;
// falha estrutural (coordenada duplicada no mesmo dump) lança erro PT-BR claro
// (fail-closed) em vez de produzir um delta silenciosamente errado.

import { formatCoord } from './coords';

/** Agregado por tribo numa versão do mundo (dump completo → ~573 linhas). */
export interface WorldTribeAggregate {
  allyId: number;
  tag: string;
  villages: number;
  points: number;
}

/** Aldeia que trocou de dono entre duas versões consecutivas (só o DELTA é persistido). */
export interface VillageOwnerChange {
  /** Coordenada "x|y" da aldeia conquistada/abandonada. */
  coord: string;
  /** Tribo do dono anterior (0 = bárbara/sem tribo — conquista vinda da bárbara). */
  fromAllyId: number;
  /** Tribo do novo dono (0 = abandonada, voltou a bárbara). */
  toAllyId: number;
}

export interface WorldHistoryVersion {
  id: string;
  /** ISO timestamp da coleta que gerou esta versão. */
  collectedAt: string;
  /** Mundo (ex.: "br128") — histórico nunca mistura mundos. */
  world: string;
  tribes: WorldTribeAggregate[];
  /** Mudanças vs a versão IMEDIATAMENTE anterior (vazia na primeira). */
  changesSincePrevious: VillageOwnerChange[];
}

/** Linha de comparação A (antiga) → B (nova) por tribo, para a tabela de evolução. */
export interface WorldDiffRow {
  allyId: number;
  tag: string;
  villagesA: number;
  villagesB: number;
  /** B − A: positivo = tribo cresceu em aldeias. */
  villagesDelta: number;
  pointsA: number;
  pointsB: number;
  /** B − A nos pontos do agregado da tribo. */
  pointsDelta: number;
}

/**
 * Agrega villages+allies por tribo. Bárbaros/aldeias sem tribo (allyId 0) são
 * DESCARTADOS: não são tribo e somariam ruído no topo do ranking (são milhares).
 * Uma tribo entra no agregado somente se possuir ≥1 aldeia no dump; `villages`
 * é contado do array de aldeias e `points`/`tag` vêm do ally.txt (o dump oficial
 * já traz os pontos totais da tribo — não recalculamos aqui). allyId presente
 * nas aldeias mas ausente do ally.txt (race entre dumps baixados em sequência)
 * entra com tag "?" para não perder a contagem. Ordenado por villages desc,
 * empate por points desc, empate por tag asc — determinístico.
 */
export function computeWorldAggregates(
  villages: readonly { allyId: number }[],
  allies: readonly { id: number; tag: string; points: number }[],
): WorldTribeAggregate[] {
  const villagesByAlly = new Map<number, number>();
  for (const village of villages) {
    if (village.allyId === 0) continue; // bárbaro/sem tribo: fora do agregado
    villagesByAlly.set(village.allyId, (villagesByAlly.get(village.allyId) ?? 0) + 1);
  }

  const allyById = new Map<number, { id: number; tag: string; points: number }>();
  for (const ally of allies) allyById.set(ally.id, ally);

  const aggregates: WorldTribeAggregate[] = [];
  for (const [allyId, villageCount] of villagesByAlly) {
    const ally = allyById.get(allyId);
    aggregates.push({
      allyId,
      tag: ally?.tag ?? '?',
      villages: villageCount,
      points: ally?.points ?? 0,
    });
  }
  aggregates.sort((a, b) => {
    if (b.villages !== a.villages) return b.villages - a.villages;
    if (b.points !== a.points) return b.points - a.points;
    return a.tag.localeCompare(b.tag, 'pt-BR');
  });
  return aggregates;
}

/** Indexa por "x|y"; coordenada repetida no MESMO array é dump corrompido — fail-closed. */
function indexByCoord(rows: readonly { x: number; y: number; allyId: number }[], label: 'anterior' | 'atual'): Map<string, number> {
  const byCoord = new Map<string, number>();
  for (const row of rows) {
    const coord = formatCoord({ x: row.x, y: row.y });
    if (byCoord.has(coord)) {
      throw new Error(
        `Aldeia "${coord}" duplicada na lista ${label} — cada coordenada deve aparecer uma única vez por versão do mundo.`,
      );
    }
    byCoord.set(coord, row.allyId);
  }
  return byCoord;
}

/**
 * Mudanças de dono por coord entre dois dumps (união das chaves). O lado em que
 * a coord não existe conta como allyId 0: aldeia recém-nascida é bárbara na
 * prática (0→0 = sem mudança) e aldeia que "sumiu" do dump é tratada como
 * abandono — em Tribal Wars aldeia não desaparece, então isso só ocorre com
 * dump truncado e o ruído fica confinado a uma versão (cap de 10). Conquista de
 * bárbara (fromAllyId 0) e abandono (toAllyId 0) SÃO registrados: são eventos
 * reais da guerra. Sem nenhuma troca de dono ⇒ lista vazia. Resultado ordenado
 * por coord asc (ordem numérica "x|y") para exibição estável.
 */
export function computeOwnerChanges(
  prev: readonly { x: number; y: number; allyId: number }[],
  next: readonly { x: number; y: number; allyId: number }[],
): VillageOwnerChange[] {
  const prevByCoord = indexByCoord(prev, 'anterior');
  const nextByCoord = indexByCoord(next, 'atual');

  const changes: VillageOwnerChange[] = [];
  const allCoords = new Set<string>([...prevByCoord.keys(), ...nextByCoord.keys()]);
  for (const coord of allCoords) {
    const fromAllyId = prevByCoord.get(coord) ?? 0;
    const toAllyId = nextByCoord.get(coord) ?? 0;
    if (fromAllyId === toAllyId) continue; // mesmo dono (ou bárbara nas duas): sem mudança
    changes.push({ coord, fromAllyId, toAllyId });
  }
  changes.sort((a, b) => a.coord.localeCompare(b.coord, 'pt-BR', { numeric: true }));
  return changes;
}

/**
 * Diff A (antiga) → B (nova) por tribo, sobre os agregados persistidos — união
 * das tribos das duas versões: tribo só em B é NOVA (villagesA/pointsA = 0),
 * tribo só em A saiu do cenário (villagesB/pointsB = 0). Tag vem da versão mais
 * recente que a tiver. Ordenado por |villagesDelta| DESC (maiores movimentos no
 * topo, crescendo ou encolhendo), empate por pointsDelta desc, empate por tag asc.
 */
export function diffWorldVersions(a: WorldHistoryVersion, b: WorldHistoryVersion): WorldDiffRow[] {
  const tribesA = new Map<number, WorldTribeAggregate>();
  for (const tribe of a.tribes) tribesA.set(tribe.allyId, tribe);
  const tribesB = new Map<number, WorldTribeAggregate>();
  for (const tribe of b.tribes) tribesB.set(tribe.allyId, tribe);

  const rows: WorldDiffRow[] = [];
  for (const allyId of new Set<number>([...tribesA.keys(), ...tribesB.keys()])) {
    const tribeA = tribesA.get(allyId);
    const tribeB = tribesB.get(allyId);
    const villagesA = tribeA?.villages ?? 0;
    const villagesB = tribeB?.villages ?? 0;
    const pointsA = tribeA?.points ?? 0;
    const pointsB = tribeB?.points ?? 0;
    rows.push({
      allyId,
      tag: tribeB?.tag ?? tribeA?.tag ?? '?',
      villagesA,
      villagesB,
      villagesDelta: villagesB - villagesA,
      pointsA,
      pointsB,
      pointsDelta: pointsB - pointsA,
    });
  }

  rows.sort((rowA, rowB) => {
    const byVillagesDelta = Math.abs(rowB.villagesDelta) - Math.abs(rowA.villagesDelta);
    if (byVillagesDelta !== 0) return byVillagesDelta;
    const byPointsDelta = rowB.pointsDelta - rowA.pointsDelta;
    if (byPointsDelta !== 0) return byPointsDelta;
    return rowA.tag.localeCompare(rowB.tag, 'pt-BR');
  });
  return rows;
}

/** Máximo de versões persistidas: 10 coletas ≈ dezenas de KB (agregados + delta) — memória e disco sob controle. */
export const MAX_WORLD_HISTORY = 10;

/**
 * Limita o histórico a MAX_WORLD_HISTORY versões. Convenção: ordem cronológica
 * no array (mais recente no FIM, append) — mantém as últimas MAX_WORLD_HISTORY
 * e descarta as mais antigas. Sempre devolve um NOVO array; os objetos de
 * versão são reaproveitados por referência (imutabilidade de entrada garantida).
 */
export function capWorldHistory(versions: readonly WorldHistoryVersion[]): WorldHistoryVersion[] {
  if (versions.length <= MAX_WORLD_HISTORY) return [...versions];
  return versions.slice(versions.length - MAX_WORLD_HISTORY);
}

/** Id único de versão (UUID — colisão prática nula mesmo com coletas manuais repetidas). */
export function newWorldVersionId(): string {
  return crypto.randomUUID();
}
