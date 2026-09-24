// Gestão de Apoio (PRÉVIA) — porta do plugin support-manager da extensão
// Toxic Squad Hub (toxic-squad-hub-ext/.../modules/features/support-manager/
// plugin.ts) sobre a ENGINE vendada em src/ext (support-manager-planner):
// - leitura da Visão de Comandos (overview_villages&mode=commands) via
//   pacedDoc — porta ESSENCIAL do adapters/supports-reader.ts da origem
//   (evidência por seletor preservada nos comentários abaixo);
// - PRÉVIA SOMENTE: planSupportWithdrawal roda fail-closed e NADA é retirado
//   (effectsAllowed/sentToTribalWars fixos em false). A RETIRADA REAL fica
//   para a fase seguinte — nenhum cancelamento/retirada é enviado aqui;
// - âncoras NÃO VERIFICADAS na origem ( marcador de tipo de linha, estrutura
//   linha-por-comando, coordenada do destino, bárbaro por nome, paginação ):
//   a leitura é DEFENSIVA — qualquer falha vira availability 'unavailable'
//   com razão pt-BR e o ciclo publica status warn, NUNCA quebra. Guarnições
//   não têm leitor → coverage sempre 'partial' → o planner bloqueia a prévia
//   por segurança (mesma semântica NO_WORK da origem), que é guardada em
//   'last-plan' para inspeção;
// - desvio documentado: scope default 'player' (a origem default 'garrison'
//   pressupunha leitor de guarnição, que não existe nem lá); grupos não têm
//   leitor no userscript — memberships vazios (groupId != '0' faz o planner
//   rejeitar, fail-closed igual à origem).

import { z } from 'zod';
import { registerTsh } from '../tsh-runtime';
import { normalizeVillageId } from '../tsh-transport';
import { pacedDoc } from '../../vanta/vanta-net';
import { pageWindow } from '../../../core/page';
import { parseGameInteger, readOwnVillages, serverNowIso } from './op-generator';
import {
  SUPPORT_WITHDRAWAL_UNITS,
  planSupportWithdrawal,
  type SupportWithdrawalGarrison,
  type SupportWithdrawalOutgoingSupport,
  type SupportWithdrawalSnapshot,
  type SupportWithdrawalTroops,
  type SupportWithdrawalUnit,
} from '../../../ext/modules/features/support-manager/support-manager-planner';

// ── Porta do supports-reader (adapters/supports-reader.ts da origem) ───────

export interface SupportsOverviewParseOptions {
  /**
   * Registro de aldeias próprias usado para classificar o destino do apoio
   * como 'own' (/map/village.txt). O prefixo `n` dos links é tolerado nos
   * dois lados da comparação.
   */
  ownVillageIds: ReadonlySet<string> | readonly string[];
}

export interface SupportsPageFacts {
  availability: 'available' | 'unavailable';
  coverage: 'complete' | 'partial';
  truncated: boolean;
  /** Apoios próprios em trânsito — registros idênticos ao do planner. */
  outgoingSupports: SupportWithdrawalOutgoingSupport[];
  /** Sempre vazio: nenhum seletor verificado expõe guarnições estacionadas. */
  garrisons: SupportWithdrawalGarrison[];
  /** Razão pt-BR — presente quando a leitura é parcial ou indisponível. */
  reason?: string;
}

const unavailableFacts = (reason: string): SupportsPageFacts => ({
  availability: 'unavailable',
  coverage: 'partial',
  truncated: false,
  outgoingSupports: [],
  garrisons: [],
  reason,
});

const zeroTroops = (): SupportWithdrawalTroops => ({
  spear: 0,
  sword: 0,
  axe: 0,
  archer: 0,
  spy: 0,
  light: 0,
  marcher: 0,
  heavy: 0,
  ram: 0,
  catapult: 0,
  knight: 0,
  snob: 0,
});

const villageIdFromHref = (href: string): string | undefined => {
  const id = new URL(href, 'https://tribalwars.com.br').searchParams.get('village');
  return id ? normalizeVillageId(id) : undefined;
};

const infoVillageIdFromHref = (href: string): string | undefined => {
  const id = new URL(href, 'https://tribalwars.com.br').searchParams.get('id');
  return id ? normalizeVillageId(id) : undefined;
};

const commandIdFromCancelHref = (href: string): string | undefined => {
  const id = new URL(href, 'https://tribalwars.com.br').searchParams.get('id');
  return id || undefined;
};

/** Coordenada `x|y` do padrão verificado `(x|y) K55`. */
const coordinateFromText = (text: string): string | undefined => {
  const match = text.match(/\((\d{1,3})\|(\d{1,3})\)/);
  return match ? `${match[1]}|${match[2]}` : undefined;
};

interface CommandsTable {
  table: Element;
  header: Element;
  originIndex: number;
  unitColumns: Map<number, SupportWithdrawalUnit>;
}

/**
 * Reconhece a tabela de comandos pelo cabeçalho canônico VERIFICADO ao vivo
 * no br142 (`order=start_name` + `order=command_date_arrival`) e mapeia as
 * colunas de unidades pelas imagens `img[src*="unit_<chave>"]`. Sem
 * cabeçalho canônico → página desconhecida.
 */
const findCommandsTable = (root: Document): CommandsTable | undefined => {
  for (const table of Array.from(root.querySelectorAll('table.vis'))) {
    const rows = Array.from(table.querySelectorAll('tr'));
    const header = rows.find(
      (row) =>
        row.querySelector('a[href*="order=start_name"]') !== null &&
        row.querySelector('a[href*="order=command_date_arrival"]') !== null,
    );
    if (!header) continue;
    const headerCells = Array.from(header.querySelectorAll('th, td'));
    const originIndex = headerCells.findIndex((cell) => cell.querySelector('a[href*="order=start_name"]') !== null);
    if (originIndex < 0) continue;
    const unitColumns = new Map<number, SupportWithdrawalUnit>();
    headerCells.forEach((cell, index) => {
      const src = cell.querySelector('img')?.getAttribute('src') ?? '';
      const key = src.match(/unit_([a-z]+)\./)?.[1];
      if (key && (SUPPORT_WITHDRAWAL_UNITS as readonly string[]).includes(key))
        unitColumns.set(index, key as SupportWithdrawalUnit);
    });
    return { table, header, originIndex, unitColumns };
  }
  return undefined;
};

type RowKind = 'support' | 'attack' | 'untyped';

/**
 * UNVERIFIED: tipo do comando por ícone (`src` com support/attack) ou classe
 * da linha. Falha-fechada: linha sem marcador é 'untyped' e NUNCA entra como
 * apoio — um ataque lido como apoio seria um erro gravíssimo.
 */
const rowKind = (row: Element): RowKind => {
  const classes = typeof row.className === 'string' ? row.className : '';
  const srcs = Array.from(row.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');
  const has = (token: string) =>
    srcs.some((src) => new RegExp(`(^|[/_.-])${token}([/_.-]|$)`).test(src)) || new RegExp(`\\b${token}\\b`).test(classes);
  if (has('support')) return 'support';
  if (has('attack')) return 'attack';
  return 'untyped';
};

/** UNVERIFIED: bárbaro por nome exato (pt-BR/EN) ou ícone com src contendo "barbarian". */
const isBarbarianDestination = (cell: Element | null | undefined, name: string): boolean => {
  if (/^(bárbaro|barbarian)$/i.test(name.trim())) return true;
  const srcs = Array.from(cell?.querySelectorAll('img') ?? []).map((img) => img.getAttribute('src') ?? '');
  return srcs.some((src) => /barbarian/i.test(src));
};

/**
 * supportId determinístico: id do comando no link `action=cancel&id=` quando
 * presente (verificado no br142); senão composto estável
 * `s:<origem>:<destino>:<assinatura de tropas>`. Linhas duplicadas recebem
 * sufixo de ocorrência `#2`, `#3`... na ordem do DOM.
 */
const compositeSupportId = (
  originVillageId: string,
  destinationVillageId: string,
  troops: SupportWithdrawalTroops,
): string => {
  const signature = SUPPORT_WITHDRAWAL_UNITS.filter((unit) => troops[unit] > 0)
    .map((unit) => `${unit}:${troops[unit]}`)
    .join(',');
  return `s:${originVillageId}:${destinationVillageId}:${signature}`;
};

const parseSupportRow = (
  row: Element,
  commands: CommandsTable,
  ownIds: Set<string>,
  usedIds: Map<string, number>,
): SupportWithdrawalOutgoingSupport | undefined => {
  const cells = Array.from(row.querySelectorAll('th, td'));
  const originCell = cells[commands.originIndex];
  const originLink = originCell?.querySelector<HTMLAnchorElement>('a[href*="village=n"]');
  const originId = originLink ? villageIdFromHref(originLink.href) : undefined;
  const originName = originLink?.textContent?.trim();
  const originCoordinate = coordinateFromText(originCell?.textContent ?? '');
  if (!originLink || !originId || !originName || !originCoordinate) return undefined;

  const destinationLink = row.querySelector<HTMLAnchorElement>('a[href*="info_village&id="]');
  const destinationCell = destinationLink?.closest('td') ?? destinationLink?.parentElement;
  const destinationId = destinationLink ? infoVillageIdFromHref(destinationLink.href) : undefined;
  const destinationName = destinationLink?.textContent?.trim();
  const destinationCoordinate = coordinateFromText(destinationCell?.textContent ?? '');
  if (!destinationLink || !destinationId || !destinationName || !destinationCoordinate) return undefined;

  // Contagens apenas das colunas de unidades do cabeçalho; célula ausente ou
  // vazia → 0 (convenção do parseGameInteger). Nunca se adivinha um número.
  const troops = zeroTroops();
  for (const [index, unit] of commands.unitColumns) {
    troops[unit] = parseGameInteger(cells[index]?.textContent);
  }

  const destinationKind: SupportWithdrawalOutgoingSupport['destinationKind'] = ownIds.has(destinationId)
    ? 'own'
    : isBarbarianDestination(destinationCell, destinationName)
      ? 'barbarian'
      : 'player';

  const cancelLink = row.querySelector<HTMLAnchorElement>('a[href*="action=cancel"][href*="id="]');
  const cancelId = cancelLink ? commandIdFromCancelHref(cancelLink.href) : undefined;
  const baseId = cancelId ?? compositeSupportId(originId, destinationId, troops);
  const occurrence = (usedIds.get(baseId) ?? 0) + 1;
  usedIds.set(baseId, occurrence);

  return {
    supportId: occurrence === 1 ? baseId : `${baseId}#${occurrence}`,
    originVillageId: originId,
    originName,
    originCoordinate,
    destinationVillageId: destinationId,
    destinationName,
    destinationCoordinate,
    destinationKind,
    // Nomes de dono/jogador/tribo não são expostos pela Visão de Comandos
    // (sem evidência) — null é o valor honesto do contrato do planner.
    ownerName: null,
    playerName: null,
    tribeName: null,
    troops,
  };
};

/**
 * Marcadores de paginação: classe `.paged-nav-item` (verificada no br142 para
 * listas paginadas) ou links `page=` na própria tabela. Paginação presente →
 * a listagem pode estar truncada.
 */
const detectPagination = (root: Document, table: Element): boolean =>
  root.querySelector('.paged-nav-item') !== null || table.querySelector('a[href*="page="]') !== null;

/**
 * Lê a Visão de Comandos e devolve os apoios em trânsito com os registros que
 * o planner de retirada consome. Falha-fechada: página não reconhecida →
 * 'unavailable' com razão pt-BR; guarnições não são expostas por esta tela →
 * sempre vazio + coverage 'partial'.
 */
export function parseSupportsOverview(html: string | Document, options: SupportsOverviewParseOptions): SupportsPageFacts {
  if (typeof html === 'string' && html.trim() === '') return unavailableFacts('HTML vazio — página não reconhecida.');
  const root = typeof html === 'string' ? new DOMParser().parseFromString(html, 'text/html') : html;
  if (!root.body) return unavailableFacts('Documento sem corpo — página não reconhecida.');

  const ownIds = new Set(Array.from(options.ownVillageIds, (id) => normalizeVillageId(id)));
  const commands = findCommandsTable(root);
  if (!commands) {
    return unavailableFacts(
      'Página não reconhecida como a Visão de Comandos (mode=commands): falta o cabeçalho canônico com as colunas order=start_name e order=command_date_arrival.',
    );
  }
  if (commands.unitColumns.size === 0) {
    return unavailableFacts('A tabela de comandos não expõe colunas de unidades — impossível ler tropas sem adivinhar.');
  }

  const truncated = detectPagination(root, commands.table);
  const dataRows = Array.from(commands.table.querySelectorAll('tr')).filter(
    (row) => row !== commands.header && row.querySelector('a[href*="village=n"]') !== null,
  );

  const usedIds = new Map<string, number>();
  const records: SupportWithdrawalOutgoingSupport[] = [];
  let typedRows = 0;
  let skippedUntyped = 0;
  let skippedInvalid = 0;

  for (const row of dataRows) {
    const kind = rowKind(row);
    if (kind === 'untyped') {
      skippedUntyped += 1;
      continue;
    }
    typedRows += 1;
    if (kind === 'attack') continue;
    const record = parseSupportRow(row, commands, ownIds, usedIds);
    if (!record) {
      skippedInvalid += 1;
      continue;
    }
    records.push(record);
  }

  if (dataRows.length > 0 && typedRows === 0) {
    return unavailableFacts(
      'Nenhuma linha da tabela de comandos expõe marcador de tipo (apoio/ataque) — impossível distinguir apoios sem adivinhar.',
    );
  }
  if (skippedInvalid > 0 && records.length === 0) {
    return unavailableFacts(
      'Nenhuma linha da tabela de comandos pôde ser validada como apoio (origem, destino e coordenadas ausentes) — leitura abandonada por segurança.',
    );
  }

  const reasonParts: string[] = [];
  if (truncated) reasonParts.push('A página expõe paginação — a lista pode estar truncada.');
  reasonParts.push(
    'A visão de comandos (mode=commands) só cobre comandos em trânsito; guarnições estacionadas não são expostas (sem seletores verificados).',
  );
  if (skippedUntyped > 0) reasonParts.push(`${skippedUntyped} linha(s) sem marcador de tipo foram ignoradas por segurança.`);
  if (skippedInvalid > 0)
    reasonParts.push(`${skippedInvalid} linha(s) de apoio sem origem/destino/coordenadas completos foram ignoradas.`);

  return {
    availability: 'available',
    // Sempre 'partial': a Visão de Comandos não expõe guarnições; um snapshot
    // de retirada honesto nunca pode se declarar completo a partir dela.
    coverage: 'partial',
    truncated,
    outgoingSupports: [...records].sort((left, right) =>
      left.supportId < right.supportId ? -1 : left.supportId > right.supportId ? 1 : 0,
    ),
    garrisons: [],
    reason: reasonParts.join(' '),
  };
}

// ── Plugin: prévia de retirada de apoio ────────────────────────────────────

const SUPPORT_WITHDRAWAL_PERCENT: Record<'10' | '25' | '50' | '100', 10 | 25 | 50 | 100> = {
  '10': 10,
  '25': 25,
  '50': 50,
  '100': 100,
};

export const supportManagerSettingsSchema = z
  .object({
    scope: z.enum(['own', 'player', 'barbarian', 'garrison']).default('player'),
    groupId: z.string().trim().nullable().default(null),
    selectionPercent: z.enum(['10', '25', '50', '100']).default('100'),
    unitIds: z.array(z.string()).default([...SUPPORT_WITHDRAWAL_UNITS]),
  })
  .strict();
export type SupportManagerSettings = z.infer<typeof supportManagerSettingsSchema>;

/** Defaults efetivos do schema (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: SupportManagerSettings = {
  scope: 'player',
  groupId: '', // campo de texto: '' = sem grupo (null não relia no formulário)
  selectionPercent: '100',
  unitIds: [...SUPPORT_WITHDRAWAL_UNITS],
};

/** Filtra/deduplica/ordena unidades no cânone do planner (refine canonicalUnitOrder). */
export function canonicalWithdrawalUnitIds(unitIds: readonly string[]): SupportWithdrawalUnit[] {
  const order = new Map<string, number>(SUPPORT_WITHDRAWAL_UNITS.map((unit, index) => [unit, index]));
  return [...new Set(unitIds)]
    .filter((unit): unit is SupportWithdrawalUnit => order.has(unit))
    .sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
}

registerTsh({
  id: 'support-manager',
  label: 'Gestão de Apoio (prévia)',
  desc: 'Lê a Visão de Comandos (mode=commands) e planeja a retirada de apoios — prévia somente (fail-closed), nenhuma tropa é retirada.',
  category: 'planejamento',
  screen: 'info_village',
  mutating: false,
  settingsDefaults: DEFAULT_SETTINGS,
  // Fica FORA do formulário: unitIds (lista de unidades — o formulário só
  // grava escalares; texto solto quebraria o parse do settings).
  settingsForm: [
    {
      key: 'scope',
      label: 'Escopo da retirada',
      type: 'select',
      options: [
        { value: 'own', label: 'Aldeias próprias' },
        { value: 'player', label: 'Apoios a jogadores' },
        { value: 'barbarian', label: 'Apoios a bárbaras' },
        { value: 'garrison', label: 'Guarnições' },
      ],
      help: 'Guarnição ainda não tem leitor no userscript — o ciclo avisa e não planeja.',
    },
    {
      key: 'groupId',
      label: 'Grupo',
      type: 'text',
      placeholder: '0',
      help: '0 = sem filtro de grupo (grupos não têm leitor no userscript — outro valor bloqueia o plano).',
    },
    {
      key: 'selectionPercent',
      label: 'Percentual dos apoios',
      type: 'select',
      options: [
        { value: '10', label: '10%' },
        { value: '25', label: '25%' },
        { value: '50', label: '50%' },
        { value: '100', label: '100%' },
      ],
      help: 'Teto de quantos % dos apoios elegíveis entram na seleção da prévia.',
    },
  ],
  async runCycle(ctx): Promise<void> {
    let settings: SupportManagerSettings;
    try {
      settings = supportManagerSettingsSchema.parse(ctx.storage.get('settings', DEFAULT_SETTINGS));
    } catch {
      ctx.status('Configurações inválidas da Gestão de Apoio — revise a chave "settings".', 'warn');
      return;
    }
    let facts: SupportsPageFacts;
    try {
      const doc = await pacedDoc(
        `/game.php?village=${encodeURIComponent(normalizeVillageId(ctx.villageId))}&screen=overview_villages&mode=commands`,
      );
      let ownVillageIds: string[] = [];
      try {
        ownVillageIds = (await readOwnVillages()).map((village) => village.villageId);
      } catch {
        // sem o mapa público a classificação 'own' fica impossível — a leitura
        // segue honesta (nenhum destino é marcado como próprio)
      }
      facts = parseSupportsOverview(doc, { ownVillageIds });
    } catch (error) {
      ctx.status(
        `Sem leitura da Visão de Comandos ainda: ${error instanceof Error ? error.message : String(error)} — abra a Visão de Comandos (mode=commands) para o Hub ler os apoios em trânsito.`,
        'warn',
      );
      return;
    }
    if (facts.availability !== 'available') {
      ctx.status(
        `A Visão de Comandos não foi reconhecida na última leitura — retirada bloqueada até uma leitura válida. ${facts.reason ?? ''}`.trim(),
        'warn',
      );
      return;
    }
    if (facts.truncated) {
      ctx.status('A Visão de Comandos expõe paginação — a lista pode estar truncada; retirada bloqueada.', 'warn');
      return;
    }
    if (settings.scope === 'garrison' && facts.garrisons.length === 0) {
      ctx.status('Guarnições ainda não têm leitor — use escopo de apoios enviados.', 'info');
      return;
    }
    const unitIds = canonicalWithdrawalUnitIds(settings.unitIds);
    if (unitIds.length === 0) {
      ctx.status('Unidades configuradas inválidas para a retirada de apoio — revise as configurações do módulo.', 'warn');
      return;
    }
    const snapshot: SupportWithdrawalSnapshot = {
      accountId: pageWindow().game_data?.player?.name ?? 'conta-do-hub',
      worldId: ctx.world,
      availability: facts.availability,
      coverage: facts.coverage,
      truncated: facts.truncated,
      groups: [], // sem leitor de grupos no userscript — groupId != '0' é rejeitado pelo planner
      memberships: [],
      outgoingSupports: facts.outgoingSupports,
      garrisons: facts.garrisons,
    };
    const evaluatedAt = serverNowIso();
    let withdrawalPlan;
    try {
      withdrawalPlan = planSupportWithdrawal({
        snapshot,
        draft: {
          scope: settings.scope,
          groupId: settings.groupId === null || settings.groupId === '' ? '0' : settings.groupId,
          unitIds,
          selection: { kind: 'percentage', percent: SUPPORT_WITHDRAWAL_PERCENT[settings.selectionPercent] },
        },
        evaluatedAt,
      });
    } catch {
      ctx.status(
        'O planejador de retirada rejeitou as regras atuais (grupo ou unidades inválidos) — revise as configurações.',
        'warn',
      );
      return;
    }
    const selectedResults = withdrawalPlan.results.filter((result) => result.disposition === 'selected');
    const selectedUnits = selectedResults.reduce(
      (total, result) => total + unitIds.reduce((subtotal, unit) => subtotal + result.troops[unit], 0),
      0,
    );
    ctx.storage.set('last-plan', {
      generatedAt: evaluatedAt,
      facts,
      plan: withdrawalPlan,
      // Resumo LEGÍVEL da prévia (os objetos acima são o contrato completo):
      // contagens que a liderança lê sem abrir o plano inteiro.
      resumo: {
        apoiosLidos: facts.outgoingSupports.length,
        escopo: settings.scope,
        selecionados: selectedResults.length,
        unidadesSelecionadas: selectedUnits,
        percentualEfetivo: Number(withdrawalPlan.metrics.effectivePercent.toFixed(1)),
      },
    });
    if (withdrawalPlan.state === 'empty' && selectedResults.length === 0) {
      ctx.status('Nenhum apoio elegível para retirada com os dados lidos da Visão de Comandos.', 'info');
      return;
    }
    if (selectedResults.length > 0) {
      ctx.status(
        `Prévia de retirada: ${selectedResults.length} apoio(s) selecionados (${selectedUnits} unidades, ${withdrawalPlan.metrics.effectivePercent.toFixed(0)}% efetivo) — retirada real fica para a fase seguinte.`,
        'ok',
      );
      return;
    }
    // Prévia bloqueada pelo planner (fail-closed): cobertura parcial é o
    // estado PERMANENTE desta leitura (guarnições sem leitor) — espelha o
    // gate NO_WORK da origem com os fatos disponíveis para inspeção.
    ctx.status(
      `A leitura da Visão de Comandos é parcial (${facts.outgoingSupports.length} apoio(s) em trânsito lidos; guarnições ainda sem leitor) — prévia de retirada bloqueada por segurança.`,
      'warn',
    );
  },
});
