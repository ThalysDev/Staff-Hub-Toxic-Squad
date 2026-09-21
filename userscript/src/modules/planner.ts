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

// Manter em sync com userscript/version.json (lido pelo build.mjs no header TM);
// entra como metadado "version" do JSON da OP.
const USERSCRIPT_VERSION = '1.0.0';

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

  const box = document.createElement('div');
  box.innerHTML = `
    <strong>Planner de OP</strong>
    <p class="shs-muted">Mesma engine da Sala de Guerra (Staff Hub): gera a operação e exporta nos
    formatos do tool (Russian Planner / TW Mass Planner). Nenhum comando parte daqui.</p>
    <div class="shs-row">
      <span id="shs-pl-world" class="shs-muted">Dados do mundo: carregando…</span>
      <button class="shs-btn shs-btn-ghost" id="shs-pl-world-btn" type="button">Atualizar dados do mundo</button>
    </div>

    <div style="border:1px solid #b7a98d;border-radius:6px;padding:8px;margin:8px 0">
      <strong>Grupo</strong>
      <div class="shs-row">
        <input class="shs-input" id="shs-pl-nome" placeholder="Nome do modelo de tropa (ex.: nuke, fake, limpeza)" />
      </div>
      <label class="shs-muted" for="shs-pl-origens">Origens ("x|y", uma por linha ou separadas por espaço)</label>
      <textarea class="shs-input" id="shs-pl-origens" rows="4"></textarea>
      <div class="shs-row">
        <span>Comandos por origem (um valor, aplica a todas)
          <input class="shs-input" id="shs-pl-por-origem" type="number" min="1" step="1" style="width:70px" /></span>
        <span>Comandos por alvo (um valor, aplica a todos)
          <input class="shs-input" id="shs-pl-por-alvo" type="number" min="1" step="1" style="width:70px" /></span>
      </div>
      <label class="shs-muted" for="shs-pl-alvos">Alvos ("x|y", uma por linha ou separadas por espaço)</label>
      <textarea class="shs-input" id="shs-pl-alvos" rows="4"></textarea>
      <div class="shs-row">
        <span>Unidade mais lenta <select id="shs-pl-unidade"></select></span>
        <span>Modo
          <select id="shs-pl-modo">
            <option value="otimizado">Otimizado</option>
            <option value="por-jogador">Distribuído por jogador</option>
            <option value="mais-perto">Mais perto</option>
            <option value="mais-longe">Mais longe</option>
          </select></span>
      </div>
      <div class="shs-row">
        <span>Distância mín <input class="shs-input" id="shs-pl-dist-min" type="number" min="0" step="1" style="width:80px" /></span>
        <span>Distância máx <input class="shs-input" id="shs-pl-dist-max" type="number" min="1" step="1" style="width:80px" /></span>
      </div>
      <div class="shs-row">
        <span>Chegar fixa em <input id="shs-pl-chegada" type="datetime-local" /></span>
        <span>Proteção BN
          <select id="shs-pl-bn">
            <option value="desativado">Desativada</option>
            <option value="reagendar">Reagendar p/ depois da janela</option>
          </select></span>
        <label><input id="shs-pl-evitar-ms" type="checkbox" /> Evitar ms no mesmo jogador</label>
      </div>
      <div class="shs-row">
        <button class="shs-btn shs-btn-ghost" id="shs-pl-add" type="button">Adicionar grupo à operação</button>
        <button class="shs-btn" id="shs-pl-gerar" type="button">Gerar operação</button>
      </div>
      <p class="shs-muted" id="shs-pl-form-hint"></p>
      <div id="shs-pl-grupos"></div>
    </div>

    <div id="shs-pl-status" class="shs-muted"></div>
    <div id="shs-pl-resultado"></div>

    <div style="border:1px solid #b7a98d;border-radius:6px;padding:8px;margin:8px 0">
      <strong>Kit de tempo de envio</strong>
      <p class="shs-muted">Agenda "Chegada → Envio" dos comandos da operação gerada
      (bônus noturno aplicado pela engine — igual à agenda da Sala de Guerra).</p>
      <div class="shs-row">
        <span>Vila de origem
          <input class="shs-input" id="shs-pl-timing-vila" placeholder="x|y (vazio = todos os comandos)" style="width:200px" /></span>
        <span>Chegada desejada <input id="shs-pl-timing-hora" type="time" value="22:00" /></span>
        <span>Dia
          <select id="shs-pl-timing-dia">
            <option value="hoje">Hoje</option>
            <option value="amanha">Amanhã</option>
          </select></span>
        <button class="shs-btn" id="shs-pl-timing-btn" type="button">Calcular horários de envio</button>
      </div>
      <p class="shs-muted" id="shs-pl-timing-info"></p>
      <div id="shs-pl-timing-result"></div>
    </div>

    <div style="border:1px solid #b7a98d;border-radius:6px;padding:8px;margin:8px 0">
      <strong>Comunicação da OP — material de MPs</strong>
      <div class="shs-row">
        <span>Título da OP
          <input class="shs-input" id="shs-pl-op-title" placeholder="ex.: OP Cerco Noturno" style="width:220px" /></span>
      </div>
      <label class="shs-muted" for="shs-pl-mp-template">Template da MP (placeholders: #jogador#, #alvos#, #horarios#)</label>
      <textarea class="shs-input" id="shs-pl-mp-template" rows="8"></textarea>
      <div class="shs-row">
        <button class="shs-btn" id="shs-pl-mp-btn" type="button">Gerar MPs (texto)</button>
      </div>
      <textarea class="shs-input" id="shs-pl-mp-output" rows="12" readonly
        placeholder="As MPs personalizadas aparecem aqui para copiar — nada é enviado daqui (envio real é papel do módulo SG_6)."></textarea>
    </div>`;
  container.appendChild(box);

  const q = <T extends HTMLElement>(selector: string): T => {
    const element = box.querySelector<T>(selector);
    if (element === null) throw new Error(`Elemento do painel ausente: ${selector}`);
    return element;
  };

  const statusEl = q<HTMLDivElement>('#shs-pl-status');
  function setStatus(message: string, tone: 'muted' | 'ok' | 'danger' = 'muted'): void {
    statusEl.textContent = message;
    statusEl.className = tone === 'ok' ? 'shs-ok' : tone === 'danger' ? 'shs-danger' : 'shs-muted';
  }

  function persist(): void {
    gm.set(storeKey, draft);
  }

  function syncFormFromDom(): void {
    draft.form = {
      nome: q<HTMLInputElement>('#shs-pl-nome').value,
      origens: q<HTMLTextAreaElement>('#shs-pl-origens').value,
      alvos: q<HTMLTextAreaElement>('#shs-pl-alvos').value,
      porOrigem: q<HTMLInputElement>('#shs-pl-por-origem').value,
      porAlvo: q<HTMLInputElement>('#shs-pl-por-alvo').value,
      unidade: q<HTMLSelectElement>('#shs-pl-unidade').value as UnitId,
      modo: q<HTMLSelectElement>('#shs-pl-modo').value as MassAssignMode,
      distMin: q<HTMLInputElement>('#shs-pl-dist-min').value,
      distMax: q<HTMLInputElement>('#shs-pl-dist-max').value,
      chegada: q<HTMLInputElement>('#shs-pl-chegada').value,
      bn: q<HTMLSelectElement>('#shs-pl-bn').value as MassNightBonusMode,
      evitarMs: q<HTMLInputElement>('#shs-pl-evitar-ms').checked,
    };
    draft.opTitle = q<HTMLInputElement>('#shs-pl-op-title').value;
    draft.mpTemplate = q<HTMLTextAreaElement>('#shs-pl-mp-template').value;
    persist();
  }

  // ---- valores persistidos nos controles (nada de HTML interpolado) ----
  const unitSelect = q<HTMLSelectElement>('#shs-pl-unidade');
  for (const id of Object.keys(UNITS) as UnitId[]) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = UNITS[id].name;
    if (id === draft.form.unidade) option.selected = true;
    unitSelect.appendChild(option);
  }
  q<HTMLInputElement>('#shs-pl-nome').value = draft.form.nome;
  q<HTMLTextAreaElement>('#shs-pl-origens').value = draft.form.origens;
  q<HTMLTextAreaElement>('#shs-pl-alvos').value = draft.form.alvos;
  q<HTMLInputElement>('#shs-pl-por-origem').value = draft.form.porOrigem;
  q<HTMLInputElement>('#shs-pl-por-alvo').value = draft.form.porAlvo;
  q<HTMLInputElement>('#shs-pl-dist-min').value = draft.form.distMin;
  q<HTMLInputElement>('#shs-pl-dist-max').value = draft.form.distMax;
  q<HTMLInputElement>('#shs-pl-chegada').value = draft.form.chegada;
  q<HTMLSelectElement>('#shs-pl-bn').value = draft.form.bn;
  q<HTMLInputElement>('#shs-pl-evitar-ms').checked = draft.form.evitarMs;
  q<HTMLSelectElement>('#shs-pl-modo').value = draft.form.modo;
  q<HTMLInputElement>('#shs-pl-op-title').value = draft.opTitle;
  q<HTMLTextAreaElement>('#shs-pl-mp-template').value = draft.mpTemplate;
  q<HTMLParagraphElement>('#shs-pl-form-hint').textContent =
    'Gerar usa os grupos adicionados abaixo; com a lista vazia, o formulário atual entra como grupo único. ' +
    `Teto da engine: ${MASS_MAX_PAIRS.toLocaleString('pt-BR')} pares (origens × alvos) por grupo.`;

  for (const input of box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input, textarea, select',
  )) {
    input.addEventListener('change', () => syncFormFromDom());
  }

  // ---- dados do mundo ----
  const worldEl = q<HTMLSpanElement>('#shs-pl-world');
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

  q<HTMLButtonElement>('#shs-pl-world-btn').addEventListener('click', () => {
    void refreshWorld();
  });
  void refreshWorld();

  // ---- lista de grupos do rascunho ----
  const groupsEl = q<HTMLDivElement>('#shs-pl-grupos');
  function renderGroups(): void {
    groupsEl.innerHTML = '';
    if (draft.groups.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'shs-muted';
      empty.textContent = 'Nenhum grupo adicionado — ao gerar, o formulário acima entra como grupo único.';
      groupsEl.appendChild(empty);
      return;
    }
    draft.groups.forEach((group, index) => {
      const row = document.createElement('div');
      row.className = 'shs-row';
      const pill = document.createElement('span');
      pill.className = 'shs-pill';
      const originCommands = group.originQuotas.reduce((sum, value) => sum + value, 0);
      const targetCommands = group.targetQuotas.reduce((sum, value) => sum + value, 0);
      pill.textContent =
        `${group.nome}: ${group.origins.length} origens (${originCommands} comandos) × ` +
        `${group.targets.length} alvos (${targetCommands}) · ${UNITS[group.slowestUnit].name} · ` +
        `${MODE_LABELS[group.assignMode]}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'shs-btn shs-btn-ghost';
      remove.textContent = 'remover';
      remove.addEventListener('click', () => {
        draft.groups.splice(index, 1);
        persist();
        renderGroups();
      });
      row.appendChild(pill);
      row.appendChild(remove);
      groupsEl.appendChild(row);
    });
  }
  renderGroups();

  q<HTMLButtonElement>('#shs-pl-add').addEventListener('click', () => {
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

  // ---- geração da operação ----
  const gerarBtn = q<HTMLButtonElement>('#shs-pl-gerar');
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
    setStatus('Gerando… não feche a página (o cálculo é síncrono e congela a aba por alguns segundos).', 'danger');
    // Yield SÓ de pintura: a engine é síncrona (sem worker na página do jogo) —
    // este await deixa o navegador desenhar o aviso antes do congelamento.
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
    }
  }
  gerarBtn.addEventListener('click', () => {
    void generate();
  });

  // ---- resultado + exportações ----
  const resultEl = q<HTMLDivElement>('#shs-pl-resultado');

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
      version: USERSCRIPT_VERSION,
      world,
      opTitle: q<HTMLInputElement>('#shs-pl-op-title').value.trim() || 'OP',
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
    const row = document.createElement('div');
    row.className = 'shs-row';
    const button = (label: string, ghost: boolean, onClick: () => void): void => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = ghost ? 'shs-btn shs-btn-ghost' : 'shs-btn';
      element.textContent = label;
      element.addEventListener('click', onClick);
      row.appendChild(element);
    };
    button('Copiar Russian Planner', false, () => {
      void copyText(
        formatRussianPlanner(commands, world),
        'BBCode Russian Planner copiado — cole no caderno da conta premium.',
      );
    });
    button('Copiar TW Mass Planner', false, () => {
      void copyText(
        formatTwMassPlanner(commands, world),
        'BBCode TW Mass Planner copiado — cole no caderno da conta premium.',
      );
    });
    button('Copiar lista de reservas', true, () => {
      void copyText(
        reservationList(opCommsInputs(commands).distribution),
        'Alvos únicos da OP copiados — cole na Reserva em Massa do SG_6.',
      );
    });
    button('Baixar OP (JSON)', true, downloadOp);
    return row;
  }

  function renderResult(): void {
    resultEl.innerHTML = '';
    if (lastResult === null) return;
    const commands = lastResult.commands;

    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid #b7a98d;border-radius:6px;padding:8px;margin:8px 0';
    const head = document.createElement('strong');
    head.textContent = `Resultado — ${commands.length} comando(s)`;
    card.appendChild(head);

    const first = commands[0];
    const last = commands[commands.length - 1];
    if (first !== undefined && last !== undefined && commands.length > 0) {
      const span = document.createElement('p');
      span.className = 'shs-muted';
      span.textContent = `1ª chegada ${formatFullClock(first.arrivalMs)} · última chegada ${formatFullClock(last.arrivalMs)}.`;
      card.appendChild(span);
    }

    if (lastResult.warnings.length > 0) {
      const title = document.createElement('p');
      title.className = 'shs-danger';
      title.textContent = `Avisos (${lastResult.warnings.length}):`;
      card.appendChild(title);
      const list = document.createElement('ul');
      for (const warning of lastResult.warnings) {
        const item = document.createElement('li');
        item.textContent = warning;
        list.appendChild(item);
      }
      card.appendChild(list);
    }

    if (lastResult.discards.length > 0) {
      const title = document.createElement('p');
      title.className = 'shs-muted';
      title.textContent = 'Pares descartados (nunca em silêncio):';
      card.appendChild(title);
      const table = document.createElement('table');
      const theadRow = table.insertRow();
      for (const label of ['Motivo', 'Pares']) {
        const cell = document.createElement('th');
        cell.textContent = label;
        theadRow.appendChild(cell);
      }
      for (const entry of lastResult.discards) {
        const row = table.insertRow();
        const reason = row.insertCell();
        reason.textContent = entry.reason;
        const count = row.insertCell();
        count.textContent = String(entry.count);
      }
      card.appendChild(table);
    }

    if (commands.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'shs-danger';
      empty.textContent = 'Nenhum comando sobrou dos filtros — veja os descartes e avisos acima.';
      card.appendChild(empty);
      resultEl.appendChild(card);
      return;
    }

    const playersTitle = document.createElement('p');
    playersTitle.innerHTML = '<strong>Por executor</strong>';
    card.appendChild(playersTitle);
    const table = document.createElement('table');
    const headRow = table.insertRow();
    for (const label of ['Executor', 'Comandos', '1º envio', 'Último envio']) {
      const cell = document.createElement('th');
      cell.textContent = label;
      headRow.appendChild(cell);
    }
    for (const player of aggregateByPlayer(commands)) {
      const row = table.insertRow();
      const nick = row.insertCell();
      nick.textContent = player.nick;
      const count = row.insertCell();
      count.textContent = String(player.count);
      const firstSend = row.insertCell();
      firstSend.textContent = formatFullClock(player.firstSendMs);
      const lastSend = row.insertCell();
      lastSend.textContent = formatFullClock(player.lastSendMs);
    }
    card.appendChild(table);
    card.appendChild(exportRow(commands));
    resultEl.appendChild(card);
  }

  // ---- kit de tempo de envio (espelho da agenda da Sg4Page) ----
  function computeTiming(): void {
    const infoEl = q<HTMLParagraphElement>('#shs-pl-timing-info');
    const resultBox = q<HTMLDivElement>('#shs-pl-timing-result');
    resultBox.innerHTML = '';
    infoEl.textContent = '';
    if (lastResult === null || lastResult.commands.length === 0) {
      setStatus('Gere a operação antes de calcular os horários de envio.', 'danger');
      return;
    }
    if (worldData === null) {
      setStatus('Dados do mundo ainda não carregados — clique em "Atualizar dados do mundo".', 'danger');
      return;
    }
    const villageText = q<HTMLInputElement>('#shs-pl-timing-vila').value.trim();
    let village: Coord | null = null;
    if (villageText !== '') {
      village = parseCoord(villageText);
      if (village === null) {
        setStatus(`Vila de origem fora do formato x|y: "${villageText.slice(0, 30)}".`, 'danger');
        return;
      }
    }
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(q<HTMLInputElement>('#shs-pl-timing-hora').value.trim());
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
    const day = q<HTMLSelectElement>('#shs-pl-timing-dia').value;
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

      infoEl.textContent = cfg.nightBonusActive
        ? `Bônus noturno ${cfg.nightStartHour}h→${cfg.nightEndHour}h (fator ${cfg.defFactor}) aplicado no tempo de viagem.`
        : 'Mundo sem bônus noturno — viagem clássica (campos × min/campo).';

      const table = document.createElement('table');
      const headRow = table.insertRow();
      for (const label of ['Alvo', 'Origem', 'Campos', 'Chegada', 'Enviar às']) {
        const cell = document.createElement('th');
        cell.textContent = label;
        headRow.appendChild(cell);
      }
      const arrivalDay = arrival.toDateString();
      for (const row of rows) {
        const fields = fieldsByPair.get(`${row.originCoord}|${row.targetCoord}`) ?? 0;
        const tableRow = table.insertRow();
        const target = tableRow.insertCell();
        target.textContent = row.targetCoord;
        const origin = tableRow.insertCell();
        origin.textContent = row.originCoord;
        const fieldsCell = tableRow.insertCell();
        fieldsCell.textContent = String(fields);
        const arrivalCell = tableRow.insertCell();
        arrivalCell.textContent = formatHms(arrival);
        const send = tableRow.insertCell();
        send.textContent = formatSendWithDay(row.sendAt, arrivalDay);
      }
      resultBox.appendChild(table);

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
  q<HTMLButtonElement>('#shs-pl-timing-btn').addEventListener('click', () => {
    computeTiming();
  });

  // ---- material de MPs (só TEXTO — envio real é papel do SG_6) ----
  function generateMps(): void {
    syncFormFromDom();
    if (lastResult === null || lastResult.commands.length === 0) {
      setStatus('Gere a operação antes de montar as MPs.', 'danger');
      return;
    }
    const template = q<HTMLTextAreaElement>('#shs-pl-mp-template').value;
    const title = q<HTMLInputElement>('#shs-pl-op-title').value.trim() || 'OP';
    const output = q<HTMLTextAreaElement>('#shs-pl-mp-output');
    try {
      const players = buildOpComms(lastResult.commands, title, template);
      const blocks = players.map(
        (player) => `=== MP para ${player.playerName} ===\n${renderTemplate(template, player)}`,
      );
      output.value = blocks.join('\n\n');
      setStatus(`${players.length} MP(s) gerada(s) — copie o texto acima. O envio fica no módulo SG_6.`, 'ok');
    } catch (error) {
      output.value = '';
      setStatus(error instanceof Error ? error.message : String(error), 'danger');
    }
  }
  q<HTMLButtonElement>('#shs-pl-mp-btn').addEventListener('click', () => {
    generateMps();
  });
}

// Visível em TODAS as telas (matchScreen undefined) — registro no shell.
registerSection({
  id: 'planner',
  label: 'Planner de OP',
  render: renderPlanner,
});
