import { dialog, session } from 'electron';
import { TW_PARTITION, type TwSessionManager } from '../tw/session';
import type { Journal } from '../journal';
import type { JsonStore } from '../stores/json-store';
import type { RequestQueue } from '../tw/request-queue';
import { DEFAULT_SETTINGS, type AppSettings, type Sg6ChargeEntry, type Sg6ChargeOutcome } from '@shared/ipc-types';
import { horariosBlock } from '@shared/comms-package';
import { erroFilaOcupada, erroSessao } from '@shared/error-catalog';
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

export interface Sg6ServiceOptions {
  /** Sentinela detectada DIRETO no corpo da mutação (POSTs fora da fila — o
   * onSentinel da RequestQueue não vê): espelha a queda no TwSessionManager
   * para a UI parar de mostrar "Ativa" na hora. Best-effort, default no-op. */
  onSessionLost?: (kind: 'session-expired' | 'captcha-suspected') => void;
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
    private readonly options: Sg6ServiceOptions = {},
  ) {}

  /** C4: coleta/mutação em andamento = esta mutação NÃO executa (pacing somado = risco de ban). */
  private assertQueueIdle(): void {
    if (this.queue.isRunning) {
      throw new Error(erroFilaOcupada('executar mutações no jogo'));
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
      throw new Error(erroSessao());
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

  /**
   * Pré-voo da reserva em massa: fila livre + sessão ativa + teto validados
   * ANTES do diálogo nativo (o ipc-sg6 chama este método antes de confirmMutation
   * — mesma ordem do chargeBatch: nada de perguntar confirmação para depois
   * falhar alto sem sessão ou acima do teto).
   */
  async assertReservePreflight(coords: string[]): Promise<void> {
    this.assertQueueIdle();
    this.world();
    const settings = await this.settings();
    if (coords.length > settings.requestCeiling) {
      throw new Error(`Reserva em massa maior que o teto das settings (${settings.requestCeiling}) — ${coords.length} coordenadas.`);
    }
  }

  /** Reserva em massa no Planejador (1 tentativa por coordenada, tolera "já reservada"). */
  async reserveMass(coords: string[], confirm: boolean): Promise<MutationOutcome[]> {
    if (!confirm) throw new Error('Confirmação dupla necessária — revise o resumo e confirme na tela.');
    if (coords.length === 0) throw new Error('Nenhuma coordenada informada.');
    this.assertQueueIdle();
    await this.assertReservePreflight(coords);
    this.queue.beginOperation();
    try {
      const settings = await this.settings();
      const parsedCoords = coords.map((coord) => ({ coord, parts: this.splitCoord(coord) }));
      const world = this.world();
      const base = `https://${world}.tribalwars.com.br/game.php?screen=ally&mode=reservations`;
      await sleep(settings.requestMinIntervalMs);
      const page = await this.twSession.fetchText(base);
      const { csrf, villageId } = this.pageTokens(page);
      const outcomes: MutationOutcome[] = [];
      for (const [index, target] of parsedCoords.entries()) {
        if (this.queue.isCancelled()) {
          // Cancelamento pela barra de progresso: mesma semântica do halt por
          // sentinela — para ANTES do POST; as não tentadas ficam explícitas.
          await this.journal.append('mutation', 'reserve-cancel', `Reserva cancelada pelo usuário antes da coordenada ${target.coord}`, false);
          for (const remaining of parsedCoords.slice(index)) {
            outcomes.push({ coord: remaining.coord, ok: false, detail: 'Cancelado pelo usuário' });
          }
          break;
        }
        await sleep(settings.requestMinIntervalMs + Math.random() * settings.requestJitterMs);
        let outcome: MutationOutcome;
        try {
          const response = await this.postForm(
            `${base}&village=${villageId}&action=new_reservation&group_id=all&filter=&h=${csrf}`,
            {
              'target_type': 'coord',
              'x[]': target.parts.x,
              'y[]': target.parts.y,
              'save_reservations': 'Reservar esta aldeia',
            },
          );
          const sentinel = detectPageSentinels(response.body);
          if (sentinel === 'session-expired' || sentinel === 'captcha-suspected') {
            this.options.onSessionLost?.(sentinel);
            await this.journal.append('mutation', 'reserve-halt', `Reserva interrompida na coordenada ${target.coord} (${sentinel})`, false);
            outcomes.push({ coord: target.coord, ok: false, detail: sentinel === 'session-expired' ? 'SESSÃO EXPIRADA — operação interrompida. Faça login e recomece.' : 'CAPTCHA — operação interrompida.' });
            break;
          }
          const already = /já reserva(?:d[ao]|u)|already reserv/i.test(response.body);
          const error = /class="error"|não existe tal aldeia/i.test(response.body);
          outcome = {
            coord: target.coord,
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
          outcome = { coord: target.coord, ok: false, detail: `Falha de rede: ${err instanceof Error ? err.message : String(err)}` };
        }
        await this.journal.append('mutation', 'reserve', `reserva ${target.coord} → ${outcome.detail}`, false);
        outcomes.push(outcome);
      }
      return outcomes;
    } catch (error) {
      // Journal gap: falha ANTES do primeiro item (teto/sessão/página/csrf)
      // também fica registrada — tentativa de mutação nunca fica sem rastro.
      await this.journal.append('mutation', 'reserve-erro', `Reserva em massa abortada: ${error instanceof Error ? error.message : String(error)}`, false);
      throw error;
    } finally {
      this.queue.endOperation();
    }
  }

  /**
   * Pré-voo do envio de MPs: fila livre + sessão ativa + teto validados ANTES
   * do diálogo nativo (o ipc-sg6 chama antes de confirmMutation — mesma ordem
   * do chargeBatch).
   */
  async assertMpsPreflight(entries: MpEntry[]): Promise<void> {
    this.assertQueueIdle();
    this.world();
    const settings = await this.settings();
    if (entries.length > settings.requestCeiling) {
      throw new Error(`Envio maior que o teto das settings (${settings.requestCeiling}) — ${entries.length} MPs.`);
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
    await this.assertMpsPreflight(entries);
    this.queue.beginOperation();
    try {
      const settings = await this.settings();
      const world = this.world();
      const base = `https://${world}.tribalwars.com.br/game.php?screen=mail&mode=new`;
      await sleep(settings.requestMinIntervalMs);
      const page = await this.twSession.fetchText(base);
      const { csrf, villageId } = this.pageTokens(page);
      const outcomes: MpOutcome[] = [];
      for (const [index, entry] of entries.entries()) {
        if (this.queue.isCancelled()) {
          // Cancelamento pela barra de progresso: para ANTES do POST do
          // destinatário atual; as MPs não enviadas ficam explícitas.
          await this.journal.append('mutation', 'mp-cancel', `Envio de MPs cancelado pelo usuário antes de ${entry.playerName}`, false);
          for (const remaining of entries.slice(index)) {
            outcomes.push({ playerName: remaining.playerName, ok: false, detail: 'Cancelado pelo usuário' });
          }
          break;
        }
        // Placeholders idênticos ao renderTemplate (prévia e envio NUNCA divergem
        // — lição do reviewer v0.33): #jogador#, #alvos# e #horarios#.
        let message = bodyTemplate
          .replaceAll('#jogador#', entry.playerName)
          .replaceAll('#alvos#', entry.coords.join(' '));
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
            this.options.onSessionLost?.(sentinel);
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
    } catch (error) {
      // Journal gap: falha ANTES do primeiro item (teto/sessão/página/csrf)
      // também fica registrada — tentativa de mutação nunca fica sem rastro.
      await this.journal.append('mutation', 'mp-erro', `Envio de MPs abortado: ${error instanceof Error ? error.message : String(error)}`, false);
      throw error;
    } finally {
      this.queue.endOperation();
    }
  }

  /**
   * Diálogo nativo ÚNICO para o lote de cobrança (cancelar é o default, C9).
   * Agregado e compacto: contagem + os 5 primeiros nicks (o resumo completo já
   * foi exibido no painel de confirmação da Sala de Guerra).
   */
  private async confirmChargeBatch(count: number, nicks: string[]): Promise<boolean> {
    const preview = nicks.slice(0, 5).join(', ');
    const extra = nicks.length - 5;
    const detail = extra > 0 ? `${preview} e mais ${extra}` : preview;
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Cobrança de faltas',
      message: `Confirmar o envio de ${count} MP(s) de cobrança? (uma por jogador — o envio é real)`,
      detail,
      buttons: ['Cancelar', 'Confirmar cobrança'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  }

  /**
   * Cobrança de faltas em lote (Sala de Guerra): UM diálogo nativo para o lote
   * inteiro (era um por jogador), depois o MESMO motor do sendMps — pacing
   * humano, 1 tentativa por MP, fail-soft por item (um nick que falha não
   * aborta o resto) e journal do lote + das falhas por item.
   */
  async chargeBatch(entries: Sg6ChargeEntry[]): Promise<{ results: Sg6ChargeOutcome[] }> {
    if (entries.length === 0) throw new Error('Nenhum jogador informado na cobrança em lote.');
    for (const entry of entries) {
      if (entry.subject.trim() === '') throw new Error('Assunto vazio.');
      if (entry.body.trim() === '') throw new Error(`Corpo vazio na cobrança de "${entry.nick}".`);
    }
    this.assertQueueIdle();
    // Sessão/teto validados ANTES do diálogo: nada de perguntar confirmação
    // para depois falhar alto sem sessão ou acima do teto.
    const world = this.world();
    const settings = await this.settings();
    if (entries.length > settings.requestCeiling) {
      throw new Error(`Cobrança maior que o teto das settings (${settings.requestCeiling}) — ${entries.length} MPs.`);
    }
    const cancelledRow = (entry: Sg6ChargeEntry): Sg6ChargeOutcome => ({
      nick: entry.nick,
      ok: false,
      detail: 'Cancelado pelo usuário',
      cancelled: true,
    });
    const confirmed = await this.confirmChargeBatch(
      entries.length,
      entries.map((entry) => entry.nick),
    );
    if (!confirmed) {
      // Mesma semântica do cancelamento nativo: nada foi enviado e nada é
      // journalado como mutação — o renderer mantém o painel armado.
      return { results: entries.map(cancelledRow) };
    }
    // Re-checagem: a fila pode ter começado uma coleta enquanto o diálogo
    // nativo ficava aberto (single-flight C4, fail-closed).
    this.assertQueueIdle();
    this.queue.beginOperation();
    let pageReady = false;
    try {
      const base = `https://${world}.tribalwars.com.br/game.php?screen=mail&mode=new`;
      await sleep(settings.requestMinIntervalMs);
      const page = await this.twSession.fetchText(base);
      const { csrf, villageId } = this.pageTokens(page);
      pageReady = true;
      const results: Sg6ChargeOutcome[] = [];
      // Contabilidade honesta do lote, reusada no fim normal e no aborto: as
      // linhas sintéticas de cancelamento NÃO contam como falha de tentativa.
      const summarize = async (action: string, extra?: string): Promise<void> => {
        const enviadas = results.filter((outcome) => outcome.ok).length;
        const canceladas = results.filter((outcome) => outcome.cancelled).length;
        const falhas = results.length - enviadas - canceladas;
        // Entradas depois de um halt NEM chegam a virar linha em results (o
        // lote não pode contar como "enviada/falha" o que nunca foi tentado).
        const notTried = entries.length - results.length;
        const partes = [
          `cobrança em lote: ${entries.length} MPs — ${enviadas} enviadas, ${falhas} falhas`,
          notTried > 0 ? `${notTried} não tentadas (sessão interrompida)` : null,
          canceladas > 0 ? `${canceladas} canceladas pelo usuário` : null,
          extra,
        ].filter((parte): parte is string => parte !== null && parte !== undefined);
        await this.journal.append('mutation', action, partes.join(', '), false);
      };
      try {
        for (const [index, entry] of entries.entries()) {
          if (this.queue.isCancelled()) {
            // Cancelamento pela barra de progresso: mesma semântica do halt por
            // sentinela — para ANTES do POST do nick atual; os demais viram
            // linha sintética "Cancelado pelo usuário" (cancelled=true).
            await this.journal.append('mutation', 'charge-cancel', `Cobrança cancelada pelo usuário antes de ${entry.nick}`, false);
            for (const remaining of entries.slice(index)) results.push(cancelledRow(remaining));
            break;
          }
          await sleep(settings.requestMinIntervalMs + Math.random() * settings.requestJitterMs);
          let outcome: Sg6ChargeOutcome;
          try {
            const response = await this.postForm(`${base}&village=${villageId}&action=send&h=${csrf}`, {
              to: entry.nick,
              subject: entry.subject,
              text: entry.body,
              send: 'Enviar',
            });
            const sentinel = detectPageSentinels(response.body);
            if (sentinel === 'session-expired' || sentinel === 'captcha-suspected') {
              // Mesma semântica do sendMps: sentinela INTERROMPE a cadeia.
              this.options.onSessionLost?.(sentinel);
              await this.journal.append('mutation', 'charge-halt', `Cobrança interrompida em ${entry.nick} (${sentinel})`, false);
              results.push({
                nick: entry.nick,
                ok: false,
                detail: sentinel === 'session-expired' ? 'SESSÃO EXPIRADA — operação interrompida. Faça login e recomece.' : 'CAPTCHA — operação interrompida.',
                cancelled: false,
              });
              break;
            }
            const notFound = /não existe|destinatário inválido|unknown recipient/i.test(response.body);
            outcome = {
              nick: entry.nick,
              ok: notFound ? false : response.ok,
              detail: notFound
                ? 'Nick não encontrado — confira o nome exato no jogo.'
                : response.ok
                  ? 'MP enviada.'
                  : `HTTP ${response.status}`,
              cancelled: false,
            };
          } catch (err) {
            outcome = { nick: entry.nick, ok: false, detail: `Falha de rede: ${err instanceof Error ? err.message : String(err)}`, cancelled: false };
          }
          if (!outcome.ok) {
            await this.journal.append('mutation', 'charge-fail', `Cobrança ${entry.nick} → ${outcome.detail}`, false);
          }
          results.push(outcome);
        }
        await summarize('charge-batch');
      } catch (error) {
        // Aborto no MEIO do lote: a linha do lote sai mesmo assim, com o estado
        // parcial + o motivo — o lote nunca desaparece do journal.
        await summarize('charge-batch-erro', `abortada: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      return { results };
    } catch (error) {
      // Journal gap: falha ANTES do primeiro envio (sessão/página/csrf) também
      // fica registrada — tentativa de mutação nunca fica sem rastro. (Aborto
      // no MEIO do lote já foi registrado pelo summarize acima.)
      if (!pageReady) {
        await this.journal.append('mutation', 'charge-batch-erro', `Cobrança abortada antes do primeiro envio: ${error instanceof Error ? error.message : String(error)}`, false);
      }
      throw error;
    } finally {
      this.queue.endOperation();
    }
  }
}
