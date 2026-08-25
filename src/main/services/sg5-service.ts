import { parseIncomingCommandRows, totalsByPlayer, type IncomingCommandRow, type PlayerCommandTotal } from '@shared/parsers/village-parsers';
import type { WorldDataService } from './world-data-service';
import type { RequestQueue } from '../tw/request-queue';
import { QueueError } from '../tw/request-queue';
import type { TwSessionManager } from '../tw/session';
import type { Journal } from '../journal';
import type { AppSettings } from '@shared/ipc-types';
import { DEFAULT_SETTINGS } from '@shared/ipc-types';
import { JsonStore } from '../stores/json-store';

export interface VerifyEntry {
  playerName: string;
  coords: string[];
}

export interface VillageVerification {
  coord: string;
  /** Comandos compartilhados chegando (todos os tipos). */
  commands: IncomingCommandRow[];
}

export interface VerifyResult {
  generatedAt: string;
  villages: VillageVerification[];
  /** Comandos que não pertencem a nenhum jogador informado (útil p/ cobrar). */
  unknown: IncomingCommandRow[];
}

/**
 * Conferência de comandos (SG_5): 1 requisição por aldeia-alvo (info_village),
 * sempre pela RequestQueue — pacing humano, teto, cancelamento e sentinelas.
 * Requer que os membros compartilhem comandos com a liderança no jogo.
 */
export class Sg5Service {
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
      throw new Error('Nenhuma sessão ativa no jogo — faça login antes de verificar comandos.');
    }
    return world;
  }

  private async ceiling(): Promise<number> {
    const raw = await this.settingsStore.load();
    const value = Number(raw.requestCeiling);
    return Number.isFinite(value) && value >= 1 ? Math.round(value) : DEFAULT_SETTINGS.requestCeiling;
  }

  private async coordToVillageId(): Promise<Map<string, number>> {
    const villages = await this.worldData.villages();
    const map = new Map<string, number>();
    for (const village of villages) map.set(`${village.x}|${village.y}`, village.id);
    return map;
  }

  private async fetchVillagePages(coords: string[], label: string): Promise<Map<string, IncomingCommandRow[]>> {
    const world = this.world();
    const idByCoord = await this.coordToVillageId();
    const missing = coords.filter((coord) => !idByCoord.has(coord));
    if (missing.length > 0) {
      throw new Error(`Coordenada(s) sem aldeia no dump do mundo: ${missing.slice(0, 5).join(' ')}${missing.length > 5 ? ' …' : ''} — atualize os dados do mundo.`);
    }
    const urls = coords.map((coord) => `https://${world}.tribalwars.com.br/game.php?screen=info_village&id=${idByCoord.get(coord)}`);
    const ceiling = await this.ceiling();
    let bodies: string[];
    try {
      bodies = await this.queue.run(urls, { label, ceiling });
    } catch (error) {
      if (error instanceof QueueError && error.kind === 'ceiling-exceeded') {
        throw new Error(`Verificação maior que o teto (${ceiling} requisições) — aumente o teto em Configurações.`);
      }
      throw error;
    }
    const byCoord = new Map<string, IncomingCommandRow[]>();
    coords.forEach((coord, index) => {
      const body = bodies[index];
      if (body !== undefined) byCoord.set(coord, parseIncomingCommandRows(body));
    });
    return byCoord;
  }

  /** Verificação alvo-a-alvo: "nick;coords" (saída da distribuição do SG_4). */
  async verify(entries: VerifyEntry[]): Promise<VerifyResult> {
    if (entries.length === 0) {
      throw new Error('Nenhuma entrada informada — cole as linhas "nick;coord coord".');
    }
    const expectedPlayers = new Set(entries.map((entry) => entry.playerName));
    const allCoords = [...new Set(entries.flatMap((entry) => entry.coords))];
    if (allCoords.length === 0) {
      throw new Error('Nenhuma coordenada de alvo informada.');
    }
    const byCoord = await this.fetchVillagePages(allCoords, `Verificando comandos (${allCoords.length} aldeias)`);
    const villages: VillageVerification[] = [];
    const unknown: IncomingCommandRow[] = [];
    for (const coord of allCoords) {
      const commands = byCoord.get(coord) ?? [];
      villages.push({ coord, commands });
      for (const command of commands) {
        if (!expectedPlayers.has(command.playerName)) unknown.push(command);
      }
    }
    await this.journal.append('read', 'sg5-verify', `${allCoords.length} aldeias — ${villages.reduce((sum, v) => sum + v.commands.length, 0)} comandos`, true);
    return { generatedAt: new Date().toISOString(), villages, unknown };
  }

  /** Totalizador: só coordenadas → participação por jogador. */
  async totals(coords: string[]): Promise<{ generatedAt: string; totals: PlayerCommandTotal[] }> {
    if (coords.length === 0) {
      throw new Error('Nenhuma coordenada informada.');
    }
    const byCoord = await this.fetchVillagePages(coords, `Totalizando comandos (${coords.length} aldeias)`);
    const all: IncomingCommandRow[] = [];
    for (const rows of byCoord.values()) all.push(...rows);
    await this.journal.append('read', 'sg5-totals', `${coords.length} aldeias — ${all.length} comandos`, true);
    return { generatedAt: new Date().toISOString(), totals: totalsByPlayer(all) };
  }
}
