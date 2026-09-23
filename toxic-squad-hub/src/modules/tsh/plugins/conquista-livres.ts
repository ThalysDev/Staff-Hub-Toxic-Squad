// Plugin TSH 'conquista-livres' — Conquista de Aldeias Livres (Onda 5b):
// - LÊ o mapa pelo próprio script (/map/village.txt via tsh-game-data) e monta
//   os candidatos: aldeias com owner = 0 (livres/bárbaras) — nada de pedir ao
//   usuário o que o jogo já entrega;
// - roda a engine PURA conquest-planner (ranking por distancia|pontos|farm|
//   barracos, tetos de pontos/distância e lealdade mínima) e publica a PRÉVIA
//   do alvo do plano, com quantos nobres o pior caso exige;
// - modo 'executar' (settings.mode): agenda UM nobre para o alvo pelo
//   Agendador de Comandos — grava o registro kind 'noble' no storage do
//   Agendador (mesma chave/contrato do módulo: o motor dele é quem envia, na
//   janela de 15s). A chegada é calculada com o tempo de viagem real do nobre
//   (tsh-game-data) e o "quando" digitado é a CHEGADA (timingMode 'arrival').
// - Fail-closed em cadeia: sem origem conhecida, sem tempo de viagem, com o
//   Agendador desligado/desarmado, com nobre já agendado para o alvo ou com
//   registro inválido, NADA é gravado — o status explica o porquê.

import { z } from 'zod';
import { registerTsh, isTshEnabled, tshArmedUntil, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { gm } from '../../../core/storage';
import { allVillages, ownVillages, travelMinutes } from '../tsh-game-data';
import { arrivalToSendAt } from '../tsh-commands-ui';
import { serverNowIso } from './op-generator';
import { createScheduledCommand } from './command-scheduler';
import {
  parseSchedulerCommandRecord,
  type HubSchedulerState,
  type ScheduledCommandRecord,
} from '../../../ext/core/scheduler-state';
import {
  parseConquestRanking,
  planConquest,
  type ConquestCandidate,
  type ConquestRankingCriterion,
  type ConquestTargetPlan,
} from '../../../ext/modules/features/conquest/conquest-planner';

/** Modos do plugin: prévia (default — nada é agendado) e execução real. */
export const CONQUEST_MODES = Object.freeze(['preview', 'executar'] as const);
export type ConquestMode = (typeof CONQUEST_MODES)[number];

const conquestSettings = z.object({
  mode: z.enum(CONQUEST_MODES).default('preview'),
  maxPoints: z.number().int().min(0).default(1_000),
  maxDistance: z.number().int().min(0).default(30),
  minLoyalty: z.number().int().min(0).max(100).default(0),
  rankingText: z.string().default(''),
});

type ConquestSettings = z.infer<typeof conquestSettings>;

/** Defaults (mesmos do schema; semente do painel). */
export const DEFAULT_SETTINGS: ConquestSettings = {
  mode: 'preview',
  maxPoints: 1_000,
  maxDistance: 30,
  minLoyalty: 0,
  rankingText: '',
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'mode',
    label: 'Modo',
    type: 'select',
    options: [
      { value: 'preview', label: 'Prévia (nada é agendado)' },
      { value: 'executar', label: 'Executar (agenda o nobre no Agendador)' },
    ],
    help: 'Prévia: só relata o alvo do plano. Executar: grava um comando de nobre no Agendador de Comandos (que precisa estar ligado e armado para enviar).',
  },
  {
    key: 'maxPoints',
    label: 'Pontos máximos do alvo',
    type: 'number',
    min: 0,
    max: 100_000,
    step: 100,
    help: 'Só entram aldeias livres com até esta pontuação (0 = sem teto).',
  },
  {
    key: 'maxDistance',
    label: 'Distância máxima (campos)',
    type: 'number',
    min: 0,
    max: 999,
    step: 1,
    help: 'Distância máxima, em campos, entre a aldeia aberta e o alvo (0 = sem teto; sem a origem conhecida e com teto ativo, ninguém é elegível).',
  },
  {
    key: 'minLoyalty',
    label: 'Lealdade mínima',
    type: 'number',
    min: 0,
    max: 100,
    step: 5,
    help: 'Descarta alvos com lealdade estimada abaixo deste valor (0 = sem filtro). Aldeias livres sem dado de lealdade são estimadas em 100.',
  },
  {
    key: 'rankingText',
    label: 'Ranking de prioridades',
    type: 'textarea',
    placeholder: 'distancia,pontos',
    help: 'Critérios em ordem, separados por vírgula: distancia, pontos, farm, barracos (sufixo "-" inverte a ordem do critério). Vazio = distancia, pontos. Critério inválido: nada é feito.',
  },
];

/** Chave do storage do Agendador de Comandos (mesma do módulo command-scheduler). */
function schedulerStorageKey(world: string): string {
  return `tsh-auto:${world}:command-scheduler:scheduler`;
}

function readSchedulerState(world: string): HubSchedulerState {
  return gm.get<HubSchedulerState>(schedulerStorageKey(world), { commands: [], transit: [] });
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['enviado', 'incerto', 'falhou', 'removido']);

/** Comando de nobre ATIVO (sem fato terminal) já apontado para o alvo? */
export function hasActiveNobleFor(
  state: HubSchedulerState,
  target: { x: number; y: number },
): ScheduledCommandRecord | undefined {
  return state.commands.find(
    (command) =>
      command.kind === 'noble' &&
      command.target.x === target.x &&
      command.target.y === target.y &&
      !command.events.some((event) => TERMINAL_STATUSES.has(event.status)),
  );
}

/** Candidato da engine a partir da linha do village.txt (owner 0 = livre). */
export function candidateFromVillage(village: { id: string; name: string; x: number; y: number; points: number }): ConquestCandidate {
  return {
    id: village.id,
    name: village.name,
    x: village.x,
    y: village.y,
    points: village.points,
    ownerId: '0',
    farm: 0,
    barracos: 0,
  };
}

/** Rótulo curto do alvo ("Nome (x|y)"). */
export function conquestTargetLabel(target: ConquestTargetPlan): string {
  return `${target.name !== '' ? target.name : 'aldeia livre'} (${target.x}|${target.y})`;
}

/** Agenda o nobre do alvo no storage do Agendador (fail-closed em cada passo). */
async function scheduleNoble(
  ctx: TshCycleContext,
  settings: ConquestSettings,
  target: ConquestTargetPlan,
  origin: { x: number; y: number } | null,
): Promise<string> {
  if (origin === null) {
    return 'Não foi possível identificar as coordenadas desta aldeia no mapa — nada foi agendado (o nobre precisa da origem para calcular a chegada).';
  }
  if (!isTshEnabled('command-scheduler')) {
    return 'O Agendador de Comandos está DESLIGADO — o nobre não seria enviado. Ligue o módulo (aba Automações) e rode de novo; nada foi agendado.';
  }
  if (Date.now() >= tshArmedUntil('command-scheduler')) {
    return 'O Agendador de Comandos não está ARMADO — sem armação ele não envia o nobre na janela. Arme o Agendador e rode de novo; nada foi agendado.';
  }
  const state = readSchedulerState(ctx.world);
  const existing = hasActiveNobleFor(state, target);
  if (existing !== undefined) {
    return `Já existe um nobre agendado para ${conquestTargetLabel(target)} (comando ${existing.id}) — nada foi duplicado.`;
  }
  const travel = await travelMinutes(origin, target, { snob: 1 });
  if (travel === null || !Number.isFinite(travel) || travel <= 0) {
    return 'Não foi possível calcular o tempo de viagem do nobre (dados do mundo indisponíveis) — nada foi agendado.';
  }
  const now = new Date(serverNowIso());
  const arrival = new Date(now.getTime() + travel * 60_000);
  const sendAt = arrivalToSendAt(arrival, travel);
  const record = createScheduledCommand({
    kind: 'noble',
    sourceVillageId: ctx.villageId.replace(/^n/, ''),
    source: origin,
    target: { x: target.x, y: target.y },
    targetName: target.name,
    // targetPoints é opcional no contrato e exige inteiro positivo: aldeia sem
    // pontos lidos entra sem o campo (nunca com zero, que o schema recusa).
    ...(target.points > 0 ? { targetPoints: target.points } : {}),
    units: { snob: 1 },
    timingMode: 'arrival',
    sendAt: sendAt.toISOString(),
    arrivalAt: arrival.toISOString(),
    detail: `Conquista de aldeia livre (plano ${settings.mode}): ${target.noblesNeeded} nobre(s) no pior caso, lealdade estimada ${target.loyalty}.`,
  });
  const parsed = parseSchedulerCommandRecord(record);
  if (!parsed.ok) return `${parsed.message} Nada foi agendado.`;
  if (state.commands.some((command) => command.id === parsed.record.id)) {
    return `O nobre para ${conquestTargetLabel(target)} já está agendado neste horário (comando ${parsed.record.id}) — nada foi duplicado.`;
  }
  gm.set(schedulerStorageKey(ctx.world), { ...state, commands: [...state.commands, parsed.record] });
  return `Nobre agendado para ${conquestTargetLabel(target)}: chegada ${arrival.toLocaleString('pt-BR')} (envio ${sendAt.toLocaleString('pt-BR')}, viagem ${travel.toFixed(1)} min). O Agendador dispara na janela.`;
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  const parsed = conquestSettings.safeParse(ctx.storage.get('settings', DEFAULT_SETTINGS));
  if (!parsed.success) {
    ctx.status('Configurações da Conquista de Aldeias Livres inválidas — nada foi feito.', 'warn');
    return;
  }
  const settings: ConquestSettings = parsed.data;
  const ranking: { ok: true; criteria: ConquestRankingCriterion[] } | { ok: false; reason: string } =
    parseConquestRanking(settings.rankingText);
  if (!ranking.ok) {
    ctx.status(`Ranking de prioridades inválido — nada foi feito (${ranking.reason}).`, 'warn');
    return;
  }
  const villages = await ownVillages();
  const currentId = ctx.villageId.replace(/^n/, '');
  const current = villages.find((village) => village.id === currentId);
  const origin = current !== undefined ? { x: current.x, y: current.y } : null;

  // Candidatos: TODAS as aldeias livres do mapa (owner 0 no village.txt).
  const all = await allVillages();
  const candidates = all.filter((village) => village.playerId === '0').map(candidateFromVillage);
  if (candidates.length === 0) {
    ctx.status('Nenhuma aldeia livre (owner 0) foi lida no mapa — confira /map/village.txt no próximo ciclo.', 'info');
    return;
  }
  const plan = planConquest({
    candidates,
    origin,
    maxPoints: settings.maxPoints,
    maxDistance: settings.maxDistance,
    minLoyalty: settings.minLoyalty,
    ranking: ranking.criteria,
    maxCandidates: 10,
  });
  if (plan.target === null) {
    ctx.status(plan.message, 'info');
    return;
  }
  const alternativas = plan.ranked
    .slice(1, 4)
    .map((target) => `${target.priority}) ${conquestTargetLabel(target)} (${target.points} pts)`)
    .join('; ');
  const preview = `${plan.message}${alternativas !== '' ? ` Próximos: ${alternativas}.` : ''}`;
  if (settings.mode !== 'executar') {
    ctx.status(`Prévia: ${preview}`, 'info');
    return;
  }
  const outcome = await scheduleNoble(ctx, settings, plan.target, origin);
  ctx.status(`${outcome} ${preview}`, outcome.startsWith('Nobre agendado') ? 'ok' : 'warn');
}

export const conquistaLivresAutomation: TshAutomation = {
  id: 'conquista-livres',
  label: 'Conquista de Aldeias Livres',
  desc: 'Ranqueia as aldeias livres do mapa (pontos/distância/lealdade) e, no modo executar, agenda um nobre no Agendador de Comandos (chegada calculada pelo tempo de viagem real).',
  category: 'planejamento',
  screen: null,
  mutating: true,
  cooldownMs: 10 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  runCycle,
};

registerTsh(conquistaLivresAutomation);
