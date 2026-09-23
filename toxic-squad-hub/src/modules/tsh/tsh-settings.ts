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
  /**
   * Parada programada universal: quando ligada e o instante `stopAt` passa, o
   * módulo NÃO roda mais (status claro no painel) até o usuário desligar —
   * funciona como freio de mão para longas sessões de automação.
   */
  stopEnabled?: boolean;
  /** Instante da parada no formato datetime-local "YYYY-MM-DDTHH:MM" (fuso do jogador). */
  stopAt?: string;
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
  if (schedule.stopAt !== undefined && schedule.stopAt !== '') {
    if (!STOP_AT.test(schedule.stopAt)) return 'Parada programada deve ser data e hora válidas.';
    // P2-1 (revisão Onda 0): regex aceita "9999-99-99T99:99" — valida também o
    // parse real, senão storage corrompido parava o módulo com rótulo estranho.
    if (!Number.isFinite(Date.parse(schedule.stopAt))) return 'Parada programada deve ser uma data real.';
  }
  return null;
}

const STOP_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Parada programada ATIVA? (stopEnabled ligado + stopAt válido já passado.)
 * Retorna true também quando o formato é inválido e stopEnabled está ligado
 * com valor presente — fail-closed: data ruim não pode virar "nunca para".
 */
export function isScheduleStopped(schedule: TshSchedule, at: Date = new Date()): boolean {
  if (schedule.stopEnabled !== true) return false;
  const raw = schedule.stopAt ?? '';
  if (raw === '') return false;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return true;
  return at.getTime() >= ts;
}

/** Rótulo curto da parada p/ status do painel ("em 23/09 18:00" / "atingida"). */
export function stopLabel(schedule: TshSchedule, at: Date = new Date()): string {
  const raw = schedule.stopAt ?? '';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return 'parada programada (data inválida)';
  if (at.getTime() >= ts) return `parada programada atingida (${raw.replace('T', ' ')})`;
  return `para em ${raw.replace('T', ' ')}`;
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
