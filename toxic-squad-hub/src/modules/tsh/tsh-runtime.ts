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
  /** Ações extras no cartão do painel (ex.: "Comandos" do agendador). */
  extraActions?: TshExtraAction[];
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
const LOCK_TTL_MS = 2 * 60 * 1000;
const ARM_TTL_MS = 30 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export function registerTsh(automation: TshAutomation): void {
  automations.set(automation.id, automation);
}

export function tshAutomations(): TshAutomation[] {
  return [...automations.values()];
}

const enabledKey = (id: string): string => `tsh-auto:${id}:enabled`;
const stateKey = (id: string, world: string): string => `tsh-auto:${world}:${id}:state`;
const statusKey = (id: string, world: string): string => `tsh-auto:${world}:${id}:status`;
const armKey = (id: string): string => `tsh-auto:${id}:armed-until`;
const lockKey = (id: string, world: string): string => `tsh-auto:${world}:${id}:lock`;

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
  gm.set(key, { tab: TAB_ID, at: now });
  return true;
}

function renewLock(id: string, world: string): void {
  gm.set(lockKey(id, world), { tab: TAB_ID, at: Date.now() });
}

/**
 * Renova o lock do módulo no meio de um ciclo longo (exportado p/ plugins com
 * miras/sleeps — P2 revisão Onda 9: sleeps somados não podem ultrapassar o
 * TTL de 2min sem renovação, senão outra aba assume e duplica a ação).
 */
export function renewTshLock(id: string, world: string): void {
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

/** Cooldown efetivo: override do usuário (minutos) > default do módulo > 5min. */
export function effectiveCooldownMs(automation: TshAutomation, schedule: TshSchedule): number {
  if (schedule.cooldownMinutes !== undefined && Number.isFinite(schedule.cooldownMinutes) && schedule.cooldownMinutes >= 1) {
    return schedule.cooldownMinutes * 60_000;
  }
  return automation.cooldownMs ?? DEFAULT_COOLDOWN_MS;
}

/** Próxima execução agendada (epoch ms) para contagem no painel; null = livre. */
export function tshNextRunAt(id: string, world?: string): number | null {
  const mundo = world ?? window.location.hostname.split('.')[0] ?? 'mundo';
  const state = gm.get<CycleState>(stateKey(id, mundo), {});
  return state.nextRunAt ?? null;
}

/** Executa um ciclo de UMA automação respeitando todas as regras. */
export async function runTshCycle(id: string, opts?: { ignoreCooldown?: boolean }): Promise<void> {
  const automation = automations.get(id);
  if (automation === undefined) return;
  // Mundo = subdomínio (br144.tribalwars.com.br → br144); aldeia da URL.
  const worldId = window.location.hostname.split('.')[0] ?? 'mundo';
  const villageId = new URLSearchParams(window.location.search).get('village') ?? '';

  if (inFlight.has(id)) return; // ciclo do mesmo módulo já em voo nesta aba
  if (!isTshEnabled(id)) return;
  if (!licenseOk()) {
    gm.set<CycleStatus>(statusKey(id, worldId), { message: 'Licença inativa — ciclos pausados.', kind: 'warn', at: Date.now() });
    return;
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
    return;
  }
  if (automation.screen !== null && screen !== automation.screen) return; // não é a tela dele
  // Agenda do usuário: fora da janela ativa o ciclo NÃO roda (status claro).
  if (!withinActiveWindow(schedule)) {
    gm.set<CycleStatus>(statusKey(id, worldId), {
      message: `Fora da janela ativa (${schedule.activeFrom ?? ''}–${schedule.activeTo ?? ''}) — ciclos pausados.`,
      kind: 'warn',
      at: Date.now(),
    });
    return;
  }
  if (automation.mutating && automation.armExempt !== true && !isArmed(id)) {
    gm.set<CycleStatus>(statusKey(id, worldId), { message: 'Aguardando armar (módulo muta o jogo).', kind: 'warn', at: Date.now() });
    return;
  }
  const state = gm.get<CycleState>(stateKey(id, worldId), {});
  const cooldown = effectiveCooldownMs(automation, schedule);
  if (!opts?.ignoreCooldown && state.nextRunAt !== undefined && Date.now() < state.nextRunAt) return;
  if (!acquireLock(id, worldId)) return; // outra aba está com o módulo
  inFlight.add(id);
  // Cooldown gravado ANTES do ciclo (P3 revisão): mutações que navegam podem
  // destruir o contexto antes do finally — o cooldown não pode se perder.
  gm.set<CycleState>(stateKey(id, worldId), { ...state, lastRunAt: Date.now(), nextRunAt: Date.now() + cooldown });
  const ctx: TshCycleContext = {
    world: worldId,
    villageId,
    storage: {
      get: <T,>(key: string, fallback: T): T => gm.get<T>(`tsh-auto:${worldId}:${id}:${key}`, fallback),
      set: <T,>(key: string, value: T): void => {
        gm.set(`tsh-auto:${worldId}:${id}:${key}`, value);
      },
    },
    status: (message, kind = 'info'): void => {
      gm.set<CycleStatus>(statusKey(id, worldId), { message, kind, at: Date.now() });
    },
  };

  try {
    await automation.runCycle(ctx);
  } catch (error) {
    ctx.status(error instanceof Error ? error.message : String(error), 'warn');
  } finally {
    renewLock(id, worldId);
    inFlight.delete(id);
  }
}

/**
 * Heartbeat: percorre as automações a cada 30s (aba aberta). O ciclo de cada
 * módulo decide se é a tela/hora dele; mutantes só com armação válida.
 */
export function startTshHeartbeat(scope: ModuleScope): void {
  scope.every(() => {
    for (const automation of automations.values()) {
      void runTshCycle(automation.id);
    }
  }, 30_000);
}
