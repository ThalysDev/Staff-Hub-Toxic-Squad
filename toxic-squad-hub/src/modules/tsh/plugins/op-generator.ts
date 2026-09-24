// Gerador de OPs (PRÉVIA) — porta do plugin op-generator da extensão Toxic
// Squad Hub (toxic-squad-hub-ext/.../modules/features/op-generator/plugin.ts)
// sobre a ENGINE vendada em src/ext (op-planner):
// - PRÉVIA ONLY, como na origem (`previewOnlyPlugin`): o plano nasce com
//   effectsAllowed/sentToTribeWars fixos em false e NENHUMA mutação é enviada;
// - na extensão as origens vinham do registro das Visualizações
//   (hubWorldState.villageRegistry + villageSnapshots), que não existe no
//   userscript. Aqui as origens vêm de (1) settings.originsText (coordenadas
//   explícitas "x|y", uma por linha) ou (2) do dump público /map/village.txt
//   filtrado pelo player do game_data (id direto ou /map/player.txt por nome);
// - grupos: o userscript não tem leitor de grupos — o snapshot nasce com
//   groups: [] e entradas com groupId preenchido ficam 'unknown-group'
//   (plano bloqueado, fail-closed igual à origem; use groupId null);
// - settings via ctx.storage (chave 'settings'), plano guardado em
//   'last-plan' e resumo (aldeias pareadas, distância máx) em ctx.status;
// - sem editor de listas aninhadas no painel, "targetsText" (x|y por linha)
//   alimenta uma ENTRADA PADRÃO enquanto "entries" estiver vazio.

import { z } from 'zod';
import { registerTsh } from '../tsh-runtime';
import { pacedGet } from '../../../core/net';
import { pageWindow } from '../../../core/page';
import { serverNowMs } from '../../../core/game-clock';
import {
  OP_PLANNER_CRITERIA,
  OP_PLANNER_LIMITS,
  parseOpPlannerTargets,
  planOpGenerator,
  type OpPlannerPlan,
} from '../../../ext/modules/features/op-generator/op-planner';

// ── Helpers compartilhados entre os plugins TSH desta onda ────────────────
// (mapa público, relógio do servidor, inteiro pt-BR do jogo — usados também
// por mass-support.ts e support-manager.ts).

export interface OwnVillageRef {
  villageId: string;
  coordinate: string;
}

/** Inteiro ≥0 do jogo, tolerante a pt-BR ("8.532" → 8532) — porta do parseGameInteger do page-adapter. */
export function parseGameInteger(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.trim().replace(/\s/g, '');
  const brazilian = normalized.replace(/\./g, '').replace(',', '.');
  const parsed = Number(brazilian.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

/**
 * Aldeias do jogador no /map/village.txt (formato id,nome,x,y,playerId,
 * pontos,bonus). O NOME pode conter vírgula — as âncoras são o primeiro
 * campo e os 5 últimos. Linhas estranhas são ignoradas (fail-closed: nunca
 * se inventa coordenada nem dono).
 */
export function parsePlayerVillages(villageTxt: string, playerId: string): OwnVillageRef[] {
  const wanted = playerId.trim().replace(/^n/, '');
  if (wanted === '' || wanted === '0') return [];
  const result: OwnVillageRef[] = [];
  for (const line of villageTxt.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.split(',');
    if (fields.length < 7) continue;
    const id = fields[0] ?? '';
    const x = Number(fields[fields.length - 5] ?? '');
    const y = Number(fields[fields.length - 4] ?? '');
    const owner = (fields[fields.length - 3] ?? '').trim();
    if (!/^\d+$/.test(id) || owner !== wanted) continue;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 999 || y < 0 || y > 999) continue;
    result.push({ villageId: id, coordinate: `${x}|${y}` });
  }
  return result;
}

/** Id do jogador pelo nome no /map/player.txt (id,nome,tribo,pontos,cidades). */
export function resolvePlayerIdFromPlayerTxt(playerTxt: string, playerName: string): string | undefined {
  const wanted = playerName.trim();
  if (wanted === '') return undefined;
  for (const line of playerTxt.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.split(',');
    if (fields.length < 5) continue;
    const id = fields[0] ?? '';
    const name = fields.slice(1, fields.length - 3).join(',');
    if (/^\d+$/.test(id) && name.trim() === wanted) return id;
  }
  return undefined;
}

/**
 * "Agora" na perspectiva do servidor — Onda A: relógio de precisão
 * (core/game-clock: medição HTTP / relógio do jogo / Hora do servidor da
 * tela, a de menor incerteza; sem nenhuma fonte = relógio local).
 */
export function serverNowIso(): string {
  return new Date(serverNowMs()).toISOString();
}

// ── Editor de texto "x|y por linha" (compartilhado pelos plugins da onda) ──

/** Uma linha válida do texto de coordenadas (extras = segmentos após "x|y"). */
export interface CoordinateLineTarget {
  /** Número da linha no texto (1-based) — para apontar a linha ruim no status. */
  readonly line: number;
  /** Coordenada normalizada "x|y" (0..999, sem zeros à esquerda). */
  readonly coordinate: string;
  readonly x: number;
  readonly y: number;
  /** Segmentos extras após "x|y" (ex.: nível de muralha em "501|504|6"). */
  readonly extras: readonly string[];
}

export interface CoordinateLinesParse {
  /** Linhas válidas na ordem do texto, SEM duplicatas (fica a 1ª ocorrência). */
  readonly targets: readonly CoordinateLineTarget[];
  /** Quantidade de coordenadas repetidas ignoradas. */
  readonly duplicates: number;
  /** Números (1-based) das linhas inválidas — ignoradas, nunca viram alvo. */
  readonly invalidLines: readonly number[];
}

/**
 * Parse "x|y por linha" (0..999), fail-closed POR LINHA: linha vazia é só
 * ruído; linha inválida é reportada em invalidLines e NUNCA vira alvo;
 * duplicata mantém a primeira ocorrência. Extras (ex.: "x|y|6") são
 * preservados para o consumidor validar (cada plugin tem o seu contrato).
 */
export function parseCoordinateLines(text: string): CoordinateLinesParse {
  const targets: CoordinateLineTarget[] = [];
  const invalidLines: number[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '') continue;
    const parts = line.split('|');
    const valid = (value: string | undefined): value is string =>
      value !== undefined && /^\d{1,3}$/.test(value) && Number(value) <= 999;
    const x = parts[0];
    const y = parts[1];
    const extras = parts.slice(2);
    if (parts.length < 2 || parts.length > 3 || !valid(x) || !valid(y) || !extras.every(valid)) {
      invalidLines.push(index + 1);
      continue;
    }
    const coordinate = `${Number(x)}|${Number(y)}`;
    if (seen.has(coordinate)) {
      duplicates += 1;
      continue;
    }
    seen.add(coordinate);
    targets.push({ line: index + 1, coordinate, x: Number(x), y: Number(y), extras });
  }
  return { targets, duplicates, invalidLines };
}

/**
 * Nota pt-BR para o status sobre linhas ignoradas/duplicadas do texto.
 * Vazia = nada a reportar (o texto parseou limpo).
 */
export function coordinateLinesNote(
  label: string,
  parse: { readonly duplicates: number; readonly invalidLines: readonly number[] },
): string {
  const parts: string[] = [];
  if (parse.invalidLines.length > 0) {
    const shown = parse.invalidLines.slice(0, 5).join(', ');
    const extra = parse.invalidLines.length > 5 ? ` +${parse.invalidLines.length - 5}` : '';
    parts.push(`${parse.invalidLines.length} linha(s) inválida(s) ignorada(s) (${shown}${extra})`);
  }
  if (parse.duplicates > 0) parts.push(`${parse.duplicates} duplicata(s) ignorada(s)`);
  return parts.length === 0 ? '' : `${label}: ${parts.join('; ')}.`;
}

const MAP_CACHE_TTL_MS = 10 * 60_000;
let villageTxtCache: { body: string; at: number } | null = null;

async function fetchVillageTxt(): Promise<string> {
  if (villageTxtCache !== null && Date.now() - villageTxtCache.at < MAP_CACHE_TTL_MS) return villageTxtCache.body;
  const body = await pacedGet('/map/village.txt');
  villageTxtCache = { body, at: Date.now() };
  return body;
}

/**
 * Aldeias próprias (id + coordenada) do mundo atual: player id do game_data
 * (fallback /map/player.txt por nome) + /map/village.txt público. Leituras
 * pela fila do core (pacedGet), com cache de 10 min no módulo.
 */
export async function readOwnVillages(): Promise<OwnVillageRef[]> {
  const data = pageWindow().game_data;
  let playerId = data?.player?.id !== undefined ? String(data.player.id) : '';
  if (playerId === '' || playerId === '0') {
    const playerName = data?.player?.name ?? '';
    if (playerName === '') return [];
    playerId = resolvePlayerIdFromPlayerTxt(await pacedGet('/map/player.txt'), playerName) ?? '';
  }
  if (playerId === '' || playerId === '0') return [];
  return parsePlayerVillages(await fetchVillageTxt(), playerId);
}

// ── Plugin: Gerador de OPs (prévia) ───────────────────────────────────────

export const opGeneratorSettingsSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            tag: z.string().trim().max(120).default('OP'),
            commandKind: z.enum(['attack', 'support']).default('attack'),
            criterion: z.enum(OP_PLANNER_CRITERIA).default('distribuir'),
            targetsText: z.string().max(OP_PLANNER_LIMITS.targetsTextCharacters).default(''),
            maximumDistanceFields: z.number().int().min(1).nullable().default(null),
            groupId: z.string().nullable().default(null),
          })
          .strict(),
      )
      .max(OP_PLANNER_LIMITS.entries)
      .default([]),
    /** Origens explícitas "x|y" (uma por linha). Vazio = aldeias próprias do mapa. */
    originsText: z.string().max(OP_PLANNER_LIMITS.targetsTextCharacters).default(''),
    /**
     * Alvos da ENTRADA PADRÃO "x|y" (uma por linha) — alimenta o plano quando
     * "entries" está vazio (o formulário não edita listas aninhadas).
     */
    targetsText: z.string().max(OP_PLANNER_LIMITS.targetsTextCharacters).default(''),
  })
  .strict();
export type OpGeneratorSettings = z.infer<typeof opGeneratorSettingsSchema>;
export type OpGeneratorEntry = OpGeneratorSettings['entries'][number];

/** Defaults efetivos do schema (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: OpGeneratorSettings = {
  entries: [],
  originsText: '',
  targetsText: '',
};

/** Entrada padrão dos alvos do targetsText (porta fiel dos defaults da origem). */
export function defaultOpEntry(targetsText: string): OpGeneratorEntry {
  return {
    tag: 'OP',
    commandKind: 'attack',
    criterion: 'distribuir',
    targetsText,
    maximumDistanceFields: null,
    groupId: null,
  };
}

/** Origens explícitas do originsText em vilas do snapshot do planner (ids estáveis). */
export function originsFromText(text: string): OwnVillageRef[] {
  return parseOpPlannerTargets(text).targets.map((coordinate, index) => ({
    villageId: `origem-${index + 1}`,
    coordinate,
  }));
}

function summarizeOpPlan(plan: OpPlannerPlan): { pairs: number; origins: number; maxDistanceFields: number; warnings: number } {
  const pairs = plan.results.reduce((total, result) => total + result.metrics.pairs, 0);
  const origins = new Set(plan.results.flatMap((result) => result.pairs.map((pair) => pair.sourceVillageId))).size;
  const maxDistanceFields = plan.results.reduce((max, result) => Math.max(max, result.metrics.maximumDistanceFields), 0);
  const warnings = plan.results.reduce((total, result) => total + result.warnings.length, 0);
  return { pairs, origins, maxDistanceFields, warnings };
}

registerTsh({
  id: 'op-generator',
  label: 'Gerador de OPs (prévia)',
  desc: 'Pareia aldeias de origem com alvos (6 critérios) e guarda a prévia da OP — somente planejamento, nenhuma mutação é enviada ao jogo.',
  category: 'planejamento',
  screen: null,
  mutating: false,
  settingsDefaults: DEFAULT_SETTINGS,
  // "entries" continua FORA do formulário (lista aninhada — tag, critério,
  // grupo, distância); enquanto ela estiver vazia, o textarea "targetsText"
  // fornece os alvos da entrada padrão.
  settingsForm: [
    {
      key: 'originsText',
      label: 'Aldeias de origem',
      type: 'textarea',
      placeholder: '500|500\n501|503',
      help: 'Origens, uma coordenada x|y por linha. Vazio = usa as aldeias próprias lidas do mapa público.',
    },
    {
      key: 'targetsText',
      label: 'Alvos (entrada padrão)',
      type: 'textarea',
      placeholder: '500|500\n501|503',
      help: 'Uma coordenada x|y por linha. Usada quando não há entradas na chave "settings": vira uma entrada única "OP" (ataque, critério distribuir). Linha inválida é ignorada e avisada no status.',
    },
  ],
  async runCycle(ctx): Promise<void> {
    let settings: OpGeneratorSettings;
    try {
      settings = opGeneratorSettingsSchema.parse(ctx.storage.get('settings', DEFAULT_SETTINGS));
    } catch {
      ctx.status('Configurações inválidas do Gerador de OPs — revise a chave "settings".', 'warn');
      return;
    }
    // Entrada padrão: targetsText alimenta o plano enquanto "entries" estiver
    // vazio (o formulário declarativo não edita listas aninhadas).
    const useDefaultEntry = settings.entries.length === 0 && settings.targetsText.trim() !== '';
    if (settings.entries.length === 0 && !useDefaultEntry) {
      ctx.status(
        'Nenhuma entrada de OP configurada: preencha "targetsText" (alvos, um x|y por linha) ou adicione entradas na chave "settings".',
        'info',
      );
      return;
    }
    if (useDefaultEntry && parseOpPlannerTargets(settings.targetsText).targets.length > OP_PLANNER_LIMITS.targetsPerEntry) {
      ctx.status(
        `"targetsText" passa do teto de ${OP_PLANNER_LIMITS.targetsPerEntry} alvos por entrada — reduza a lista.`,
        'warn',
      );
      return;
    }
    const entries: OpGeneratorEntry[] = useDefaultEntry
      ? [defaultOpEntry(settings.targetsText)]
      : settings.entries.map((entry) => ({
          tag: entry.tag,
          commandKind: entry.commandKind,
          criterion: entry.criterion,
          targetsText: entry.targetsText,
          maximumDistanceFields: entry.maximumDistanceFields,
          groupId: entry.groupId === '' ? null : entry.groupId,
        }));
    let origins: OwnVillageRef[];
    if (settings.originsText.trim() !== '') {
      origins = originsFromText(settings.originsText);
    } else {
      try {
        origins = await readOwnVillages();
      } catch (error) {
        ctx.status(
          `Falha ao ler as aldeias de origem em /map/village.txt: ${error instanceof Error ? error.message : String(error)} — ou preencha "originsText" nas configurações.`,
          'warn',
        );
        return;
      }
    }
    if (origins.length === 0) {
      ctx.status(
        'Nenhuma aldeia de origem com coordenadas conhecidas: preencha "originsText" ou mantenha a sessão aberta para a leitura do mapa público.',
        'info',
      );
      return;
    }
    const opPlan = planOpGenerator({
      config: { entries },
      snapshot: {
        villages: origins.map((origin) => ({ villageId: origin.villageId, coordinate: origin.coordinate, groupIds: [] })),
        groups: [], // sem leitor de grupos no userscript — groupId preenchido bloqueia (fail-closed)
      },
    });
    const summary = summarizeOpPlan(opPlan);
    ctx.storage.set('last-plan', {
      generatedAt: serverNowIso(),
      origins: origins.length,
      defaultEntryFromTargetsText: useDefaultEntry,
      summary,
      plan: opPlan,
    });
    if (opPlan.state === 'empty') {
      ctx.status('Nenhum par de comandos pôde ser formado com os alvos atuais.', 'info');
      return;
    }
    if (opPlan.state === 'blocked') {
      ctx.status(
        'Plano de OPs bloqueado: entrada com grupo desconhecido (grupos não têm leitor no userscript) ou sem alvos — revise as entradas.',
        'warn',
      );
      return;
    }
    const warningsLabel = summary.warnings > 0 ? ` (${summary.warnings} aviso(s) na prévia)` : '';
    const defaultEntryLabel = useDefaultEntry ? ', entrada padrão do "targetsText"' : '';
    ctx.status(
      `Prévia de OPs: ${opPlan.results.length} entrada(s)${defaultEntryLabel} → ${summary.pairs} par(es) de ${summary.origins} aldeia(s) origem, distância máx ${summary.maxDistanceFields.toFixed(1)} campos${warningsLabel} — nenhuma mutação é enviada.`,
      'ok',
    );
  },
});
