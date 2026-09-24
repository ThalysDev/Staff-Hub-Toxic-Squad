// Regras por GRUPO da Coleta (v3.6.0) — versão para leigos: em vez de
// "grupoId:duração:lote:min" digitado à mão, cada regra é um cartão com o
// grupo escolhido pelo NOME (grupos do próprio jogo), como coletar
// (Equilibrada, um nível ou "Não coletar") e um tempo-alvo opcional.
// Puro/testável: o ciclo e a tela usam estas funções.

import { z } from 'zod';
import { gm } from '../../../core/storage';
import { parseGroupRules } from './collection-rules';

export const GROUP_MODES = ['geral', 'equilibrada', 'pequena', 'media', 'grande', 'extrema', 'pular'] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

export const groupProfileSchema = z.object({
  groupId: z.number().int().positive(),
  groupName: z.string().default(''),
  mode: z.enum(GROUP_MODES).default('geral'),
  /** Tempo-alvo (h) das ofensivas/defensivas do grupo; null = o geral. */
  hoursOff: z.number().min(0).max(48).nullable().default(null),
  hoursDef: z.number().min(0).max(48).nullable().default(null),
  /** Tropas que NÃO coletam neste grupo; null = as da configuração geral. */
  skipUnits: z.array(z.string()).nullable().default(null),
});
export type GroupProfile = z.infer<typeof groupProfileSchema>;

const MODE_LABEL: Record<GroupMode, string> = {
  geral: 'coletam como a configuração geral',
  equilibrada: 'níveis livres voltando juntos',
  pequena: 'só a Pequena Coleta',
  media: 'só a Média Coleta',
  grande: 'só a Grande Coleta',
  extrema: 'só a Extrema Coleta',
  pular: 'NÃO coletam',
};

/** Nível do modo (1..4), 'equilibrada', null (= não coletar) ou undefined (= o da configuração geral). */
export function levelForMode(mode: GroupMode): 'equilibrada' | number | null | undefined {
  if (mode === 'geral') return undefined;
  if (mode === 'pular') return null;
  if (mode === 'equilibrada') return 'equilibrada';
  return { pequena: 1, media: 2, grande: 3, extrema: 4 }[mode];
}

/** Frase do cartão: "Aldeias do grupo Defesa: só a Extrema Coleta, tempo-alvo 4 h." */
export function profileSummary(
  p: Pick<GroupProfile, 'groupName' | 'groupId' | 'mode' | 'hoursOff' | 'hoursDef'> & { skipUnits?: readonly string[] | null },
): string {
  const nome = p.groupName.trim() !== '' ? p.groupName : `grupo ${p.groupId}`;
  if (p.mode === 'pular') return `Aldeias de "${nome}" ${MODE_LABEL.pular}.`;
  const h = (v: number | null): string => (v === null ? 'como o geral' : v === 0 ? 'sem limite' : `${String(v).replace('.', ',')} h`);
  const alvo =
    p.hoursOff === null && p.hoursDef === null ? 'voltam no tempo geral' : `voltam em até: ofensivas ${h(p.hoursOff)}, defensivas ${h(p.hoursDef)}`;
  const tropas = p.skipUnits == null ? 'tropas iguais às gerais' : `${p.skipUnits.length} tropa(s) fora da coleta`;
  return `Aldeias de "${nome}": ${MODE_LABEL[p.mode]}, ${alvo}, ${tropas}.`;
}

/** Aldeia → regra (a PRIMEIRA regra da lista vence quando a aldeia está em mais de um grupo). */
export function profileByVillage(profiles: readonly GroupProfile[], villagesByGroup: ReadonlyMap<number, readonly number[]>): Map<string, GroupProfile> {
  const out = new Map<string, GroupProfile>();
  for (const p of profiles) {
    for (const vid of villagesByGroup.get(p.groupId) ?? []) {
      const key = String(vid);
      if (!out.has(key)) out.set(key, p);
    }
  }
  return out;
}

/** Converte as regras antigas em texto ("grupoId:duração:lote:min") em cartões. */
export function profilesFromLegacy(text: string): GroupProfile[] {
  if (text.trim() === '') return [];
  const parsed = parseGroupRules(text);
  if (!parsed.ok) return [];
  return parsed.rules.map((r) => ({ groupId: r.groupId, groupName: '', mode: r.duration, hoursOff: null, hoursDef: null, skipUnits: null }));
}

/**
 * Modo de execução SALVO (v3.6.0). Quem já tinha a Coleta configurada antes
 * da 3.6 (settings salvos sem execMode) continua em 'tela' — o segundo plano
 * em TODAS as aldeias é opt-in para quem já usava; conta nova nasce em 'fundo'.
 */
export function savedExecMode(world: string): { mode: 'fundo' | 'tela' | null; legacy: boolean } {
  const raw = gm.get<Record<string, unknown> | null>(`tsh-auto:${world}:collection:settings`, null);
  if (raw === null || typeof raw !== 'object' || Object.keys(raw).length === 0) return { mode: null, legacy: false };
  if (raw.execMode === 'fundo' || raw.execMode === 'tela') return { mode: raw.execMode, legacy: false };
  return { mode: 'tela', legacy: true };
}

/** Lê a lista salva (fail-closed: item inválido some, o resto vale). */
export function readProfiles(raw: unknown): GroupProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupProfile[] = [];
  for (const item of raw) {
    const r = groupProfileSchema.safeParse(item);
    if (r.success && !out.some((p) => p.groupId === r.data.groupId)) out.push(r.data);
  }
  return out;
}
