// Motor de automações da extensão Toxic Squad Hub adaptado ao userscript.
// Regras portadas do page-runner da extensão (toxic-squad-hub-ext), ajustadas
// ao ambiente Tampermonkey:
// - Sem service worker: o "heartbeat" é um interval RASTRADO (ModuleScope) —
//   só roda com a aba do jogo aberta.
// - Multi-aba sem background: LOCK por módulo+ mundo em GM storage (aba viva
//   renova; lock vence em 2min) para duas abas não mutarem o mesmo módulo.
// - Licença SHS ativa (valida OU graça) — mesmo gate do produto.
// - Cooldown por módulo (default 5 min) + "armar" explícito para módulos que
//   MUTAM o jogo (o ciclo nunca decide sozinho mutar sem armação).
// - Regra F2: no máximo 1 mutação por ciclo — o plugin controla; o runtime
//   registra o nextRunAt quando o ciclo reporta mutação.

import { gm } from '../../core/storage';
import { licenseState } from '../../core/license';
import { pageWindow } from '../../core/page';
import { haltLabel, haltState } from '../../core/halt';
import type { ModuleScope } from '../vanta/vanta-lifecycle';
import { loadSchedule, withinActiveWindow, isScheduleStopped, stopLabel, type SettingsField, type TshSchedule } from './tsh-settings';

export interface TshCycleContext {
  world: string;
  villageId: string;
  /** Storage namespaced por módulo (chaves estáveis entre ciclos). */
  storage: {
    get<T>(key: string, fallback: T): T;
    set<T>(key: string, value: T): void;
  };
  /** Publica status do ciclo (aparece na aba Automações). */
  status(message: string, kind?: 'info' | 'ok' | 'warn'): void;
  /**
   * Pede o próximo ciclo mais cedo (v3.6.0): ainda há trabalho e este ciclo
   * já fez a SUA mutação (F2 segue: 1 por ciclo). Piso de 60 s.
   */
  again?(delayMs: number): void;
}

/** Tela de configuração própria do módulo (v3.6.0) — substitui "Parâmetros". */
export interface TshSettingsPanel {
  el: HTMLElement;
  /** Resumo que abre a janela (antes da Agenda), opcional. */
  top?: HTMLElement;
  /** Esconde o "Intervalo entre ciclos" da Agenda (o ritmo real mora na tela própria). */
  hideCooldown?: boolean;
  /** Valores prontos para salvar, ou o motivo (pt-BR) de não poder salvar. */
  collect(): { ok: true; values: Record<string, unknown> } | { ok: false; error: string };
}

export type TshCategory = 'economia' | 'producao' | 'planejamento';

export interface TshAutomation {
  id: string;
  label: string;
  desc: string;
  /** Grupo no painel (Economia / Produção & Militar / Planejamento). */
  category?: TshCategory;
  /** Tela (screen=) onde o ciclo roda; null = qualquer tela (API-driven). */
  screen: string | null;
  /**
   * v3.7.1 — script de PÁGINA cujo ciclo roda em qualquer tela mas que vive
   * numa página do jogo (ex.: Auto Farm → Assistente de Saque).
   */
  pageScreen?: string;
  /** Mínimo entre ciclos (ms) — DEFAULT; o usuário sobrepõe em MINUTOS nas configurações. */
  cooldownMs?: number;
  /** Mutação de jogo? Exige "armar" (autorização com validade). */
  mutating: boolean;
  /**
   * Exime do ARMAR (Onda 9, decisão do dono): a própria ação do módulo já é
   * autorização explícita do usuário (ex.: agendar um comando) — o toggle
   * Ativo é o único opt-in necessário. F2/lock/cooldown seguem valendo.
   */
  armExempt?: boolean;
  /** Formulário de configurações para o painel (campos declarativos). */
  settingsForm?: SettingsField[];
  /** Defaults dos settings (mesma forma que o plugin lê via ctx.storage). */
  settingsDefaults?: Record<string, unknown>;
  /** Tela própria de parâmetros (ícones, pré-visualização); o settingsForm segue como contrato. */
  settingsPanel?(settings: Record<string, unknown>, world: string): TshSettingsPanel;
  /** Ações extras no cartão do painel (ex.: "Comandos" do agendador). */
  extraActions?: TshExtraAction[];
  /**
   * Roda um ciclo LOGO após o carregamento da página (Onda A), sem esperar o
   * 1º heartbeat de 30s — ex.: o agendador precisa mirar na tela de
   * confirmação recém-aberta pelo pré-arme. Cooldown ignorado só neste boot;
   * lock/armação/tela/janela seguem valendo.
   */
  bootOnLoad?: boolean;
  /** Lock entre abas por ALDEIA (não por mundo): várias abas, uma por origem. */
  lockPerVillage?: boolean;
  /** Um ciclo: ler → planejar → NO MÁXIMO 1 mutação (F2). */
  runCycle(ctx: TshCycleContext): Promise<void>;
}

export interface TshExtraAction {
  label: string;
  open(shadow: ShadowRoot, world: string, rerender: () => void): void;
}

interface CycleStatus {
  message: string;
  kind: 'info' | 'ok' | 'warn';
  at: number;
}

const automations = new Map<string, TshAutomation>();
const TAB_ID = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Id desta carga de página (aba) — reivindicações entre abas (Onda A). */
export function tshTabId(): string {
  return TAB_ID;
}
const LOCK_TTL_MS = 2 * 60 * 1000;
const ARM_TTL_MS = 30 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export function registerTsh(automation: TshAutomation): void {
  automations.set(automation.id, automation);
}

/** Página do jogo de um script de página (null = script de background). */
export function tshPageScreen(automation: Pick<TshAutomation, 'pageScreen' | 'screen'>): string | null {
  return automation.pageScreen ?? automation.screen;
}

export function tshAutomations(): TshAutomation[] {
  return [...automations.values()];
}

const enabledKey = (id: string): string => `tsh-auto:${id}:enabled`;
/**
 * Escopo por ALDEIA (`lockPerVillage`): lock, cooldown e status andam JUNTOS.
 * Revisão de código da Onda 1 (P0): só o lock era por aldeia — o cooldown
 * (nextRunAt) ficava por mundo e, com duas abas de origem, a primeira a rodar
 * empurrava a outra para fora de TODOS os ciclos (só rodava no boot).
 */
const villageScope = (id: string): string =>
  automations.get(id)?.lockPerVillage === true ? `:v${currentVillageId()}` : '';
const stateKey = (id: string, world: string): string => `tsh-auto:${world}:${id}${villageScope(id)}:state`;
const statusKey = (id: string, world: string): string => `tsh-auto:${world}:${id}${villageScope(id)}:status`;
const armKey = (id: string): string => `tsh-auto:${id}:armed-until`;
/**
 * Aldeia desta página: `game_data` do jogo primeiro (a URL pode não trazer
 * `village=` — `game.php?screen=place` abre a aldeia atual), URL de reserva;
 * sem o prefixo `n` das aldeias novas.
 */
export function currentVillageId(): string {
  const fromGame = pageWindow().game_data?.village?.id;
  const raw = fromGame !== undefined && fromGame !== null ? String(fromGame) : (new URLSearchParams(window.location.search).get('village') ?? '');
  return raw.replace(/^n/, '');
}

/**
 * Chave do lock entre abas. Módulos com `lockPerVillage` travam POR ALDEIA:
 * o Agendador só envia comandos da aldeia aberta na aba, então numa OP com
 * várias origens cada aba (uma por aldeia) precisa rodar ao mesmo tempo — o
 * lock por mundo deixava só UMA aba viva e as outras origens nunca enviavam.
 */
const lockKey = (id: string, world: string): string => `tsh-auto:${world}:${id}${villageScope(id)}:lock`;

export function isTshEnabled(id: string): boolean {
  return gm.get<boolean>(enabledKey(id), false); // OPT-IN: nada muta por padrão.
}

export function setTshEnabled(id: string, enabled: boolean): void {
  gm.set(enabledKey(id), enabled);
}

export function tshStatus(id: string, world?: string): CycleStatus | null {
  const mundo = world ?? window.location.hostname.split('.')[0] ?? 'mundo';
  return gm.get<CycleStatus | null>(statusKey(id, mundo), null);
}

/** Arma um módulo mutante por 30 min (confirmação explícita do usuário). */
export function armTsh(id: string): void {
  gm.set(armKey(id), Date.now() + ARM_TTL_MS);
}

/** Desarma na hora (Onda C: "Desarmar todas" no painel). */
export function disarmTsh(id: string): void {
  gm.set(armKey(id), 0);
}

export function tshArmedUntil(id: string): number {
  return gm.get<number>(armKey(id), 0);
}

function isArmed(id: string): boolean {
  return Date.now() < tshArmedUntil(id);
}

/** Lock de aba: só uma aba por mundo+módulo executa ciclos. */
function acquireLock(id: string, world: string): boolean {
  const key = lockKey(id, world);
  const lock = gm.get<{ tab: string; at: number } | null>(key, null);
  const now = Date.now();
  if (lock !== null && lock.tab !== TAB_ID && now - lock.at < LOCK_TTL_MS) return false;
  handedOff.delete(id); // novo ciclo desta aba: volta a ser dona do lock
  gm.set(key, { tab: TAB_ID, at: now });
  return true;
}

function renewLock(id: string, world: string): void {
  // Lock entregue à página seguinte (clique/submit que navega): o `finally`
  // do ciclo roda ANTES da navegação e não pode retomá-lo (Onda E).
  if (handedOff.has(id)) return;
  gm.set(lockKey(id, world), { tab: TAB_ID, at: Date.now() });
}

/**
 * Libera o lock do módulo SE for desta aba (Onda A): chamado logo antes de uma
 * ação que NAVEGA de propósito (pré-arme do cravado) — a página nova recebe
 * um id de aba novo e, sem isto, ficaria até 2min sem conseguir o lock.
 */
/** Módulos que ENTREGARAM o lock à próxima página (o finally não o retoma). */
const handedOff = new Set<string>();

export function releaseTshLock(id: string, world: string): void {
  handedOff.add(id);
  const key = lockKey(id, world);
  const lock = gm.get<{ tab: string; at: number } | null>(key, null);
  if (lock !== null && lock.tab === TAB_ID) gm.set(key, { tab: TAB_ID, at: 0 });
}

/**
 * Renova o lock do módulo no meio de um ciclo longo (exportado p/ plugins com
 * miras/sleeps — P2 revisão Onda 9: sleeps somados não podem ultrapassar o
 * TTL de 2min sem renovação, senão outra aba assume e duplica a ação).
 */
export function renewTshLock(id: string, world: string): void {
  handedOff.delete(id); // renovação explícita = a aba segue dona (ex.: o clique falhou)
  renewLock(id, world);
}

function licenseOk(): boolean {
  const state = licenseState();
  return state.kind === 'valida' || state.kind === 'graca';
}

// P1 (revisão Onda 6): guarda de re-entrância por id na MESMA aba — cliques
// repetidos em "Rodar agora" ou heartbeat sobrepondo ciclo lento nunca podem
// disparar 2 mutações do mesmo módulo.
const inFlight = new Set<string>();

function currentScreen(): string | null {
  return new URLSearchParams(window.location.search).get('screen');
}

interface CycleState {
  nextRunAt?: number;
  lastRunAt?: number;
}

/** Nome em português das telas do jogo (mensagens do "Rodar agora"). */
const SCREEN_LABELS: Record<string, string> = {
  place: 'Praça', snob: 'Academia', market: 'Mercado', main: 'Edifício principal', barracks: 'Quartel',
  stable: 'Estábulo', garage: 'Oficina', statue: 'Estátua', smith: 'Ferreiro', overview_villages: 'Visualizações',
  overview: 'Visão geral', info_village: 'Informações da aldeia', inventory: 'Inventário', am_farm: 'Assistente de Saque',
  map: 'Mapa', ally: 'Tribo', train: 'Recrutamento', scavenge: 'Coleta',
};

/** Cooldown efetivo: override do usuário (minutos) > default do módulo > 5min. */
export function effectiveCooldownMs(automation: TshAutomation, schedule: TshSchedule): number {
  if (schedule.cooldownMinutes !== undefined && Number.isFinite(schedule.cooldownMinutes) && schedule.cooldownMinutes >= 1) {
    return schedule.cooldownMinutes * 60_000;
  }
  return automation.cooldownMs ?? DEFAULT_COOLDOWN_MS;
}

/**
 * Aplica NA HORA um novo intervalo salvo nas configurações. O `nextRunAt` é
 * gravado quando o ciclo começa, com o intervalo da época: sem isto, baixar de
 * 60 para 5 min só valia depois de esperar os 60 antigos ("não consigo alterar
 * o tempo de ciclo"). Recalcula a partir do último ciclo com o intervalo novo.
 */
export function applyScheduleChange(id: string, world: string): void {
  const automation = automations.get(id);
  if (automation === undefined) return;
  const state = gm.get<CycleState>(stateKey(id, world), {});
  if (state.lastRunAt === undefined) {
    if (state.nextRunAt !== undefined) gm.set<CycleState>(stateKey(id, world), {});
    return;
  }
  const cooldown = effectiveCooldownMs(automation, loadSchedule(world, id));
  gm.set<CycleState>(stateKey(id, world), { ...state, nextRunAt: state.lastRunAt + cooldown });
}

/** Próxima execução agendada (epoch ms) para contagem no painel; null = livre. */
export function tshNextRunAt(id: string, world?: string): number | null {
  const mundo = world ?? window.location.hostname.split('.')[0] ?? 'mundo';
  const state = gm.get<CycleState>(stateKey(id, mundo), {});
  return state.nextRunAt ?? null;
}

/**
 * Restringe esta página a algumas automações (v3.3.0: o quadro invisível do
 * envio em 2º plano só roda o Agendador — nada de Coleta/Apoio em massa lá).
 */
let onlyIds: ReadonlySet<string> | null = null;
export function restrictTshTo(ids: readonly string[]): void {
  onlyIds = new Set(ids);
}

/**
 * Travas de agenda que impedem o ciclo em QUALQUER tela (licença, parada
 * programada, fora do horário ativo) — leitura pura, sem gravar status.
 * Usado pelo Condutor (v3.2.2): não leva aba nenhuma para a Praça se o
 * Agendador lá não vai rodar. null = liberado.
 */
export function tshAgendaBlock(id: string, worldId: string): string | null {
  if (!licenseOk()) return 'a licença está inativa';
  const schedule = loadSchedule(worldId, id);
  if (isScheduleStopped(schedule)) return 'a parada programada do Agendador foi atingida';
  if (!withinActiveWindow(schedule)) return 'o Agendador está fora do horário ativo';
  return null;
}

/**
 * v3.7.0 — travas de uma automação que roda FORA do ciclo (script de página,
 * ex.: Central de Farm): desligada, script pausado (captcha/sessão), licença,
 * parada programada, fora do horário ativo. null = liberada.
 */
export interface TshRunBlock {
  /** 'janela' = só esperar (volta sozinho quando o horário abrir). */
  kind: 'desligado' | 'pausado' | 'licenca' | 'parada' | 'janela';
  /** Frase completa em PT-BR. */
  text: string;
}

export function tshRunBlock(id: string, worldId: string): TshRunBlock | null {
  if (!isTshEnabled(id)) return { kind: 'desligado', text: 'Parou: a automação foi desligada no painel.' };
  const halt = haltState();
  if (halt !== null) return { kind: 'pausado', text: `Pausado: ${haltLabel(halt)}. Resolva no jogo e retome na aba Início do painel.` };
  if (!licenseOk()) return { kind: 'licenca', text: 'Parou: sua licença está inativa.' };
  const schedule = loadSchedule(worldId, id);
  if (isScheduleStopped(schedule)) return { kind: 'parada', text: 'Parou: a parada programada foi atingida (desligue em Configurar → Agenda).' };
  if (!withinActiveWindow(schedule)) {
    return { kind: 'janela', text: `Fora do horário ativo (${schedule.activeFrom ?? ''}–${schedule.activeTo ?? ''}) — volta sozinho quando o horário abrir.` };
  }
  return null;
}

/**
 * Executa um ciclo. Devolve null quando RODOU, ou o motivo (pt-BR) de não
 * ter rodado — o "Rodar agora" mostra isso na linha (antes o clique
 * terminava em silêncio e parecia quebrado).
 */
export async function runTshCycle(id: string, opts?: { ignoreCooldown?: boolean }): Promise<string | null> {
  const automation = automations.get(id);
  if (automation === undefined) return 'Automação desconhecida.';
  // Mundo = subdomínio (br144.tribalwars.com.br → br144); aldeia da URL.
  const worldId = window.location.hostname.split('.')[0] ?? 'mundo';
  const villageId = currentVillageId();

  if (onlyIds !== null && !onlyIds.has(id)) return 'Esta página só roda o Agendador (envio em 2º plano).';
  if (inFlight.has(id)) return 'Já está rodando um ciclo agora.'; // ciclo do mesmo módulo já em voo nesta aba
  if (!isTshEnabled(id)) return 'Está desligada — ligue a chave primeiro.';
  // Disjuntor (Onda 1): captcha/sessão param TODAS as automações até o
  // jogador retomar na Início — nada de tentar de novo a cada ciclo.
  const halt = haltState();
  if (halt !== null) {
    gm.set<CycleStatus>(statusKey(id, worldId), { message: `${haltLabel(halt)} — pausado. Retome na aba Início do painel (ou na faixa vermelha acima do escudo).`, kind: 'warn', at: Date.now() });
    return `${haltLabel(halt)}: script pausado — retome na Início.`;
  }
  if (!licenseOk()) {
    gm.set<CycleStatus>(statusKey(id, worldId), { message: 'Licença inativa — ciclos pausados.', kind: 'warn', at: Date.now() });
    return 'Licença inativa.';
  }
  const screen = currentScreen();
  // Parada programada ANTES do gate de tela (P2-2 revisão Onda 0): o status de
  // "parado" precisa ser escrito mesmo com o jogador em outra tela — é o único
  // escritor da mensagem que o painel de Automações mostra.
  const schedule = loadSchedule(worldId, id);
  if (isScheduleStopped(schedule)) {
    gm.set<CycleStatus>(statusKey(id, worldId), {
      message: `${stopLabel(schedule)} — ciclos pausados até a parada ser desligada nas configurações.`,
      kind: 'warn',
      at: Date.now(),
    });
    return 'Parada programada atingida — desligue a parada em Configurar.';
  }
  if (automation.screen !== null && screen !== automation.screen) {
    return `Só roda na tela ${SCREEN_LABELS[automation.screen] ?? automation.screen} — abra essa tela do jogo.`; // não é a tela dele
  }
  // Agenda do usuário: fora da janela ativa o ciclo NÃO roda (status claro).
  if (!withinActiveWindow(schedule)) {
    gm.set<CycleStatus>(statusKey(id, worldId), {
      message: `Fora da janela ativa (${schedule.activeFrom ?? ''}–${schedule.activeTo ?? ''}) — ciclos pausados.`,
      kind: 'warn',
      at: Date.now(),
    });
    return schedule.activeFrom !== undefined && schedule.activeTo !== undefined
      ? `Fora do horário ativo (${schedule.activeFrom}–${schedule.activeTo}). Ajuste em Configurar.`
      : 'Fora do horário ativo. Ajuste em Configurar.';
  }
  if (automation.mutating && automation.armExempt !== true && !isArmed(id)) {
    gm.set<CycleStatus>(statusKey(id, worldId), { message: 'Aguardando armar (módulo muta o jogo).', kind: 'warn', at: Date.now() });
    return 'Clique em "Armar" nesta linha e tente de novo.';
  }
  const state = gm.get<CycleState>(stateKey(id, worldId), {});
  const cooldown = effectiveCooldownMs(automation, schedule);
  if (!opts?.ignoreCooldown && state.nextRunAt !== undefined && Date.now() < state.nextRunAt) return 'Aguardando o intervalo entre ciclos.';
  if (!acquireLock(id, worldId)) return 'Outra aba do jogo está rodando esta automação.'; // outra aba está com o módulo
  inFlight.add(id);
  // Cooldown gravado ANTES do ciclo (P3 revisão): mutações que navegam podem
  // destruir o contexto antes do finally — o cooldown não pode se perder.
  gm.set<CycleState>(stateKey(id, worldId), { ...state, lastRunAt: Date.now(), nextRunAt: Date.now() + cooldown });
  let againAt: number | null = null;
  const ctx: TshCycleContext = {
    world: worldId,
    villageId,
    storage: {
      get: <T,>(key: string, fallback: T): T => {
        const value = gm.get<T>(`tsh-auto:${worldId}:${id}:${key}`, fallback);
        // Settings salvos PARCIAIS (versão antiga, chave nova sem campo no
        // formulário) chegavam com chaves undefined ao ciclo: completa com os
        // padrões do módulo — o salvo sempre vence.
        if (key === 'settings' && automation.settingsDefaults !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)) {
          return { ...automation.settingsDefaults, ...(value as Record<string, unknown>) } as T;
        }
        return value;
      },
      set: <T,>(key: string, value: T): void => {
        gm.set(`tsh-auto:${worldId}:${id}:${key}`, value);
      },
    },
    status: (message, kind = 'info'): void => {
      gm.set<CycleStatus>(statusKey(id, worldId), { message, kind, at: Date.now() });
    },
    again: (delayMs: number): void => {
      againAt = Date.now() + Math.max(60_000, delayMs);
    },
  };

  try {
    await automation.runCycle(ctx);
  } catch (error) {
    ctx.status(error instanceof Error ? error.message : String(error), 'warn');
  } finally {
    if (againAt !== null) {
      const cur = gm.get<CycleState>(stateKey(id, worldId), {});
      if (cur.nextRunAt === undefined || againAt < cur.nextRunAt) gm.set<CycleState>(stateKey(id, worldId), { ...cur, nextRunAt: againAt });
    }
    renewLock(id, worldId);
    inFlight.delete(id);
  }
  return null;
}

/**
 * Heartbeat: percorre as automações a cada 30s (aba aberta). O ciclo de cada
 * módulo decide se é a tela/hora dele; mutantes só com armação válida.
 *
 * Modo Sentinela (Onda 5): a aba de fundo chama ESTE mesmo heartbeat. O gate
 * de tela NÃO foi reescrito nesta onda (decisão explícita): automações
 * API-first (screen null) rodam em qualquer tela — logo rodam na Sentinela;
 * as presas a uma tela seguem limitadas à tela aberta NA ABA ATIVA (a
 * Sentinela destrava as null-screen e acelera as demais quando o usuário
 * navega nela). O lock por módulo+mundo abaixo é o que impede Sentinela e aba
 * normal executarem o mesmo módulo ao mesmo tempo.
 */
export function startTshHeartbeat(scope: ModuleScope): void {
  // Cada carga de página tem id de aba NOVO: sem soltar o lock ao sair, a
  // página seguinte (o jogador navegou na Praça, enviou um ataque à mão)
  // ficava até LOCK_TTL_MS sem poder rodar — cravado nessa janela falhava.
  // pagehide dispara 1× no fim da página (vale também para o bfcache).
  window.addEventListener('pagehide', () => {
    const world = window.location.hostname.split('.')[0] ?? 'mundo';
    for (const id of automations.keys()) {
      const lock = gm.get<{ tab: string; at: number } | null>(lockKey(id, world), null);
      if (lock !== null && lock.tab === TAB_ID) gm.set(lockKey(id, world), null);
    }
  });
  // Boot (Onda A): módulos que pedem ciclo imediato rodam ~0,4s após o load.
  scope.after(() => {
    for (const automation of automations.values()) {
      if (automation.bootOnLoad === true) void runTshCycle(automation.id, { ignoreCooldown: true });
    }
  }, 400);
  scope.every(() => {
    for (const automation of automations.values()) {
      void runTshCycle(automation.id);
    }
  }, 30_000);
}

/**
 * Quantas automações estão ligadas (switch Ativo) — usado pelo badge da aba
 * Sentinela (contagem "N ativas" no título, sem abrir painel).
 */
export function activeTshCount(): number {
  let total = 0;
  for (const id of automations.keys()) {
    if (isTshEnabled(id)) total += 1;
  }
  return total;
}
