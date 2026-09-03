import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AlertTriangle, Bell, Check, Clock, Copy, Crosshair, Plus, Radar, Send, Share2, Swords } from 'lucide-react';
import { parseCoord, parseCoordList } from '@shared/coords';
import {
  centralOpAnalysis,
  distributeTargets,
  distributionSummary,
  originsSummary,
  parseOriginsInput,
  splitTargetsFakes,
  type CentralOpRow,
  type DistributionInput,
  type DistributionResult,
  type EnemyVillageRef,
  type OriginPlayer,
  type TargetLine,
} from '@shared/sg4-engine';
import { computeSendTimes, formatHms, formatSendSchedule, nobleTrain, type SendScheduleRow } from '@shared/sg4-timing';
import { originsFromSnapshot } from '@shared/origins-from-snapshot';
import { solveDepartureForArrival, type NightBonusCfg } from '@shared/night-bonus';
import { buildPlayerComms, planBbcode, renderTemplate, reservationList, sg6EntriesText } from '@shared/comms-package';
import type { WorldPlayer } from '@shared/types';
import Callout from '../../components/Callout';
import Field from '../../components/Field';
import PageHeader from '../../components/PageHeader';
import TemplateLibrary from '../../components/TemplateLibrary';
import WorldMapCanvas from '../sg1/WorldMapCanvas';
import { useDiplomacyRelations } from '../../hooks/useDiplomacyRelations';
import { usePreferences } from '../../hooks/usePreferences';
import { useToast } from '../../hooks/useToast';
import { MODULES } from '../../modules';
import FakesIntelligentSection from './FakesIntelligentSection';
import MoraleCurve from './MoraleCurve';
import SpyReportSection from './SpyReportSection';

const HOUR_LABELS = [
  '0–1h',
  '1–2h',
  '2–3h',
  '3–4h',
  '4–5h',
  '5–6h',
  '6–7h',
  '7–8h',
];

const LINE_NAMES = ['PRIMEIRA', 'SEGUNDA', 'TERCEIRA', 'QUARTA', 'QUINTA', 'SEXTA'];

interface OriginLine {
  fullsFrom: string;
  fullsTo: string;
  /** Faixa opcional de SEMIS do jogador (vazio = 0–200 = todas). */
  semisFrom: string;
  semisTo: string;
  coordsText: string;
}

/** Campos do SG_4 persistidos entre sessões (só ENTRADAS de formulário —
 * splitResult, planning, distribution, agenda, ações e estados de busy ficam
 * voláteis). Nome da chave = nome exato do estado correspondente. */
type Sg4Prefs = {
  enemyTagsText: string;
  centralCoordText: string;
  cutoffHours: number;
  originsText: string;
  /** Array INTEIRO das linhas de alvo (JSON puro de objetos rasos). */
  lines: OriginLine[];
  priority: 'nearest' | 'farthest';
  minMoraleText: string;
  maxFieldsText: string;
  opTimeText: string;
  /** Dia da CHEGADA da OP: "hoje" = hoje; "amanha" = base do cálculo +1 dia. */
  opDay: 'hoje' | 'amanha';
  noblesText: string;
  spacingText: string;
  /** Marcas de alerta T-minus em texto livre (ex.: "15 5 1") — parseadas
   *  com \d{1,4} e validadas no main (inteiros 1–1440, sem duplicatas). */
  tminusMarksText: string;
  opTitle: string;
  commsTemplate: string;
  planThreadUrl: string;
  sepByEnter: boolean;
};

/** Padrões de fábrica dos campos persistidos do módulo sg4. */
function buildSg4Defaults(): Sg4Prefs {
  return {
    enemyTagsText: '',
    centralCoordText: '',
    cutoffHours: 5,
    originsText: '',
    lines: [
      { fullsFrom: '', fullsTo: '', semisFrom: '', semisTo: '', coordsText: '' },
      { fullsFrom: '', fullsTo: '', semisFrom: '', semisTo: '', coordsText: '' },
    ],
    priority: 'nearest',
    minMoraleText: '0',
    maxFieldsText: '70',
    opTimeText: '22:00',
    opDay: 'hoje',
    noblesText: '1',
    spacingText: '300',
    tminusMarksText: '15 5 1',
    opTitle: `OP do ${new Date().toLocaleDateString('pt-BR')}`,
    commsTemplate:
      'OP marcada!\n\nSeus alvos:\n#alvos#\n\nEnvie cada comando para bater no horário combinado:\n#horarios#\n\nBoa sorte!',
    planThreadUrl: '',
    sepByEnter: true,
  };
}

/** Rehidrata as linhas de alvo gravadas em JSON: descarta lixo e normaliza cada
 * campo para string (o storage pode conter qualquer coisa de sessões antigas). */
function sanitizeLines(raw: unknown): OriginLine[] {
  if (!Array.isArray(raw)) return [];
  const lines: OriginLine[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    lines.push({
      fullsFrom: typeof record.fullsFrom === 'string' ? record.fullsFrom : '',
      fullsTo: typeof record.fullsTo === 'string' ? record.fullsTo : '',
      semisFrom: typeof record.semisFrom === 'string' ? record.semisFrom : '',
      semisTo: typeof record.semisTo === 'string' ? record.semisTo : '',
      coordsText: typeof record.coordsText === 'string' ? record.coordsText : '',
    });
  }
  return lines;
}

function parseTags(text: string): string[] {
  return text
    .split(';')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** Extrai as marcas T-minus (minutos antes do envio) do texto "15 5 1":
 *  cada token \d{1,4} vira um número. Faixa 1–1440 e duplicatas NÃO são
 *  validadas aqui — o main valida na fronteira do IPC e lança o erro PT-BR
 *  que a página exibe no erro/toast da agenda. */
function parseTminusMarks(text: string): number[] {
  return [...text.matchAll(/\d{1,4}/g)].map((match) => Number(match[0]));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha de comunicação com o processo principal.';
}

function mixChannel(a: number, b: number, u: number): number {
  return Math.round(a + (b - a) * u);
}

/** Cor do heatmap por proporção t ∈ [0,1]: verde → amarelo → vermelho. */
function heatColor(t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  if (clamped < 0.5) {
    const u = clamped * 2;
    return [mixChannel(67, 251, u), mixChannel(160, 192, u), mixChannel(71, 45, u)];
  }
  const u = (clamped - 0.5) * 2;
  return [mixChannel(251, 211, u), mixChannel(192, 47, u), mixChannel(45, 47, u)];
}

function heatStyle(t: number): CSSProperties {
  const [r, g, b] = heatColor(t);
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return {
    backgroundColor: `rgb(${r}, ${g}, ${b})`,
    color: luminance > 150 ? '#202020' : '#fdf6e8',
  };
}

/** Etapa do fluxo de OP exibida no stepper do topo. */
interface StepperStep {
  label: string;
  done: boolean;
  /** Concluída, mas os inputs mudaram desde então — âmbar: recalcular. */
  stale?: boolean;
  /** Resumo curto do resultado (tooltip de etapa concluída). */
  summary?: string;
  /** O que fazer nesta etapa (tooltip de etapa atual/futura). */
  action?: string;
  /** id do título da seção para rolar. */
  anchor: string;
}

/** Estado visual do chip: concluída / concluída-stale / atual / futura. */
type StepperStepState = 'done' | 'stale' | 'current' | 'future';

/** Estado de cada chip: concluídas ficam verdes (ou âmbar quando stale); a
 *  PRIMEIRA pendente é a atual (accent, "Você está aqui"); as demais, futuras. */
function stepState(step: StepperStep, isCurrent: boolean): StepperStepState {
  if (!step.done) return isCurrent ? 'current' : 'future';
  return step.stale === true ? 'stale' : 'done';
}

/** Tooltip/aria-label por estado: diz onde o usuário está e o que fazer. */
function stepTip(index: number, step: StepperStep, state: StepperStepState): string {
  const n = index + 1;
  switch (state) {
    case 'done':
      return `Etapa ${n} concluída — clique para ir. ${step.summary ?? ''}`.trim();
    case 'stale':
      return `Etapa ${n} concluída — mas os parâmetros mudaram. Recalcule antes de confiar. ${step.summary ?? ''}`.trim();
    case 'current':
      return `Você está aqui — conclua esta etapa para avançar: ${step.action ?? step.label}`.trim();
    default:
      return `Etapa ${n} pendente — ${step.action ?? step.label}`.trim();
  }
}

/** Stepper do fluxo de OP: chips próprios (.sg4-step) com círculo numerado,
 *  rótulo e conectores "→", em partes iguais na largura. Estados: is-done
 *  (verde + check no círculo), is-stale (âmbar — recalcule), is-current
 *  (primeira pendente, accent, aria-current="step") e is-future (apagada).
 *  Clique rola suavemente até a seção correspondente. */
function Sg4Stepper({ steps }: { steps: StepperStep[] }) {
  const currentIndex = steps.findIndex((step) => !step.done);
  return (
    <nav className="sg4-steps" aria-label="Etapas da criação de OP">
      {steps.map((step, index) => {
        const state = stepState(step, index === currentIndex);
        const tip = stepTip(index, step, state);
        const finished = state === 'done' || state === 'stale';
        return (
          <Fragment key={step.anchor}>
            {index > 0 && (
              <span className="sg4-step-connector" aria-hidden="true">→</span>
            )}
            <button
              type="button"
              className={`sg4-step is-${state}`}
              data-tip={tip}
              aria-label={tip}
              aria-current={state === 'current' ? 'step' : undefined}
              onClick={() => document.getElementById(step.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <span className="sg4-step-num" aria-hidden="true">
                {finished ? <Check size={13} /> : index + 1}
              </span>
              <span className="sg4-step-label">{step.label}</span>
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

/** Cabeçalho de seção colapsada (progressive disclosure): a dica em 1 linha
 *  reaproveita a redação do callout de gate da própria seção e o botão ghost
 *  libera o conteúdo completo para o usuário avançado adiantar a etapa. */
function GatedHint({ hint, onReveal }: { hint: string; onReveal: () => void }) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <span className="muted">{hint}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onReveal}>
        Mostrar mesmo assim
      </button>
    </div>
  );
}

/** Props do SG_4: a ponte de navegação é OPCIONAL — o App injeta depois
 *  (P1 hand-off). Tipos frouxos de propósito: 'sg6' e 'guerra' hoje, PageId
 *  real quando o App ligar o fio. Sem prop, os botões de atalho não renderizam. */
export interface Sg4PageProps {
  onNavigate?: (page: string) => void;
}

/** SG_4 — Criação de Operações (screen=ally&mode=contracts, grupo OP). */
export default function Sg4Page({ onNavigate }: Sg4PageProps = {}) {
  const { push } = useToast();
  const moduleInfo = MODULES.find((module) => module.id === 'sg4');
  // Preferências do módulo: os campos de entrada sobrevivem a F5/reinício.
  const [sg4Defaults] = useState(buildSg4Defaults);
  const { prefs, savePrefs, resetPrefs } = usePreferences('sg4', sg4Defaults);

  // ---- Seção A — OP com coordenada central ----
  // Diplomacia: carrega no boot, refaz quando a sessão entra em logged-in e
  // expõe retry manual — ver useDiplomacyRelations.
  const { relations, relationsFailed, relationsBusy, retryRelations } = useDiplomacyRelations();
  const [enemyTagsText, setEnemyTagsText] = useState(sg4Defaults.enemyTagsText);
  const [centralCoordText, setCentralCoordText] = useState(sg4Defaults.centralCoordText);
  const [errorsA, setErrorsA] = useState<{ tags?: string; central?: string }>({});
  const [runErrorA, setRunErrorA] = useState('');
  const [loadingVillages, setLoadingVillages] = useState(false);
  const [opRows, setOpRows] = useState<CentralOpRow[] | null>(null);
  const [enemyVillages, setEnemyVillages] = useState<EnemyVillageRef[]>([]);
  const [nobleMinutes, setNobleMinutes] = useState(0);
  const [actions, setActions] = useState<Map<number, 'alvo' | 'fake'>>(new Map());
  /** Snapshot dos inputs da Seção A no momento do último carregamento bem-
   *  sucedido — base da invalidação em cascata (analysisStale). */
  const [analysisInputs, setAnalysisInputs] = useState<{ tags: string; central: string } | null>(null);
  const [cutoffHours, setCutoffHours] = useState(sg4Defaults.cutoffHours);
  const [splitResult, setSplitResult] = useState<{ targets: string[]; fakes: string[] } | null>(null);
  const [sepByEnter, setSepByEnter] = useState(sg4Defaults.sepByEnter);

  // Caches de dump para a seção B (moral da distribuição).
  const [playersCache, setPlayersCache] = useState<WorldPlayer[] | null>(null);

  // Moral do mundo: false = clássico SEM moral por pontos — o campo "Moral
  // aceita" desabilita e a distribuição roda com moral 0.
  const [moraleActive, setMoraleActive] = useState(true);

  // ---- Seção B — Distribuição de Alvos de OP ----
  const [originsText, setOriginsText] = useState(sg4Defaults.originsText);
  const [lines, setLines] = useState<OriginLine[]>(sg4Defaults.lines);
  const [priority, setPriority] = useState<'nearest' | 'farthest'>(sg4Defaults.priority);
  const [minMoraleText, setMinMoraleText] = useState(sg4Defaults.minMoraleText);
  const [maxFieldsText, setMaxFieldsText] = useState(sg4Defaults.maxFieldsText);
  const [errorsB, setErrorsB] = useState<{ origins?: string }>({});
  const [runErrorB, setRunErrorB] = useState('');
  const [busyB, setBusyB] = useState(false);
  const [planning, setPlanning] = useState<DistributionResult | null>(null);
  const [distribution, setDistribution] = useState<DistributionResult | null>(null);
  /** Snapshot dos inputs da Seção B na última DISTRIBUIÇÃO REALIZADA — base da
   *  invalidação em cascata (distributionStale). */
  const [distributionInputs, setDistributionInputs] = useState<{
    originsText: string;
    lines: OriginLine[];
    priority: 'nearest' | 'farthest';
    minMoraleText: string;
    maxFieldsText: string;
  } | null>(null);

  // ---- Seção C — Agenda de envio (timing da OP: P0-1/P0-2/P0-6) ----
  const [opTimeText, setOpTimeText] = useState(sg4Defaults.opTimeText);
  const [opDay, setOpDay] = useState<'hoje' | 'amanha'>(sg4Defaults.opDay);
  const [noblesText, setNoblesText] = useState(sg4Defaults.noblesText);
  const [spacingText, setSpacingText] = useState(sg4Defaults.spacingText);
  const [tminusMarksText, setTminusMarksText] = useState(sg4Defaults.tminusMarksText);
  const [scheduleRows, setScheduleRows] = useState<SendScheduleRow[] | null>(null);
  /** Snapshot dos inputs da agenda no último cálculo — base do scheduleStale. */
  const [scheduleInputs, setScheduleInputs] = useState<{ opTime: string; nobles: string; spacing: string; day: string } | null>(
    null,
  );
  const [timingError, setTimingError] = useState('');
  // ---- P0-9 — Arquivo de OPs ----
  const [opTitle, setOpTitle] = useState(sg4Defaults.opTitle);
  const [archiving, setArchiving] = useState(false);
  // ---- P0-8 — Pacote de comunicação ----
  const [commsTemplate, setCommsTemplate] = useState(sg4Defaults.commsTemplate);
  const [planThreadUrl, setPlanThreadUrl] = useState(sg4Defaults.planThreadUrl);
  const [planPending, setPlanPending] = useState(false);
  const [planPosting, setPlanPosting] = useState(false);
  const [planResult, setPlanResult] = useState<string | null>(null);
  // ---- Progressive disclosure (3-J): cada seção downstream tem um "revelar"
  //  manual — default COLAPSADA enquanto o pré-requisito falta; com o
  //  pré-requisito satisfeito o flag é ignorado e a seção renderiza como
  //  sempre. Nada de lógica nova: só apresenta o que já estava lá.
  const [distRevealed, setDistRevealed] = useState(false);
  const [agendaRevealed, setAgendaRevealed] = useState(false);
  const [commsRevealed, setCommsRevealed] = useState(false);

  // ---- Invalidação em cascata (stale): deriva dos snapshots dos inputs.
  //  Banners avisam (não destrutivo) — resultados continuam na tela, mas os
  //  botões que congelam estado (arquivar/postar/alertas) travam até recalcular.
  const analysisStale =
    opRows !== null &&
    (analysisInputs === null ||
      analysisInputs.tags !== enemyTagsText ||
      analysisInputs.central !== centralCoordText);

  const distributionStale =
    distribution !== null &&
    distributionInputs !== null &&
    (distributionInputs.originsText !== originsText ||
      distributionInputs.priority !== priority ||
      distributionInputs.minMoraleText !== minMoraleText ||
      distributionInputs.maxFieldsText !== maxFieldsText ||
      JSON.stringify(distributionInputs.lines) !== JSON.stringify(lines));

  const scheduleStale =
    scheduleRows !== null &&
    scheduleInputs !== null &&
    (scheduleInputs.opTime !== opTimeText ||
      scheduleInputs.nobles !== noblesText ||
      scheduleInputs.spacing !== spacingText ||
      scheduleInputs.day !== opDay);

  // Hidratação das preferências (uma única vez, após prefs chegar do main):
  // aplica só as chaves presentes e válidas, para não pisar em estado que o
  // usuário já editou e não reabrir o formulário com lixo de storage antigo.
  const prefsHydrated = useRef(false);
  useEffect(() => {
    if (prefs === null || prefsHydrated.current) return;
    prefsHydrated.current = true;
    if (typeof prefs.enemyTagsText === 'string') setEnemyTagsText(prefs.enemyTagsText);
    if (typeof prefs.centralCoordText === 'string') setCentralCoordText(prefs.centralCoordText);
    if (Number.isInteger(prefs.cutoffHours) && prefs.cutoffHours >= 1 && prefs.cutoffHours <= 5) {
      setCutoffHours(prefs.cutoffHours);
    }
    if (typeof prefs.originsText === 'string') setOriginsText(prefs.originsText);
    const restoredLines = sanitizeLines(prefs.lines);
    if (restoredLines.length > 0) setLines(restoredLines);
    if (prefs.priority === 'nearest' || prefs.priority === 'farthest') setPriority(prefs.priority);
    if (typeof prefs.minMoraleText === 'string') setMinMoraleText(prefs.minMoraleText);
    if (typeof prefs.maxFieldsText === 'string') setMaxFieldsText(prefs.maxFieldsText);
    if (typeof prefs.opTimeText === 'string') setOpTimeText(prefs.opTimeText);
    if (prefs.opDay === 'hoje' || prefs.opDay === 'amanha') setOpDay(prefs.opDay);
    if (typeof prefs.noblesText === 'string') setNoblesText(prefs.noblesText);
    if (typeof prefs.spacingText === 'string') setSpacingText(prefs.spacingText);
    if (typeof prefs.tminusMarksText === 'string' && prefs.tminusMarksText.trim() !== '') {
      setTminusMarksText(prefs.tminusMarksText);
    }
    if (typeof prefs.opTitle === 'string' && prefs.opTitle.trim() !== '') setOpTitle(prefs.opTitle);
    if (typeof prefs.commsTemplate === 'string' && prefs.commsTemplate !== '') setCommsTemplate(prefs.commsTemplate);
    if (typeof prefs.planThreadUrl === 'string') setPlanThreadUrl(prefs.planThreadUrl);
    if (typeof prefs.sepByEnter === 'boolean') setSepByEnter(prefs.sepByEnter);
  }, [prefs]);

  // Persistência com guard: só grava DEPOIS da hidratação — nunca sobrescreve o
  // storage com os defaults do primeiro render. savePrefs é debounced.
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({
      enemyTagsText,
      centralCoordText,
      cutoffHours,
      originsText,
      lines,
      priority,
      minMoraleText,
      maxFieldsText,
      opTimeText,
      opDay,
      noblesText,
      spacingText,
      tminusMarksText,
      opTitle,
      commsTemplate,
      planThreadUrl,
      sepByEnter,
    });
  }, [
    enemyTagsText,
    centralCoordText,
    cutoffHours,
    originsText,
    lines,
    priority,
    minMoraleText,
    maxFieldsText,
    opTimeText,
    opDay,
    noblesText,
    spacingText,
    tminusMarksText,
    opTitle,
    commsTemplate,
    planThreadUrl,
    sepByEnter,
    savePrefs,
  ]);

  // Template PADRÃO da biblioteca como ponto de partida da MP da OP: aplica
  // UMA vez no mount, somente quando as prefs não têm commsTemplate salvo
  // (prefs existentes vencem — "não salvo" = prefs ainda no texto de fábrica
  // embutido do buildSg4Defaults). Fail-soft: sem biblioteca/isDefault,
  // mantém o texto atual.
  const commsDefaultApplied = useRef(false);
  useEffect(() => {
    if (prefs === null || commsDefaultApplied.current) return;
    commsDefaultApplied.current = true;
    if (prefs.commsTemplate !== sg4Defaults.commsTemplate) return;
    let cancelled = false;
    void window.staffhub.templates
      .list()
      .then((templates) => {
        if (cancelled) return;
        const defaultTemplate = templates.find((entry) => entry.isDefault);
        if (defaultTemplate !== undefined) setCommsTemplate(defaultTemplate.body);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [prefs]);

  // Fail-soft: mundo sem resposta conta COM moral (comportamento atual).
  useEffect(() => {
    let cancelled = false;
    void window.staffhub.world
      .moraleInfo()
      .then((info) => {
        if (!cancelled) setMoraleActive(info.active);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function ensureWorldData(): Promise<void> {
    const status = await window.staffhub.world.status();
    if (status.villageCount === 0) {
      push('info', 'Baixando dados do mundo…');
      await window.staffhub.world.refresh();
    }
  }

  // -----------------------------------------------------------------------
  // Seção A
  // -----------------------------------------------------------------------

  function useEnemyTagsFromDiplomacy(): void {
    if (relations === null) {
      push(
        'error',
        relationsFailed
          ? 'Diplomacia indisponível — clique em "Tentar de novo" no aviso de atenção.'
          : 'Diplomacia ainda carregando — tente de novo em instantes.',
      );
      return;
    }
    setEnemyTagsText(relations.enemies.map((enemy) => enemy.tag).join(';'));
    push('ok', `Inimigas da diplomacia preenchidas: ${relations.enemies.length} tribo(s).`);
  }

  async function runLoadEnemies(): Promise<void> {
    const tags = parseTags(enemyTagsText);
    const central = parseCoord(centralCoordText);
    const nextErrors: { tags?: string; central?: string } = {};
    if (tags.length === 0) nextErrors.tags = 'Informe ao menos uma tag inimiga — confira a grafia (ex.: DARK).';
    if (central === null)
      nextErrors.central =
        'A coordenada central ficou inválida — confira o formato 123|456 e clique em "Carregar aldeias inimigas" de novo.';
    if (tags.length === 0 || central === null) {
      setErrorsA(nextErrors);
      const message = nextErrors.central ?? nextErrors.tags ?? 'Confira os campos da OP.';
      push('error', message);
      return;
    }
    setErrorsA({});
    setRunErrorA('');
    setLoadingVillages(true);
    setOpRows(null);
    setSplitResult(null);
    try {
      await ensureWorldData();
      const [villages, players, tribes, noble] = await Promise.all([
        window.staffhub.world.villages(),
        window.staffhub.world.players(),
        window.staffhub.world.tribes(),
        window.staffhub.world.nobleMinutes(),
      ]);
      const tagSet = new Set(tags.map((tag) => tag.toLowerCase()));
      const allyIds = new Set<number>();
      for (const ally of tribes) {
        if (tagSet.has(ally.tag.toLowerCase())) allyIds.add(ally.id);
      }
      if (allyIds.size === 0) {
        const message = 'Nenhuma tribo encontrada com as tags informadas — confira a grafia (ex.: DARK).';
        setRunErrorA(message);
        push('error', message);
        return;
      }
      const playersById = new Map(players.map((player) => [player.id, player]));
      const enemies: EnemyVillageRef[] = [];
      for (const village of villages) {
        if (village.playerId === 0) continue;
        if (!allyIds.has(village.allyId)) continue;
        const player = playersById.get(village.playerId);
        enemies.push({
          playerId: village.playerId,
          playerName: player?.name ?? `Jogador ${village.playerId}`,
          coord: { x: village.x, y: village.y },
          points: village.points,
        });
      }
      if (enemies.length === 0) {
        const message = 'Nenhuma aldeia inimiga carregada para as tags informadas.';
        setRunErrorA(message);
        push('error', message);
        return;
      }
      const analysis = centralOpAnalysis(enemies, central, noble);
      setEnemyVillages(enemies);
      setNobleMinutes(noble);
      setPlayersCache(players);
      setOpRows(analysis.rows);
      // Reconstrói as marcações PRESERVANDO escolhas manuais: jogador que já
      // tinha ação marcada (alvo/fake) mantém a anterior — recarregar os dados
      // não pode resetar tudo para 'fake' e silenciosamente mudar a OP.
      const initialActions = new Map<number, 'alvo' | 'fake'>();
      for (const row of analysis.rows) {
        const previous = actions.get(row.playerId);
        initialActions.set(row.playerId, previous ?? row.action);
      }
      setActions(initialActions);
      // Sucesso = snapshot novo dos inputs: derruba o banner de análise stale.
      setAnalysisInputs({ tags: enemyTagsText, central: centralCoordText });
      push('ok', `${enemies.length} aldeia(s) inimiga(s) — ${analysis.rows.length} jogador(es).`);
    } catch (error) {
      const message = errorMessage(error);
      setRunErrorA(message);
      push('error', message);
    } finally {
      setLoadingVillages(false);
    }
  }

  function updateAction(playerId: number, action: 'alvo' | 'fake'): void {
    setActions((current) => {
      const next = new Map(current);
      next.set(playerId, action);
      return next;
    });
    setSplitResult(null);
  }

  function markAllFake(): void {
    if (opRows === null) return;
    const allFake = new Map<number, 'alvo' | 'fake'>();
    for (const row of opRows) allFake.set(row.playerId, 'fake');
    setActions(allFake);
    setSplitResult(null);
  }

  function runSplit(): void {
    const central = parseCoord(centralCoordText);
    if (opRows === null || enemyVillages.length === 0 || central === null || nobleMinutes <= 0) {
      const message = "Clique em 'Carregar aldeias inimigas' antes de separar alvos e fakes.";
      setRunErrorA(message);
      push('error', message);
      return;
    }
    const result = splitTargetsFakes(enemyVillages, central, nobleMinutes, actions, cutoffHours);
    setSplitResult(result);
    push('ok', `Alvos: ${result.targets.length} · Fakes: ${result.fakes.length}.`);
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      push('ok', 'Copiado para a área de transferência.');
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  /** P1-16: aplica as linhas "x|y" vindas dos fakes inteligentes na caixa
   *  ALDEIAS FAKES (substitui o resultado do split preservando os alvos).
   *  Guard ANTES do set (sem flag de updater): caixa sumiu = erro honesto. */
  function applyIntelligentFakes(fakeLines: string[]): void {
    if (splitResult === null) {
      push('error', 'As caixas de alvos/fakes foram limpas — gere o split de novo antes de aplicar fakes inteligentes.');
      return;
    }
    setSplitResult({ ...splitResult, fakes: fakeLines });
    push('ok', 'Fakes inteligentes aplicados na caixa.');
  }

  /** Ponte A→B: cola os alvos gerados na Seção A na PRIMEIRA linha de alvos da
   *  Distribuição (etapa 2). Pede confirmação se a linha já tem coordenadas. */
  function bridgeTargetsToDistribution(): void {
    if (splitResult === null || splitResult.targets.length === 0) return;
    const firstLine = lines[0];
    if (firstLine !== undefined && firstLine.coordsText.trim() !== '') {
      const replace = window.confirm(
        `Substituir as coordenadas de destino da PRIMEIRA linha (faixa atual) pelos ${splitResult.targets.length} alvos gerados?`,
      );
      if (!replace) return;
    }
    updateLine(0, 'coordsText', splitResult.targets.join(separator));
    push('ok', 'Alvos colados na primeira linha da Distribuição (etapa 2 abaixo).');
    document.getElementById('sg4-dist-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Restaura os campos persistidos do módulo para os padrões de fábrica.
   *  MUTAÇÃO ampla: pede confirmação e derruba TAMBÉM os resultados órfãos
   *  (alvos, planificação, distribuição, agenda) dos inputs restaurados. */
  function restoreDefaults(): void {
    const confirmed = window.confirm(
      'Restaurar padrões? TODOS os campos salvos deste módulo voltam ao padrão e os resultados na tela somem. Esta ação não pode ser desfeita.',
    );
    if (!confirmed) return;
    setEnemyTagsText(sg4Defaults.enemyTagsText);
    setCentralCoordText(sg4Defaults.centralCoordText);
    setCutoffHours(sg4Defaults.cutoffHours);
    setOriginsText(sg4Defaults.originsText);
    setLines(sg4Defaults.lines.map((line) => ({ ...line })));
    setPriority(sg4Defaults.priority);
    setMinMoraleText(sg4Defaults.minMoraleText);
    setMaxFieldsText(sg4Defaults.maxFieldsText);
    setOpTimeText(sg4Defaults.opTimeText);
    setOpDay(sg4Defaults.opDay);
    setNoblesText(sg4Defaults.noblesText);
    setSpacingText(sg4Defaults.spacingText);
    setTminusMarksText(sg4Defaults.tminusMarksText);
    setOpTitle(sg4Defaults.opTitle);
    setCommsTemplate(sg4Defaults.commsTemplate);
    setPlanThreadUrl(sg4Defaults.planThreadUrl);
    setSepByEnter(sg4Defaults.sepByEnter);
    // Resultados órfãos dos inputs restaurados + snapshots de invalidação.
    setOpRows(null);
    setSplitResult(null);
    setActions(new Map());
    setPlanning(null);
    setDistribution(null);
    setDistributionInputs(null);
    setScheduleRows(null);
    setScheduleInputs(null);
    setAnalysisInputs(null);
    setRunErrorA('');
    setRunErrorB('');
    setTimingError('');
    void resetPrefs();
  }

  /** Estável entre renders: o DistributionMap refaz o fetch do mapa se o
   * callback mudar a cada render do pai (toasts/progresso). */
  const handleMapError = useCallback((message: string): void => {
    push('error', message);
  }, [push]);

  /** P0-7: origens "nick;fulls;coords" direto do snapshot de tropas do SG_2. */
  async function fillOriginsFromSnapshot(): Promise<void> {
    try {
      const snapshot = await window.staffhub.troops.get('troops');
      if (snapshot === null) {
        push('error', 'Nenhum snapshot de tropas — rode a coleta no SG2 antes de preencher.');
        return;
      }
      const text = originsFromSnapshot(snapshot);
      if (text === '') {
        push('error', 'Snapshot sem aldeias com nobre (snob) — nada para preencher.');
        return;
      }
      setOriginsText(text);
      const playerCount = text.split('\n').filter((line) => line.trim() !== '').length;
      push('ok', `Origens preenchidas do SG2: ${playerCount} jogador(es) com aldeia full.`);
    } catch (error) {
      push('error', errorMessage(error));
    }
  }

  /** P0-8: jogadores com alvos+horários prontos para o pacote de comunicação
   * (MPs com #horarios#, BBCode do plano e lista de reservas). */
  /** Prévia das origens coladas: valida o formato na hora e mostra fulls/semis
   *  por jogador ANTES de distribuir (erro aparece aqui, não só no submit). */
  const originsPreview = useMemo<{ players: OriginPlayer[]; summary: ReturnType<typeof originsSummary> } | null>(() => {
    if (originsText.trim() === '') return null;
    try {
      const players = parseOriginsInput(originsText);
      return { players, summary: originsSummary(players) };
    } catch {
      return null; // erro completo só ao distribuir (a Field de origem mostra)
    }
  }, [originsText]);

  /** Coordenadas de origem SEMI segundo a ÚLTIMA DISTRIBUIÇÃO REALIZADA (a
   *  agenda é calculada sobre ela — marcar pelo texto vivo poderia mentir se
   *  o usuário editasse as origens depois de distribuir). */
  const semiOriginCoords = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    if (distribution === null) return set;
    for (const row of distribution.matrix) {
      if (row.tier === 'semi') set.add(row.origin);
    }
    return set;
  }, [distribution]);

  /** Ponte com os fakes inteligentes: coords de origem JÁ USADAS na distribuição
   *  (um par fechado por origem usada) — derivadas dos assignments. */
  const fakesUsedOriginCoords = useMemo<string[]>(() => {
    if (distribution === null) return [];
    return [...new Set(distribution.assignments.map((assignment) => assignment.origin))];
  }, [distribution]);

  /** Origens para os fakes inteligentes no modo pós-distribuição: a MESMA caixa
   *  "Origens da tribo" com as coordenadas usadas removidas linha a linha (o
   *  formato restante nick;fulls[;semis];coords é preservado). */
  const fakesOriginsText = useMemo<string>(() => {
    if (distribution === null) return originsText;
    const used = new Set(distribution.assignments.map((assignment) => assignment.origin));
    const remainingLines: string[] = [];
    for (const line of originsText.split('\n')) {
      if (line.trim() === '') continue;
      const sepIndex = line.lastIndexOf(';');
      if (sepIndex === -1) {
        remainingLines.push(line);
        continue;
      }
      const head = line.slice(0, sepIndex);
      const remaining = line
        .slice(sepIndex + 1)
        .split(/\s+/)
        .map((coord) => coord.trim())
        .filter((coord) => coord !== '' && !used.has(coord));
      if (remaining.length === 0) continue;
      remainingLines.push(`${head};${remaining.join(' ')}`);
    }
    return remainingLines.join('\n');
  }, [distribution, originsText]);

  const commsPlayers = useMemo(() => {
    if (distribution === null || scheduleRows === null || scheduleRows.length === 0) return null;
    try {
      return buildPlayerComms({
        opTitle,
        template: commsTemplate,
        distribution: distributionSummary(distribution),
        sendSchedule: formatSendSchedule(scheduleRows),
      });
    } catch {
      return null;
    }
  }, [distribution, scheduleRows, opTitle, commsTemplate]);

  /** Memoizado: recalcular distributionSummary a cada render é desperdício. */
  const distributionSummaryText = useMemo(
    () => (distribution === null ? '' : distributionSummary(distribution)),
    [distribution],
  );

  const commsDistributionText = useMemo(
    () => (distribution === null ? '' : distributionSummary(distribution)),
    [distribution],
  );

  /** Prévia da MP do 1º jogador — erro NÃO silencioso: devolve {preview,error}
   *  e a falha de template aparece em callout vermelho na tela. */
  function commsPreview(): { preview: string | null; error: string } {
    if (commsPlayers === null || commsPlayers.length === 0) return { preview: null, error: '' };
    try {
      return {
        preview: renderTemplate(commsTemplate, commsPlayers[0] ?? { playerName: '?', coords: [], horarios: [] }),
        error: '',
      };
    } catch (error) {
      return {
        preview: null,
        error: error instanceof Error ? error.message : 'Template da MP inválido — revise #alvos# e #horarios#.',
      };
    }
  }

  /**
   * P0-8 (fecho): posta o plano BBCode no fórum — substitui o 1º post do
   * tópico informado. MUTAÇÃO com confirmação dupla (aqui) + dialog nativo
   * (main) + verificação real pós-envio + journal.
   */
  async function runPostPlan(): Promise<void> {
    if (distribution === null) return;
    setPlanPosting(true);
    try {
      const bbcode = planBbcode({
        opTitle,
        template: commsTemplate,
        distribution: commsDistributionText,
        sendSchedule: scheduleRows !== null && scheduleRows.length > 0 ? formatSendSchedule(scheduleRows) : '',
      });
      const result = await window.staffhub.sg7.postPlan({ threadUrl: planThreadUrl.trim(), bbcode }, true);
      setPlanResult(result.detail);
      push(result.ok ? 'ok' : 'error', result.detail);
    } catch (error) {
      const message = errorMessage(error);
      setPlanResult(message);
      push('error', message);
    } finally {
      setPlanPosting(false);
      setPlanPending(false);
    }
  }

  /** P0-9: arquiva a OP atual (alvos + distribuição + agenda) no arquivo de OPs. */
  async function archiveOp(): Promise<void> {
    if (distribution === null || distribution.assignments.length === 0) return;
    setArchiving(true);
    try {
      const targets = [...new Set(distribution.assignments.map((assignment) => assignment.target))];
      const entry = await window.staffhub.opArchive.save({
        title: opTitle.trim() === '' ? `OP do ${new Date().toLocaleDateString('pt-BR')}` : opTitle.trim(),
        targets,
        distribution: distributionSummary(distribution),
        ...(scheduleRows !== null && scheduleRows.length > 0 ? { sendSchedule: formatSendSchedule(scheduleRows) } : {}),
      });
      push('ok', `OP "${entry.title}" arquivada (${targets.length} alvos) — acompanhe na Sala de Guerra.`);
    } catch (error) {
      push('error', errorMessage(error));
    } finally {
      setArchiving(false);
    }
  }

  // -----------------------------------------------------------------------
  // Seção B
  // -----------------------------------------------------------------------

  function updateLine(index: number, key: keyof OriginLine, value: string): void {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, [key]: value } : line)));
  }

  function removeLine(index: number): void {
    setLines((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current));
  }

  function addLine(): void {
    setLines((current) => [...current, { fullsFrom: '', fullsTo: '', semisFrom: '', semisTo: '', coordsText: '' }]);
  }

  async function runDistribution(planOnly: boolean): Promise<void> {
    if (busyB) return;
    const nextErrors: { origins?: string } = {};
    const messages: string[] = [];

    let origins: ReturnType<typeof parseOriginsInput> | null = null;
    try {
      // Se a prévia já parseou com sucesso, reusa (não re-parsear a cada consulta).
      origins = originsPreview?.players ?? parseOriginsInput(originsText);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Linhas de origem inválidas.';
      nextErrors.origins = message;
      messages.push(message);
    }

    const builtLines: TargetLine[] = [];
    for (const [index, line] of lines.entries()) {
      const targets = parseCoordList(line.coordsText);
      if (targets.length === 0) continue;
      const lineName = (LINE_NAMES[index] ?? `${index + 1}ª linha`).toLowerCase();
      const from = line.fullsFrom.trim() === '' ? 0 : Number(line.fullsFrom);
      const to = line.fullsTo.trim() === '' ? 200 : Number(line.fullsTo);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 200 || from > to) {
        messages.push(`Confira a faixa FULLS DE/ATÉ (0–200) da ${lineName} de alvos.`);
        break;
      }
      // Faixa opcional de semis do jogador (vazio = 0–200 = todas).
      const semiRange: { semisFrom?: number; semisTo?: number } = {};
      if (line.semisFrom.trim() !== '' || line.semisTo.trim() !== '') {
        const sFrom = line.semisFrom.trim() === '' ? 0 : Number(line.semisFrom);
        const sTo = line.semisTo.trim() === '' ? 200 : Number(line.semisTo);
        if (!Number.isInteger(sFrom) || !Number.isInteger(sTo) || sFrom < 0 || sTo > 200 || sFrom > sTo) {
          messages.push(`Confira a faixa SEMIS DE/ATÉ (0–200) da ${lineName} — vazia significa todas.`);
          break;
        }
        semiRange.semisFrom = sFrom;
        semiRange.semisTo = sTo;
      }
      builtLines.push({ fullsFrom: from, fullsTo: to, ...semiRange, targets });
    }
    if (builtLines.length === 0) {
      messages.push('Informe ao menos 1 coordenada de alvo nas linhas (123|456 456|123 …).');
    }

    // Moral mínima: validação explícita 0–100 (vazio = 0 = filtro desligado) —
    // SEM clamp silencioso: valor fora da faixa é erro, não ajuste escondido.
    const minMoraleRaw = minMoraleText.trim() === '' ? 0 : Number(minMoraleText);
    const maxFields = Number(maxFieldsText);
    if (!Number.isFinite(minMoraleRaw) || minMoraleRaw < 0 || minMoraleRaw > 100) {
      messages.push('Moral mínima deve ser um número entre 0 e 100 — 0 desliga o filtro.');
    }
    if (!Number.isFinite(maxFields) || maxFields <= 0) {
      messages.push('Distância máxima deve ser um número de campos maior que 0.');
    }

    if (origins === null || messages.length > 0) {
      setErrorsB(nextErrors);
      setRunErrorB(nextErrors.origins === undefined ? (messages[0] ?? '') : '');
      push('error', messages[0] ?? 'Confira os parâmetros da distribuição.');
      return;
    }
    setErrorsB({});
    setRunErrorB('');
    setBusyB(true);
    try {
      await ensureWorldData();
      const players = playersCache ?? (await window.staffhub.world.players());
      if (playersCache === null) setPlayersCache(players);
      const noble = nobleMinutes > 0 ? nobleMinutes : await window.staffhub.world.nobleMinutes();
      if (nobleMinutes === 0) setNobleMinutes(noble);

      const originPoints = new Map(players.map((player) => [player.name, player.points]));
      const playerPointsById = new Map(players.map((player) => [player.id, player.points]));
      const targetPoints = new Map<string, number>();
      for (const enemy of enemyVillages) {
        if (enemy.points !== undefined) targetPoints.set(`${enemy.coord.x}|${enemy.coord.y}`, playerPointsById.get(enemy.playerId) ?? enemy.points ?? 0);
      }
      // Mundo clássico (sem moral por pontos): nunca envia minMorale > 0,
      // mesmo que o campo tenha guardado um valor antes de desabilitar.
      // Fora de 0–100 NÃO chega aqui — a validação acima já barrou com erro.
      const minMorale = moraleActive ? Math.round(minMoraleRaw) : 0;
      const input: DistributionInput = {
        origins,
        lines: builtLines,
        nobleMinutesPerField: noble,
        priority,
        minMorale,
        maxFields,
        ...(originPoints.size > 0 ? { originPoints } : {}),
        ...(targetPoints.size > 0 ? { targetPoints } : {}),
      };
      const result = distributeTargets(input);
      if (planOnly) {
        // Simular é SIMULAÇÃO: derruba distribuição e agenda antigas —
        // não pode ficar agenda armada de uma distribuição anterior.
        setPlanning(result);
        setDistribution(null);
        setDistributionInputs(null);
        setScheduleRows(null);
        setScheduleInputs(null);
        setTimingError('');
        push('ok', `Simulação: ${result.matrix.length} origem(ns) × ${result.lineTargets.length} alvo(s).`);
      } else {
        setDistribution(result);
        // Snapshot dos inputs usados — base do banner "parâmetros mudaram".
        setDistributionInputs({ originsText, lines, priority, minMoraleText, maxFieldsText });
        // Distribuição nova = agenda antiga órfã (lookup de campos mudou).
        setScheduleRows(null);
        setScheduleInputs(null);
        setTimingError('');
        push(
          'ok',
          `Distribuição: ${result.assignments.length} atacante(s) alocado(s) — ${result.orphanOrigins.length} origem(ns) e ${result.orphanTargets.length} alvo(s) órfãos.`,
        );
      }
    } catch (error) {
      const message = errorMessage(error);
      setRunErrorB(message);
      push('error', message);
    } finally {
      setBusyB(false);
    }
  }

  const heatRange = useMemo(() => {
    if (planning === null) return { min: 0, max: 1 };
    const hours = planning.matrix.flatMap((row) => row.cells.map((cell) => cell.hours));
    if (hours.length === 0) return { min: 0, max: 1 };
    return { min: Math.min(...hours), max: Math.max(...hours) };
  }, [planning]);

  /** "Distância máxima" em número, para APAGAR células além do limite no
   *  heatmap (aviso visual — o filtro de verdade vale na distribuição). */
  const maxFieldsLimit = useMemo<number | null>(() => {
    const parsed = Number(maxFieldsText);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [maxFieldsText]);

  /**
   * P0-1/P0-2/P0-6: agenda de envio = chegada desejada − tempo de viagem
   * (com bônus noturno aplicado por par, quando ativo no mundo) + trem de
   * nobres (N envios por alvo espaçados em segundos).
   */
  async function runSendSchedule(): Promise<void> {
    setTimingError('');
    setScheduleRows(null);
    if (distribution === null || distribution.assignments.length === 0) {
      setTimingError('Realize a distribuição antes de calcular os horários de envio.');
      return;
    }
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(opTimeText.trim());
    if (timeMatch === null) {
      setTimingError('Horário inválido — use HH:MM (ex.: 22:00).');
      return;
    }
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const noblesPerTarget = Number(noblesText);
    const spacingSec = Number(spacingText);
    if (!Number.isInteger(noblesPerTarget) || noblesPerTarget < 1) {
      setTimingError('Nobres por alvo deve ser um número inteiro maior ou igual a 1.');
      return;
    }
    if (!Number.isFinite(spacingSec) || spacingSec < 0) {
      setTimingError('Espaçamento entre nobres deve ser um número de segundos maior ou igual a 0.');
      return;
    }
    try {
      const noble = nobleMinutes > 0 ? nobleMinutes : await window.staffhub.world.nobleMinutes();
      if (nobleMinutes === 0) setNobleMinutes(noble);
      let nightCfg: NightBonusCfg | null = null;
      try {
        const night = await window.staffhub.world.nightBonus();
        nightCfg = { nightBonusActive: night.active, nightStartHour: night.startHour, nightEndHour: night.endHour };
      } catch {
        nightCfg = null; // sem config do mundo: viagem clássica, sem bônus
      }

      // Campos por par origem×alvo direto da planilha da distribuição.
      const fieldsByPair = new Map<string, number>();
      distribution.matrix.forEach((row) => {
        distribution.lineTargets.forEach((target, index) => {
          fieldsByPair.set(`${row.origin}|${target.x}|${target.y}`, row.cells[index]?.fields ?? 0);
        });
      });

      // Base = hoje; "Amanhã" adianta a data ANTES de fixar as horas — a OP
      // chega no dia selecionado, não importa a hora atual do relógio.
      const base = new Date();
      if (opDay === 'amanha') base.setDate(base.getDate() + 1);
      const arrival = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
      const travelMinutesPerPair = (originPlayer: OriginPlayer, targetCoord: string): number => {
        const originCoord = originPlayer.origins[0];
        if (originCoord === undefined) {
          throw new Error(`Jogador ${originPlayer.playerName} sem aldeia de origem — confira ORIGENS DA TRIBO.`);
        }
        const key = `${originCoord.x}|${originCoord.y}|${targetCoord}`;
        const fields = fieldsByPair.get(key);
        if (fields === undefined) {
          throw new Error(
            `Não encontrei a distância do par origem→alvo (${key}) — os pares mudaram desde a distribuição. Rode a distribuição de novo e recalcule a agenda.`,
          );
        }
        const classicMinutes = fields * noble;
        if (nightCfg === null || !nightCfg.nightBonusActive) return classicMinutes;
        // Bônus noturno: solver inverso a ponto fixo (partida ↔ viagem) na
        // engine — converge mesmo nas bordas da janela; fail-closed se não.
        const solved = solveDepartureForArrival({
          distanceFields: fields,
          minutesPerField: noble,
          arrivalAt: arrival,
          cfg: nightCfg,
        });
        return solved.travelMs / 60_000;
      };

      const origins = originsPreview?.players ?? parseOriginsInput(originsText);
      const baseRows = computeSendTimes(
        { distribution, origins },
        { desiredArrival: { hour, minute }, baseDate: base, travelMinutesPerPair },
      );
      const rows = noblesPerTarget > 1 ? nobleTrain(baseRows, { noblesPerTarget, spacingSec }) : baseRows;
      setScheduleRows(rows);
      // Snapshot dos inputs da agenda — base do banner "horários mudaram".
      setScheduleInputs({ opTime: opTimeText, nobles: noblesText, spacing: spacingText, day: opDay });
      if (nightCfg !== null && nightCfg.nightBonusActive && nightCfg.nightStartHour !== nightCfg.nightEndHour) {
        push('info', `Bônus noturno ${nightCfg.nightStartHour}h→${nightCfg.nightEndHour}h aplicado no tempo de viagem.`);
      }
      const past = rows.filter((row) => row.sendAt.getTime() < Date.now()).length;
      if (past > 0) {
        push(
          'error',
          `${past} envio(s) com horário JÁ PASSADO — mude o Dia da chegada para Amanhã ou antecipe o horário da OP.`,
        );
      } else {
        push('ok', `Agenda pronta: ${rows.length} envio(s).`);
      }
    } catch (error) {
      const message = errorMessage(error);
      setTimingError(message);
      push('error', message);
    }
  }

  const separator = sepByEnter ? '\n' : ' ';

  /** Ativa os alertas T-minus com as marcas configuradas ("15 5 1"). A
   *  validação das marcas (inteiros 1–1440, sem duplicatas) é do main: o erro
   *  PT-BR lançado lá aparece no erro/toast da seção da agenda. Texto sem
   *  nenhum número → lista vazia → main usa o padrão histórico 15/5/1. */
  async function runTminusAlerts(): Promise<void> {
    if (scheduleRows === null || scheduleRows.length === 0) return;
    setTimingError('');
    const marks = parseTminusMarks(tminusMarksText);
    try {
      const result = await window.staffhub.tminus.schedule(formatSendSchedule(scheduleRows), marks);
      const marksLabel = (marks.length > 0 ? marks : [15, 5, 1]).join(', ');
      push(
        'ok',
        `${result.alerts} alerta(s) T-minus agendado(s) — notificações ${marksLabel} minuto(s) antes de cada envio.`,
      );
    } catch (error) {
      const message = errorMessage(error);
      setTimingError(message);
      push('error', message);
    }
  }

  // Prévia da MP calculada UMA vez por render — falha vira callout, não some.
  const mpPreview = commsPreview();

  // Estado de cada etapa do fluxo — 1 linha muted sob cada título de seção.
  const stepAlvosStatus =
    splitResult !== null
      ? `${splitResult.targets.length} alvos gerados · ${splitResult.fakes.length} fakes · corte ${cutoffHours}h`
      : opRows !== null
        ? `${opRows.length} jogador(es) carregados — marque Alvo/Fake e separe alvos e fakes`
        : 'aldeias inimigas não carregadas';
  const stepDistributionStatus =
    distribution !== null
      ? `${distribution.assignments.length} pares fechados · ${distribution.orphanTargets.length} alvo(s) sem atacante${distributionStale ? ' — parâmetros mudaram, redistribua' : ''}`
      : planning !== null
        ? 'simulação pronta — revise o mapa de calor e distribua'
        : 'distribuição não realizada';
  const stepAgendaStatus =
    scheduleRows !== null && scheduleRows.length > 0
      ? `${scheduleRows.length} envio(s) para chegar às ${opTimeText} (${opDay === 'amanha' ? 'amanhã' : 'hoje'})${scheduleStale ? ' — horários mudaram, recalcule' : ''}`
      : 'agenda não calculada';
  const stepCommsStatus =
    commsPlayers !== null
      ? `${commsPlayers.length} jogador(es) com MP pronta`
      : 'precisa de distribuição + agenda';

  // ---- Gates do progressive disclosure: as MESMAS condições dos callouts de
  //  "vazio" que cada seção já computa (distribuição: origem E alvos vazios —
  //  e sem resultado na tela, que nunca pode sumir). Agenda e comunicação
  //  abrem com a distribuição, igual aos callouts delas.
  const distGated =
    planning === null &&
    distribution === null &&
    originsText.trim() === '' &&
    lines.every((line) => parseCoordList(line.coordsText).length === 0);
  const distCollapsed = distGated && !distRevealed;
  const agendaCollapsed = distribution === null && !agendaRevealed;
  const commsCollapsed = distribution === null && !commsRevealed;

  return (
    <section className="page">
      <PageHeader
        kicker={`Módulo SG4 — Fase ${moduleInfo?.phase ?? 4}`}
        title={moduleInfo?.originalLabel ?? 'Criação de Operações'}
        description="Em 4 etapas: alvos e fakes, distribuição, agenda de envio e comunicação."
      />

      <Sg4Stepper
        steps={[
          {
            label: 'Alvos',
            done: splitResult !== null,
            stale: analysisStale,
            summary: stepAlvosStatus,
            action: 'carregue as aldeias inimigas, marque Alvo/Fake e clique em "Separar alvos e fakes"',
            anchor: 'sg4-op-title',
          },
          {
            label: 'Distribuição',
            done: distribution !== null,
            stale: distributionStale,
            summary: stepDistributionStatus,
            action: 'cole as origens e os alvos e clique em "Distribuir agora"',
            anchor: 'sg4-dist-title',
          },
          {
            label: 'Agenda',
            done: scheduleRows !== null && scheduleRows.length > 0,
            stale: scheduleStale,
            summary: stepAgendaStatus,
            action: 'defina "OP bate às" e clique em "Calcular horários de envio"',
            anchor: 'sg4-agenda-title',
          },
          {
            label: 'Comunicação',
            done: commsPlayers !== null,
            summary: stepCommsStatus,
            action: 'revise a prévia da MP e poste o plano no fórum',
            anchor: 'sg4-comms-title',
          },
        ]}
      />

      {/* ===== Seção A — Criação de OP com Coordenada Central ===== */}
      <section className="page-section" aria-labelledby="sg4-op-title">
        <h2 className="section-title" id="sg4-op-title">Criação de OP com coordenada central</h2>
        <p className="muted">{stepAlvosStatus}</p>
        {opRows === null && (
          <Callout variant="info">
            <p>
              <strong>Comece por aqui</strong> — informe as tags inimigas e a coordenada central e
              clique em "Carregar aldeias inimigas"; depois marque quem é alvo e quem é fake.
            </p>
          </Callout>
        )}
        <div className="card">
          <div className="card-body">
            {relationsFailed && (
              <Callout variant="warn">
                <p>
                  <strong>Diplomacia indisponível</strong> — o botão de preencher tags fica
                  desativado até ela voltar; a OP funciona com tags digitadas à mão.{' '}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={relationsBusy}
                    onClick={() => void retryRelations()}
                  >
                    Tentar de novo
                  </button>
                </p>
              </Callout>
            )}
            <div className="sg4-form-grid">
              <div className="sg4-span-2">
                <Field
                  id="sg4-enemyTags"
                  label="Tags das tribos inimigas"
                  hint="Separe as tags com ; ou use o botão abaixo para preencher com a diplomacia."
                  error={errorsA.tags}
                >
                  <textarea
                    id="sg4-enemyTags"
                    className="textarea"
                    rows={2}
                    placeholder="DARK;SAV;NEW"
                    value={enemyTagsText}
                    data-tip="Siglas separadas por ; (ex.: DARK;SAV). Todo jogador dessas tribos entra na tabela."
                    aria-describedby={errorsA.tags !== undefined ? 'sg4-enemyTags-error' : 'sg4-enemyTags-hint'}
                    onChange={(event) => setEnemyTagsText(event.target.value)}
                  />
                </Field>
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={useEnemyTagsFromDiplomacy}
                    disabled={relationsFailed}
                    data-tip="Preenche o campo com as tribos inimigas da diplomacia da sua tribo."
                  >
                    <Swords size={14} aria-hidden="true" />
                    Usar inimigas da diplomacia
                  </button>
                </div>
              </div>
              <Field id="sg4-central" label="Coordenada central da OP" error={errorsA.central}>
                <input
                  id="sg4-central"
                  className="input"
                  placeholder="123|456"
                  value={centralCoordText}
                  data-tip="Aldeia de referência: as faixas de horas são medidas daqui, em tempo de nobre."
                  aria-describedby={errorsA.central !== undefined ? 'sg4-central-error' : undefined}
                  onChange={(event) => setCentralCoordText(event.target.value)}
                />
              </Field>
            </div>
            <div className="sg4-form-actions">
              <button
                type="button"
                className="btn sg4-btn-green"
                onClick={() => void runLoadEnemies()}
                disabled={loadingVillages}
                data-tip="Na 1ª vez baixa os dados do mundo (pode demorar)."
              >
                {loadingVillages ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Carregando aldeias inimigas…
                  </>
                ) : (
                  <>
                    <Radar size={15} aria-hidden="true" />
                    Carregar aldeias inimigas
                  </>
                )}
              </button>
            </div>
            {runErrorA !== '' && (
              <p className="error" role="alert">{runErrorA}</p>
            )}
          </div>
        </div>

        {opRows !== null && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Análise por jogador ({opRows.length})</h3>
              <span className="spacer" />
              <div className="sg4-cutoff">
                <label className="field-label" htmlFor="sg4-cutoff">Incluir aldeias até X horas de nobre</label>
                <select
                  id="sg4-cutoff"
                  className="select"
                  value={cutoffHours}
                  data-tip={`Só entram nas caixas as aldeias a MENOS de ${cutoffHours}h da central. Menor = OP mais enxuta.`}
                  onChange={(event) => {
                    setCutoffHours(Number(event.target.value));
                    setSplitResult(null);
                  }}
                >
                  {[1, 2, 3, 4, 5].map((hours) => (
                    <option key={hours} value={hours}>{hours}</option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={markAllFake}>
                Selecionar todos para fake
              </button>
            </div>
            {analysisStale && (
              <div className="card-body" style={{ paddingBottom: 0 }}>
                <Callout variant="warn" title="Análise possivelmente desatualizada">
                  <p>Coordenada central ou tags mudaram — recarregue as aldeias antes de confiar nesta análise.</p>
                </Callout>
              </div>
            )}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Jogador</th>
                    {HOUR_LABELS.map((label, index) => (
                      <th
                        scope="col"
                        key={label}
                        className="cell-num"
                        data-tip={`Aldeias do jogador entre ${index} e ${index + 1}h de nobre da central.`}
                      >
                        {label}
                      </th>
                    ))}
                    <th scope="col" className="cell-num" data-tip="Aldeias a 8h ou mais — nunca entram nos alvos/fakes.">
                      8h+
                    </th>
                    <th
                      scope="col"
                      data-tip="Alvo = ataque de verdade (caixa ALVOS) · Fake = ataque de fachada (caixa FAKES)."
                    >
                      Ação
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {opRows.map((row) => (
                    <tr key={row.playerId}>
                      <td className="cell-nowrap">{row.playerName}</td>
                      {row.hourCounts.map((count, index) => (
                        <td key={index} className="cell-num">{count}</td>
                      ))}
                      <td className="cell-num">{row.others}</td>
                      <td className="cell-nowrap">
                        <select
                          className="select sg4-action-cell"
                          value={actions.get(row.playerId) ?? 'fake'}
                          aria-label={`Ação do jogador ${row.playerName}`}
                          data-tip="Marque Alvo para quem será atacado de verdade; Fake para os demais. Vale para todas as aldeias do jogador."
                          onChange={(event) => updateAction(row.playerId, event.target.value as 'alvo' | 'fake')}
                        >
                          <option value="fake">Fake</option>
                          <option value="alvo">Alvo</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-body">
              <button
                type="button"
                className="btn"
                onClick={runSplit}
                data-tip="Gera as caixas respeitando o corte e a marcação."
              >
                <Crosshair size={15} aria-hidden="true" />
                Separar alvos e fakes
              </button>
            </div>
          </div>
        )}

        {splitResult !== null && (
          <div className="sg4-split">
            <div className="card">
              <div className="card-body">
                <div className="sg4-split-head">
                  <h4 className="sg4-split-title">QUANTIDADE DE ALDEIAS ALVO</h4>
                  <span className="sg4-count">{splitResult.targets.length}</span>
                </div>
                <label className="field">
                  <span className="field-label">ALDEIAS ALVOS</span>
                  <textarea
                    className="textarea sg4-coords"
                    rows={6}
                    readOnly
                    value={splitResult.targets.join(separator)}
                    data-tip="Somente leitura. Copie para onde precisar (ou use o botão de ponte abaixo)."
                    aria-label="ALDEIAS ALVOS"
                  />
                </label>
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={splitResult.targets.length === 0}
                    onClick={bridgeTargetsToDistribution}
                    data-tip="Cola os alvos gerados na primeira linha de alvos da Distribuição (etapa 2)."
                  >
                    <Share2 size={14} aria-hidden="true" />
                    Usar estes alvos na distribuição
                  </button>
                </div>
              </div>
            </div>
            <div className="card">
              <div className="card-body">
                <div className="sg4-split-head">
                  <h4 className="sg4-split-title">QUANTIDADE DE ALDEIAS FAKE</h4>
                  <span className="sg4-count">{splitResult.fakes.length}</span>
                </div>
                <label className="field">
                  <span className="field-label">ALDEIAS FAKES</span>
                  <textarea
                    className="textarea sg4-coords"
                    rows={6}
                    readOnly
                    value={splitResult.fakes.join(separator)}
                    data-tip="Somente leitura. Copie para onde precisar (ou use o botão de ponte abaixo)."
                    aria-label="ALDEIAS FAKES"
                  />
                </label>
              </div>
            </div>
            <div className="sg4-split-actions">
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={sepByEnter}
                  data-tip="Uma coordenada por linha (ligado) ou todas numa linha separadas por espaço."
                  onChange={(event) => setSepByEnter(event.target.checked)}
                />
                <span>Uma coordenada por linha</span>
              </label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={splitResult.targets.length === 0}
                onClick={() => void copyText(splitResult.targets.join(separator))}
              >
                <Copy size={14} aria-hidden="true" />
                Copiar alvos
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={splitResult.fakes.length === 0}
                onClick={() => void copyText(splitResult.fakes.join(separator))}
              >
                <Copy size={14} aria-hidden="true" />
                Copiar fakes
              </button>
            </div>
          </div>
        )}

        {/* P1-16 — Fakes inteligentes: logo abaixo das caixas ALDEIAS ALVOS/FAKES.
         *  Sem distribuição (A): alvos = caixa ALDEIAS ALVOS, com aviso de que
         *  fakes podem colidir com ataques reais. Com distribuição (B): alvos =
         *  órfãos da distribuição e origens = coords não usadas. */}
        <FakesIntelligentSection
          mode={distribution === null ? 'sem-distribuicao' : 'pos-distribuicao'}
          targetCoords={splitResult?.targets ?? []}
          originsText={distribution === null ? originsText : fakesOriginsText}
          orphanTargets={distribution?.orphanTargets ?? []}
          usedOriginCoords={fakesUsedOriginCoords}
          onApply={applyIntelligentFakes}
          canApply={splitResult !== null}
        />

        {/* Análise de espionagem — subseção da Seção A, logo após o bloco
         *  "Separar alvos e fakes". O título da seção vem do próprio
         *  componente (evita heading duplicado). */}
        <SpyReportSection onUseAsTarget={setCentralCoordText} />
      </section>

      {/* ===== Seção B — Distribuição de Alvos de OP ===== */}
      <section className="page-section" aria-labelledby="sg4-dist-title">
        <h2 className="section-title" id="sg4-dist-title">Distribuição de alvos da OP</h2>
        <p className="muted">{stepDistributionStatus}</p>
        {distCollapsed ? (
          <GatedHint
            hint="Sem origens nem alvos nesta etapa — conclua a etapa anterior (alvos e fakes) para liberar."
            onReveal={() => setDistRevealed(true)}
          />
        ) : (
          <>
          {originsText.trim() === '' && (
            <Callout variant="info">
              <p>
                <strong>Sem origens ainda</strong> — cole a saída do contador do SG2 no campo
                "Origens da tribo" abaixo (ou use o botão "Preencher com o SG2").
              </p>
            </Callout>
          )}
          {lines.every((line) => parseCoordList(line.coordsText).length === 0) && (
            <Callout variant="info">
              <p>
                <strong>Sem alvos nesta etapa</strong> — cole as coordenadas dos alvos (123|456
                456|123) na primeira linha de alvos, ou traga os alvos da etapa 1 com o botão "Usar
                estes alvos na distribuição".
              </p>
            </Callout>
          )}
          <div className="card">
            <div className="card-body">
              <Field
                id="sg4-origins"
                label="Origens da tribo (nick;fulls;coords)"
                hint="Cada coordenada de origem = 1 NT estacionado (1 alvo a receber). Formatos: nick;fulls;coords ou nick;fulls;semis;coords (coords fulls primeiro — saída do contador do SG2)."
                error={errorsB.origins}
              >
                <textarea
                  id="sg4-origins"
                  className="textarea sg4-coords"
                  rows={4}
                  placeholder={'hasua;50;686|420 686|424\nou com semis: hasua;3;2;686|420 686|424 690|430 691|431'}
                  value={originsText}
                  data-tip="Um jogador por linha: nick;fulls;semis;coords (semis opcional; fulls primeiro). Cada coordenada = 1 nobre pronto = 1 alvo. Cole a saída do SG2 ou use o botão."
                  aria-describedby={errorsB.origins !== undefined ? 'sg4-origins-error' : 'sg4-origins-hint'}
                  onChange={(event) => setOriginsText(event.target.value)}
                />
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void fillOriginsFromSnapshot()}
                    data-tip="Substitui o campo com as aldeias com nobre da última coleta do SG2."
                  >
                    <Swords size={14} aria-hidden="true" />
                    Preencher com o SG2 (aldeias com nobre)
                  </button>
                </div>
              </Field>

              {originsPreview !== null && (
                <div className="col" style={{ gap: 8, marginBottom: 12 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="pill pill--muted">{originsPreview.summary.players} jogador(es)</span>
                    <span className="pill pill--muted">{originsPreview.summary.fulls} full(s)</span>
                    {originsPreview.summary.semis > 0 && <span className="pill pill--muted">{originsPreview.summary.semis} semi(s)</span>}
                    <span className="pill pill--muted">{originsPreview.summary.villages} origem(ns)</span>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Jogador</th>
                          <th scope="col" className="cell-num">Fulls</th>
                          <th scope="col" className="cell-num">Semis</th>
                          <th scope="col">Origens (F = full · S = semi)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {originsPreview.players.map((player) => {
                          const semiSet = new Set((player.semiOrigins ?? []).map((coord) => `${coord.x}|${coord.y}`));
                          return (
                            <tr key={player.playerName}>
                              <td className="cell-nowrap">{player.playerName}</td>
                              <td className="cell-num"><strong>{player.fulls}</strong></td>
                              <td className="cell-num">{player.semis ?? 0}</td>
                              <td className="cell-detail">
                                {player.origins.map((coord) => {
                                  const label = `${coord.x}|${coord.y}`;
                                  return semiSet.has(label)
                                    ? <span key={label} className="text-warn">S {label} </span>
                                    : <span key={label}>F {label} </span>;
                                })}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {lines.map((line, index) => (
                <div className="sg4-line-grid" key={index}>
                  {/* Faixas fulls/semis: UM rótulo por par (legível) — os limites
                      de/até são identificados por aria-label e placeholder. */}
                  <fieldset className="field" style={{ gridColumn: 'span 2' }}>
                    <legend className="field-label">Fulls (de–até)</legend>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={200}
                        placeholder="0"
                        value={line.fullsFrom}
                        style={{ flex: 1, minWidth: 0 }}
                        aria-label={`Fulls mínimas da linha ${index + 1}`}
                        data-tip="Só entram nesta linha jogadores com essa quantidade de fulls. Vazio = todos."
                        onChange={(event) => updateLine(index, 'fullsFrom', event.target.value)}
                      />
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={200}
                        placeholder="200"
                        value={line.fullsTo}
                        style={{ flex: 1, minWidth: 0 }}
                        aria-label={`Fulls máximas da linha ${index + 1}`}
                        data-tip="Só entram nesta linha jogadores com essa quantidade de fulls. Vazio = todos."
                        onChange={(event) => updateLine(index, 'fullsTo', event.target.value)}
                      />
                    </div>
                  </fieldset>
                  <fieldset className="field" style={{ gridColumn: 'span 2' }}>
                    <legend className="field-label">Semis (de–até)</legend>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={200}
                        placeholder="0"
                        value={line.semisFrom}
                        style={{ flex: 1, minWidth: 0 }}
                        aria-label={`Semis mínimas da linha ${index + 1}`}
                        data-tip="Filtro extra pela quantidade de semis (origens em formato legado têm 0 semis)."
                        onChange={(event) => updateLine(index, 'semisFrom', event.target.value)}
                      />
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={200}
                        placeholder="200"
                        value={line.semisTo}
                        style={{ flex: 1, minWidth: 0 }}
                        aria-label={`Semis máximas da linha ${index + 1}`}
                        data-tip="Filtro extra pela quantidade de semis (origens em formato legado têm 0 semis)."
                        onChange={(event) => updateLine(index, 'semisTo', event.target.value)}
                      />
                    </div>
                  </fieldset>
                  <label className="field">
                    <span className="field-label">
                      Coordenadas de destino ({(LINE_NAMES[index] ?? `${index + 1}ª linha`).toLowerCase()})
                    </span>
                    <textarea
                      className="textarea"
                      rows={2}
                      placeholder="123|456 456|123 111|222"
                      value={line.coordsText}
                      data-tip="Alvos desta linha, separados por espaço. Só jogadores na faixa de fulls/semis ao lado podem pegá-los."
                      onChange={(event) => updateLine(index, 'coordsText', event.target.value)}
                    />
                    <div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={lines.length <= 1}
                        onClick={() => removeLine(index)}
                      >
                        Remover linha
                      </button>
                    </div>
                  </label>
                </div>
              ))}
              <button type="button" className="btn btn-ghost btn-sm" onClick={addLine}>
                <Plus size={14} aria-hidden="true" />
                Adicionar linha de alvos
              </button>

              <div className="sg4-params">
                <fieldset className="field" data-tip="Cada origem escolhe o alvo elegível mais perto (ou mais longe) primeiro.">
                  <legend className="field-label">Priorizar</legend>
                  <div className="sg4-radio-row">
                    <label className="checkbox-field">
                      <input
                        type="radio"
                        name="sg4-priority"
                        checked={priority === 'nearest'}
                        onChange={() => setPriority('nearest')}
                      />
                      mais próximas
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="radio"
                        name="sg4-priority"
                        checked={priority === 'farthest'}
                        onChange={() => setPriority('farthest')}
                      />
                      mais distantes
                    </label>
                  </div>
                </fieldset>
                <label className="field">
                  <span className="field-label">Moral mínima (%) — 0 desliga</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={100}
                    value={minMoraleText}
                    disabled={!moraleActive}
                    data-tip="Moral mínima do par atacante→alvo. 0 desliga o filtro."
                    aria-describedby={!moraleActive ? 'sg4-morale-hint' : undefined}
                    onChange={(event) => setMinMoraleText(event.target.value)}
                  />
                  {!moraleActive && (
                    <p className="field-hint" id="sg4-morale-hint">
                      Mundo clássico — sem moral por pontos
                    </p>
                  )}
                </label>
                <label className="field">
                  <span className="field-label">Distância máxima (campos)</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={maxFieldsText}
                    data-tip="Distância máxima origem→alvo, em campos. O heatmap mostra todos; o filtro vale na distribuição."
                    onChange={(event) => setMaxFieldsText(event.target.value)}
                  />
                </label>
              </div>

              {/* Curva da moral com a linha da moral mínima configurada — só
                  quando o valor é um número válido em 0–100 (senão, curva pura). */}
              {moraleActive &&
                (() => {
                  const mm = Number(minMoraleText);
                  return (
                    <MoraleCurve
                      {...(Number.isFinite(mm) && mm >= 0 && mm <= 100 ? { minMorale: Math.round(mm) } : {})}
                    />
                  );
                })()}

              <div className="sg4-form-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busyB}
                  onClick={() => void runDistribution(true)}
                  data-tip="Só calcula a matriz origem×alvo para revisar — nada é fechado."
                >
                  <Crosshair size={15} aria-hidden="true" />
                  {busyB ? 'Calculando…' : 'Simular (ver mapa de calor)'}
                </button>
                <button
                  type="button"
                  className="btn sg4-btn-green"
                  disabled={busyB}
                  onClick={() => void runDistribution(false)}
                  data-tip="Fecha a distribuição: cada origem fica com 1 alvo e habilita agenda, MPs, mapa e arquivo."
                >
                  <Share2 size={15} aria-hidden="true" />
                  {busyB ? 'Calculando…' : 'Distribuir agora'}
                </button>
              </div>
              {runErrorB !== '' && (
                <p className="error" role="alert">{runErrorB}</p>
              )}
            </div>
          </div>

          {planning !== null && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Simulação (origem × alvo)</h3>
                <span className="spacer" />
                <span className="pill pill--muted">
                  {planning.matrix.length} origens · {planning.lineTargets.length} alvos
                </span>
              </div>
              {planning.matrix.length === 0 || planning.lineTargets.length === 0 ? (
                <div className="card-body">
                  <p className="muted">Matriz vazia — confira as origens e os alvos informados.</p>
                </div>
              ) : (
                <div className="card-body">
                  <div className="table-wrap sg4-heat-wrap">
                    <table className="table sg4-heat">
                      <thead>
                        <tr>
                          <th scope="col">Origem (Jogador)</th>
                          {planning.lineTargets.map((target, index) => (
                            <th scope="col" key={`${target.x}|${target.y}-${index}`}>
                              {target.x}|{target.y}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {planning.matrix.map((row) => (
                          <tr key={row.origin}>
                            <th scope="row" className="cell-nowrap sg4-heat-origin">
                              <span className="muted">{row.origin}</span> {row.player}
                              {row.tier === 'semi' && <span className="text-warn" title="Origem SEMI (população ofensiva abaixo do limiar de full)"> semi</span>}
                            </th>
                        {row.cells.map((cell, index) => {
                          const span = heatRange.max - heatRange.min;
                          const t = span === 0 ? 0.5 : (cell.hours - heatRange.min) / span;
                          const morale = cell.morale;
                          // Célula além da "Distância máxima": apagada (aviso, não filtro).
                          const far = maxFieldsLimit !== null && cell.fields > maxFieldsLimit;
                          const tipParts = [
                            `${cell.hours.toFixed(1).replace('.', ',')}h de viagem`,
                            `${cell.fields} campos`,
                          ];
                          if (morale !== null) tipParts.push(`moral ${morale}%`);
                          if (far && maxFieldsLimit !== null) tipParts.push(`fora do limite de ${maxFieldsLimit} campos`);
                          return (
                            <td
                              key={index}
                              className={far ? 'sg4-heat-cell sg4-heat-cell--far' : 'sg4-heat-cell'}
                              style={heatStyle(t)}
                              data-tip={tipParts.join(' · ')}
                            >
                              {cell.hours.toFixed(1)}
                            </td>
                          );
                        })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted sg4-heat-legend">
                    Horas de NOBRE da origem até o alvo: verde (mais perto) → amarelo → vermelho (mais longe).
                    Células apagadas estão além da "Distância máxima" — o filtro vale na distribuição.
                    Passe o mouse sobre as células para ver horas, campos e moral.
                  </p>
                </div>
              )}
            </div>
          )}

          {distribution !== null && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Distribuição</h3>
                <span className="spacer" />
                <span className="pill pill--muted">
                  {distribution.assignments.length} pares fechados · {distribution.orphanOrigins.length} origens sem
                  alvo · {distribution.orphanTargets.length} alvos sem atacante
                </span>
              </div>
              {distributionStale && (
                <div className="card-body" style={{ paddingBottom: 0 }}>
                  <Callout variant="warn" title="Distribuição possivelmente desatualizada">
                    <p>Os parâmetros mudaram depois da distribuição — redistribua antes de usar.</p>
                  </Callout>
                </div>
              )}
              <div className="card-body">
                <label className="field">
                  <span className="field-label">Resultado: quem ataca o quê (nick;coords)</span>
                  <textarea
                    className="textarea sg4-coords"
                    rows={6}
                    readOnly
                    value={distributionSummaryText}
                    aria-label="Resultado da distribuição: quem ataca o quê (nick;coords)"
                  />
                  <div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={distribution.assignments.length === 0}
                      onClick={() => void copyText(distributionSummary(distribution))}
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar distribuição
                    </button>
                  </div>
                </label>
                {distribution.orphanOrigins.length > 0 && (
                  <p className="muted">
                    Origens sem alvo:{' '}
                    {distribution.orphanOrigins.map((orphan) => `${orphan.playerName} (${orphan.origin})`).join(' · ')}{' '}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        void copyText(distribution.orphanOrigins.map((orphan) => orphan.origin).join(' '))
                      }
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar
                    </button>
                  </p>
                )}
                {distribution.orphanTargets.length > 0 && (
                  <p className="muted">
                    Alvos sem atacante: {distribution.orphanTargets.join(' ')}{' '}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void copyText(distribution.orphanTargets.join(' '))}
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar
                    </button>
                  </p>
                )}
                {distribution.orphanOrigins.length === 0 && distribution.orphanTargets.length === 0 && (
                  <p className="ok">Todos os alvos receberam um atacante.</p>
                )}
                <div className="sg4-params" style={{ marginTop: 12 }}>
                  <label className="field">
                    <span className="field-label">Nome da OP (para o histórico)</span>
                    <input
                      className="input"
                      value={opTitle}
                      data-tip="Nome com que a OP entra no arquivo de OPs (Sala de Guerra) e no plano do fórum."
                      onChange={(event) => setOpTitle(event.target.value)}
                      aria-label="Nome da OP para o histórico"
                    />
                  </label>
                  <div className="field">
                    <span className="field-label">Arquivo de OPs</span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={
                        archiving || distribution.assignments.length === 0 || distributionStale
                      }
                      title={
                        distributionStale
                          ? 'Os parâmetros mudaram depois da distribuição — redistribua antes de arquivar.'
                          : undefined
                      }
                      onClick={() => void archiveOp()}
                    >
                      {archiving ? <><span className="btn-spinner" aria-hidden="true" /> Arquivando…</> : 'Arquivar OP (Sala de Guerra)'}
                    </button>
                    {/* Hand-off pós-arquivo: atalho para acompanhar a OP na Sala
                        de Guerra — só existe quando o App injeta onNavigate. */}
                    {onNavigate !== undefined && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => onNavigate('guerra')}
                        data-tip="Abre a Sala de Guerra para acompanhar esta OP arquivada."
                      >
                        Abrir Sala de Guerra
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {distribution !== null && distribution.assignments.length > 0 && (
            <DistributionMap assignments={distribution.assignments} onError={handleMapError} />
          )}
          </>
        )}
      </section>

      {/* ===== Etapa 3 — Agenda de Envio =====
           Seção PERMANENTE no DOM (a âncora do stepper existe mesmo sem
           distribuição): sem distribuição, callout orienta o que fazer antes. */}
      <section className="page-section" aria-labelledby="sg4-agenda-title">
        <h2 className="section-title" id="sg4-agenda-title">Agenda de envio (timing da OP)</h2>
        <p className="muted">{stepAgendaStatus}</p>
        {agendaCollapsed ? (
          <GatedHint
            hint="A agenda abre depois da distribuição — conclua a etapa anterior para liberar."
            onReveal={() => setAgendaRevealed(true)}
          />
        ) : distribution === null ? (
          <Callout variant="info">
            <p>
              <strong>A agenda abre depois da distribuição</strong> — feche quem ataca o quê na
              etapa 2 e volte aqui para calcular a que horas cada um precisa enviar.
            </p>
          </Callout>
        ) : (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Horários de envio</h3>
              <span className="spacer" />
              <span className="pill pill--muted">enviar às = chegada desejada − tempo de viagem</span>
            </div>
            <div className="card-body">
              {scheduleStale && (
                <Callout variant="warn" title="Agenda possivelmente desatualizada">
                  <p>Horários mudaram — recalcule a agenda.</p>
                </Callout>
              )}
              <div className="sg4-params">
                <label className="field">
                  <span className="field-label">OP bate às (HH:MM)</span>
                  <input
                    className="input"
                    type="time"
                    value={opTimeText}
                    data-tip="Horário de CHEGADA dos ataques, no dia selecionado."
                    onChange={(event) => setOpTimeText(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Dia da chegada</span>
                  <select
                    className="select"
                    value={opDay}
                    aria-label="Dia da chegada dos ataques"
                    data-tip="Dia em que os ataques BATEM — os horários de envio saem para chegar nesse dia (Amanhã = base +1 antes de fixar as horas)."
                    onChange={(event) => setOpDay(event.target.value as 'hoje' | 'amanha')}
                  >
                    <option value="hoje">Hoje</option>
                    <option value="amanha">Amanhã</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Nobres por alvo (trem)</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={noblesText}
                    data-tip="Quantos nobres cada alvo recebe, em sequência."
                    onChange={(event) => setNoblesText(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Espaçamento entre nobres (s)</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={spacingText}
                    data-tip="Segundos entre os nobres do trem no mesmo alvo."
                    onChange={(event) => setSpacingText(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Marcas de alerta (minutos)</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    placeholder="15 5 1"
                    value={tminusMarksText}
                    data-tip="Minutos antes de cada envio para o Windows notificar (ex.: 15 5 1)."
                    aria-describedby="sg4-tminus-marks-hint"
                    onChange={(event) => setTminusMarksText(event.target.value)}
                  />
                  <p className="field-hint" id="sg4-tminus-marks-hint">
                    Minutos antes de cada envio para notificar (inteiros 1–1440, sem repetições) — usado pelo botão de alertas T-minus.
                  </p>
                </label>
              </div>
              <div className="sg4-form-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void runSendSchedule()}
                  data-tip="Enviar às = chegada − tempo de viagem do nobre (com bônus noturno, se houver)."
                >
                  <Clock size={15} aria-hidden="true" />
                  Calcular horários de envio
                </button>
              </div>
              {timingError !== '' && <p className="error" role="alert">{timingError}</p>}
              {scheduleRows !== null && scheduleRows.length > 0 && (
                <>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Jogador</th>
                          <th scope="col">Origem</th>
                          <th scope="col">Alvo</th>
                          <th scope="col">Enviar às</th>
                          <th scope="col" className="cell-num">Viagem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scheduleRows.map((row, index) => (
                          <tr key={`${row.nick}-${row.targetCoord}-${index}`}>
                            <td className="cell-nowrap">{row.nick}</td>
                            <td>
                              {row.originCoord}
                              {semiOriginCoords.has(row.originCoord) && (
                                <span className="text-warn" title="Origem SEMI"> semi</span>
                              )}
                            </td>
                            <td>{row.targetCoord}</td>
                            <td className={row.sendAt.getTime() < Date.now() ? 'cell-nowrap text-warn' : 'cell-nowrap'}>
                              {formatHms(row.sendAt)}
                            </td>
                            <td className="cell-num">{row.travelMinutes.toFixed(1)} min</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <label className="field">
                    <span className="field-label">Nick;alvo;enviar às (formato original)</span>
                    <textarea
                      className="textarea sg4-coords"
                      rows={Math.min(12, scheduleRows.length + 2)}
                      readOnly
                      value={formatSendSchedule(scheduleRows)}
                      aria-label="Nick;alvo;enviar às"
                    />
                    <div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void copyText(formatSendSchedule(scheduleRows))}
                      >
                        <Copy size={14} aria-hidden="true" />
                        Copiar agenda de envio
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={distributionStale || scheduleStale}
                        title={
                          scheduleStale
                            ? 'Horários mudaram — recalcule a agenda antes de ativar alertas.'
                            : distributionStale
                              ? 'Os parâmetros mudaram depois da distribuição — redistribua antes de ativar alertas.'
                              : undefined
                        }
                        onClick={() => void runTminusAlerts()}
                      >
                        <Bell size={14} aria-hidden="true" />
                        Ativar alertas T-minus
                      </button>
                    </div>
                  </label>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ===== Etapa 4 — Pacote de Comunicação =====
           Também PERMANENTE no DOM: sem distribuição, callout orienta. */}
      <section className="page-section" aria-labelledby="sg4-comms-title">
        <h2 className="section-title" id="sg4-comms-title">Pacote de comunicação</h2>
        <p className="muted">{stepCommsStatus}</p>
        {commsCollapsed ? (
          <GatedHint
            hint="MPs e plano aparecem depois da distribuição — conclua a etapa anterior para liberar."
            onReveal={() => setCommsRevealed(true)}
          />
        ) : distribution === null ? (
          <Callout variant="info">
            <p>
              <strong>MPs e plano aparecem depois da distribuição</strong> — cada jogador só tem
              alvos e horários para receber quando a OP está distribuída e agendada.
            </p>
          </Callout>
        ) : (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">MPs, plano e reservas</h3>
              <span className="spacer" />
              <span className="pill pill--muted">MPs com #horarios# · BBCode do plano · reservas</span>
            </div>
            <div className="card-body">
              <label className="field">
                <span className="field-label">Template da MP (use #alvos# e #horarios#)</span>
                <textarea
                  className="textarea"
                  rows={5}
                  value={commsTemplate}
                  data-tip="Texto base da MP. #alvos# vira os alvos do jogador e #horarios# os horários."
                  aria-label="Template da MP"
                  onChange={(event) => setCommsTemplate(event.target.value)}
                />
              </label>
              {/* Biblioteca de templates (só corpo no SG_4): aplica/substitui o
                  template da MP da OP e salva o atual como novo template. */}
              <TemplateLibrary
                variant="sg4"
                currentSubject=""
                currentBody={commsTemplate}
                onApply={(_subject, body) => setCommsTemplate(body)}
              />
              {scheduleRows === null || scheduleRows.length === 0 ? (
                <p className="muted">
                  Calcule a agenda de envio acima para gerar MPs com #horarios# — BBCode e lista de reservas já funcionam só com a distribuição.
                </p>
              ) : commsPlayers === null ? (
                <p className="error" role="alert">
                  A agenda foi calculada para outra distribuição — rode a distribuição e a agenda de
                  novo, na ordem, para as MPs saírem certas.
                </p>
              ) : (
                <>
                  {mpPreview.error !== '' && (
                    <Callout variant="danger" title="Prévia da MP falhou">
                      <p>{mpPreview.error}</p>
                    </Callout>
                  )}
                  {mpPreview.preview !== null && (
                    <div>
                      <p className="field-label">Prévia da MP de {commsPlayers[0]?.playerName}:</p>
                      <pre className="sg7-code">{mpPreview.preview}</pre>
                    </div>
                  )}
                  <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void copyText(sg6EntriesText(commsPlayers))}
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar destinatários (Reservas e MPs)
                    </button>
                    {/* Hand-off: leva a lista de destinatários ao módulo certo
                        (Reservas e MPs) — só existe com onNavigate injetado. */}
                    {onNavigate !== undefined && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => onNavigate('sg6')}
                        data-tip="Abre o módulo de Reservas e MPs para disparar as MPs desta OP."
                      >
                        <Send size={14} aria-hidden="true" />
                        Ir para Reservas e MPs
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        void copyText(
                          planBbcode({
                            opTitle,
                            template: commsTemplate,
                            distribution: commsDistributionText,
                            sendSchedule: formatSendSchedule(scheduleRows),
                          }),
                        )
                      }
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar BBCode do plano (fórum)
                    </button>
                  </div>
                </>
              )}
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={commsDistributionText === ''}
                  onClick={() => void copyText(reservationList(commsDistributionText))}
                >
                  <Copy size={14} aria-hidden="true" />
                  Copiar lista de reservas
                </button>
              </div>
              <div className="sg4-params" style={{ marginTop: 12 }}>
                <label className="field">
                  <span className="field-label">URL do tópico do plano (o 1º post será substituído)</span>
                  <input
                    className="input"
                    placeholder="https://br142.tribalwars.com.br/game.php?screen=forum&screenmode=view_thread&forum_id=…&thread_id=…"
                    value={planThreadUrl}
                    data-tip="Abra o tópico do plano no fórum do jogo e cole a URL aqui — o POSTAR substitui o 1º post."
                    aria-label="URL do tópico do plano"
                    onChange={(event) => setPlanThreadUrl(event.target.value)}
                  />
                </label>
                <div className="field">
                  <span className="field-label">Postar no fórum — mutação real</span>
                  {!planPending ? (
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={planPosting || distributionStale || !/thread_id=\d+/.test(planThreadUrl) || scheduleRows === null || scheduleRows.length === 0}
                      title={
                        distributionStale
                          ? 'Os parâmetros mudaram depois da distribuição — redistribua antes de postar.'
                          : undefined
                      }
                      data-tip="Substitui o 1º post do tópico pelo plano. Confirmação dupla."
                      onClick={() => {
                        setPlanResult(null);
                        setPlanPending(true);
                      }}
                    >
                      Postar plano no fórum
                    </button>
                  ) : (
                    <div className="sg6-confirm">
                      <p>
                        Substituir o <strong>primeiro post</strong> do tópico pelo plano BBCode desta OP? Mutação única
                        com verificação — e o Windows ainda pedirá confirmação nativa.
                      </p>
                      <div className="row">
                        <button type="button" className="btn btn-danger" disabled={planPosting} onClick={() => void runPostPlan()}>
                          {planPosting ? <><span className="btn-spinner" aria-hidden="true" /> Postando…</> : 'Confirmar post do plano'}
                        </button>
                        <button type="button" className="btn btn-ghost" disabled={planPosting} onClick={() => setPlanPending(false)}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                  {(scheduleRows === null || scheduleRows.length === 0) && (
                    <p className="muted">Calcule a agenda de envio antes de postar — o plano do fórum sem horários não serve ao time.</p>
                  )}
                </div>
              </div>
              {planResult !== null && <p className="muted">{planResult}</p>}
            </div>
          </div>
        )}

      </section>

      {/* Rodapé: "Restaurar padrões" NÃO é passo do fluxo — última linha. */}
      <div className="row sg4-footer-actions">
        <button
          type="button"
          className="btn btn-ghost btn-ghost--danger btn-sm"
          onClick={restoreDefaults}
          data-tip="Limpa TODOS os campos do SG4 salvos — os resultados na tela (alvos, distribuição e agenda) também somem."
        >
          <AlertTriangle size={14} aria-hidden="true" />
          Restaurar padrões do módulo
        </button>
      </div>
    </section>
  );
}

/** Visualização da Distribuição: origens (verde) × alvos (branco) sobre o mapa. */
const EMPTY_MARKINGS = new Map<number, import('@shared/types').TribeMarking>();

function DistributionMap({ assignments, onError }: { assignments: { playerName: string; origin: string; target: string }[]; onError: (message: string) => void }) {
  const [villages, setVillages] = useState<readonly import('@shared/types').WorldVillage[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.staffhub.world
      .villages()
      .then((list) => {
        if (!cancelled) setVillages(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  if (villages === null) {
    return <p className="muted">Carregando mapa para a visualização da distribuição…</p>;
  }
  const origins = new Set(assignments.map((a) => a.origin));
  const targets = new Set(assignments.map((a) => a.target));
  return (
    <div className="card sg4-mapviz">
      <div className="card-header">
        <h3 className="card-title">Visualização da distribuição</h3>
        <span className="muted">● origens (NTs) · □ alvos</span>
      </div>
      <div className="card-body">
        <WorldMapCanvas
          villages={villages}
          markings={EMPTY_MARKINGS}
          highlights={targets}
          origins={origins}
          connections={assignments.map((a) => ({ from: a.origin, to: a.target }))}
        />
      </div>
    </div>
  );
}