// Serviço da Análise de Aldeias e Distâncias (SG_1): resolve as tribos das
// tags do formulário contra os map dumps do mundo e calcula os buckets de
// tempo de nobre com a engine compartilhada. 100% leitura — nenhum acesso
// aqui modifica estado do jogo.

import { JsonStore } from '../stores/json-store';
import type { WorldDataService } from './world-data-service';
import type { Sg1Input, Sg1Result, UnitInfo } from '@shared/types';
import {
  buildEnemySet,
  computeSg1Buckets,
  effectiveNobleMinutesPerField,
} from '@shared/sg1-engine';
import { parseUnitInfoXml } from '@shared/parsers/world-parsers';
import { parseWorldConfigXml, type WorldConfig } from '@shared/world-config';

/** TTL dos caches de get_unit_info/get_config (únicos e raros — 1 dia). */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface CachedUnitInfo {
  fetchedAt: string | null;
  world: string | null;
  units: Record<string, UnitInfo>;
}

interface CachedWorldConfig {
  fetchedAt: string | null;
  world: string | null;
  config: WorldConfig | null;
}

export class Sg1Service {
  private readonly unitInfoStore: JsonStore<CachedUnitInfo>;
  private readonly worldConfigStore: JsonStore<CachedWorldConfig>;

  constructor(private readonly worldData: WorldDataService) {
    this.unitInfoStore = new JsonStore<CachedUnitInfo>('unit-info', { fetchedAt: null, world: null, units: {} });
    this.worldConfigStore = new JsonStore<CachedWorldConfig>('world-config', {
      fetchedAt: null,
      world: null,
      config: null,
    });
  }

  async analyze(input: Sg1Input): Promise<Sg1Result> {
    const world = this.worldData.world();
    const [allVillages, allPlayers, allAllies] = await Promise.all([
      this.worldData.villages(),
      this.worldData.players(),
      this.worldData.tribes(),
    ]);

    // — Tribo própria (TAG TRIBO ANALISADA): tag → id da tribo → ids dos
    // jogadores (player.txt) → aldeias daqueles jogadores (village.txt).
    const ownAlly = allAllies.find((ally) => ally.tag === input.ownTag);
    if (ownAlly === undefined) {
      throw new Error(`Tribo "${input.ownTag}" não encontrada no dump do mundo — confira a TAG TRIBO ANALISADA.`);
    }
    const ownPlayerIds = new Set(allPlayers.filter((player) => player.allyId === ownAlly.id).map((player) => player.id));
    const ownVillages = allVillages.filter((village) => ownPlayerIds.has(village.playerId));

    // — Tribos inimigas (TAG TRIBOS INIMIGAS): mesmo caminho; a engine aplica
    // os consider/desconsider e monta os conjuntos finais (próprios + inimigos).
    const enemyAllyIds = new Set<number>();
    for (const tag of input.enemyTags) {
      const ally = allAllies.find((candidate) => candidate.tag === tag);
      if (ally === undefined) {
        throw new Error(`Tribo inimiga "${tag}" não encontrada no dump do mundo — confira as tags informadas.`);
      }
      enemyAllyIds.add(ally.id);
    }
    const enemyPlayerIds = new Set(allPlayers.filter((player) => enemyAllyIds.has(player.allyId)).map((player) => player.id));
    const enemyTagVillages = allVillages.filter((village) => enemyPlayerIds.has(village.playerId));

    const sets = buildEnemySet(ownVillages, enemyTagVillages, {
      kEnemyDiscard: input.kEnemyDiscard,
      enemyCoordsDiscard: input.enemyCoordsDiscard,
      enemyCoordsConsider: input.enemyCoordsConsider,
      allyCoordsConsider: input.allyCoordsConsider,
    });
    if (sets.enemy.length === 0) {
      throw new Error('Conjunto inimigo vazio após os filtros — informe tags inimigas ou coordenadas consideradas.');
    }
    if (sets.own.length === 0) {
      throw new Error('Conjunto próprio vazio após os filtros — confira a TAG TRIBO ANALISADA.');
    }

    // — Tempo de nobre: velocidade do Nobre (get_unit_info) + configuração do
    // mundo (get_config), ambos cacheados 1 dia.
    const units = await this.unitInfo(world);
    const snob = units.snob;
    if (snob === undefined) {
      throw new Error('get_unit_info sem dados do Nobre — configuração de unidades inesperada.');
    }
    const config = await this.worldConfig(world);
    const nobleMinutesPerField = effectiveNobleMinutesPerField(snob.speed, config.speed, config.unitSpeed);
    // kDesired vazio = todos os continentes; a engine só filtra quando o array
    // é fornecido (um [] filtraria tudo).
    const buckets = computeSg1Buckets(
      {
        ownVillages: sets.own,
        enemyVillages: sets.enemy,
        nobleMinutesPerField,
      },
      input.kDesired.length > 0 ? { kDesiredFilter: input.kDesired } : undefined,
    );

    return {
      generatedAt: new Date().toISOString(),
      ownVillageCount: sets.own.length,
      enemyVillageCount: sets.enemy.length,
      nobleMinutesPerField,
      buckets,
    };
  }

  /** Minutos por campo do NOBRE no mundo ativo (efetivo, com speed/unit_speed).
   * Reuso público do SG_4 (planilha/distribuição em horas de nobre). */
  async nobleMinutesPerField(): Promise<number> {
    const world = this.worldData.world();
    const units = await this.unitInfo(world);
    const snob = units.snob;
    if (snob === undefined) {
      throw new Error('get_unit_info sem dados do Nobre — configuração de unidades inesperada.');
    }
    const config = await this.worldConfig(world);
    return effectiveNobleMinutesPerField(snob.speed, config.speed, config.unitSpeed);
  }

  /** Unidades do mundo (interface.php?func=get_unit_info), cache 1 dia por mundo. */
  private async unitInfo(world: string): Promise<Record<string, UnitInfo>> {
    const cached = await this.unitInfoStore.load();
    if (cached.fetchedAt !== null && cached.world === world && Date.now() - Date.parse(cached.fetchedAt) < ONE_DAY_MS) {
      return cached.units;
    }
    const xml = await this.worldData.fetchGame(`https://${world}.tribalwars.com.br/interface.php?func=get_unit_info`);
    let units: Record<string, UnitInfo>;
    try {
      units = parseUnitInfoXml(xml);
    } catch (error) {
      throw new Error(`get_unit_info com formato inesperado: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.unitInfoStore.save({ fetchedAt: new Date().toISOString(), world, units });
    return units;
  }

  /** Configuração do mundo (interface.php?func=get_config), cache 1 dia por mundo. */
  private async worldConfig(world: string): Promise<WorldConfig> {
    const cached = await this.worldConfigStore.load();
    if (
      cached.fetchedAt !== null &&
      cached.world === world &&
      cached.config !== null &&
      Date.now() - Date.parse(cached.fetchedAt) < ONE_DAY_MS
    ) {
      return cached.config;
    }
    const xml = await this.worldData.fetchGame(`https://${world}.tribalwars.com.br/interface.php?func=get_config`);
    let config: WorldConfig;
    try {
      config = parseWorldConfigXml(world, xml);
    } catch (error) {
      throw new Error(`get_config com formato inesperado: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.worldConfigStore.save({ fetchedAt: new Date().toISOString(), world, config });
    return config;
  }
}