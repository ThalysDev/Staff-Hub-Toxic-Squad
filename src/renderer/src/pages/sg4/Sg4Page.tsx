import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Crosshair, Radar, Share2, Swords } from 'lucide-react';
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
import { computeSendTimes, formatSendSchedule, nobleTrain, type SendScheduleRow } from '@shared/sg4-timing';
import { originsFromSnapshot } from '@shared/origins-from-snapshot';
import { solveDepartureForArrival, type NightBonusCfg } from '@shared/night-bonus';
import { buildPlayerComms, planBbcode } from '@shared/comms-package';
import type { WorldPlayer } from '@shared/types';
import Callout from '../../components/Callout';
import Field from '../../components/Field';
import PageHeader from '../../components/PageHeader';
import { useDiplomacyRelations } from '../../hooks/useDiplomacyRelations';
import { usePreferences } from '../../hooks/usePreferences';
import { useToast } from '../../hooks/useToast';
import { MODULES } from '../../modules';
import { getWorldVillages, invalidateWorldVillages } from '../../world-cache';
import FakesIntelligentSection from './FakesIntelligentSection';
import Sg4AgendaSection from './Sg4AgendaSection';
import Sg4CommsSection from './Sg4CommsSection';
import Sg4DistributionSection from './Sg4DistributionSection';
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

/** Nomes das linhas de alvos — exportado para a seção da Distribuição
 *  (Sg4DistributionSection) rotular as caixas de coordenadas. */
export const LINE_NAMES = ['PRIMEIRA', 'SEGUNDA', 'TERCEIRA', 'QUARTA', 'QUINTA', 'SEXTA'];

export interface OriginLine {
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
 *  libera o conteúdo completo para o usuário avançado adiantar a etapa.
 *  Exportado: as seções downstream (Distribuição/Agenda/Comunicação) usam o
 *  MESMO componente — função declarada, o import cíclico entre a página e as
 *  seções é inerte (só resolve na hora do render). */
export function GatedHint({ hint, onReveal }: { hint: string; onReveal: () => void }) {
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
  // ---- Progressive disclosure (3-J): o flag "revelar" de cada seção
  //  downstream é estado de UI LOCAL da própria seção (Sg4DistributionSection,
  //  Sg4AgendaSection, Sg4CommsSection) — a página não lê esse flag.

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
      // Dump mudou no main: a cópia de aldeias no renderer está velha.
      invalidateWorldVillages();
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
        getWorldVillages(),
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

  /** Estável entre renders: o mapa da Distribuição (na seção correspondente)
   *  refaz o fetch do mapa se o callback mudar a cada render do pai. */
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

  const commsDistributionText = useMemo(
    () => (distribution === null ? '' : distributionSummary(distribution)),
    [distribution],
  );

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

      {/* ===== Seção B — Distribuição de Alvos de OP =====
           Estado e runDistribution continuam NA PÁGINA (restaurar padrões e o
           recálculo de uma etapa derrubam resultados das outras) — a seção é
           apresentação + estado de UI local (o "revelar" do gate). */}
      <Sg4DistributionSection
        statusText={stepDistributionStatus}
        originsText={originsText}
        onOriginsTextChange={setOriginsText}
        originsPreview={originsPreview}
        onFillFromSnapshot={fillOriginsFromSnapshot}
        lines={lines}
        onLineChange={updateLine}
        onRemoveLine={removeLine}
        onAddLine={addLine}
        priority={priority}
        onPriorityChange={setPriority}
        minMoraleText={minMoraleText}
        onMinMoraleTextChange={setMinMoraleText}
        maxFieldsText={maxFieldsText}
        onMaxFieldsTextChange={setMaxFieldsText}
        moraleActive={moraleActive}
        originsError={errorsB.origins}
        busy={busyB}
        runError={runErrorB}
        onRun={runDistribution}
        planning={planning}
        distribution={distribution}
        stale={distributionStale}
        opTitle={opTitle}
        onOpTitleChange={setOpTitle}
        archiving={archiving}
        onArchive={archiveOp}
        onCopy={copyText}
        onMapError={handleMapError}
        onNavigate={onNavigate}
      />

      {/* ===== Etapa 3 — Agenda de Envio =====
           Seção PERMANENTE no DOM (a âncora do stepper existe mesmo sem
           distribuição): sem distribuição, callout orienta o que fazer antes. */}
      <Sg4AgendaSection
        statusText={stepAgendaStatus}
        distribution={distribution}
        distributionStale={distributionStale}
        stale={scheduleStale}
        opTimeText={opTimeText}
        onOpTimeTextChange={setOpTimeText}
        opDay={opDay}
        onOpDayChange={setOpDay}
        noblesText={noblesText}
        onNoblesTextChange={setNoblesText}
        spacingText={spacingText}
        onSpacingTextChange={setSpacingText}
        tminusMarksText={tminusMarksText}
        onTminusMarksTextChange={setTminusMarksText}
        timingError={timingError}
        scheduleRows={scheduleRows}
        onCalculate={runSendSchedule}
        onActivateAlerts={runTminusAlerts}
        onCopy={copyText}
      />

      {/* ===== Etapa 4 — Pacote de Comunicação =====
           Também PERMANENTE no DOM: sem distribuição, callout orienta. */}
      <Sg4CommsSection
        statusText={stepCommsStatus}
        distribution={distribution}
        distributionStale={distributionStale}
        scheduleRows={scheduleRows}
        commsPlayers={commsPlayers}
        commsTemplate={commsTemplate}
        onCommsTemplateChange={setCommsTemplate}
        commsDistributionText={commsDistributionText}
        opTitle={opTitle}
        planThreadUrl={planThreadUrl}
        onPlanThreadUrlChange={setPlanThreadUrl}
        planPending={planPending}
        planPosting={planPosting}
        planResult={planResult}
        onBeginPost={() => {
          setPlanResult(null);
          setPlanPending(true);
        }}
        onConfirmPost={runPostPlan}
        onCancelPost={() => setPlanPending(false)}
        onCopy={copyText}
        onNavigate={onNavigate}
      />

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