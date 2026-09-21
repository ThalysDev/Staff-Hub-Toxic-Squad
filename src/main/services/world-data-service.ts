// Serviço de dados do mundo (SG_1): baixa e persiste os map dumps oficiais
// (village/player/ally) do mundo ativo e as relações diplomáticas da tribo do
// jogador. 100% leitura — nenhum acesso aqui modifica estado do jogo.

import { gunzipSync } from 'node:zlib';
import { session } from 'electron';
import { TW_PARTITION, type TwSessionManager } from '../tw/session';
import { detectPageSentinels } from '../tw/request-queue';
import { erroSessao, erroSentinela } from '@shared/error-catalog';
import { JsonStore } from '../stores/json-store';
import type { DiplomacyRelations, WorldAlly, WorldDataStatus, WorldPlayer, WorldVillage } from '@shared/types';
import { buildNickIndex, screenRecipients } from '@shared/recipient-screen';
import type { Journal } from '../journal';
import { parseMapAllyTxt, parseMapPlayerTxt, parseMapVillageTxt } from '@shared/parsers/world-parsers';
import { parseContracts } from '@shared/parsers/ally-parsers';
import {
  capOdaOddHistory,
  diffTribeKills,
  parseKillsTribeFile,
  type TribeKillsSnapshot,
} from '@shared/oda-odd';
import type { OdaOddKind, OdaOddKindOutcome, OdaOddRefreshResult, OdaOddStatus } from '@shared/ipc-types';
import {
  capWorldHistory,
  computeOwnerChanges,
  computeWorldAggregates,
  newWorldVersionId,
  type WorldHistoryVersion,
} from '@shared/world-history';

/** Cache persistido dos map dumps do mundo ativo. */
interface WorldDataCache {
  world: string | null;
  fetchedAt: string | null;
  villages: WorldVillage[];
  players: WorldPlayer[];
  allies: WorldAlly[];
}

/** Histórico versionado do mundo (só agregados por tribo + delta de donos). */
interface WorldHistoryStore {
  versions: WorldHistoryVersion[];
}

/** Store do Painel de Guerra ODA/ODD (userData/stores/oda-odd.json): snapshots
 *  de kills por tribo (arquivo kill_att/def_tribe.txt.gz do mundo). */
interface OdaOddStore {
  world: string | null;
  allyTribeId: number | null;
  /** Snapshots EM ORDEM CRONOLÓGICA (mais recente no FIM), cap por tipo. */
  history: Record<OdaOddKind, TribeKillsSnapshot[]>;
  /** ISO do último DOWNLOAD por arquivo ('' = nunca) — base da guarda de 1h. */
  lastFetch: Record<OdaOddKind, string>;
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
/** Regra da API oficial: no MÁXIMO 1 download por hora por arquivo de kills —
 *  refresh dentro da janela reusa a última leitura (reportado como 'cache'). */
const ODA_REFETCH_MIN_INTERVAL_MS = 60 * 60_000;
/** Arquivos de kills, na ordem de download (um por vez, com pacing). */
const ODA_KINDS: readonly OdaOddKind[] = ['att', 'def'];

/** Factory (NÃO constante): o JsonStore devolve o fallback ELE MESMO quando o
 *  arquivo ainda não existe — um objeto module-level compartilhado vazaria
 *  snapshots entre instâncias/testes (arrays aninhados por referência). */
const emptyOdaOddStore = (): OdaOddStore => ({
  world: null,
  allyTribeId: null,
  history: { att: [], def: [] },
  lastFetch: { att: '', def: '' },
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WorldDataService {
  private readonly store: JsonStore<WorldDataCache>;
  private readonly historyStore: JsonStore<WorldHistoryStore>;
  private readonly odaOddStore: JsonStore<OdaOddStore>;
  private relationsCache: { at: number; data: DiplomacyRelations } | null = null;
  private lastDirectFetchAt = 0;
  /** Refresh em andamento (single-flight): 2º chamador reusa a mesma promise. */
  private refreshing: Promise<WorldDataStatus> | null = null;
  /** Refresh de ODA/ODD em andamento (single-flight idem refresh()). */
  private odaRefreshing: Promise<OdaOddRefreshResult> | null = null;

  constructor(
    private readonly twSession: TwSessionManager,
    private readonly journal?: Journal,
    /** Fila compartilhada (C4): o refresh roda FORA da fila (gzip/bytes crus),
     * mas entre downloads consulta o cancelamento da barra de progresso. Lazy
     * porque a RequestQueue é criada depois dos services no boot. */
    private readonly isCancelled?: () => boolean,
  ) {
    // Compacto: o dump tem ~100k aldeias — stringify indentado trava o main.
    this.store = new JsonStore<WorldDataCache>('world-data', EMPTY_WORLD_CACHE, { compact: true });
    this.historyStore = new JsonStore<WorldHistoryStore>('world-history', { versions: [] }, { compact: true });
    // ODA/ODD é pequeno (≤120 snapshots) — gravação legível, sem compact.
    this.odaOddStore = new JsonStore<OdaOddStore>('oda-odd', emptyOdaOddStore());
  }

  /** Mundo ativo da sessão; fail-closed com mensagem clara se não houver login. */
  world(): string {
    const { state, world } = this.twSession.getStatus();
    if (state !== 'logged-in' || world === null) {
      throw new Error(erroSessao());
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
        if (sentinel !== null) {
          throw new Error(erroSentinela(sentinel));
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

  /** Cancelamento do refresh pela barra de progresso (fila compartilhada):
   * entre um download e o outro o usuário pode abortar — erro LIMPO de
   * operação cancelada (não é falha de rede nem de formato). */
  private assertRefreshNotCancelled(): void {
    if (this.isCancelled?.() === true) {
      throw new Error('Atualização dos dados do mundo cancelada.');
    }
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

    this.assertRefreshNotCancelled();
    const villageResponse = await fetchDump('/map/village.txt.gz', 'village.txt.gz');
    this.assertRefreshNotCancelled();
    const playerResponse = await fetchDump('/map/player.txt', 'player.txt');
    this.assertRefreshNotCancelled();
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
      throw new Error(`Map dados do mundo com formato inesperado: ${error instanceof Error ? error.message : String(error)}`);
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

    // Histórico do mundo (roadmap 18): arquiva agregados por tribo + o DELTA de
    // donos vs o dump anterior ANTES de sobrescrevê-lo — o dump completo (270k
    // aldeias) nunca é versionado, só o que mudou. Falha aqui NÃO derruba o
    // refresh (histórico é best-effort; o dump atual é o que importa).
    try {
      const previous = await this.store.load();
      const collectedAt = new Date().toISOString();
      const changes =
        previous.world === world && previous.villages.length > 0
          ? computeOwnerChanges(previous.villages, villages)
          : [];
      const version: WorldHistoryVersion = {
        id: newWorldVersionId(),
        collectedAt,
        world,
        tribes: computeWorldAggregates(villages, allies),
        changesSincePrevious: changes,
      };
      const history = await this.historyStore.load();
      // capWorldHistory espera ordem cronológica (mais recente no FIM).
      await this.historyStore.save({ versions: capWorldHistory([...history.versions, version]) });
      // Arquivamento com rastro no journal (best-effort) — igual ao
      // troops-history; falha do journal nunca derruba o refresh.
      try {
        await this.journal?.append('system', 'worldhistory-archive', `mundo=${world} tribos=${version.tribes.length} mudancas=${changes.length}`, false);
      } catch {
        // best-effort
      }
    } catch (error) {
      // best-effort MAS nunca silencioso: dump repetidamente corrompido
      // (ex.: coord duplicada do fail-closed) pararia o histórico sem rastro.
      console.warn('[world-history] falha ao arquivar versão do mundo:', error);
      try {
        await this.journal?.append('system', 'worldhistory-archive-erro', error instanceof Error ? error.message : String(error), false);
      } catch {
        // best-effort
      }
    }

    await this.store.save({ world, fetchedAt: new Date().toISOString(), villages, players, allies });
    return this.status();
  }

  /** Versões do histórico do mundo ATIVO, mais recente primeiro (roadmap 18).
   *  Nunca mistura mundos: versões de outro mundo ficam no store mas não são
   *  expostas (o diff cruzado mostraria números sem sentido). */
  async history(): Promise<WorldHistoryVersion[]> {
    const history = await this.historyStore.load();
    const currentWorld = this.world();
    // Store em ordem cronológica (cap mantém as últimas no fim) — filtra pelo
    // mundo atual e inverte p/ a UI.
    return [...history.versions].reverse().filter((version) => version.world === currentWorld);
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

  /** Triagem de destinatários de MP contra o mundo + a diplomacia da tribo
   *  (v0.36.1 — caso real: MP saiu para jogador que saiu da tribo e virou
   *  inimigo; o roster vinha de OP persistida). Falha se o cache não existe. */
  async screenRecipients(nicks: readonly string[]) {
    const data = await this.requireCache();
    const currentWorld = this.world();
    if (data.world && data.world !== currentWorld) {
      throw new Error(
        `Dados do mundo em cache são de ${data.world} — a sessão atual é ${currentWorld}. Atualize os dados do mundo.`,
      );
    }
    const relations = await this.relations().catch(() => null);
    return screenRecipients(nicks, buildNickIndex(data.players), relations);
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

  // -------------------------------------------------------------------------
  // Painel de Guerra ODA/ODD (kill_att/def_tribe.txt.gz)
  // -------------------------------------------------------------------------

  /** Estado local do painel, SEM rede (canal oda:status é ungated — leitura de
   *  store). Nunca mistura mundos: store de outro mundo devolve vazio (o
   *  histórico antigo permanece no disco, igual à régua de history()). */
  async odaStatus(): Promise<OdaOddStatus> {
    const data = await this.odaOddStore.load();
    const sessionWorld = this.twSession.getStatus().world;
    if (data.world === null || (sessionWorld !== null && data.world !== sessionWorld)) {
      return {
        world: sessionWorld ?? data.world,
        allyTribeId: null,
        history: { att: [], def: [] },
        lastFetch: { att: '', def: '' },
      };
    }
    return {
      world: data.world,
      allyTribeId: data.allyTribeId,
      history: { att: [...data.history.att], def: [...data.history.def] },
      lastFetch: { ...data.lastFetch },
    };
  }

  /** Refresh do painel: para cada arquivo (att/def), reusa o cache dentro da
   *  janela de 1h da API ou baixa o dump oficial (mesmas convenções dos dumps
   *  do refresh(): fora da RequestQueue, pacing + 3 tentativas, 4xx fatal).
   *  Single-flight; cada kind persiste NA HORA para um download nunca se
   *  repetir dentro da janela de 1h, mesmo que o outro arquivo falhe. */
  async odaRefresh(tribeId: number): Promise<OdaOddRefreshResult> {
    if (!Number.isSafeInteger(tribeId) || tribeId <= 0) {
      throw new Error('ID da tribo inválido — use o número do perfil da tribo no jogo (ex.: 123).');
    }
    if (this.odaRefreshing !== null) return this.odaRefreshing;
    this.odaRefreshing = this.doOdaRefresh(tribeId).finally(() => {
      this.odaRefreshing = null;
    });
    return this.odaRefreshing;
  }

  private async doOdaRefresh(tribeId: number): Promise<OdaOddRefreshResult> {
    const world = this.world();
    const store = await this.odaOddStore.load();
    // Troca de mundo: kills comparados entre mundos não significam nada —
    // zera o painel antes de arquivar o mundo novo (mesma régua de history()).
    if (store.world !== world) {
      store.world = world;
      store.allyTribeId = null;
      store.history = { att: [], def: [] };
      store.lastFetch = { att: '', def: '' };
    }

    const outcomes: OdaOddKindOutcome[] = [];
    const failures: string[] = [];
    for (const kind of ODA_KINDS) {
      const file = `kill_${kind}_tribe.txt.gz`;
      const label = kind === 'att' ? 'ODA' : 'ODD';
      try {
        const history = store.history[kind];
        const lastFetchIso = store.lastFetch[kind];
        const ageMs = lastFetchIso === '' ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(lastFetchIso);
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ODA_REFETCH_MIN_INTERVAL_MS) {
          // Guarda da API (1 download/hora/arquivo): reusa a última leitura.
          const latest = history[history.length - 1];
          if (latest === undefined) {
            throw new Error(`marca de download de ${file} existe sem snapshot no histórico — store oda-odd inconsistente.`);
          }
          const delta = diffTribeKills(history[history.length - 2] ?? null, latest.kills)?.delta ?? null;
          outcomes.push({ kind, source: 'cache', kills: latest.kills, delta });
          continue;
        }
        this.assertRefreshNotCancelled();
        const text = await this.fetchKillsDump(`https://${world}.tribalwars.com.br/map/${file}`, file);
        // Fail-closed: dump malformado não vira snapshot.
        const rows = parseKillsTribeFile(text);
        const row = rows.find((candidate) => candidate.tribeId === tribeId);
        if (row === undefined) {
          throw new Error(
            `tribo ${tribeId} não está no ranking de ${kind === 'att' ? 'kills ofensivos' : 'kills defensivos'} do mundo ${world} — confira o ID no perfil da tribo no jogo.`,
          );
        }
        const fetchedAt = new Date().toISOString();
        const delta = diffTribeKills(history[history.length - 1] ?? null, row.kills)?.delta ?? null;
        // Persiste ANTES do próximo kind: se o segundo arquivo falhar, o
        // download deste não se repete dentro da janela de 1h da API.
        // Cópia rasa dos Record antes de escrever: o load() do JsonStore pode
        // devolver os objetos aninhados do FALLBACK module-level (primeira
        // execução, sem arquivo) — mutá-los vazaria estado entre instâncias.
        const nextHistory = { ...store.history };
        nextHistory[kind] = capOdaOddHistory([...history, { fetchedAt, kills: row.kills }]);
        store.history = nextHistory;
        store.lastFetch = { ...store.lastFetch, [kind]: fetchedAt };
        await this.odaOddStore.save(store);
        outcomes.push({ kind, source: 'fetched', kills: row.kills, delta });
      } catch (error) {
        failures.push(`${label} (${file}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (outcomes.length === 0) {
      throw new Error(`Falha ao atualizar os ODs da tribo ${tribeId}: ${failures.join(' · ')}`);
    }
    store.allyTribeId = tribeId;
    await this.odaOddStore.save(store);

    // Journal best-effort (padrão do serviço): um rastro por refresh.
    const describe = (outcome: OdaOddKindOutcome): string => {
      const label = outcome.kind === 'att' ? 'ODA' : 'ODD';
      const value =
        outcome.delta === null
          ? `1a leitura (${outcome.kills} kills)`
          : `${outcome.delta >= 0 ? '+' : '-'}${Math.abs(outcome.delta)} kills`;
      return `${label} ${value}${outcome.source === 'cache' ? ' (cache)' : ''}`;
    };
    try {
      await this.journal?.append('read', 'oda-refresh', `${outcomes.map(describe).join(' / ')} (tribe ${tribeId})`, false);
    } catch {
      // Journal é best-effort: nunca derruba o refresh.
    }
    if (failures.length > 0) {
      // Sucesso parcial: o que deu certo já está persistido/journalado; o erro
      // sobe contextualizado para a UI mostrar o arquivo que falhou.
      throw new Error(`OD parcialmente atualizado — ${failures.join(' · ')}`);
    }
    return { tribeId, outcomes };
  }

  /** Download de um kill_*_tribe.txt.gz: mesmas convenções do fetchDump do
   *  refresh() de dumps — FORA da RequestQueue (bytes crus de gzip), pacing
   *  humano + 3 tentativas em falha transitória, 4xx é erro fatal. */
  private async fetchKillsDump(url: string, what: string): Promise<string> {
    const ses = session.fromPartition(TW_PARTITION);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.paceDirectFetch();
      const response = await ses.fetch(url, { redirect: 'follow' });
      if (response.ok) {
        try {
          // Mesmo helper do refresh(): gunzipSync sobre os bytes crus.
          return gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf-8');
        } catch (error) {
          throw new Error(`${what} ilegível (não é gzip válido): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      lastError = new Error(`Falha ao baixar ${what}: HTTP ${response.status}`);
      if (response.status >= 400 && response.status < 500) throw lastError;
      await sleep(500 * (attempt + 1));
    }
    throw lastError ?? new Error(`Falha ao baixar ${what}`);
  }
}