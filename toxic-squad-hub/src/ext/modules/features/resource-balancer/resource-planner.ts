import type { ResourceType } from '../../shared/module-types';

/**
 * Planejador de balanceamento de recursos — mescla comprovada dos algoritmos
 * da comunidade (WHBalancer Shinko-to-Kuma + resBalancer Constache),
 * adaptada ao contrato do Hub: função pura, determinística, fail-closed.
 *
 * Do Shinko: média corrigida iterativa (exclusão de armazéns pequenos) e
 * políticas declarativas por perfil de aldeia.
 * Do Constache: reserva de mercadores, teto de 95% do armazém no recebimento,
 * normalização por capacidade de transporte, matching guloso multi-recurso
 * por distância e descarte de cargas quase vazias.
 */

export interface BalancePolicy {
  /** Reserva de mercadores por aldeia que nunca são usados. */
  reserveMerchants: number;
  /** Capacidade de transporte por mercador (1000 ou 1500 em mundos PT). */
  merchantCapacity: number;
  /** Fração do armazém até onde uma receptora pode ser enchida (0.95). */
  receiveCapFactor: number;
  /** Carga mínima por mercador como fração da capacidade (descarta < 70%). */
  minLoadFactor: number;
  /** Fator sobre a média corrigida que define o alvo por aldeia (0..1). */
  averageFactor: number;
  /** Pontos abaixo dos quais a aldeia é tratada como receptora prioritária. */
  lowPoints: number;
  /** Aldeias com pontos >= highPoints doam além da média (estão prontas). */
  highPoints: number;
  /** Fração do armazém retida por aldeias prontas (doadoras). */
  builtOutRetainFactor: number;
  /** Distância máxima entre doadora e receptora (campos); 0 = sem limite. */
  maxDistance: number;
}

export const defaultBalancePolicy: BalancePolicy = {
  reserveMerchants: 0,
  merchantCapacity: 1000,
  receiveCapFactor: 0.95,
  minLoadFactor: 0.7,
  averageFactor: 1,
  lowPoints: 3000,
  highPoints: 8000,
  builtOutRetainFactor: 0.25,
  maxDistance: 0,
};

/**
 * Política derivada da velocidade do mundo (game-data `gameSpeed`): língua
 * dos mercadores escala com a speed (1000×speed — br142 speed 1.5 → 1500,
 * "1000 ou 1500 em mundos PT"). O override por parâmetro continua vencendo
 * via spread no chamador.
 */
export function defaultBalancePolicyForWorldSpeed(gameSpeed: number): BalancePolicy {
  return { ...defaultBalancePolicy, merchantCapacity: Math.round(defaultBalancePolicy.merchantCapacity * gameSpeed) };
}

export interface BalanceTransferCandidate {
  donorId: string;
  receiverId: string;
  wood: number;
  stone: number;
  iron: number;
  merchants: number;
}

export interface BalanceVillage {
  id: string;
  resources: Record<ResourceType, number>;
  /** Armazém da aldeia (capacidade por recurso). */
  storage: number;
  points: number;
  merchantsAvailable: number;
  x?: number;
  y?: number;
}

export interface BalanceNeed {
  villageId: string;
  resource: ResourceType;
  amount: number;
}

function villageDistance(left: BalanceVillage, right: BalanceVillage): number {
  if (left.x === undefined || left.y === undefined || right.x === undefined || right.y === undefined) return 0;
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/**
 * Média corrigida iterativa (Shinko): começa com total/n e remove do cálculo
 * as aldeias cujo armazém é menor que a média corrente — evita planejar
 * recebimentos que estourariam armazéns pequenos.
 */
export function correctedAverage(villages: BalanceVillage[], resource: ResourceType): number {
  let candidates = villages.slice();
  let average = 0;
  while (candidates.length > 0) {
    const total = candidates.reduce((sum, village) => sum + village.resources[resource], 0);
    average = total / candidates.length;
    const constrained = candidates.filter((village) => village.storage < average);
    if (constrained.length === 0) break;
    candidates = candidates.filter((village) => village.storage >= average);
  }
  return Math.floor(average);
}

/** Alvo por aldeia: média corrigida × fator, com políticas por perfil. */
// vendored: parâmetro marcado como não usado (noUnusedParameters do userscript; o motor original não lê o recurso no alvo)
function targetFor(village: BalanceVillage, _resource: ResourceType, average: number, policy: BalancePolicy): number {
  if (village.points >= policy.highPoints) return Math.floor(village.storage * policy.builtOutRetainFactor);
  if (village.points < policy.lowPoints) return Math.floor(village.storage * policy.receiveCapFactor);
  return Math.floor(average * policy.averageFactor);
}

/**
 * Planeja transferências: para cada recurso, receptoras com déficit são
 * abastecidas pelas doadoras mais próxinhas (guloso), respeitando reserva de
 * mercadores, teto de 95% do armazém e carga mínima por mercador. Uma
 * transferência por par (doadora, receptora) já agregando os 3 recursos.
 */
export function planBalanceTransfers(villages: BalanceVillage[], policy: BalancePolicy): BalanceTransferCandidate[] {
  // Pares com coordenada ausente são EXCLUÍDOS do planejamento (convenção do
  // buildUnifiedBalanceSnapshot): sem coordenada não há distância confiável, e
  // devolvê-la como 0 faria a aldeia sem coords virar "doadora mais próxima"
  // e passar no filtro de maxDistance — falha verificada que parava o limite.
  const planned = villages.filter((village) => village.x !== undefined && village.y !== undefined);
  if (planned.length < 2) return [];
  const averages: Record<ResourceType, number> = {
    wood: correctedAverage(planned, 'wood'),
    stone: correctedAverage(planned, 'stone'),
    iron: correctedAverage(planned, 'iron'),
  };
  type Surplus = { villageId: string; resource: ResourceType; amount: number };
  const surplus: Surplus[] = [];
  const needs: BalanceNeed[] = [];
  for (const village of planned) {
    for (const resource of ['wood', 'stone', 'iron'] as const) {
      const target = Math.min(
        targetFor(village, resource, averages[resource], policy),
        Math.floor(village.storage * policy.receiveCapFactor),
      );
      const current = village.resources[resource];
      const diff = current - target;
      if (diff > 0) surplus.push({ villageId: village.id, resource, amount: diff });
      else if (diff < 0) needs.push({ villageId: village.id, resource, amount: -diff });
    }
  }
  const byId = new Map(planned.map((village) => [village.id, village]));
  const transfers = new Map<string, BalanceTransferCandidate & { remainingMerchants: number }>();
  for (const need of needs) {
    const receiver = byId.get(need.villageId);
    if (!receiver) continue;
    let missing = need.amount;
    const donors = surplus
      .filter((entry) => entry.resource === need.resource && entry.amount > 0)
      .map((entry) => ({ entry, donor: byId.get(entry.villageId) }))
      .filter(({ donor }) => donor !== undefined)
      .map(({ entry, donor }) => ({ entry, donor: donor! }))
      .filter(({ donor }) => {
        const distance = villageDistance(donor, receiver);
        return (
          policy.maxDistance <= 0 || distance <= policy.maxDistance || donor.x === undefined || receiver.x === undefined
        );
      })
      .sort((left, right) => villageDistance(left.donor, receiver) - villageDistance(right.donor, receiver));
    for (const { entry, donor } of donors) {
      if (missing <= 0) break;
      const key = `${donor.id}->${receiver.id}`;
      const current = transfers.get(key) ?? {
        donorId: donor.id,
        receiverId: receiver.id,
        wood: 0,
        stone: 0,
        iron: 0,
        merchants: 0,
        remainingMerchants: Math.max(0, donor.merchantsAvailable - policy.reserveMerchants),
      };
      if (current.remainingMerchants <= 0) continue;
      const send = Math.min(missing, entry.amount, current.remainingMerchants * policy.merchantCapacity);
      if (
        send < policy.merchantCapacity * policy.minLoadFactor &&
        current.wood + current.stone + current.iron === 0 &&
        send < missing
      )
        continue;
      if (send <= 0) continue;
      current[need.resource] += send;
      const merchantsUsed = Math.ceil((current.wood + current.stone + current.iron) / policy.merchantCapacity);
      current.remainingMerchants = Math.max(0, donor.merchantsAvailable - policy.reserveMerchants) - merchantsUsed;
      current.merchants = merchantsUsed;
      entry.amount -= send;
      missing -= send;
      transfers.set(key, current);
    }
  }
  return Array.from(transfers.values())
    .filter((transfer) => transfer.wood + transfer.stone + transfer.iron > 0)
    .map(({ remainingMerchants: _ignored, ...transfer }) => transfer);
}
