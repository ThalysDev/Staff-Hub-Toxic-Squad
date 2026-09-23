// Cultivador de Bárbaras (userscript) — porta da frente da extensão
// toxic-squad-hub-ext (src/modules/features/farming-suite/plugin.ts,
// barbarianCultivatorPlugin) NO ESTADO DE ORIGEM: planejamento/prévia, sem
// execução. Na origem o plugin escolhe o primeiro alvo bárbaro e o primeiro
// edifício alvo não protegido a partir do snapshot compartilhado — e o
// page-adapter da extensão nunca popula `targets`, ou seja, não há execução
// canarada. Aqui a prévia avalia a mesma regra sobre os alvos de TEXTO
// "x|y por linha" (settings.targetsText, todos bárbaros por definição) ou,
// com o texto vazio, sobre a lista local (storage 'targets'), com catapultas
// conhecidas (storage 'troops'), publicando o resultado em
// status/'last-preview'. mutating=false: nenhum comando é enviado em
// nenhuma fase.

import { z } from 'zod';
import { registerTsh } from '../tsh-runtime';
import { coordinateLinesNote, parseCoordinateLines } from './op-generator';

export const barbarianCultivatorSettingsSchema = z.object({
  catapultsPerWave: z.number().int().min(1).default(20),
  protectedBuildings: z.array(z.string()).default(['wood', 'stone', 'iron', 'farm', 'storage']),
  targetBuildings: z.array(z.string()).default(['main', 'barracks', 'stable', 'market']),
  /** Editor de texto "x|y por linha" — alvos bárbaros do Cultivador. */
  targetsText: z.string().max(20_000).default(''),
});
export type BarbarianCultivatorSettings = z.infer<typeof barbarianCultivatorSettingsSchema>;

/** Defaults efetivos do schema (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: BarbarianCultivatorSettings = {
  catapultsPerWave: 20,
  protectedBuildings: ['wood', 'stone', 'iron', 'farm', 'storage'],
  targetBuildings: ['main', 'barracks', 'stable', 'market'],
  targetsText: '',
};

/** Alvo local: fatos mínimos que a regra da origem consome (VillageTarget). */
export const barbarianCultivatorTargetSchema = z.object({
  id: z.string().min(1),
  x: z.number().int().min(0).max(999),
  y: z.number().int().min(0).max(999),
  points: z.number().int().nonnegative().default(0),
  barbarian: z.boolean(),
});
export type BarbarianCultivatorTarget = z.infer<typeof barbarianCultivatorTargetSchema>;

export interface BarbarianCultivatorTextTargets {
  targets: BarbarianCultivatorTarget[];
  invalidLines: number[];
  duplicates: number;
}

/**
 * Texto "x|y por linha" → alvos que o planner lê (id = coordenada, pontos 0,
 * bárbara por definição — o módulo cultiva bárbaras). Linha com segmento
 * extra (ex.: "500|500|3") é inválida AQUI: o Cultivador não tem contrato de
 * nível. Linha inválida é reportada (1-based) e NUNCA vira alvo.
 */
export function barbarianTargetsFromText(text: string): BarbarianCultivatorTextTargets {
  const parsed = parseCoordinateLines(text);
  const invalidLines = [...parsed.invalidLines];
  const targets: BarbarianCultivatorTarget[] = [];
  for (const line of parsed.targets) {
    if (line.extras.length > 0) {
      invalidLines.push(line.line);
      continue;
    }
    targets.push({ id: line.coordinate, x: line.x, y: line.y, points: 0, barbarian: true });
  }
  return { targets, invalidLines: invalidLines.sort((left, right) => left - right), duplicates: parsed.duplicates };
}

export type BarbarianCultivationPlan =
  | Readonly<{ kind: 'NO_WORK'; reason: string }>
  | Readonly<{ kind: 'PLAN'; targetId: string; building: string; catapult: number }>;

/**
 * Planejador puro — mesma regra do plugin da origem: primeiro alvo bárbaro
 * desde que exista edifício alvo fora da lista de protegidos e catapultas
 * suficientes em casa.
 */
export function planBarbarianCultivation(
  settings: BarbarianCultivatorSettings,
  targets: readonly BarbarianCultivatorTarget[],
  catapultsAvailable: number,
): BarbarianCultivationPlan {
  const targetBuilding = settings.targetBuildings.find((building) => !settings.protectedBuildings.includes(building));
  const target = targets.find((candidate) => candidate.barbarian && targetBuilding !== undefined);
  if (!target || !targetBuilding || catapultsAvailable < settings.catapultsPerWave) {
    return { kind: 'NO_WORK', reason: 'Nenhuma construção bárbara está elegível para cultivo.' };
  }
  return { kind: 'PLAN', targetId: target.id, building: targetBuilding, catapult: settings.catapultsPerWave };
}

registerTsh({
  id: 'barbarian-cultivator',
  label: 'Cultivador de Bárbaras',
  desc: 'Prévia (sem execução): escolhe o alvo bárbaro e o edifício alvo da onda de catapultas pela lista local — nenhum ataque é enviado.',
  category: 'planejamento',
  screen: null,
  mutating: false,
  settingsDefaults: DEFAULT_SETTINGS,
  // Ficam FORA do formulário: protectedBuildings/targetBuildings são LISTAS de
  // edifícios e a lista 'targets' do storage não é escalar do settings — o
  // TEXTO "x|y por linha" abaixo é o editor dessa lista no painel.
  settingsForm: [
    {
      key: 'catapultsPerWave',
      label: 'Catapultas por onda',
      type: 'number',
      min: 1,
      help: 'Precisa haver esta quantidade em casa para a prévia formar a onda.',
    },
    {
      key: 'targetsText',
      label: 'Alvos (texto)',
      type: 'textarea',
      placeholder: '500|500\n501|503',
      help: 'Coordenadas x|y de bárbaras, uma por linha. Preenchido, substitui a lista "targets" do JSON; vazio, vale a lista salva. Linha inválida é ignorada e avisada no status.',
    },
  ],
  async runCycle(ctx): Promise<void> {
    const settings = barbarianCultivatorSettingsSchema.parse(ctx.storage.get('settings', DEFAULT_SETTINGS));
    const fromText = settings.targetsText.trim() !== '';
    const textTargets = fromText ? barbarianTargetsFromText(settings.targetsText) : null;
    const targets =
      textTargets !== null
        ? textTargets.targets
        : z.array(barbarianCultivatorTargetSchema).parse(ctx.storage.get<unknown>('targets', []));
    const troops = z
      .object({ catapult: z.number().int().nonnegative().default(0) })
      .parse(ctx.storage.get<unknown>('troops', {}));
    const plan = planBarbarianCultivation(settings, targets, troops.catapult);
    const note = textTargets !== null ? coordinateLinesNote('targetsText', textTargets) : '';
    ctx.storage.set('last-preview', {
      ...plan,
      generatedAt: new Date().toISOString(),
      source: textTargets !== null ? 'targetsText' : 'targets',
      targetsConsidered: targets.length,
    });
    const suffix = `${note !== '' ? ` ${note}` : ''} Prévia, sem execução.`;
    if (plan.kind === 'PLAN') {
      ctx.status(
        `Prévia Cultivador de Bárbaras: alvo ${plan.targetId}, edifício ${plan.building}, ${plan.catapult} catapultas —${suffix}`,
        'ok',
      );
    } else {
      ctx.status(`${plan.reason}${suffix}`, 'info');
    }
  },
});
