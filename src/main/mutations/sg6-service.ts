import { session } from 'electron';
import { TW_PARTITION, type TwSessionManager } from '../tw/session';
import type { Journal } from '../journal';
import { JsonStore } from '../stores/json-store';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc-types';

export interface MutationOutcome {
  coord: string;
  dryRun: boolean;
  ok: boolean | null;
  detail: string;
}

export interface MpEntry {
  playerName: string;
  coords: string[];
}

export interface MpOutcome {
  playerName: string;
  dryRun: boolean;
  ok: boolean | null;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Mutações do SG_6 (reservas em massa + MPs personalizadas). Regras da política
 * (AGENTS.md): confirmação dupla (o renderer só chama com confirm=true depois de
 * mostrar resumo), UMA tentativa por mutação (jamais reenvio automático), pacing
 * humano entre envios, journal obrigatório de cada evento e DRY-RON global das
 * settings — em dry-run nada sai para o servidor, só o journal.
 */
export class Sg6Service {
  private readonly settingsStore: JsonStore<AppSettings>;

  constructor(
    private readonly twSession: TwSessionManager,
    private readonly journal: Journal,
  ) {
    this.settingsStore = new JsonStore<AppSettings>('settings', DEFAULT_SETTINGS);
  }

  private async settings(): Promise<AppSettings> {
    const raw = await this.settingsStore.load();
    const minInterval = Number(raw.requestMinIntervalMs);
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      requestMinIntervalMs: Number.isFinite(minInterval) && minInterval >= 350 ? minInterval : DEFAULT_SETTINGS.requestMinIntervalMs,
      dryRun: raw.dryRun === false ? false : true,
    };
  }

  private world(): string {
    const { state, world } = this.twSession.getStatus();
    if (state !== 'logged-in' || world === null) {
      throw new Error('Nenhuma sessão ativa no jogo — faça login antes de executar mutações.');
    }
    return world;
  }

  /** Extrai csrf e aldeia atual dos dados embutidos da página. */
  private pageTokens(html: string): { csrf: string; villageId: string } {
    const csrf = /"csrf":"([a-f0-9]+)"/.exec(html)?.[1];
    const villageId = /"village":"(\d+)"/.exec(html)?.[1];
    if (csrf === undefined || villageId === undefined) {
      throw new Error('Página do jogo sem csrf/aldeia (formato inesperado) — abortado antes de qualquer envio.');
    }
    return { csrf, villageId };
  }

  private async postForm(url: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; body: string }> {
    const ses = session.fromPartition(TW_PARTITION);
    const body = new URLSearchParams(params).toString();
    const response = await ses.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'follow',
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }

  /** Reserva em massa no Planejador (1 tentativa por coordenada, tolera "já reservada"). */
  async reserveMass(coords: string[], confirm: boolean): Promise<MutationOutcome[]> {
    if (!confirm) throw new Error('Confirmação dupla necessária — revise o resumo e confirme na tela.');
    if (coords.length === 0) throw new Error('Nenhuma coordenada informada.');
    const settings = await this.settings();
    const world = this.world();
    const base = `https://${world}.tribalwars.com.br/game.php?screen=ally&mode=reservations`;
    const page = await this.twSession.fetchText(base);
    const { csrf, villageId } = this.pageTokens(page);
    const outcomes: MutationOutcome[] = [];
    for (const coord of coords) {
      const [x, y] = coord.split('|');
      if (settings.dryRun) {
        await this.journal.append('mutation', 'reserve-dry-run', `reserva ${coord} SIMULADA (dry-run ativo)`, true);
        outcomes.push({ coord, dryRun: true, ok: null, detail: 'Simulado (DRY-RUN ativo nas Configurações).' });
        continue;
      }
      await sleep(settings.requestMinIntervalMs + Math.random() * 250);
      let outcome: MutationOutcome;
      try {
        const response = await this.postForm(
          `${base}&village=${villageId}&action=new_reservation&group_id=all&filter=&h=${csrf}`,
          {
            'target_type': 'coord',
            'x[]': x ?? '',
            'y[]': y ?? '',
            'save_reservations': 'Reservar esta aldeia',
          },
        );
        const already = /já reservad|already/i.test(response.body);
        const error = /class="error"|não existe tal aldeia/i.test(response.body);
        outcome = {
          coord,
          dryRun: false,
          ok: error ? false : response.ok,
          detail: error
            ? 'Recusado pelo jogo (aldeia inexistente ou erro).'
            : already
              ? 'Já reservada por outro membro — tolerado.'
              : response.ok
                ? 'Pedido enviado.'
                : `HTTP ${response.status}`,
        };
      } catch (err) {
        outcome = { coord, dryRun: false, ok: false, detail: `Falha de rede: ${err instanceof Error ? err.message : String(err)}` };
      }
      await this.journal.append('mutation', 'reserve', `reserva ${coord} → ${outcome.detail}`, false);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /** MPs personalizadas em cadeia: #alvos# substituído pelas coords de cada nick. */
  async sendMps(subject: string, bodyTemplate: string, entries: MpEntry[], confirm: boolean): Promise<MpOutcome[]> {
    if (!confirm) throw new Error('Confirmação dupla necessária — revise o resumo e confirme na tela.');
    if (subject.trim() === '') throw new Error('Assunto vazio.');
    if (!bodyTemplate.includes('#alvos#')) throw new Error('O corpo precisa conter #alvos# para inserir os alvos de cada jogador.');
    if (entries.length === 0) throw new Error('Nenhuma entrada "nick;coords" informada.');
    const settings = await this.settings();
    const world = this.world();
    const base = `https://${world}.tribalwars.com.br/game.php?screen=mail&mode=new`;
    const page = await this.twSession.fetchText(base);
    const { csrf, villageId } = this.pageTokens(page);
    const outcomes: MpOutcome[] = [];
    for (const entry of entries) {
      const message = bodyTemplate.replaceAll('#alvos#', entry.coords.join(' '));
      if (settings.dryRun) {
        await this.journal.append('mutation', 'mp-dry-run', `MP para ${entry.playerName} SIMULADA (${entry.coords.length} alvos)`, true);
        outcomes.push({ playerName: entry.playerName, dryRun: true, ok: null, detail: 'Simulado (DRY-RUN ativo).' });
        continue;
      }
      await sleep(settings.requestMinIntervalMs + Math.random() * 250);
      let outcome: MpOutcome;
      try {
        const response = await this.postForm(`${base}&village=${villageId}&action=send&h=${csrf}`, {
          to: entry.playerName,
          subject,
          text: message,
          send: 'Enviar',
        });
        const notFound = /não existe|destinatário inválido|unknown recipient/i.test(response.body);
        outcome = {
          playerName: entry.playerName,
          dryRun: false,
          ok: notFound ? false : response.ok,
          detail: notFound
            ? 'Nick não encontrado — confira o nome exato no jogo.'
            : response.ok
              ? 'MP enviada.'
              : `HTTP ${response.status}`,
        };
      } catch (err) {
        outcome = { playerName: entry.playerName, dryRun: false, ok: false, detail: `Falha de rede: ${err instanceof Error ? err.message : String(err)}` };
      }
      await this.journal.append('mutation', 'mp-send', `MP ${entry.playerName} (${entry.coords.length} alvos) → ${outcome.detail}`, false);
      outcomes.push(outcome);
    }
    return outcomes;
  }
}
