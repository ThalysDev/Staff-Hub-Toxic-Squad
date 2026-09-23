// Demolidor de Muralhas (userscript) — porta da frente da extensão
// toxic-squad-hub-ext (src/modules/features/farming-suite/plugin.ts,
// wallDemolitionPlugin) NO ESTADO DE ORIGEM: planejamento/prévia, sem
// execução. Na origem o plugin planeja a primeira onda de aríetes sobre um
// alvo com muralha mínima a partir do snapshot compartilhado — e o
// page-adapter da extensão nunca popula `targets` (lista sempre vazia), ou
// seja, não há execução canarada. Aqui a prévia avalia a mesma regra sobre os
// alvos de TEXTO "x|y|nível" (settings.targetsText; sem nível = muralha 0,
// nunca elegível) ou, com o texto vazio, sobre a lista local (storage
// 'targets'), com tropas conhecidas (storage 'troops'), publicando o
// resultado em status/'last-preview'. mutating=false: nenhum comando é
// enviado em nenhuma fase.

import { z } from 'zod';
import { registerTsh } from '../tsh-runtime';
import { coordinateLinesNote, parseCoordinateLines } from './op-generator';

export const wallDemolitionSettingsSchema = z.object({
  minRams: z.number().int().min(1).default(10),
  maxAttempts: z.number().int().min(1).max(10).default(1),
  minWallLevel: z.number().int().min(1).default(1),
  /** Editor de texto "x|y por linha" (opcional "x|y|nível da muralha"). */
  targetsText: z.string().max(20_000).default(''),
});
export type WallDemolitionSettings = z.infer<typeof wallDemolitionSettingsSchema>;

/** Defaults efetivos do schema (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: WallDemolitionSettings = {
  minRams: 10,
  maxAttempts: 1,
  minWallLevel: 1,
  targetsText: '',
};

/** Alvo local: fatos mínimos que a regra da origem consome (VillageTarget). */
export const wallDemolitionTargetSchema = z.object({
  id: z.string().min(1),
  x: z.number().int().min(0).max(999),
  y: z.number().int().min(0).max(999),
  points: z.number().int().nonnegative().default(0),
  wallLevel: z.number().int().min(0),
  barbarian: z.boolean().default(false),
});
export type WallDemolitionTarget = z.infer<typeof wallDemolitionTargetSchema>;

export interface WallDemolitionTextTargets {
  targets: WallDemolitionTarget[];
  invalidLines: number[];
  duplicates: number;
}

/**
 * Texto "x|y por linha" → alvos que o planner lê (id = coordenada, pontos 0).
 * O segmento opcional "x|y|nível" define a muralha do alvo (o planner só
 * forma onda com muralha >= minWallLevel); sem nível a muralha conta como 0.
 * Linha inválida é reportada (número 1-based) e NUNCA vira alvo.
 */
export function wallTargetsFromText(text: string): WallDemolitionTextTargets {
  const parsed = parseCoordinateLines(text);
  return {
    targets: parsed.targets.map((line) => ({
      id: line.coordinate,
      x: line.x,
      y: line.y,
      points: 0,
      wallLevel: line.extras.length > 0 ? Number(line.extras[0] ?? 0) : 0,
      barbarian: false,
    })),
    invalidLines: [...parsed.invalidLines],
    duplicates: parsed.duplicates,
  };
}

export type WallDemolitionPlan =
  | Readonly<{ kind: 'NO_WORK'; reason: string }>
  | Readonly<{ kind: 'PLAN'; targetId: string; ram: number; attempts: number }>;

/**
 * Planejador puro — mesma regra do plugin da origem: primeiro alvo com
 * muralha >= minWallLevel desde que haja aríetes suficientes em casa.
 */
export function planWallDemolition(
  settings: WallDemolitionSettings,
  targets: readonly WallDemolitionTarget[],
  ramsAvailable: number,
): WallDemolitionPlan {
  if (targets.length === 0) {
    return { kind: 'NO_WORK', reason: 'Nenhum alvo cadastrado na lista local — a prévia fica sem candidato.' };
  }
  const target = targets.find(
    (candidate) => candidate.wallLevel >= settings.minWallLevel && ramsAvailable >= settings.minRams,
  );
  if (!target) {
    return { kind: 'NO_WORK', reason: 'Nenhuma muralha elegível possui aríetes suficientes.' };
  }
  return { kind: 'PLAN', targetId: target.id, ram: settings.minRams, attempts: settings.maxAttempts };
}

registerTsh({
  id: 'wall-demolition',
  label: 'Demolidor de Muralhas',
  desc: 'Prévia (sem execução): calcula a onda de aríetes sobre o primeiro alvo com muralha mínima da lista local — nenhum ataque é enviado.',
  category: 'planejamento',
  screen: null,
  mutating: false,
  settingsDefaults: DEFAULT_SETTINGS,
  // Ficam FORA do formulário: a lista 'targets' do storage (objetos com
  // muralha/pontos) e 'troops' não são escalares do settings — o TEXTO
  // "x|y|nível" abaixo é o editor dessa lista no painel.
  settingsForm: [
    { key: 'minRams', label: 'Aríetes por onda', type: 'number', min: 1, help: 'Precisa haver esta quantidade em casa para a prévia formar a onda.' },
    { key: 'maxAttempts', label: 'Máximo de tentativas', type: 'number', min: 1, max: 10 },
    { key: 'minWallLevel', label: 'Nível mínimo da muralha', type: 'number', min: 1, help: 'Só alvos com muralha neste nível ou acima entram na prévia.' },
    {
      key: 'targetsText',
      label: 'Alvos (texto)',
      type: 'textarea',
      placeholder: '501|504|6\n505|510',
      help: 'Uma coordenada x|y por linha, com o nível da muralha opcional: "x|y|nível" (ex.: 501|504|6). Preenchido, substitui a lista "targets" do JSON; vazio, vale a lista salva. Sem nível a muralha conta como 0 — a prévia não forma onda. Linha inválida é ignorada e avisada no status.',
    },
  ],
  async runCycle(ctx): Promise<void> {
    const settings = wallDemolitionSettingsSchema.parse(ctx.storage.get('settings', DEFAULT_SETTINGS));
    const fromText = settings.targetsText.trim() !== '';
    const textTargets = fromText ? wallTargetsFromText(settings.targetsText) : null;
    const targets =
      textTargets !== null
        ? textTargets.targets
        : z.array(wallDemolitionTargetSchema).parse(ctx.storage.get<unknown>('targets', []));
    const troops = z
      .object({ ram: z.number().int().nonnegative().default(0) })
      .parse(ctx.storage.get<unknown>('troops', {}));
    const plan = planWallDemolition(settings, targets, troops.ram);
    const note = textTargets !== null ? coordinateLinesNote('targetsText', textTargets) : '';
    // Texto sem nível nenhum: a muralha conta como 0 e NADA é elegível —
    // o motivo honesto precisa dizer isso, não "falta aríete".
    const allLevelZero =
      textTargets !== null && textTargets.targets.length > 0 && textTargets.targets.every((target) => target.wallLevel === 0);
    const levelHint =
      plan.kind === 'NO_WORK' && allLevelZero
        ? ' Dica: informe o nível da muralha no texto ("x|y|nível", ex.: 501|504|6) — sem nível nenhum alvo é elegível.'
        : '';
    ctx.storage.set('last-preview', {
      ...plan,
      generatedAt: new Date().toISOString(),
      source: textTargets !== null ? 'targetsText' : 'targets',
      targetsConsidered: targets.length,
    });
    const suffix = `${note !== '' ? ` ${note}` : ''} Prévia, sem execução.`;
    if (plan.kind === 'PLAN') {
      ctx.status(
        `Prévia Demolidor de Muralhas: alvo ${plan.targetId} com ${plan.ram} aríetes (${plan.attempts} tentativa(s)) —${suffix}`,
        'ok',
      );
    } else {
      ctx.status(`${plan.reason}${levelHint}${suffix}`, 'info');
    }
  },
});
