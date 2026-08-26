// Serviço de dados do mundo (SG_1): baixa e persiste os map dumps oficiais
// (village/player/ally) do mundo ativo e as relações diplomáticas da tribo do
// jogador. 100% leitura — nenhum acesso aqui modifica estado do jogo.

import { gunzipSync } from 'node:zlib';
import { session } from 'electron';
import { TW_PARTITION, type TwSessionManager } from '../tw/session';
import { detectPageSentinels } from '../tw/request-queue';
import { JsonStore } from '../stores/json-store';
import type { DiplomacyRelations, WorldAlly, WorldDataStatus, WorldPlayer, WorldVillage } from '@shared/types';
import { parseMapAllyTxt, parseMapPlayerTxt, parseMapVillageTxt } from '@shared/parsers/world-parsers';
import { parseContracts } from '@shared/parsers/ally-parsers';

/** Cache persistido dos map dumps do mundo ativo. */
interface WorldDataCache {
  world: string | null;
  fetchedAt: string | null;
  villages: WorldVillage[];
  players: WorldPlayer[];
  allies: WorldAlly[];
}

const EMPTY_WORLD_CACHE: WorldDataCache = {
  fetchedAt: null,
  villages: [],
  players: [],
  allies: [],
 world: null };

/** Relações diplomáticas cacheadas em memória (TTL de 5 minutos). */
const RELATIONS_CACHE_MS = 5 * 60_000;
/** Pacing humano mínimo entre QUALQUER fetch direto deste serviço (política AGENTS.md). */
const DIRECT_FETCH_MIN_INTERVAL_MS = 350;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WorldDataService {
  private readonly store: JsonStore<WorldDataCache>;
  private relationsCache: { at: number; data: DiplomacyRelations } | null = null;
  private lastDirectFetchAt = 0;
  /** Refresh em andamento (single-flight): 2º chamador reusa a mesma promise. */
  private refreshing: Promise<WorldDataStatus> | null = null;

  constructor(private readonly twSession: TwSessionManager) {
    this.store = new JsonStore<WorldDataCache>('world-data', EMPTY_WORLD_CACHE);
  }

  /** Mundo ativo da sessão; fail-closed com mensagem clara se não houver login. */
  world(): string {
    const { state, world } = this.twSession.getStatus();
    if (state !== 'logged-in' || world === null) {
      throw new Error('Nenhuma sessão ativa no jogo — faça login (ou importe o sid) antes de continuar.');
    }
    return world;
  }

  /** Pacing entre fetches diretos (mesmo fora da RequestQueue — política permanente). */
  private async paceDirectFetch(): Promise<void> {
    const elapsed = Date.now() - this.lastDirectFetchAt;
    if (elapsed < DIRECT_FETCH_MIN_INTERVAL_MS) {
      await sleep(DIRECT_FETCH_MIN_INTERVAL_MS - elapsed);
    }
    this.lastDirectFetchAt = Date.now();
  }

  /** Fetch autenticado pela partição persist:tw com pacing + retry de leitura
   * (3 tentativas em falha transitória) + sentinelas de sessão/captcha. */
  async fetchGame(url: string): Promise<string> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.paceDirectFetch();
      const result = await this.twSession.fetchForQueue(url);
      if (result.ok) {
        const sentinel = detectPageSentinels(result.body);
        if (sentinel === 'session-expired') {
          throw new Error('Sessão expirada — faça login novamente e tente de novo.');
        }
        if (sentinel === 'captcha-suspected') {
          throw new Error('Captcha detectado — resolva na janela de login e tente de novo.');
        }
        return result.body;
      }
      if (result.status >= 400 && result.status < 500) {
        throw new Error(`HTTP ${result.status} ao acessar ${url}`);
      }
      lastError = new Error(`HTTP ${result.status} ao acessar ${url}`);
      await sleep(500 * (attempt + 1));
    }
    throw lastError ?? new Error(`Falha ao acessar ${url}`);
  }

  /**
   * Baixa os map dumps oficiais do mundo ativo e grava o cache local.
   * Single-flight: chamadas concorrentes compartilham o download em andamento
   * (sem downloads duplicados nem saves corrompíveis).
   * village.txt.gz é um arquivo gzip binário: sai pelo session.fetch da
   * partição direto (bytes crus + gunzipSync) — o fetchForQueue decodificaria
   * o corpo como texto e corromperia o gzip.
   */
  async refresh(): Promise<WorldDataStatus> {
    if (this.refreshing !== null) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<WorldDataStatus> {
    const world = this.world();
    const base = `https://${world}.tribalwars.com.br`;
    const ses = session.fromPartition(TW_PARTITION);

    // Sequencial com pacing (política): dumps em paralelo disparariam 3 hits
    // simultâneos no servidor sem intervalo humano entre eles.
    const fetchDump = async (path: string, what: string): Promise<Response> => {
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.paceDirectFetch();
        const response = await ses.fetch(`${base}${path}`, { redirect: 'follow' });
        if (response.ok) return response;
        lastError = new Error(`Falha ao baixar ${what}: HTTP ${response.status}`);
        if (response.status >= 400 && response.status < 500) throw lastError;
        await sleep(500 * (attempt + 1));
      }
      throw lastError ?? new Error(`Falha ao baixar ${what}`);
    };

    const villageResponse = await fetchDump('/map/village.txt.gz', 'village.txt.gz');
    const playerResponse = await fetchDump('/map/player.txt', 'player.txt');
    const allyResponse = await fetchDump('/map/ally.txt', 'ally.txt');

    let villageText: string;
    try {
      villageText = gunzipSync(Buffer.from(await villageResponse.arrayBuffer())).toString('utf-8');
    } catch (error) {
      throw new Error(`village.txt.gz ilegível (não é gzip válido): ${error instanceof Error ? error.message : String(error)}`);
    }
    const playerText = await playerResponse.text();
    const allyText = await allyResponse.text();

    let villages: WorldVillage[];
    let players: WorldPlayer[];
    let allies: WorldAlly[];
    try {
      villages = parseMapVillageTxt(villageText);
      players = parseMapPlayerTxt(playerText);
      allies = parseMapAllyTxt(allyText);
    } catch (error) {
      throw new Error(`Map dump do mundo com formato inesperado: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (villages.length === 0) {
      throw new Error('village.txt.gz veio sem nenhuma aldeia — dump incompleto; tente de novo e reporte se persistir.');
    }
    // Enriquece cada aldeia com a tribo do dono (player.txt) para o mapa
    // mundial colorir por tribo sem join no renderer.
    const playerAlly = new Map<number, number>(players.map((p) => [p.id, p.allyId]));
    for (const village of villages) {
      village.allyId = playerAlly.get(village.playerId) ?? 0;
    }

    await this.store.save({ world, fetchedAt: new Date().toISOString(), villages, players, allies });
    return this.status();
  }

  async status(): Promise<WorldDataStatus> {
    const data = await this.store.load();
    return {
      fetchedAt: data.fetchedAt,
      villageCount: data.villages.length,
      playerCount: data.players.length,
      allyCount: data.allies.length,
    };
  }

  /** Aldeias do cache; erro claro se o mundo ainda não foi baixado ou é de outro mundo. */
  async villages(): Promise<WorldVillage[]> {
    const data = await this.requireCache();
    const currentWorld = this.world();
    if (data.world && data.world !== currentWorld) {
      throw new Error(`Dados do mundo em cache são de ${data.world} — a sessão atual é ${currentWorld}. Clique em "Atualizar dados do mundo".`);
    }
    return data.villages;
  }

  /** Jogadores do cache (uso interno do SG_1: tribo → jogadores → aldeias). */
  async players(): Promise<WorldPlayer[]> {
    const data = await this.requireCache();
    const currentWorld = this.world();
    if (data.world && data.world !== currentWorld) {
      throw new Error(`Dados do mundo em cache são de ${data.world} — a sessão atual é ${currentWorld}. Atualize os dados do mundo.`);
    }
    return data.players;
  }

  /** Tribos do cache. */
  async tribes(): Promise<WorldAlly[]> {
    const data = await this.requireCache();
    const currentWorld = this.world();
    if (data.world && data.world !== currentWorld) {
      throw new Error(`Dados do mundo em cache são de ${data.world} — a sessão atual é ${currentWorld}. Atualize os dados do mundo.`);
    }
    return data.allies;
  }

  private async requireCache(): Promise<WorldDataCache> {
    const data = await this.store.load();
    if (data.fetchedAt === null) {
      throw new Error('Dados do mundo ainda não baixados — execute "Atualizar Dados do Mundo" primeiro.');
    }
    return data;
  }

  /** Relações diplomáticas da tribo do jogador (screen=ally&mode=contracts),
   * cacheadas em memória por 5 minutos. */
  async relations(): Promise<DiplomacyRelations> {
    const now = Date.now();
    if (this.relationsCache !== null && now - this.relationsCache.at < RELATIONS_CACHE_MS) {
      return this.relationsCache.data;
    }
    const world = this.world();
    const html = await this.fetchGame(`https://${world}.tribalwars.com.br/game.php?screen=ally&mode=contracts`);
    let relations: DiplomacyRelations;
    try {
      relations = parseContracts(html);
    } catch (error) {
      throw new Error(`Página de diplomacia com formato inesperado: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A página de contratos expõe o NOME da própria tribo, não a tag — a tag
    // verdadeira vem do dump ally.txt pelo ownAllyId.
    try {
      const data = await this.store.load();
      const ownAlly = data.allies.find((ally) => ally.id === relations.ownAllyId);
      if (ownAlly) relations.ownTag = ownAlly.tag;
    } catch {
      // sem dump ainda: segue com o que a página deu
    }
    this.relationsCache = { at: now, data: relations };
    return relations;
  }
}