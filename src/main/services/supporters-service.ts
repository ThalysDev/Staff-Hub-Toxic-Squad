import { parseIncomingCommandRows, type IncomingCommandRow } from '@shared/parsers/village-parsers';
import type { WorldDataService } from './world-data-service';
import type { RequestQueue } from '../tw/request-queue';
import { QueueError } from '../tw/request-queue';
import type { TwSessionManager } from '../tw/session';
import type { Journal } from '../journal';
import { JsonStore } from '../stores/json-store';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc-types';

import type { SupportersResult, VillageSupportersResult } from '@shared/types';

/**
 * Exibir apoiadores (SG_3): para cada aldeia, lê a página info_village e lista
 * quem tem comandos compartilhados chegando (suportes). OPT-IN e com aviso de
 * volume: 1 requisição por aldeia via RequestQueue (pacing/teto/sentinelas).
 */
export class SupportersService {
  private readonly settingsStore: JsonStore<AppSettings>;

  constructor(
    private readonly twSession: TwSessionManager,
    private readonly queue: RequestQueue,
    private readonly journal: Journal,
    private readonly worldData: WorldDataService,
  ) {
    this.settingsStore = new JsonStore<AppSettings>('settings', DEFAULT_SETTINGS);
  }

  private world(): string {
    const { state, world } = this.twSession.getStatus();
    if (state !== 'logged-in' || world === null) {
      throw new Error('Nenhuma sessão ativa no jogo — faça login antes de consultar apoiadores.');
    }
    return world;
  }

  async supporters(coords: string[]): Promise<SupportersResult> {
    if (coords.length === 0) throw new Error('Nenhuma coordenada informada.');
    const settings = await this.settingsStore.load();
    const ceiling = Number.isFinite(Number(settings.requestCeiling)) ? Math.max(1, Number(settings.requestCeiling)) : DEFAULT_SETTINGS.requestCeiling;
    const world = this.world();

    // Resolve coordenada → aldeia (id + dono) pelo dump do mundo.
    const [villages, players] = await Promise.all([this.worldData.villages(), this.worldData.players()]);
    const villageByCoord = new Map(villages.map((v) => [`${v.x}|${v.y}`, v]));
    const playerById = new Map(players.map((p) => [p.id, p]));
    const missing = coords.filter((coord) => !villageByCoord.has(coord));
    if (missing.length > 0) {
      throw new Error(`Coordenada(s) sem aldeia no dump: ${missing.slice(0, 5).join(' ')} — atualize os dados do mundo.`);
    }

    const urls = coords.map((coord) => {
      const village = villageByCoord.get(coord)!;
      return `https://${world}.tribalwars.com.br/game.php?screen=info_village&id=${village.id}`;
    });
    let bodies: string[];
    try {
      bodies = await this.queue.run(urls, { label: `Apoiadores (${coords.length} aldeias)`, ceiling });
    } catch (error) {
      if (error instanceof QueueError && error.kind === 'ceiling-exceeded') {
        throw new Error(`Consulta maior que o teto (${ceiling}) — reduza a lista ou aumente o teto em Configurações.`);
      }
      throw error;
    }

    const result: VillageSupportersResult[] = coords.map((coord, index) => {
      const village = villageByCoord.get(coord)!;
      const owner = village.playerId === 0 ? null : playerById.get(village.playerId) ?? null;
      const rows: IncomingCommandRow[] = parseIncomingCommandRows(bodies[index] ?? '');
      const supports = rows.filter((row) => row.type === 'support');
      const byPlayer = new Map<string, number>();
      for (const row of supports) byPlayer.set(row.playerName, (byPlayer.get(row.playerName) ?? 0) + 1);
      const supporters = [...byPlayer.entries()]
        .map(([playerName, count]) => ({
          playerName,
          count,
          selfSupport: owner !== null && owner.name === playerName,
        }))
        .sort((a, b) => b.count - a.count || a.playerName.localeCompare(b.playerName, 'pt-BR'));
      return {
        coord,
        villageName: village.name,
        ownerName: owner?.name ?? null,
        supporters,
        totalSupports: supports.length,
      };
    });

    await this.journal.append(
      'read',
      'sg3-supporters',
      `${coords.length} aldeias — ${result.reduce((sum, v) => sum + v.totalSupports, 0)} suportes compartilhados`,
      true,
    );
    return { generatedAt: new Date().toISOString(), villages: result };
  }
}
