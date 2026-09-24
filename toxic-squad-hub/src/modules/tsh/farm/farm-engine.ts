// Motor da Central de Farm (v3.7.0) — SCRIPT DE PÁGINA: roda na página do
// Assistente de Saque (screen=am_farm) enquanto ela está aberta, o Auto Farm
// está ligado no painel e o jogador apertou "Iniciar". É a "aba de farm".
//
// Uma RODADA:
//   1. lê a lista do Assistente (todas as páginas) — uma vez;
//   2. lê as tropas em casa de todas as aldeias (Visão de Tropas, grupo 0 fixo)
//      e os ataques a caminho (Visão de Comandos) — para não repetir chegada;
//   3. monta o plano global (farm-global), agrupado por aldeia de origem, e
//      envia um a um pelo MESMO pedido dos botões A/B/C do jogo, com pausa
//      humana entre os ataques;
//   4. espera o intervalo entre rodadas e recomeça.
// Travas: Parar (de qualquer aba), painel desligado, captcha/sessão
// (disjuntor), licença, parada programada — param; fora do horário ativo —
// espera. Recusa do jogo = registra e segue; dúvida = o alvo fica bloqueado
// por 1 h (nunca reenviado às cegas) e 3 dúvidas seguidas encerram a rodada.
// Erro de leitura NÃO derruba o motor: a rodada é encerrada e a próxima tenta.

import { pacedGet } from '../../../core/net';
import { gm } from '../../../core/storage';
import { backgroundSleep, serverNowMs } from '../../../core/game-clock';
import { getGroupVillages } from '../tsh-groups';
import { unitSpeedsMinutesPerField } from '../tsh-game-data';
import { reservationForVillage } from '../tsh-reserva';
import { parseCommandRows } from '../tsh-troop-forecast';
import { currentVillageId, tshRunBlock } from '../tsh-runtime';
import { sendFarmAttack } from '../tsh-transport';
import { parseFarmPage, type FarmRow, type FarmTemplates } from './farm-page';
import { fits, freeUnits, jittered, readFarmConfig, type FarmConfig, type FarmSkip } from './farm-plan';
import { parseUnitsHome, planFarmRound, travelMinutes, type FarmPlanItem, type OwnFarmVillage, type UnitsHomeRow } from './farm-global';

export const FARM_ID = 'auto-farm';
const MAX_LIST_PAGES = 100;
const LOG_MAX = 80;
/** Lock entre abas: renovado a cada ≤ 5 s (esperas longas vão em pedaços). */
const LOCK_TTL_MS = 45_000;
/** Retomar sozinho só se a aba farmava há pouco (página recarregada). */
const RESUME_MAX_AGE_MS = 3 * 60_000;
/** Envio sem confirmação: o alvo fica bloqueado por este tempo. */
const DOUBT_BLOCK_MS = 60 * 60_000;
const SLEEP_SLICE_MS = 5_000;
/** Velocidades clássicas (min/campo) se o get_unit_info falhar. */
const FALLBACK_SPEEDS: Record<string, number> = { spear: 18, sword: 22, axe: 18, archer: 18, spy: 9, light: 10, marcher: 10, heavy: 11, ram: 30, catapult: 30, knight: 10, snob: 35 };

export type FarmPhase = 'parado' | 'lendo' | 'enviando' | 'aguardando' | 'bloqueado';

export interface FarmLogEntry {
  at: number;
  kind: 'ok' | 'recusa' | 'duvida' | 'info';
  text: string;
}

export interface FarmState {
  running: boolean;
  phase: FarmPhase;
  /** Frase do momento ("Lendo a lista do Assistente — página 3 de 37"). */
  detail: string;
  progress: { done: number; total: number };
  round: number;
  nextRoundAt: number | null;
  /** Última vez que o motor deu sinal de vida (retomada após recarregar). */
  heartbeatAt: number;
  /** Totais do dia (zeram à meia-noite local). */
  day: string;
  sent: { A: number; B: number; C: number };
  refused: number;
  lastRound: { sent: number; skipped: Partial<Record<FarmSkip, number>>; villages: number; targets: number } | null;
  walls: { targetId: string; x: number; y: number; wall: number }[];
  log: FarmLogEntry[];
}

const key = (world: string, k: string): string => `tsh-farm:${world}:${k}`;
const today = (): string => new Date().toDateString();

export function emptyFarmState(): FarmState {
  return {
    running: false,
    phase: 'parado',
    detail: 'Aperte Iniciar para começar.',
    progress: { done: 0, total: 0 },
    round: 0,
    nextRoundAt: null,
    heartbeatAt: 0,
    day: today(),
    sent: { A: 0, B: 0, C: 0 },
    refused: 0,
    lastRound: null,
    walls: [],
    log: [],
  };
}

export function loadFarmState(world: string): FarmState {
  const s = { ...emptyFarmState(), ...gm.get<Partial<FarmState>>(key(world, 'state'), {}) };
  if (s.day !== today()) return { ...s, day: today(), sent: { A: 0, B: 0, C: 0 }, refused: 0 };
  return s;
}

/** Configuração do farm: mora nos settings do Auto Farm (chave `farm`). */
export function farmConfig(world: string): FarmConfig {
  const settings = gm.get<Record<string, unknown>>(`tsh-auto:${world}:${FARM_ID}:settings`, {});
  return readFarmConfig(settings.farm);
}

/** Pedido de parada vindo de QUALQUER aba (o motor dono lê a cada passo). */
export function requestFarmStop(world: string): void {
  gm.set(key(world, 'stop'), Date.now());
}

type Listener = (s: FarmState) => void;

/** Horizonte da reserva do Agendador: ida e volta do farm mais lento possível. */
export function farmReserveHorizonMs(cfg: FarmConfig, templates: FarmTemplates | null, speeds: Record<string, number>): number {
  const units = { ...(templates?.A?.units ?? {}), ...(templates?.B?.units ?? {}), light: 1 };
  const oneWayMin = travelMinutes(units, cfg.maxDistance, speeds);
  return Math.max(6 * 60 * 60_000, 2 * oneWayMin * 60_000 + 10 * 60_000);
}

/** Motor de UMA aba. Criado pela Central (farm-central.ts). */
export class FarmEngine {
  private state: FarmState;
  private readonly listeners = new Set<Listener>();
  private readonly tab = Math.random().toString(36).slice(2);
  private loopActive = false;
  private startedAt = 0;
  private notifyPending = false;
  private persistAt = 0;

  constructor(
    private readonly world: string,
    private readonly schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms),
  ) {
    this.state = loadFarmState(world);
    const outra = this.otherTabRunning();
    if (this.state.running && outra) {
      this.state = { ...this.state, running: false, phase: 'bloqueado', detail: 'Outra aba está farmando agora. Pare lá (ou feche aquela aba) para farmar daqui.' };
    } else if (this.state.running && Date.now() - this.state.heartbeatAt > RESUME_MAX_AGE_MS) {
      this.state = { ...this.state, running: false, phase: 'parado', nextRoundAt: null, detail: 'A Central estava rodando, mas a aba ficou fechada. Aperte Iniciar para continuar.' };
    } else if (!this.state.running && !outra) {
      this.state = { ...this.state, phase: 'parado', nextRoundAt: null };
    }
  }

  get snapshot(): FarmState {
    return this.state;
  }

  /** Estava rodando há pouco (página recarregada)? Então retoma sozinho. */
  shouldResume(): boolean {
    return this.state.running && !this.otherTabRunning() && Date.now() - this.state.heartbeatAt <= RESUME_MAX_AGE_MS;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  /** Atualiza o estado; grava no storage no máximo a cada 2 s (só a aba dona). */
  private set(patch: Partial<FarmState>, opts?: { persist?: boolean; now?: boolean }): void {
    this.state = { ...this.state, ...patch };
    const persist = opts?.persist ?? true;
    if (persist && (opts?.now === true || Date.now() - this.persistAt > 2_000)) {
      this.persistAt = Date.now();
      gm.set(key(this.world, 'state'), this.state);
    }
    if (opts?.now === true) {
      for (const fn of this.listeners) fn(this.state);
      return;
    }
    if (this.notifyPending) return;
    this.notifyPending = true;
    this.schedule(() => {
      this.notifyPending = false;
      for (const fn of this.listeners) fn(this.state);
    }, 250);
  }

  private flush(): void {
    this.persistAt = Date.now();
    gm.set(key(this.world, 'state'), this.state);
  }

  private log(kind: FarmLogEntry['kind'], text: string): void {
    this.set({ log: [{ at: Date.now(), kind, text }, ...this.state.log].slice(0, LOG_MAX) });
  }

  /** Outra aba está farmando agora? (lock renovado a cada passo). */
  otherTabRunning(): boolean {
    const lock = gm.get<{ tab: string; at: number } | null>(key(this.world, 'lock'), null);
    return lock !== null && lock.tab !== this.tab && Date.now() - lock.at < LOCK_TTL_MS;
  }

  private renewLock(): void {
    gm.set(key(this.world, 'lock'), { tab: this.tab, at: Date.now() });
  }

  releaseLock(): void {
    const lock = gm.get<{ tab: string; at: number } | null>(key(this.world, 'lock'), null);
    if (lock?.tab === this.tab) gm.set(key(this.world, 'lock'), null);
  }

  start(): void {
    if (this.otherTabRunning()) {
      // Não grava: o estado compartilhado é da aba que está farmando.
      this.set({ phase: 'bloqueado', detail: 'Outra aba está farmando agora. Pare lá (ou feche aquela aba) para farmar daqui.' }, { persist: false, now: true });
      return;
    }
    this.startedAt = Date.now();
    this.renewLock();
    this.set({ running: true, phase: 'lendo', heartbeatAt: Date.now(), detail: 'Começando…' }, { now: true });
    this.log('info', 'Central iniciada.');
    if (!this.loopActive) void this.loop();
  }

  stop(reason = 'Parado por você.'): void {
    this.set({ running: false, phase: 'parado', detail: reason, nextRoundAt: null, progress: { done: 0, total: 0 } }, { now: true });
    this.releaseLock();
  }

  /** Continua rodando? Senão diz por quê (e para). Fora do horário = só espera. */
  private canGo(): boolean {
    if (!this.state.running) return false;
    const stopAt = gm.get<number>(key(this.world, 'stop'), 0);
    if (stopAt > this.startedAt) {
      this.stop('Parado por você.');
      return false;
    }
    if (this.otherTabRunning()) {
      this.stop('Outra aba assumiu a Central de Farm.');
      return false;
    }
    const block = tshRunBlock(FARM_ID, this.world);
    if (block !== null && block.kind !== 'janela') {
      this.stop(block.text);
      this.log('info', block.text);
      return false;
    }
    this.renewLock();
    this.state = { ...this.state, heartbeatAt: Date.now() };
    return true;
  }

  /** Espera em pedaços, conferindo as travas e renovando o lock. */
  private async pause(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!this.canGo()) return false;
      await backgroundSleep(Math.min(SLEEP_SLICE_MS, until - Date.now()));
    }
    return this.canGo();
  }

  /** Fora do horário ativo: espera (sem parar) até a janela abrir. */
  private async waitWindow(): Promise<boolean> {
    let block = tshRunBlock(FARM_ID, this.world);
    if (block?.kind !== 'janela') return true;
    this.set({ phase: 'aguardando', nextRoundAt: null, detail: block.text });
    while (this.canGo()) {
      block = tshRunBlock(FARM_ID, this.world);
      if (block?.kind !== 'janela') return true;
      if (!(await this.pause(15_000))) return false;
    }
    return false;
  }

  private async loop(): Promise<void> {
    this.loopActive = true;
    try {
      while (this.canGo()) {
        if (!(await this.waitWindow())) break;
        try {
          await this.round();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.log('info', `Rodada ${this.state.round} interrompida: ${msg} Tento de novo na próxima.`);
        }
        if (!this.canGo()) break;
        const cfg = farmConfig(this.world);
        const until = Date.now() + cfg.roundPauseMin * 60_000;
        this.set({ phase: 'aguardando', nextRoundAt: until, progress: { done: 0, total: 0 } });
        this.flush();
        if (!(await this.pause(cfg.roundPauseMin * 60_000))) break;
      }
    } finally {
      this.loopActive = false;
      this.flush();
    }
  }

  private async read(path: string): Promise<string> {
    this.renewLock();
    return pacedGet(path, { fresh: true });
  }

  private async round(): Promise<void> {
    const cfg = farmConfig(this.world);
    this.set({ round: this.state.round + 1, phase: 'lendo', nextRoundAt: null, progress: { done: 0, total: 0 } });

    // 1) Lista do Assistente (todas as páginas, lida da aldeia aberta).
    const here = currentVillageId();
    const rows: FarmRow[] = [];
    let templates: FarmTemplates | null = null;
    let last = 0;
    for (let p = 0; p <= last && p < MAX_LIST_PAGES; p++) {
      if (!this.canGo()) return;
      this.set({ detail: `Lendo a lista do Assistente de Saque — página ${p + 1}${last > 0 ? ` de ${last + 1}` : ''}.` });
      const page = parseFarmPage(await this.read(`/game.php?village=${here}&screen=am_farm&Farm_page=${p}`));
      if (page === null) throw new Error('Não consegui ler a lista do Assistente (formato mudou?) — nada foi enviado.');
      templates ??= page.templates;
      last = page.lastPage;
      rows.push(...page.rows);
    }
    if (templates === null) return;
    const speedsRead = await unitSpeedsMinutesPerField().catch(() => null);
    if (speedsRead === null) this.log('info', 'Não li as velocidades do mundo — usei as clássicas só para espaçar as chegadas.');
    const speeds = speedsRead ?? FALLBACK_SPEEDS;

    // 2) Tropas em casa de todas as aldeias (grupo 0 fixo) e reservas.
    this.set({ detail: 'Lendo as tropas em casa das suas aldeias.' });
    const byId = new Map<string, UnitsHomeRow>();
    for (let p = 0; p < 20; p++) {
      if (!this.canGo()) return;
      const r = parseUnitsHome(await this.read(`/game.php?screen=overview_villages&mode=units&type=own_home&group=0&page=${p}`));
      if (r === null) throw new Error('Não consegui ler a Visão de Tropas — nada foi enviado.');
      const before = byId.size;
      for (const row of r.rows) byId.set(row.id, row);
      if (!r.full || byId.size === before) break; // última página (ou o jogo repetiu a mesma)
    }
    let allowed: Set<string> | null = null;
    if (cfg.groupId > 0) {
      const g = await getGroupVillages(cfg.groupId);
      allowed = new Set(g.map((v) => String(v.villageId)));
      if (allowed.size === 0) this.log('info', 'O grupo escolhido veio vazio (ou não foi lido) — nenhuma aldeia farmou nesta rodada.');
    }
    const now = serverNowMs();
    const horizon = farmReserveHorizonMs(cfg, templates, speeds);
    const reservedOf = (id: string): Record<string, number> => {
      if (!cfg.respectScheduler) return {};
      const res = reservationForVillage(this.world, id, now + horizon);
      const out: Record<string, number> = { ...(res.units as Record<string, number>) };
      for (const u of res.all) out[u] = Number.MAX_SAFE_INTEGER;
      return out;
    };
    const villages: OwnFarmVillage[] = [...byId.values()]
      .filter((v) => allowed === null || allowed.has(v.id))
      .map((v) => ({ id: v.id, name: v.name, x: v.x, y: v.y, free: freeUnits(v.units, cfg.keepHome, reservedOf(v.id)) }));

    // 3) Ataques já a caminho (chegadas por alvo) + chegadas e dúvidas desta Central.
    this.set({ detail: 'Conferindo os ataques que já estão a caminho.' });
    const gapMs = cfg.targetIntervalMin * 60_000;
    const arrivals = this.loadArrivals(now, gapMs);
    const blocked = this.loadDoubts(now);
    try {
      const cmd = parseCommandRows(await this.read('/game.php?screen=overview_villages&mode=commands&type=attack&group=0&page=-1'), now);
      for (const c of cmd) {
        if (c.target === undefined) continue;
        const k = `${c.target.x}|${c.target.y}`;
        arrivals.set(k, [...(arrivals.get(k) ?? []), c.arrivalMs]);
      }
      if (cmd.length === 0 && rows.some((r) => r.attacked)) this.log('info', 'A Visão de Comandos veio vazia, mas há alvos com ataque a caminho — conferi só pelo ícone da lista.');
    } catch {
      this.log('info', 'Não consegui ler os ataques a caminho — usei só o histórico desta Central.');
    }

    // 4) Plano global e envio (agrupado por aldeia de origem).
    const plan = planFarmRound({ rows, villages, templates, cfg, speeds, arrivals, nowMs: now, blocked });
    const order = new Map(villages.map((v, i) => [v.id, i]));
    plan.items.sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0));
    this.set({
      walls: plan.walls.slice(0, 50),
      lastRound: { sent: 0, skipped: plan.skipped, villages: villages.length, targets: rows.length },
      phase: 'enviando',
      progress: { done: 0, total: plan.items.length },
      detail: plan.items.length === 0 ? 'Nada a enviar nesta rodada.' : `Enviando ${plan.items.length} farm(s).`,
    });
    if (plan.items.length === 0) {
      const semModelo = (plan.skipped['sem-modelo'] ?? 0) > 0 && (plan.skipped['sem-modelo'] ?? 0) >= rows.length - (plan.skipped.jogador ?? 0);
      const msg = semModelo
        ? 'Os modelos A e B do Assistente estão vazios: preencha-os (logo abaixo, em "Modelos") antes de iniciar.'
        : `Rodada ${this.state.round}: nada a enviar agora (${rows.length} alvos, ${villages.length} aldeias).`;
      this.set({ detail: msg });
      this.log('info', msg);
      return;
    }
    await this.execute(plan.items, cfg, speeds, arrivals, reservedOf);
    this.saveArrivals(arrivals, now, gapMs);
  }

  private loadArrivals(nowMs: number, gapMs: number): Map<string, number[]> {
    const raw = gm.get<Record<string, number[]>>(key(this.world, 'arrivals'), {});
    const out = new Map<string, number[]>();
    for (const [k, list] of Object.entries(raw)) {
      const alive = (Array.isArray(list) ? list : []).filter((t) => typeof t === 'number' && t > nowMs - gapMs);
      if (alive.length > 0) out.set(k, alive);
    }
    return out;
  }

  /** Grava as chegadas UMA vez por rodada (antes: a cada envio), já podadas. */
  private saveArrivals(map: ReadonlyMap<string, readonly number[]>, nowMs: number, gapMs: number): void {
    const out: Record<string, number[]> = {};
    for (const [k, list] of map) {
      const alive = list.filter((t) => t > nowMs - Math.max(gapMs, 60_000)).slice(-4);
      if (alive.length > 0) out[k] = [...alive];
    }
    gm.set(key(this.world, 'arrivals'), out);
  }

  /** Alvos com envio sem confirmação: bloqueados por 1 h (nunca reenviados às cegas). */
  private loadDoubts(nowMs: number): Set<string> {
    const raw = gm.get<Record<string, number>>(key(this.world, 'doubts'), {});
    return new Set(Object.entries(raw).filter(([, until]) => until > nowMs).map(([k]) => k));
  }

  private addDoubt(target: string): void {
    const now = serverNowMs();
    const raw = gm.get<Record<string, number>>(key(this.world, 'doubts'), {});
    const pruned = Object.fromEntries(Object.entries(raw).filter(([, until]) => until > now));
    pruned[target] = now + DOUBT_BLOCK_MS;
    gm.set(key(this.world, 'doubts'), pruned);
  }

  private async execute(
    items: FarmPlanItem[],
    cfg: FarmConfig,
    speeds: Record<string, number>,
    arrivals: Map<string, number[]>,
    reservedOf: (id: string) => Record<string, number>,
  ): Promise<void> {
    let doubts = 0;
    let sentNow = 0;
    const exhausted = new Set<string>();
    /** Tropas livres corrigidas pela resposta do jogo (current_units). */
    const live = new Map<string, Record<string, number>>();
    let lastSource = '';
    for (const [i, item] of items.entries()) {
      if (exhausted.has(item.sourceId)) continue;
      const liveFree = live.get(item.sourceId);
      if (liveFree !== undefined && !fits(item.units, liveFree)) continue; // o jogo disse que não sobrou
      if (lastSource !== '' && lastSource !== item.sourceId && !(await this.pause(jittered(cfg.villagePauseMs, cfg.jitterPct)))) return;
      if (!this.canGo()) return;
      lastSource = item.sourceId;
      const alvo = `${item.target.x}|${item.target.y}`;
      this.set({ detail: `${item.kind} de ${item.sourceName} → ${alvo} (${item.distance} campos).`, progress: { done: i, total: items.length } });
      try {
        const { currentUnits } = await sendFarmAttack(
          item.sourceId,
          item.kind === 'C'
            ? { kind: 'report', reportId: item.reportId ?? '' }
            : { kind: 'template', targetId: item.targetId, templateId: item.templateId ?? '' },
        );
        // Chegada recalculada NA HORA do envio (o plano foi feito minutos antes).
        const arrival = serverNowMs() + travelMinutes(item.units, item.distance, speeds) * 60_000;
        arrivals.set(alvo, [...(arrivals.get(alvo) ?? []), arrival]);
        if (currentUnits !== null) live.set(item.sourceId, freeUnits(currentUnits, cfg.keepHome, reservedOf(item.sourceId)));
        doubts = 0;
        sentNow += 1;
        this.set({ sent: { ...this.state.sent, [item.kind]: this.state.sent[item.kind] + 1 } });
        this.log('ok', `${item.kind} ${item.sourceName} → ${alvo}`);
      } catch (error) {
        const e = error as { code?: string; message?: string };
        const msg = e.message ?? String(error);
        if (e.code === 'RESULT_UNCERTAIN') {
          doubts += 1;
          this.addDoubt(alvo); // na dúvida o alvo fica bloqueado por 1 h
          this.log('duvida', `${alvo}: ${msg} (alvo bloqueado por 1 h, sem reenvio)`);
          if (doubts >= 3) {
            this.log('info', '3 envios sem confirmação seguidos — encerrei a rodada por segurança.');
            return;
          }
        } else if (e.code === 'GATEWAY_UNAVAILABLE') {
          this.log('info', `${msg} — rodada encerrada.`);
          return;
        } else {
          this.set({ refused: this.state.refused + 1 });
          this.log('recusa', `${item.sourceName} → ${alvo}: ${msg}`);
          // Sem tropa na aldeia: não insiste com os outros alvos dela.
          if (/tropa|unidade|suficiente/i.test(msg)) exhausted.add(item.sourceId);
        }
      }
      if (this.state.lastRound !== null) this.set({ lastRound: { ...this.state.lastRound, sent: sentNow } });
      if (!(await this.pause(jittered(cfg.pauseMs, cfg.jitterPct)))) return;
    }
    this.set({ progress: { done: items.length, total: items.length } });
    this.log('info', `Rodada ${this.state.round}: ${sentNow} farm(s) enviado(s).`);
  }
}
