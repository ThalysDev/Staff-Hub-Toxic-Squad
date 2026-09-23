// Configurações das automações: formulários declarativos + storage por
// módulo/mundo (mesma chave que os plugins já leem via ctx.storage) + agenda
// (cooldown em MINUTOS definido pelo usuário + janela de horário ativo).
// O painel gera o formulário a partir dos campos declarados — nada de JSON cru.

import { gm } from '../../core/storage';

export type SettingsFieldType = 'number' | 'boolean' | 'text' | 'textarea' | 'select' | 'record';

export interface SettingsRecordKey {
  /** Chave dentro do objeto do settings (ex.: 'spear', 'wood'). */
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface SettingsField {
  /** Chave dentro do objeto de settings do plugin (raiz — sem pontos). */
  key: string;
  label: string;
  type: SettingsFieldType;
  min?: number;
  max?: number;
  step?: number;
  /** Apenas para type='select'. */
  options?: { value: string; label: string }[];
  /** Apenas para type='record': uma caixa numérica por chave do objeto. */
  recordKeys?: SettingsRecordKey[];
  placeholder?: string;
  /** Ajuda curta exibida sob o campo. */
  help?: string;
}

/** Agenda de um módulo: quando os ciclos podem rodar. */
export interface TshSchedule {
  /** Cooldown entre ciclos em MINUTOS (override do default do módulo). */
  cooldownMinutes?: number;
  /** Janela ativa "HH:MM" local; vazio/ausente = sempre. Suporta virar a meia-noite (22:00→06:00). */
  activeFrom?: string;
  activeTo?: string;
}

const settingsKey = (world: string, id: string): string => `tsh-auto:${world}:${id}:settings`;
const scheduleKey = (world: string, id: string): string => `tsh-auto:${world}:${id}:schedule`;

/**
 * Settings efetivos: stored sobre defaults, chaves desconhecidas removidas e
 * tipos conferidos (number não vira string silenciosa no storage antigo).
 */
export function loadSettings<T extends Record<string, unknown>>(world: string, id: string, defaults: T): T {
  const stored = gm.get<Record<string, unknown>>(settingsKey(world, id), {});
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = stored[key];
    if (value === undefined) continue;
    const expected = defaults[key];
    if (typeof expected === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value;
    } else if (typeof expected === 'boolean') {
      if (typeof value === 'boolean') merged[key] = value;
    } else if (typeof expected === 'string') {
      if (typeof value === 'string') merged[key] = value;
    } else {
      merged[key] = value; // objetos/listas: confia (plugins validam com zod quando têm)
    }
  }
  return merged as T;
}

/**
 * Salva settings em MODO MERGE (P1 revisão Onda 8): o objeto gravado preserva
 * chaves que não têm campo no formulário (destinations/targets/blacklist/
 * priorities/…) — substituir o objeto inteiro apagava configuração existente.
 */
export function saveSettings(world: string, id: string, values: Record<string, unknown>): void {
  const stored = gm.get<Record<string, unknown>>(settingsKey(world, id), {});
  gm.set(settingsKey(world, id), { ...stored, ...values });
}

/** ZERA os settings do módulo (usado por "Restaurar padrões"). */
export function clearSettings(world: string, id: string): void {
  gm.set(settingsKey(world, id), {});
}

export function loadSchedule(world: string, id: string): TshSchedule {
  return gm.get<TshSchedule>(scheduleKey(world, id), {});
}

export function saveSchedule(world: string, id: string, schedule: TshSchedule): void {
  gm.set(scheduleKey(world, id), schedule);
}

const HH_MM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Valida agenda: cooldown 1..1440 min; janelas "HH:MM". Retorna erro pt-BR ou null. */
export function scheduleError(schedule: TshSchedule): string | null {
  if (schedule.cooldownMinutes !== undefined) {
    if (!Number.isFinite(schedule.cooldownMinutes) || schedule.cooldownMinutes < 1 || schedule.cooldownMinutes > 1440) {
      return 'Cooldown em minutos: número entre 1 e 1440.';
    }
  }
  if (schedule.activeFrom !== undefined && schedule.activeFrom !== '' && !HH_MM.test(schedule.activeFrom)) {
    return 'Início da janela ativa deve ser HH:MM (ex.: 08:00).';
  }
  if (schedule.activeTo !== undefined && schedule.activeTo !== '' && !HH_MM.test(schedule.activeTo)) {
    return 'Fim da janela ativa deve ser HH:MM (ex.: 23:00).';
  }
  return null;
}

function hmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Dentro da janela ativa? (relógio LOCAL do jogador; janela vazia = sempre).
 * Janela que cruza a meia-noite (22:00→06:00) conta como fora-inclusive.
 */
export function withinActiveWindow(schedule: TshSchedule, at: Date = new Date()): boolean {
  const from = schedule.activeFrom ?? '';
  const to = schedule.activeTo ?? '';
  if (from === '' || to === '' || !HH_MM.test(from) || !HH_MM.test(to)) return true;
  const now = at.getHours() * 60 + at.getMinutes();
  const start = hmToMinutes(from);
  const end = hmToMinutes(to);
  if (start === end) return true; // janela "travada" num horário único = sempre (evita surpresa)
  if (start < end) return now >= start && now < end;
  return now >= start || now < end; // cruza meia-noite
}
