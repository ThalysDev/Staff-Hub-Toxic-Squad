import { session } from 'electron';
import { TW_PARTITION, type TwSessionManager } from '../tw/session';
import type { Journal } from '../journal';
import type { JsonStore } from '../stores/json-store';
import type { RequestQueue } from '../tw/request-queue';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc-types';
import { horariosBlock } from '@shared/comms-package';
import { detectPageSentinels } from '../tw/request-queue';

export interface MutationOutcome {
  coord: string;
  ok: boolean;
  detail: string;
}

export interface MpEntry {
  playerName: string;
  coords: string[];
  /** Horários "HH:MM:SS" alinhados às coords (substitui #horarios#). */
  horarios?: string[];
}

export interface MpOutcome {
  playerName: string;
  ok: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Mutações do SG_6 (reservas em massa + MPs personalizadas). Regras da política
 * (AGENTS.md): confirmação dupla (o renderer só chama com confirm=true depois de
 * mostrar resumo), UMA tentativa por mutação (jamais reenvio automático), pacing
 * humano entre envios e journal obrigatório de cada evento. Modo real
 * permanente (decisão do dono 25/08/2026) — mutações sempre executam.
 */
export class Sg6Service {
  constructor(
    private readonly twSession: TwSessionManager,
    private readonly journal: Journal,
    /** Instância COMPARTILHADA com o index — sem cache obsoleto entre services. */
    private readonly settingsStore: JsonStore<AppSettings>,
    /** Single-flight global (C4): mutação não corre junto com coleta da fila. */
    private readonly queue: RequestQueue,
  ) {}

  /** C4: coleta/mutação em andamento = esta mutação NÃO executa (pacing somado = risco de ban). */
  private assertQueueIdle(): void {
    if (this.queue.isRunning) {
      throw new Error('Uma operação está em andamento — aguarde terminar (ou cancele a coleta na barra de progresso) antes de executar mutações no jogo.');
    }
  }

  private async settings(): Promise<AppSettings> {
    const raw = await this.settingsStore.load();
    const minInterval = Number(raw.requestMinIntervalMs);
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      requestMinIntervalMs: Number.isFinite(minInterval) && minInterval >= 350 ? minInterval : DEFAULT_SETTINGS.requestMinIntervalMs,
    };
  }

  private world(): string {
    const { state, world } = this.twSession.getStatus();
    if (state !== 'logged-in' || world === null) {
      throw new Error('Nenhuma sessão ativa no jogo — faça login antes de executar mutações.');
    }
    return world;
  }

  /** Extrai csrf e aldeia atual dos dados embutidos da página (BR142: "village":{"id":N}). */
  private pageTokens(html: string): { csrf: string; villageId: string } {
    const csrf = /"csrf":"([a-f0-9]+)"/.exec(html)?.[1];
    const villageId = /"village":\{"id":(\d+)/.exec(html)?.[1];
    if (csrf === undefined || villageId === undefined) {
      throw new Error('Página do jogo sem csrf/aldeia (formato inesperado) — abortado antes de qualquer envio.');
    }
    return { csrf, villageId };
  }

  /** Coordenada "123|456" validada na fronteira da mutação (IPC não valida). */
  private splitCoord(coord: string): { x: string; y: string } {
    const match = /^(\d{1,3})\|(\d{1,3})$/.exec(coord.trim());
    if (match === null) {
      throw new Error(`Coordenada inválida na reserva em massa: "${coord}" — abortado antes de qualquer envio.`);
    }
    return { x: match[1] ?? '', y: match[2] ?? '' };
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
    this.assertQueueIdle();
    this.queue.beginOperation();
    try {
      const settings = await this.settings();
      if (coords.length > settings.requestCeiling) {
        throw new Error(`Reserva em massa maior que o teto das settings (${settings.requestCeiling}) — ${coords.length} coordenadas.`);
      }
      const parsedCoords = coords.map((coord) => ({ coord, parts: this.splitCoord(coord) }));
      const world = this.world();
      const base = `https://${world}.tribalwars.com.br/game.php?screen=ally&mode=reservations`;
      await sleep(settings.requestMinIntervalMs);
      const page = await this.twSession.fetchText(base);
      const { csrf, villageId } = this.pageTokens(page);
      const outcomes: MutationOutcome[] = [];
      for (const { coord, parts } of parsedCoords) {
        await sleep(settings.requestMinIntervalMs + Math.random() * settings.requestJitterMs);
        let outcome: MutationOutcome;
        try {
          const response = await this.postForm(
            `${base}&village=${villageId}&action=new_reservation&group_id=all&filter=&h=${csrf}`,
            {
              'target_type': 'coord',
              'x[]': parts.x,
              'y[]': parts.y,
              'save_reservations': 'Reservar esta aldeia',
            },
          );
          const sentinel = detectPageSentinels(response.body);
          if (sentinel === 'session-expired' || sentinel === 'captcha-suspected') {
            await this.journal.append('mutation', 'reserve-halt', `Reserva interrompida na coordenada ${coord} (${sentinel})`, false);
            outcomes.push({ coord, ok: false, detail: sentinel === 'session-expired' ? 'SESSÃO EXPIRADA — operação interrompida. Faça login e recomece.' : 'CAPTCHA — operação interrompida.' });
            break;
          }
          const already = /já reserva(?:d[ao]|u)|already reserv/i.test(response.body);
          const error = /class="error"|não existe tal aldeia/i.test(response.body);
          outcome = {
            coord,
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
          outcome = { coord, ok: false, detail: `Falha de rede: ${err instanceof Error ? err.message : String(err)}` };
        }
        await this.journal.append('mutation', 'reserve', `reserva ${coord} → ${outcome.detail}`, false);
        outcomes.push(outcome);
      }
      return outcomes;
    } finally {
      this.queue.endOperation();
    }
  }

  /** MPs personalizadas em cadeia: #alvos# (coords) e opcionalmente #horarios# por jogador. */
  async sendMps(subject: string, bodyTemplate: string, entries: MpEntry[], confirm: boolean): Promise<MpOutcome[]> {
    if (!confirm) throw new Error('Confirmação dupla necessária — revise o resumo e confirme na tela.');
    if (subject.trim() === '') throw new Error('Assunto vazio.');
    if (!bodyTemplate.includes('#alvos#') && !bodyTemplate.includes('#horarios#')) {
      throw new Error('O corpo precisa conter #alvos# e/ou #horarios# para personalizar a MP de cada jogador.');
    }
    if (entries.length === 0) throw new Error('Nenhuma entrada "nick;coords" informada.');
    this.assertQueueIdle();
    // Fail-closed ANTES de qualquer POST: #horarios# no corpo exige horários
    // coerentes (mesma quantidade que os alvos) em TODAS as entradas.
    if (bodyTemplate.includes('#horarios#')) {
      for (const entry of entries) {
        if (entry.horarios === undefined || entry.horarios.length === 0) {
          throw new Error(`O corpo usa #horarios#, mas a entrada de "${entry.playerName}" não trouxe horários — gere o pacote de comunicação no SG_4.`);
        }
        if (entry.horarios.length !== entry.coords.length) {
          throw new Error(`Horários de "${entry.playerName}" dessincronizados: ${entry.horarios.length} horário(s) × ${entry.coords.length} alvo(s).`);
        }
      }
    }
    this.queue.beginOperation();
    try {
      const settings = await this.settings();
    if (entries.length > settings.requestCeiling) {
      throw new Error(`Envio maior que o teto das settings (${settings.requestCeiling}) — ${entries.length} MPs.`);
    }
    const world = this.world();
    const base = `https://${world}.tribalwars.com.br/game.php?screen=mail&mode=new`;
    await sleep(settings.requestMinIntervalMs);
    const page = await this.twSession.fetchText(base);
    const { csrf, villageId } = this.pageTokens(page);
    const outcomes: MpOutcome[] = [];
    for (const entry of entries) {
      let message = bodyTemplate.replaceAll('#alvos#', entry.coords.join(' '));
      if (message.includes('#horarios#') && entry.horarios !== undefined) {
        message = message.replaceAll('#horarios#', horariosBlock(entry.coords, entry.horarios));
      }
      await sleep(settings.requestMinIntervalMs + Math.random() * settings.requestJitterMs);
      let outcome: MpOutcome;
      try {
        const response = await this.postForm(`${base}&village=${villageId}&action=send&h=${csrf}`, {
          to: entry.playerName,
          subject,
          text: message,
          send: 'Enviar',
        });
        const sentinel = detectPageSentinels(response.body);
        if (sentinel === 'session-expired' || sentinel === 'captcha-suspected') {
          // Mesma semântica do reserveMass: sentinela INTERROMPE a cadeia —
          // nunca continuar dando POST em página de login/captcha.
          await this.journal.append('mutation', 'mp-halt', `MP interrompida em ${entry.playerName} (${sentinel})`, false);
          outcomes.push({
            playerName: entry.playerName,
            ok: false,
            detail: sentinel === 'session-expired' ? 'SESSÃO EXPIRADA — operação interrompida. Faça login e recomece.' : 'CAPTCHA — operação interrompida.',
          });
          break;
        }
        const notFound = /não existe|destinatário inválido|unknown recipient/i.test(response.body);
        outcome = {
          playerName: entry.playerName,
          ok: notFound ? false : response.ok,
          detail: notFound
            ? 'Nick não encontrado — confira o nome exato no jogo.'
            : response.ok
              ? 'MP enviada.'
              : `HTTP ${response.status}`,
        };
      } catch (err) {
        outcome = { playerName: entry.playerName, ok: false, detail: `Falha de rede: ${err instanceof Error ? err.message : String(err)}` };
      }
      await this.journal.append('mutation', 'mp-send', `MP ${entry.playerName} (${entry.coords.length} alvos) → ${outcome.detail}`, false);
      outcomes.push(outcome);
    }
      return outcomes;
    } finally {
      this.queue.endOperation();
    }
  }
}
