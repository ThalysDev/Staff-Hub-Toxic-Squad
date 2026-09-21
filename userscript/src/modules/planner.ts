// Planner de OP — seção "Planner de OP" do Staff Hub In-Game (visível em todas
// as telas do jogo). Reúne as MESMAS engines da Sala de Guerra do app:
//   1. Formulário de grupo (mínimo) → MassGroupConfig validado (validateMassGroup),
//      persistido em GM storage `worldKey(world, 'planner-groups')` (o rascunho
//      sobrevive a reinícios — por design);
//   2. "Gerar operação" → generateMassPlan (@shared/mass-planner-engine). A engine
//      é SÍNCRONA: o aviso "Gerando…" é pintado antes e a aba congela durante o
//      cálculo (o worker do app não existe aqui — tradeoff documentado no relatório);
//   3. Exportações byte-fiéis do tool real: Russian Planner / TW Mass Planner
//      (@shared/mass-planner-formats), lista de reservas (@shared/comms-package via
//      @shared/op-comms) e JSON da OP (@shared/op-export, download via Blob);
//   4. Kit de tempo de envio: get_config/get_unit_info/dumps via pacedGet + parsers
//      do mundo; agenda "Chegada → Envio" com @shared/sg4-timing e solver de bônus
//      noturno (@shared/night-bonus) — espelha o fluxo da Sg4Page do app;
//   5. Material de MPs personalizadas (@shared/op-comms + comms-package) — SOMENTE
//      texto para copiar: NENHUM POST de jogo parte daqui (mutações são do SG_6).

import { gameContext, registerSection } from '../core/shell';
import { card, cardTitle, el, empty, iconButton, notification, pill, spinner, table } from '../core/ui';
import { icon, type IconName } from '../core/icons';
import { gm, worldKey } from '../core/storage';
import { pacedGet } from '../core/net';
import {
  MASS_MAX_PAIRS,
  generateMassPlan,
  parseMassCoordGroups,
  validateMassGroup,
} from '@shared/mass-planner-engine';
import type {
  MassAssignMode,
  MassGroupConfig,
  MassNightBonusMode,
  MassPlanCommand,
  MassPlanContext,
  MassPlanResult,
} from '@shared/mass-planner-types';
import { formatRussianPlanner, formatTwMassPlanner } from '@shared/mass-planner-formats';
import { buildOpComms, executorNick, opCommsInputs } from '@shared/op-comms';
import { renderTemplate, reservationList } from '@shared/comms-package';
import { serializeOpExport } from '@shared/op-export';
import { parseWorldConfigXml, type WorldConfig } from '@shared/world-config';
import {
  parseMapPlayerTxt,
  parseMapVillageTxt,
  parseUnitInfoXml,
} from '@shared/parsers/world-parsers';
import { UNITS, type UnitId } from '@shared/units';
import { parseCoord, type Coord } from '@shared/coords';
import { computeSendTimes, formatHms, type SendPair } from '@shared/sg4-timing';
import { solveDepartureForArrival, type NightBonusCfg } from '@shared/night-bonus';

// Versão injetada em compile-time pelo build.mjs (define do esbuild, lido de
// userscript/version.json — a mesma do header TM); entra como metadado
// "version" do JSON da OP. O `declare` satisfaz o tsc; em runtime o
// identificador já foi substituído pelo literal antes da obfuscação.
declare const __SHS_VERSION__: string;

// Molde de MP "Diretrizes de OP" aprovado pelo dono (o mesmo seed do app —
// MassPlannerSection.DEFAULT_OP_MP_BODY). Editável na UI; placeholder exige
// #alvos# e/ou #horarios# (renderTemplate é fail-closed).
const DEFAULT_MP_BODY =
  '[b]⚔ OP — Diretrizes da operação[/b]\n\n' +
  '[b]📍 SEUS ALVOS[/b]\n[spoiler=Clique para ver seus alvos]\n#alvos#\n[/spoiler]\n\n' +
  '[b]⏰ SEUS HORÁRIOS DE ENVIO[/b]\n[spoiler=Clique para ver quando enviar]\n#horarios#\n[/spoiler]\n\n' +
  '[b]📌 Diretrizes:[/b]\n' +
  '1. [b]Confirme[/b] respondendo esta MP com "OK";\n' +
  '2. Ataque com [b]toda a tropa indicada[/b] — nada de poupar;\n' +
  '3. [b]Não mire nada além do informado[/b];\n' +
  '4. Alvo caiu antes? [b]Envie mesmo assim[/b] no horário combinado;\n' +
  '5. Não pode participar? Avise [b]agora[/b] para realocarmos seus alvos;\n' +
  '6. [b]Não compartilhe[/b] esta MP fora da operação.\n\n' +
  'Boa sorte! 🍀\n— Comando';

const MODE_LABELS: Record<MassAssignMode, string> = {
  otimizado: 'Otimizado',
  'por-jogador': 'Por jogador',
  'mais-perto': 'Mais perto',
  'mais-longe': 'Mais longe',
};

// ---------------------------------------------------------------------------
// Rascunho persistido (formulário + grupos + material de comunicação)
// ---------------------------------------------------------------------------

interface PlannerForm {
  nome: string;
  /** "x|y …" — uma coordenada por linha ou separada por espaço (grupos ";" do
   *  tool real não entram no formulário mínimo: um valor de comandos aplica a todas). */
  origens: string;
  alvos: string;
  porOrigem: string;
  porAlvo: string;
  unidade: UnitId;
  modo: MassAssignMode;
  distMin: string;
  distMax: string;
  /** datetime-local ("AAAA-MM-DDTHH:MM") — chegada fixa do grupo. */
  chegada: string;
  bn: MassNightBonusMode;
  evitarMs: boolean;
}

interface PlannerDraft {
  groups: MassGroupConfig[];
  form: PlannerForm;
  opTitle: string;
  mpTemplate: string;
}

function defaultForm(): PlannerForm {
  const now = new Date();
  const part = (value: number): string => String(value).padStart(2, '0');
  return {
    nome: '',
    origens: '',
    alvos: '',
    porOrigem: '1',
    porAlvo: '1',
    unidade: 'ram',
    modo: 'otimizado',
    distMin: '0',
    distMax: '2000',
    chegada: `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}T21:00`,
    bn: 'desativado',
    evitarMs: false,
  };
}

/** Storage do GM é dado do usuário: cada campo volta ao default se estiver torto. */
function sanitizeForm(raw: unknown): PlannerForm {
  const base = defaultForm();
  if (typeof raw !== 'object' || raw === null) return base;
  const source = raw as Record<string, unknown>;
  const str = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);
  const modo = source['modo'];
  const unidade = source['unidade'];
  return {
    nome: str(source['nome'], ''),
    origens: str(source['origens'], ''),
    alvos: str(source['alvos'], ''),
    porOrigem: str(source['porOrigem'], '1'),
    porAlvo: str(source['porAlvo'], '1'),
    unidade: typeof unidade === 'string' && unidade in UNITS ? (unidade as UnitId) : base.unidade,
    modo:
      modo === 'por-jogador' || modo === 'mais-perto' || modo === 'mais-longe'
        ? modo
        : 'otimizado',
    distMin: str(source['distMin'], '0'),
    distMax: str(source['distMax'], '2000'),
    chegada: str(source['chegada'], base.chegada),
    bn: source['bn'] === 'reagendar' ? 'reagendar' : 'desativado',
    evitarMs: source['evitarMs'] === true,
  };
}

/** Forma mínima de um MassGroupConfig vindo do storage — o motor lê TODOS os
 *  campos abaixo; rascunho faltando qualquer um é descartado (fail-closed). */
function isGroupLike(entry: unknown): entry is MassGroupConfig {
  if (typeof entry !== 'object' || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['nome'] === 'string' &&
    Array.isArray(record['origins']) &&
    Array.isArray(record['originQuotas']) &&
    Array.isArray(record['targets']) &&
    Array.isArray(record['targetQuotas']) &&
    typeof record['repeatOriginSamePlayer'] === 'boolean' &&
    Array.isArray(record['towers']) &&
    typeof record['towerRadius'] === 'number' &&
    typeof record['slowestUnit'] === 'string' &&
    record['slowestUnit'] in UNITS &&
    typeof record['assignMode'] === 'string' &&
    typeof record['minDistance'] === 'number' &&
    typeof record['maxDistance'] === 'number' &&
    typeof record['arrivalKind'] === 'string' &&
    typeof record['arrivalBaseMs'] === 'number' &&
    typeof record['windowStartMs'] === 'number' &&
    typeof record['windowEndMs'] === 'number' &&
    typeof record['attackDelaySeconds'] === 'number' &&
    typeof record['nightBonus'] === 'string' &&
    typeof record['avoidMsConflict'] === 'boolean' &&
    typeof record['minMorale'] === 'number' &&
    Array.isArray(record['catapultTargets'])
  );
}

function loadDraft(key: string): PlannerDraft {
  const stored = gm.get<unknown>(key, {});
  const source = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  const rawGroups = source['groups'];
  const mpTemplate = source['mpTemplate'];
  return {
    groups: Array.isArray(rawGroups) ? rawGroups.filter(isGroupLike) : [],
    form: sanitizeForm(source['form']),
    opTitle: typeof source['opTitle'] === 'string' ? source['opTitle'] : '',
    mpTemplate: typeof mpTemplate === 'string' && mpTemplate !== '' ? mpTemplate : DEFAULT_MP_BODY,
  };
}

// ---------------------------------------------------------------------------
// Dados do mundo (mesma fonte da Sala de Guerra: interface.php + dumps)
// ---------------------------------------------------------------------------

interface WorldData {
  config: WorldConfig;
  /** Minutos-por-campo EFETIVOS por unidade (get_unit_info já serve o valor final). */
  unitMinutes: Partial<Record<UnitId, number>>;
  villagePoints: Map<string, number>;
  ownerByCoord: Map<string, string>;
  playerPoints: Map<string, number>;
  villageIdByCoord: Map<string, number>;
  dumpsOk: boolean;
}

let worldCache: WorldData | null = null;

async function loadWorldData(world: string): Promise<WorldData> {
  const configXml = await pacedGet('interface.php?func=get_config');
  const config = parseWorldConfigXml(world, configXml);
  const unitsXml = await pacedGet('interface.php?func=get_unit_info');
  const units = parseUnitInfoXml(unitsXml);
  const unitMinutes: Partial<Record<UnitId, number>> = {};
  for (const id of Object.keys(UNITS) as UnitId[]) {
    const speed = units[id]?.speed;
    if (speed !== undefined && Number.isFinite(speed) && speed > 0) unitMinutes[id] = speed;
  }
  const data: WorldData = {
    config,
    unitMinutes,
    villagePoints: new Map<string, number>(),
    ownerByCoord: new Map<string, string>(),
    playerPoints: new Map<string, number>(),
    villageIdByCoord: new Map<string, number>(),
    dumpsOk: false,
  };
  // Dumps do mundo (village.txt/player.txt): dono, pontos e ID interno por "x|y".
  // Best-effort: sem eles a OP gerada funciona (executor cai para "Grupo <nome>",
  // link da praça degradado, moral sem dados) — com aviso VISÍVEL na UI.
  try {
    const [villagesTxt, playersTxt] = await Promise.all([pacedGet('map/village.txt'), pacedGet('map/player.txt')]);
    const players = parseMapPlayerTxt(playersTxt);
    const nameById = new Map<number, string>();
    for (const player of players) {
      nameById.set(player.id, player.name);
      data.playerPoints.set(player.name, player.points);
    }
    const villages = parseMapVillageTxt(villagesTxt);
    for (const village of villages) {
      const key = `${village.x}|${village.y}`;
      data.villagePoints.set(key, village.points);
      data.villageIdByCoord.set(key, village.id);
      if (village.playerId !== 0) {
        const owner = nameById.get(village.playerId);
        if (owner !== undefined) data.ownerByCoord.set(key, owner);
      }
    }
    data.dumpsOk = true;
  } catch {
    // degradação controlada: renderWorldStatus mostra que os dumps falharam
  }
  return data;
}

/** Contexto do motor; com dados do mundo ausentes, contexto vazio (a validação
 *  do grupo acusa a unidade sem velocidade — nunca dado inventado). */
function planContextOf(data: WorldData | null): MassPlanContext {
  return {
    unitMinutesPerField: data?.unitMinutes ?? {},
    nightBonus:
      data === null
        ? { nightBonusActive: false, nightStartHour: 0, nightEndHour: 0 }
        : {
            nightBonusActive: data.config.nightBonusActive,
            nightStartHour: data.config.nightStartHour,
            nightEndHour: data.config.nightEndHour,
          },
    villagePoints: data?.villagePoints ?? new Map<string, number>(),
    ownerByCoord: data?.ownerByCoord ?? new Map<string, string>(),
    playerPoints: data?.playerPoints ?? new Map<string, number>(),
    villageIdByCoord: data?.villageIdByCoord ?? new Map<string, number>(),
    moralActive: data?.config.moralActive ?? true,
  };
}

// ---------------------------------------------------------------------------
// Formulário → MassGroupConfig (campos fora do formulário mínimo ficam no
// default da spec: sem torres, arrivalKind fixa, moral ignorada, sem catapulta)
// ---------------------------------------------------------------------------

interface BuiltGroup {
  group: MassGroupConfig;
  /** Erro de cotas do formato do tool real ("O número de separadores…"). */
  quotaErrors: string[];
  originsSummary: string;
  targetsSummary: string;
}

function buildGroupFromForm(form: PlannerForm): BuiltGroup {
  const origins = parseMassCoordGroups(form.origens, form.porOrigem);
  const targets = parseMassCoordGroups(form.alvos, form.porAlvo);
  const quotaErrors: string[] = [];
  if (origins.quotaError !== null) quotaErrors.push(`Comandos por origem: ${origins.quotaError}`);
  if (targets.quotaError !== null) quotaErrors.push(`Comandos por alvo: ${targets.quotaError}`);
  const summary = (parsed: { entries: unknown[]; duplicatesRemoved: number; invalidTokens: number }): string => {
    const extras: string[] = [];
    if (parsed.duplicatesRemoved > 0) extras.push(`${parsed.duplicatesRemoved} duplicada(s) ignorada(s)`);
    if (parsed.invalidTokens > 0) extras.push(`${parsed.invalidTokens} trecho(s) inválido(s) ignorado(s)`);
    return `${parsed.entries.length} coordenada(s)${extras.length > 0 ? ` — ${extras.join(', ')}` : ''}`;
  };
  return {
    group: {
      id: crypto.randomUUID(),
      nome: form.nome,
      origins: origins.entries,
      originQuotas: origins.quotas,
      targets: targets.entries,
      targetQuotas: targets.quotas,
      repeatOriginSamePlayer: true,
      towers: [],
      towerRadius: 15,
      slowestUnit: form.unidade,
      assignMode: form.modo,
      minDistance: Number(form.distMin),
      maxDistance: Number(form.distMax),
      arrivalKind: 'fixa',
      arrivalBaseMs: form.chegada === '' ? Number.NaN : new Date(form.chegada).getTime(),
      windowStartMs: Number.NaN,
      windowEndMs: Number.NaN,
      attackDelaySeconds: 0,
      nightBonus: form.bn,
      avoidMsConflict: form.evitarMs,
      minMorale: 0,
      catapultTargets: [],
    },
    quotaErrors,
    originsSummary: summary(origins),
    targetsSummary: summary(targets),
  };
}

function firstGroupError(group: MassGroupConfig, context: MassPlanContext, quotaErrors: readonly string[]): string | null {
  if (quotaErrors.length > 0) return quotaErrors[0] ?? null;
  const errors = validateMassGroup(group, context);
  for (const message of Object.values(errors)) {
    if (message !== undefined) return message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Formatação local (relógio do navegador — igual ao app; sem lógica de jogo)
// ---------------------------------------------------------------------------

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

/** "dd/MM HH:MM:SS" — chegada sempre com o dia (viagens D-1 são comuns). */
function formatFullClock(ms: number): string {
  const at = new Date(ms);
  return `${pad(at.getDate())}/${pad(at.getMonth() + 1)} ${formatHms(at)}`;
}

/** HH:MM:SS com sufixo "@dd/MM" quando o envio cai fora do dia da chegada. */
function formatSendWithDay(sendAt: Date, arrivalDay: string): string {
  const suffix =
    sendAt.toDateString() === arrivalDay ? '' : ` @${pad(sendAt.getDate())}/${pad(sendAt.getMonth() + 1)}`;
  return `${formatHms(sendAt)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Tabela por executor (agregado do plano gerado)
// ---------------------------------------------------------------------------

interface PlayerAgg {
  nick: string;
  count: number;
  firstSendMs: number;
  lastSendMs: number;
}

function aggregateByPlayer(commands: readonly MassPlanCommand[]): PlayerAgg[] {
  const byNick = new Map<string, PlayerAgg>();
  for (const command of commands) {
    const nick = executorNick(command);
    const current = byNick.get(nick);
    if (current === undefined) {
      byNick.set(nick, { nick, count: 1, firstSendMs: command.sendMs, lastSendMs: command.sendMs });
    } else {
      current.count += 1;
      current.firstSendMs = Math.min(current.firstSendMs, command.sendMs);
      current.lastSendMs = Math.max(current.lastSendMs, command.sendMs);
    }
  }
  return [...byNick.values()].sort((a, b) => a.firstSendMs - b.firstSendMs);
}

// ---------------------------------------------------------------------------
// Ajudantes de UI local (design system do shell, via core/ui)
// ---------------------------------------------------------------------------

/** Campo do design system: .shs-field com rótulo .shs-field-label (o texto do
 *  rótulo entra como child string — o el() do core o converte em text node). */
function field(labelText: string, control: HTMLElement): HTMLDivElement {
  return el('div', { className: 'shs-field' }, el('span', { className: 'shs-field-label' }, labelText), control);
}

/** Botão type=button com ícone + variante do design system (core/ui). */
function button(
  label: string,
  variant: 'primary' | 'ghost' | 'danger',
  iconName: IconName,
  onClick: () => void,
  sm = false,
  tip?: string | undefined,
): HTMLButtonElement {
  const element = iconButton(label, iconName, tip === undefined ? { variant, small: sm } : { variant, tip, small: sm });
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}

/** Grade de campos compactos (inline style: o CSS vive no shell, um arquivo só). */
function fieldGrid(...fields: readonly HTMLElement[]): HTMLDivElement {
  const grid = el('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(180px, 1fr))';
  grid.style.columnGap = '12px';
  for (const child of fields) grid.appendChild(child);
  return grid;
}

/** Input numérico de passo inteiro com mínimo. */
function numberInput(min: string): HTMLInputElement {
  const input = el('input', { className: 'shs-input' });
  input.type = 'number';
  input.min = min;
  input.step = '1';
  return input;
}

/** Option de select com value. */
function option(value: string, label: string): HTMLOptionElement {
  const element = el('option', undefined, label);
  element.value = value;
  return element;
}

// ---------------------------------------------------------------------------
// Seção
// ---------------------------------------------------------------------------

function renderPlanner(container: HTMLElement): void {
  // O shell re-invoca render quando a página do jogo troca conteúdo sem
  // recarregar (MutationObserver) SEM limpar o corpo da aba: sem esta guarda
  // a seção duplicaria a cada navegação interna do jogo.
  if (container.childElementCount > 0) return;

  const ctx = gameContext();
  const world = ctx.world === '—' ? 'br' : ctx.world;
  const storeKey = worldKey(ctx.world, 'planner-groups');
  const draft = loadDraft(storeKey);

  let worldData: WorldData | null = worldCache;
  let lastResult: MassPlanResult | null = null;

  // ---- controles (referências diretas — sem ids, sem querySelector) ----
  const worldEl = el('span', { className: 'shs-muted' }, 'Dados do mundo: carregando…');
  const worldBtn = button('Atualizar dados do mundo', 'ghost', 'refresh', () => {
    void refreshWorld();
  });
  const statusEl = el('div', { className: 'shs-muted' });

  const nomeInput = el('input', { className: 'shs-input' });
  nomeInput.placeholder = 'ex.: nuke, fake, limpeza';
  const origensArea = el('textarea', { className: 'shs-input' });
  origensArea.rows = 4;
  const alvosArea = el('textarea', { className: 'shs-input' });
  alvosArea.rows = 4;
  const porOrigemInput = numberInput('1');
  const porAlvoInput = numberInput('1');
  const unidadeSelect = el('select');
  const modoSelect = el(
    'select',
    undefined,
    option('otimizado', 'Otimizado'),
    option('por-jogador', 'Distribuído por jogador'),
    option('mais-perto', 'Mais perto'),
    option('mais-longe', 'Mais longe'),
  );
  const distMinInput = numberInput('0');
  const distMaxInput = numberInput('1');
  const chegadaInput = el('input', { className: 'shs-input' });
  chegadaInput.type = 'datetime-local';
  const bnSelect = el(
    'select',
    undefined,
    option('desativado', 'Desativada'),
    option('reagendar', 'Reagendar p/ depois da janela'),
  );
  const evitarMsInput = el('input');
  evitarMsInput.type = 'checkbox';

  const opTitleInput = el('input', { className: 'shs-input' });
  opTitleInput.placeholder = 'ex.: OP Cerco Noturno';
  const mpTemplateArea = el('textarea', { className: 'shs-input' });
  mpTemplateArea.rows = 8;
  const mpBtn = button(
    'Gerar MPs (texto)',
    'primary',
    'zap',
    () => {
      generateMps();
    },
    false,
    'Monta o texto das MPs para copiar — nada é enviado daqui',
  );
  const mpOutputArea = el('textarea', { className: 'shs-input' });
  mpOutputArea.rows = 12;
  mpOutputArea.readOnly = true;
  mpOutputArea.placeholder =
    'As MPs personalizadas aparecem aqui para copiar — nada é enviado daqui (envio real é papel do módulo SG_6).';

  const timingVilaInput = el('input', { className: 'shs-input' });
  timingVilaInput.placeholder = 'x|y (vazio = todos os comandos)';
  const timingHoraInput = el('input', { className: 'shs-input' });
  timingHoraInput.type = 'time';
  timingHoraInput.value = '22:00';
  const timingDiaSelect = el('select', undefined, option('hoje', 'Hoje'), option('amanha', 'Amanhã'));
  const timingBtn = button('Calcular horários de envio', 'primary', 'clock', () => {
    computeTiming();
  });
  const timingInfo = el('p', { className: 'shs-muted' });
  const timingResult = el('div');

  const addBtn = button('Adicionar grupo à operação', 'ghost', 'plus', () => {
    syncFormFromDom();
    const built = buildGroupFromForm(draft.form);
    const error = firstGroupError(built.group, planContextOf(worldData), built.quotaErrors);
    if (error !== null) {
      setStatus(`Grupo inválido: ${error}`, 'danger');
      return;
    }
    draft.groups.push(built.group);
    persist();
    renderGroups();
    setStatus(
      `Grupo "${built.group.nome}" adicionado — origens: ${built.originsSummary}; alvos: ${built.targetsSummary}.`,
      'ok',
    );
  });
  const formHint = el(
    'p',
    { className: 'shs-muted' },
    'Gerar usa os grupos adicionados abaixo; com a lista vazia, o formulário atual entra como grupo único. ' +
      `Teto da engine: ${MASS_MAX_PAIRS.toLocaleString('pt-BR')} pares (origens × alvos) por grupo.`,
  );
  const groupsEl = el('div');
  const progressEl = el('div');
  const gerarBtn = button('Gerar operação', 'primary', 'zap', () => {
    void generate();
  });
  const resultEl = el('div');

  // ---- montagem: cartões do design system (Grupos → Grupos adicionados →
  // Resultado com o material de MPs → Kit de tempo de envio) ----
  const box = el('div');
  box.append(
    el('strong', undefined, 'Planner de OP'),
    el(
      'p',
      { className: 'shs-muted' },
      'Mesma engine da Sala de Guerra (Staff Hub): gera a operação e exporta nos formatos do tool (Russian Planner / TW Mass Planner). Nenhum comando parte daqui.',
    ),
    el('div', { className: 'shs-row' }, worldEl, worldBtn),
    statusEl,
    card(
      cardTitle('sword', 'Grupos'),
      field('Nome do modelo de tropa', nomeInput),
      field('Origens ("x|y", uma por linha ou separadas por espaço)', origensArea),
      field('Alvos ("x|y", uma por linha ou separadas por espaço)', alvosArea),
      fieldGrid(
        field('Comandos por origem (um valor, aplica a todas)', porOrigemInput),
        field('Comandos por alvo (um valor, aplica a todos)', porAlvoInput),
        field('Unidade mais lenta', unidadeSelect),
        field('Modo', modoSelect),
        field('Distância mín', distMinInput),
        field('Distância máx', distMaxInput),
        field('Chegada fixa em', chegadaInput),
        field('Proteção BN', bnSelect),
      ),
      el(
        'div',
        { className: 'shs-row' },
        el('label', undefined, evitarMsInput, ' Evitar ms no mesmo jogador'),
        addBtn,
      ),
    ),
    card(cardTitle('list', 'Grupos adicionados'), formHint, groupsEl, progressEl, el('div', { className: 'shs-row' }, gerarBtn)),
    card(
      cardTitle('chart', 'Resultado'),
      resultEl,
      el('hr', { className: 'shs-divider' }),
      field('Título da OP', opTitleInput),
      field('Template da MP (placeholders: #jogador#, #alvos#, #horarios#)', mpTemplateArea),
      el('div', { className: 'shs-row' }, mpBtn),
      mpOutputArea,
    ),
    card(
      cardTitle('clock', 'Kit de tempo de envio'),
      el(
        'p',
        { className: 'shs-muted' },
        'Agenda "Chegada → Envio" dos comandos da operação gerada (bônus noturno aplicado pela engine — igual à agenda da Sala de Guerra).',
      ),
      fieldGrid(
        field('Vila de origem', timingVilaInput),
        field('Chegada desejada', timingHoraInput),
        field('Dia', timingDiaSelect),
      ),
      el('div', { className: 'shs-row' }, timingBtn),
      timingInfo,
      timingResult,
    ),
  );
  container.appendChild(box);

  function setStatus(message: string, tone: 'muted' | 'ok' | 'danger' = 'muted'): void {
    statusEl.textContent = message;
    statusEl.className = tone === 'ok' ? 'shs-ok' : tone === 'danger' ? 'shs-danger' : 'shs-muted';
  }

  function persist(): void {
    gm.set(storeKey, draft);
  }

  function syncFormFromDom(): void {
    draft.form = {
      nome: nomeInput.value,
      origens: origensArea.value,
      alvos: alvosArea.value,
      porOrigem: porOrigemInput.value,
      porAlvo: porAlvoInput.value,
      unidade: unidadeSelect.value as UnitId,
      modo: modoSelect.value as MassAssignMode,
      distMin: distMinInput.value,
      distMax: distMaxInput.value,
      chegada: chegadaInput.value,
      bn: bnSelect.value as MassNightBonusMode,
      evitarMs: evitarMsInput.checked,
    };
    draft.opTitle = opTitleInput.value;
    draft.mpTemplate = mpTemplateArea.value;
    persist();
  }

  // ---- valores persistidos nos controles (nada de HTML interpolado) ----
  for (const id of Object.keys(UNITS) as UnitId[]) {
    const unitOption = option(id, UNITS[id].name);
    if (id === draft.form.unidade) unitOption.selected = true;
    unidadeSelect.appendChild(unitOption);
  }
  nomeInput.value = draft.form.nome;
  origensArea.value = draft.form.origens;
  alvosArea.value = draft.form.alvos;
  porOrigemInput.value = draft.form.porOrigem;
  porAlvoInput.value = draft.form.porAlvo;
  distMinInput.value = draft.form.distMin;
  distMaxInput.value = draft.form.distMax;
  chegadaInput.value = draft.form.chegada;
  bnSelect.value = draft.form.bn;
  evitarMsInput.checked = draft.form.evitarMs;
  modoSelect.value = draft.form.modo;
  opTitleInput.value = draft.opTitle;
  mpTemplateArea.value = draft.mpTemplate;

  for (const input of box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input, textarea, select',
  )) {
    input.addEventListener('change', () => syncFormFromDom());
  }

  // ---- dados do mundo ----
  function renderWorldStatus(): void {
    if (worldData === null) {
      worldEl.textContent = 'Dados do mundo: não carregados.';
      return;
    }
    const config = worldData.config;
    const bn = config.nightBonusActive
      ? `${config.nightStartHour}h→${config.nightEndHour}h (fator ${config.defFactor})`
      : 'desativado';
    const dumps = worldData.dumpsOk
      ? ''
      : ' · DUMPS INDISPONÍVEIS: executor/pontos/ID das vilas desconhecidos (exportações degradadas)';
    worldEl.textContent =
      `Dados do mundo: speed ${config.speed} · unit_speed ${config.unitSpeed} · bônus noturno ${bn} · ` +
      `moral ${config.moralActive ? 'ativa' : 'desativada'}${dumps}`;
  }

  async function refreshWorld(): Promise<void> {
    worldEl.textContent = 'Dados do mundo: carregando (get_config, get_unit_info, dumps)…';
    try {
      worldData = await loadWorldData(world);
      worldCache = worldData;
      renderWorldStatus();
    } catch (error) {
      worldData = null;
      worldEl.textContent = 'Dados do mundo: FALHA';
      setStatus(error instanceof Error ? error.message : String(error), 'danger');
    }
  }

  void refreshWorld();

  // ---- lista de grupos do rascunho ----
  function renderGroups(): void {
    groupsEl.innerHTML = '';
    if (draft.groups.length === 0) {
      groupsEl.appendChild(empty('Nenhum grupo adicionado — ao gerar, o formulário acima entra como grupo único.'));
      return;
    }
    draft.groups.forEach((group, index) => {
      const row = el('div', { className: 'shs-row' });
      const originCommands = group.originQuotas.reduce((sum, value) => sum + value, 0);
      const targetCommands = group.targetQuotas.reduce((sum, value) => sum + value, 0);
      const summaryText =
        `${group.nome}: ${group.origins.length} origens (${originCommands} comandos) × ` +
        `${group.targets.length} alvos (${targetCommands}) · ${UNITS[group.slowestUnit].name} · ` +
        `${MODE_LABELS[group.assignMode]}`;
      const summary = pill(summaryText);
      const remove = button(
        'Remover',
        'danger',
        'trash',
        () => {
          draft.groups.splice(index, 1);
          persist();
          renderGroups();
        },
        true,
      );
      row.append(summary, remove);
      groupsEl.appendChild(row);
    });
  }
  renderGroups();

  // ---- geração da operação ----
  async function generate(): Promise<void> {
    syncFormFromDom();
    if (worldData === null) {
      setStatus('Carregando dados do mundo antes de gerar…');
      await refreshWorld();
      if (worldData === null) return; // refreshWorld já mostrou o erro
    }
    const context = planContextOf(worldData);
    if (draft.groups.length === 0) {
      const built = buildGroupFromForm(draft.form);
      const error = firstGroupError(built.group, context, built.quotaErrors);
      if (error !== null) {
        setStatus(`Grupo do formulário inválido: ${error}`, 'danger');
        return;
      }
      draft.groups.push(built.group);
      persist();
      renderGroups();
    }
    for (const group of draft.groups) {
      const error = firstGroupError(group, context, []);
      if (error !== null) {
        setStatus(`Grupo "${group.nome}": ${error}`, 'danger');
        return;
      }
    }
    gerarBtn.disabled = true;
    gerarBtn.replaceChildren(spinner(), document.createTextNode('Gerando…'));
    // Aviso "Gerando…" como notificação do design system (+ spinner no botão);
    // precisa estar PINTADO antes do congelamento: yield SÓ de pintura abaixo
    // (a engine é síncrona, sem worker na página do jogo).
    progressEl.innerHTML = '';
    progressEl.appendChild(
      notification('error', 'Gerando… não feche a página (o cálculo é síncrono e congela a aba por alguns segundos).'),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    try {
      lastResult = generateMassPlan(draft.groups, context);
      renderResult();
      setStatus(
        `Operação gerada: ${lastResult.commands.length} comando(s) em ${((Date.now() - started) / 1000).toFixed(1)}s.`,
        'ok',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'danger');
    } finally {
      gerarBtn.disabled = false;
      gerarBtn.replaceChildren(icon('zap'), document.createTextNode('Gerar operação'));
      progressEl.innerHTML = '';
    }
  }

  // ---- resultado + exportações ----
  async function copyText(text: string, okMessage: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(okMessage, 'ok');
    } catch {
      // Fallback legado (permissão de clipboard negada): seleção + execCommand.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.focus();
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      setStatus(ok ? okMessage : 'Não foi possível copiar — permissão de área de transferência negada.', ok ? 'ok' : 'danger');
    }
  }

  function downloadOp(): void {
    if (lastResult === null) return;
    const commands = lastResult.commands;
    // Mesmo formato do compartilhamento da OP no app (ipc-op): cada (jogador,
    // alvo) vira uma linha do JSON portável; a origem não existe no arquivo (vazia).
    const json = serializeOpExport({
      version: __SHS_VERSION__,
      world,
      opTitle: opTitleInput.value.trim() || 'OP',
      targets: [...new Set(commands.map((command) => command.target))],
      distribution: commands.map((command) => ({
        playerName: executorNick(command),
        origin: '',
        target: command.target,
      })),
      sendSchedule: opCommsInputs(commands).sendSchedule,
    });
    const now = new Date();
    const stamp = `${pad(now.getDate())}${pad(now.getMonth() + 1)}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `op-${world}-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setStatus(`Arquivo da OP baixado (${commands.length} comando(s) na agenda).`, 'ok');
  }

  function exportRow(commands: readonly MassPlanCommand[]): HTMLElement {
    const row = el('div', { className: 'shs-row' });
    row.appendChild(
      button(
        'Copiar Russian Planner',
        'primary',
        'copy',
        () => {
          void copyText(
            formatRussianPlanner(commands, world),
            'BBCode Russian Planner copiado — cole no caderno da conta premium.',
          );
        },
        false,
        'Copia o BBCode do formato Russian Planner',
      ),
    );
    row.appendChild(
      button(
        'Copiar TW Mass Planner',
        'primary',
        'copy',
        () => {
          void copyText(
            formatTwMassPlanner(commands, world),
            'BBCode TW Mass Planner copiado — cole no caderno da conta premium.',
          );
        },
        false,
        'Copia o BBCode do formato TW Mass Planner',
      ),
    );
    row.appendChild(
      button(
        'Copiar lista de reservas',
        'ghost',
        'copy',
        () => {
          void copyText(
            reservationList(opCommsInputs(commands).distribution),
            'Alvos únicos da OP copiados — cole na Reserva em Massa do SG_6.',
          );
        },
        false,
        'Alvos únicos para a Reserva em Massa do SG_6',
      ),
    );
    row.appendChild(
      button(
        'Baixar OP (JSON)',
        'ghost',
        'download',
        () => {
          downloadOp();
        },
        false,
        'Baixa o arquivo JSON portátil da OP',
      ),
    );
    return row;
  }

  function renderResult(): void {
    resultEl.innerHTML = '';
    if (lastResult === null) return;
    const commands = lastResult.commands;

    const first = commands[0];
    const last = commands[commands.length - 1];
    if (first !== undefined && last !== undefined && commands.length > 0) {
      resultEl.appendChild(
        el(
          'p',
          { className: 'shs-muted' },
          `${commands.length} comando(s) — 1ª chegada ${formatFullClock(first.arrivalMs)} · última chegada ${formatFullClock(last.arrivalMs)}.`,
        ),
      );
    }

    if (lastResult.warnings.length > 0) {
      resultEl.appendChild(el('p', { className: 'shs-danger' }, `Avisos (${lastResult.warnings.length}):`));
      const list = el('ul');
      for (const warning of lastResult.warnings) list.appendChild(el('li', undefined, warning));
      resultEl.appendChild(list);
    }

    if (lastResult.discards.length > 0) {
      resultEl.appendChild(el('p', { className: 'shs-muted' }, 'Pares descartados (nunca em silêncio):'));
      resultEl.appendChild(
        el(
          'div',
          { className: 'shs-tablewrap' },
          table(
            ['Motivo', 'Pares'],
            lastResult.discards.map((entry) => [entry.reason, String(entry.count)]),
          ),
        ),
      );
    }

    if (commands.length === 0) {
      resultEl.appendChild(
        el('p', { className: 'shs-danger' }, 'Nenhum comando sobrou dos filtros — veja os descartes e avisos acima.'),
      );
      return;
    }

    resultEl.appendChild(el('p', { className: 'shs-strong' }, 'Por executor'));
    resultEl.appendChild(
      el(
        'div',
        { className: 'shs-tablewrap' },
        table(
          ['Executor', 'Comandos', '1º envio', 'Último envio'],
          aggregateByPlayer(commands).map((player) => [
            player.nick,
            String(player.count),
            formatFullClock(player.firstSendMs),
            formatFullClock(player.lastSendMs),
          ]),
        ),
      ),
    );
    resultEl.appendChild(exportRow(commands));
  }

  // ---- kit de tempo de envio (espelho da agenda da Sg4Page) ----
  function computeTiming(): void {
    timingResult.innerHTML = '';
    timingInfo.textContent = '';
    if (lastResult === null || lastResult.commands.length === 0) {
      setStatus('Gere a operação antes de calcular os horários de envio.', 'danger');
      return;
    }
    if (worldData === null) {
      setStatus('Dados do mundo ainda não carregados — clique em "Atualizar dados do mundo".', 'danger');
      return;
    }
    const villageText = timingVilaInput.value.trim();
    let village: Coord | null = null;
    if (villageText !== '') {
      village = parseCoord(villageText);
      if (village === null) {
        setStatus(`Vila de origem fora do formato x|y: "${villageText.slice(0, 30)}".`, 'danger');
        return;
      }
    }
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timingHoraInput.value.trim());
    if (timeMatch === null) {
      setStatus('Chegada desejada inválida — use HH:MM (ex.: 22:00).', 'danger');
      return;
    }
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      setStatus('Chegada desejada inválida — use hora 0–23 e minuto 0–59.', 'danger');
      return;
    }
    const day = timingDiaSelect.value;
    try {
      const commands =
        village === null
          ? lastResult.commands
          : lastResult.commands.filter((command) => command.origin === `${village.x}|${village.y}`);
      if (commands.length === 0) {
        setStatus('Nenhum comando da operação sai da vila informada — deixe a vila vazia para ver todos.', 'danger');
        return;
      }
      // Base = hoje; "Amanhã" adianta a data ANTES de fixar as horas (igual à Sg4Page).
      const base = new Date();
      if (day === 'amanha') base.setDate(base.getDate() + 1);
      const arrival = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
      const cfg: NightBonusCfg = worldData.config;

      const fieldsByPair = new Map<string, number>();
      const minutesByPair = new Map<string, number>();
      const pairs: SendPair[] = [];
      for (const command of commands) {
        const parsed = parseCoord(command.origin);
        if (parsed === null) throw new Error(`Origem inesperada no plano gerado: ${command.origin}`);
        const key = `${command.origin}|${command.target}`;
        fieldsByPair.set(key, command.distanceFields);
        const minutes = worldData.unitMinutes[command.unit];
        if (minutes === undefined || !(minutes > 0)) {
          throw new Error(
            `Velocidade da unidade ${UNITS[command.unit].name} indisponível — atualize os dados do mundo.`,
          );
        }
        minutesByPair.set(key, minutes);
        pairs.push({
          originPlayer: { playerName: executorNick(command), fulls: 0, origins: [parsed] },
          originCoord: command.origin,
          targetCoord: command.target,
        });
      }
      // Mesma conta da Sg4Page: viagem clássica = campos × min/campo; com bônus
      // noturno ativo, solver inverso na chegada desejada (converge nas bordas).
      const travelMinutesPerPair = (originPlayer: { origins: { x: number; y: number }[] }, targetCoord: string): number => {
        const origin = originPlayer.origins[0];
        if (origin === undefined) throw new Error('Par de envio sem vila de origem — gere a operação de novo.');
        const key = `${origin.x}|${origin.y}|${targetCoord}`;
        const fields = fieldsByPair.get(key);
        const minutes = minutesByPair.get(key);
        if (fields === undefined || minutes === undefined) {
          throw new Error('Par origem→alvo mudou desde a geração — gere a operação de novo.');
        }
        if (!cfg.nightBonusActive) return fields * minutes;
        return (
          solveDepartureForArrival({ distanceFields: fields, minutesPerField: minutes, arrivalAt: arrival, cfg })
            .travelMs / 60_000
        );
      };
      const rows = computeSendTimes(pairs, {
        desiredArrival: { hour, minute },
        baseDate: base,
        travelMinutesPerPair,
      }).slice();
      rows.sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());

      timingInfo.textContent = cfg.nightBonusActive
        ? `Bônus noturno ${cfg.nightStartHour}h→${cfg.nightEndHour}h (fator ${cfg.defFactor}) aplicado no tempo de viagem.`
        : 'Mundo sem bônus noturno — viagem clássica (campos × min/campo).';

      const arrivalDay = arrival.toDateString();
      timingResult.appendChild(
        el(
          'div',
          { className: 'shs-tablewrap' },
          table(
            ['Alvo', 'Origem', 'Campos', 'Chegada', 'Enviar às'],
            rows.map((row) => [
              row.targetCoord,
              row.originCoord,
              String(fieldsByPair.get(`${row.originCoord}|${row.targetCoord}`) ?? 0),
              formatHms(arrival),
              formatSendWithDay(row.sendAt, arrivalDay),
            ]),
          ),
        ),
      );

      const past = rows.filter((row) => row.sendAt.getTime() < Date.now()).length;
      setStatus(
        past > 0
          ? `Agenda pronta: ${rows.length} envio(s) — ATENÇÃO: ${past} com horário JÁ PASSADO (mude o dia ou a hora).`
          : `Agenda pronta: ${rows.length} envio(s).`,
        past > 0 ? 'danger' : 'ok',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'danger');
    }
  }

  // ---- material de MPs (só TEXTO — envio real é papel do SG_6) ----
  function generateMps(): void {
    syncFormFromDom();
    if (lastResult === null || lastResult.commands.length === 0) {
      setStatus('Gere a operação antes de montar as MPs.', 'danger');
      return;
    }
    const template = mpTemplateArea.value;
    const title = opTitleInput.value.trim() || 'OP';
    try {
      const players = buildOpComms(lastResult.commands, title, template);
      const blocks = players.map(
        (player) => `=== MP para ${player.playerName} ===\n${renderTemplate(template, player)}`,
      );
      mpOutputArea.value = blocks.join('\n\n');
      setStatus(`${players.length} MP(s) gerada(s) — copie o texto acima. O envio fica no módulo SG_6.`, 'ok');
    } catch (error) {
      mpOutputArea.value = '';
      setStatus(error instanceof Error ? error.message : String(error), 'danger');
    }
  }
}

// Visível em TODAS as telas (matchScreen undefined) — registro no shell.
registerSection({
  id: 'planner',
  label: 'Planner de OP',
  icon: 'target',
  render: renderPlanner,
});
