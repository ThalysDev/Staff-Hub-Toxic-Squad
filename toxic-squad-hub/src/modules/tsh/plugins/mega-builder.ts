// Plugin TSH 'mega-builder' — porta do plugin da extensão
// (toxic-squad-hub-ext/.../modules/features/mega-builder/plugin.ts) para o
// motor de ciclos do userscript:
// - fila de construção por settings (priorities/reserve) OU template GC
//   importado (base64 decodificado pelo codec vendado
//   decodeGcTemplate — igrejas rejeitadas, limiar de fazenda honrado);
// - NOVO (Onda 16): fila em TEXTO (settings.prioritiesText, "um edifício por
//   linha; opcionalmente edifício:nível") — parse PURA com whitelist de
//   edifícios; linha inválida = status warn e NADA muda (as priorities
//   anteriores seguem valendo — fail-closed). Preenchido e válido, o texto
//   tem PRIORIDADE sobre o template GC;
// - leitura da tela screen=main: fila ativa (#build_queue, presente só com
//   construção ativa — verificado ao vivo no br142), níveis dos edifícios
//   ([data-building]+data-level, porta do readBuildings) e recursos da barra;
// - F2: UMA mutação por ciclo — upgradeBuilding do primeiro item pendente da
//   fila (respeitando as reservas de recursos configuradas).

import { z } from 'zod';
import { registerTsh, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { upgradeBuilding } from '../tsh-transport';
import {
  decodeGcTemplate,
  GcTemplateCodecError,
  type GcTemplateCodecErrorCode,
} from '../../../ext/modules/features/mega-builder/gc-template-codec';
import type { ResourceType } from '../../../ext/modules/shared/module-types';

const RESOURCES: readonly ResourceType[] = ['wood', 'stone', 'iron'];

function gcCodecErrorMessage(code: GcTemplateCodecErrorCode): string {
  switch (code) {
    case 'GC_BASE64_INVALID':
      return 'O template GC não é um Base64 válido.';
    case 'GC_INPUT_TOO_LARGE':
      return 'O template GC excede o tamanho suportado.';
    case 'GC_MARKER_MISSING':
      return 'O template GC não contém o marcador de template esperado.';
    case 'GC_NO_VALID_STEPS':
      return 'O template GC não contém passos de construção válidos.';
    case 'MODEL_OUT_OF_BOUNDS':
      return 'O template GC está fora dos limites suportados.';
  }
}

/** Decodificação + gates do template GC (porta 1:1 do plugin da extensão). */
export function decodeBuilderImport(
  encoded: string,
):
  | { ok: true; steps: ReadonlyArray<{ buildingId: string; targetLevel: number }>; name: string; threshold: number }
  | { ok: false; reason: string } {
  let decoded;
  try {
    decoded = decodeGcTemplate(encoded);
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof GcTemplateCodecError
          ? gcCodecErrorMessage(error.code)
          : 'O template GC não pôde ser decodificado.',
    };
  }
  if (decoded.orderedSteps.some((step) => step.buildingId === 'church' || step.buildingId === 'church_f')) {
    return { ok: false, reason: 'Template contém edifícios de igreja ainda não suportados' };
  }
  return {
    ok: true,
    steps: decoded.orderedSteps,
    name: decoded.name,
    threshold: decoded.farmPriority.thresholdPercent,
  };
}

/** Item da fila de construção (mesma forma do settings.priorities). */
export interface BuilderPriority {
  building: string;
  targetLevel: number;
}

/** Edifícios aceitos na fila em texto (chaves do jogo). */
const BUILDING_WHITELIST: ReadonlySet<string> = new Set([
  'main',
  'barracks',
  'stable',
  'garage',
  'snob',
  'smith',
  'place',
  'statue',
  'market',
  'wood',
  'stone',
  'iron',
  'farm',
  'storage',
  'hide',
  'wall',
]);
const WHITELIST_LABEL = [...BUILDING_WHITELIST].join(', ');

/**
 * Nível-alvo de linha SEM nível explícito ("main") = até o máximo do
 * edifício no mundo. Nenhum edifício do jogo passa de 99, então o item
 * permanece pendente enquanto o jogo oferecer o link de ampliação.
 */
export const PRIORITY_UNTIL_MAX_LEVEL = 99;

/**
 * Parser PURA da fila em texto (Onda 16): um edifício por linha, na ordem;
 * opcionalmente "edifício:nível" (ex.: "main:20"). Case e espaços extra são
 * tolerados; linhas vazias são ignoradas. Qualquer linha inválida (edifício
 * fora da whitelist, nível não inteiro/≤ 0, dois-pontos sobrando) derruba o
 * parse INTEIRO com o motivo da primeira linha ruim — o chamador mantém as
 * priorities anteriores (fail-closed).
 */
export function parsePrioritiesText(
  text: string,
): { ok: true; priorities: BuilderPriority[] } | { ok: false; reason: string } {
  const priorities: BuilderPriority[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(':');
    const building = (parts[0] ?? '').trim().toLowerCase();
    const levelPart = parts[1];
    if (parts.length > 2 || building === '' || !BUILDING_WHITELIST.has(building)) {
      return {
        ok: false,
        reason: `linha ${index + 1} ("${line}") não é um edifício aceito — use um por linha: ${WHITELIST_LABEL}.`,
      };
    }
    let targetLevel = PRIORITY_UNTIL_MAX_LEVEL;
    if (levelPart !== undefined && levelPart.trim() !== '') {
      const parsedLevel = Number(levelPart.trim().replace(',', '.'));
      if (!Number.isInteger(parsedLevel) || parsedLevel <= 0) {
        return {
          ok: false,
          reason: `linha ${index + 1} ("${line}") tem nível inválido — use um inteiro positivo (ex.: main:20).`,
        };
      }
      targetLevel = parsedLevel;
    }
    priorities.push({ building, targetLevel });
  }
  return { ok: true, priorities };
}

const builderSettings = z
  .object({
    priorities: z.array(z.object({ building: z.string(), targetLevel: z.number().int().positive() })).default([]),
    reserve: z.record(z.string(), z.number().int().nonnegative()).default({ wood: 0, stone: 0, iron: 0 }),
    gcTemplateImport: z.string().default(''),
    prioritiesText: z.string().default(''),
    farmPriorityThreshold: z.number().int().min(0).max(100).default(0),
  })
  .superRefine((settings, context) => {
    if (settings.gcTemplateImport.trim() === '') return;
    const decoded = decodeBuilderImport(settings.gcTemplateImport);
    if (!decoded.ok) context.addIssue({ code: 'custom', path: ['gcTemplateImport'], message: decoded.reason });
  });

type BuilderSettings = z.infer<typeof builderSettings>;

/** Espelha os defaults do schema zod (usado como fallback e semente do painel). */
export const DEFAULT_SETTINGS: BuilderSettings = {
  priorities: [],
  reserve: { wood: 0, stone: 0, iron: 0 },
  gcTemplateImport: '',
  prioritiesText: '',
  farmPriorityThreshold: 0,
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'prioritiesText',
    label: 'Fila de construção (texto)',
    type: 'textarea',
    placeholder: 'main:20\nbarracks\nstable:15',
    help: 'Um edifício por linha, na ordem de prioridade; opcionalmente "edifício:nível" (ex.: main:20). Linha sem nível = amplia até o máximo do edifício. Preenchido e válido, vale MAIS que o template GC. Linha inválida: nada é feito e as prioridades salvas continuam valendo.',
  },
  {
    key: 'gcTemplateImport',
    label: 'Template GC (Base64)',
    type: 'textarea',
    placeholder: 'Cole aqui o template GC exportado (Base64)…',
    help: 'Se preenchido (e a fila em texto acima estiver vazia/inválida), o template define a fila de construção na ordem (igrejas são rejeitadas e o limiar de fazenda vem do próprio template).',
  },
];

/** Inteiro de jogo pt-BR ("1.234") — porta do parseGameInteger. */
function parseGameInteger(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.trim().replace(/\s/g, '');
  const brazilian = normalized.replace(/\./g, '').replace(',', '.');
  const parsed = Number(brazilian.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function readResources(doc: Document): Record<ResourceType, number> {
  const read = (resource: ResourceType): number => {
    const element = doc.querySelector(`#${resource}, [data-resource="${resource}"], .resource-${resource}`);
    const text =
      element instanceof HTMLInputElement || element instanceof HTMLSelectElement
        ? element.value
        : element?.textContent;
    return parseGameInteger(text);
  };
  return { wood: read('wood'), stone: read('stone'), iron: read('iron') };
}

/** Fila de construção ativa (porta do readBuildQueue: #build_queue presente). */
function hasActiveBuildQueue(doc: Document): boolean {
  return doc.querySelector('#build_queue') !== null;
}

/**
 * Níveis dos edifícios da tela principal: caminho primário [data-building]
 * (porta do readBuildings da extensão) com fallback para os links canônicos
 * de ampliação (a chave do edifício viaja no parâmetro id=/type= do href —
 * mesmos seletores do transporte) + "Nível N" do texto da linha.
 */
function readMainBuildings(doc: Document): Map<string, number> {
  const levels = new Map<string, number>();
  for (const row of Array.from(doc.querySelectorAll<HTMLElement>('[data-building]'))) {
    const building = row.getAttribute('data-building');
    if (building === null || building === '') continue;
    const level = parseGameInteger(
      row.getAttribute('data-level') ??
        row.querySelector('[data-level]')?.getAttribute('data-level') ??
        row.textContent ??
        '',
    );
    if (level > 0) levels.set(building, level);
  }
  if (levels.size > 0) return levels;
  for (const link of Array.from(
    doc.querySelectorAll<HTMLAnchorElement>('a[href*="screen=main"][href*="action=upgrade_building"]'),
  )) {
    const href = new URL(link.href, doc.baseURI);
    const building = href.searchParams.get('id') ?? href.searchParams.get('type') ?? '';
    if (building === '' || levels.has(building)) continue;
    const levelText = link.closest('tr')?.textContent ?? '';
    const match = levelText.match(/n[íi]vel\s+(\d{1,3})/i);
    levels.set(building, match !== null ? Number(match[1]) : 0);
  }
  return levels;
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  const parsed = builderSettings.safeParse(ctx.storage.get('settings', DEFAULT_SETTINGS));
  if (!parsed.success) {
    ctx.status('Configurações do Mega Construtor inválidas — nada foi feito. Revise prioridades/template GC.', 'warn');
    return;
  }
  const settings: BuilderSettings = parsed.data;
  if (hasActiveBuildQueue(document)) {
    ctx.status('Já existe uma construção em andamento nesta aldeia.', 'info');
    return;
  }
  let priorities = settings.priorities;
  let templateName: string | undefined;
  // Fila em texto (Onda 16): preenchida e VÁLIDA, tem prioridade sobre o
  // template GC. Linha inválida = fail-closed: status warn e as priorities
  // anteriores seguem valendo (o ciclo não cai para o template nem muta).
  if (settings.prioritiesText.trim() !== '') {
    const parsedText = parsePrioritiesText(settings.prioritiesText);
    if (!parsedText.ok) {
      ctx.status(`Fila em texto inválida — nada foi feito e as prioridades salvas seguem valendo (${parsedText.reason}).`, 'warn');
      return;
    }
    priorities = parsedText.priorities;
  } else if (settings.gcTemplateImport.trim() !== '') {
    const imported = decodeBuilderImport(settings.gcTemplateImport);
    if (!imported.ok) {
      ctx.status(imported.reason, 'warn');
      return;
    }
    priorities = imported.steps.map((step) => ({ building: step.buildingId, targetLevel: step.targetLevel }));
    templateName = imported.name;
  }
  if (priorities.length === 0) {
    ctx.status('Nenhuma fila de construção configurada (texto, settings.priorities ou template GC).', 'info');
    return;
  }
  const buildings = readMainBuildings(document);
  const priority = priorities.find((candidate) => (buildings.get(candidate.building) ?? 0) < candidate.targetLevel);
  if (priority === undefined) {
    ctx.status('Nenhuma prioridade de construção está pendente.', 'info');
    return;
  }
  const reserve = settings.reserve ?? {};
  const resources = readResources(document); // 1 leitura da barra (não 1 por recurso)
  const withinReserve = RESOURCES.every((resource) => resources[resource] >= (reserve[resource] ?? 0));
  if (!withinReserve) {
    ctx.status('Os recursos estão abaixo das reservas configuradas.', 'info');
    return;
  }
  // F2: UMA mutação por ciclo — ampliação do próximo pendente da fila.
  await upgradeBuilding(priority.building);
  ctx.status(
    `Ampliação enviada: ${priority.building} → nível ${priority.targetLevel}${
      templateName !== undefined && templateName !== '' ? ` (template "${templateName}")` : ''
    }.`,
    'ok',
  );
}

export const megaBuilderAutomation: TshAutomation = {
  id: 'mega-builder',
  label: 'Mega Construtor',
  desc: 'Fila de construção por texto, prioridades salvas ou template GC no Edifício Principal: amplia o próximo pendente (1 upgrade por ciclo).',
  category: 'producao',
  screen: 'main',
  mutating: true,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  runCycle,
};

registerTsh(megaBuilderAutomation);
