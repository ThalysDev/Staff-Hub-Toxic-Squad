import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  Layers,
  ShieldCheck,
  Swords,
  Users,
} from 'lucide-react';
import { parseCoordList, type AxesRange } from '@shared/coords';
import { migrateLegacyNamesText, parsePlayerNames } from '@shared/names-filter';
import type { QueueProgress } from '@shared/ipc-types';
import HistoryEvolutionSection from './HistoryEvolutionSection';
import MemorySummarySection from './MemorySummarySection';
import { filterTroops, playersSummary, type DefenseSnapshot } from '@shared/sg2-engine';
import { defenseToTroopSnapshot } from '@shared/sg2-defense-source';
import type { Sg2FilterResult, Sg2Filters, TroopSnapshot } from '@shared/sg2-engine';
import {
  fullSemiReport,
  formatFullSemiRows,
  formatOriginsRows,
  type FullSemiReport,
  type FullSemiSortBy,
} from '@shared/full-semi';
import { UNITS, type UnitCounts, type UnitId } from '@shared/units';
import { TW_UNIT_ICONS } from '../../assets';
import EmptyState from '../../components/EmptyState';
import Field from '../../components/Field';
import PageHeader from '../../components/PageHeader';
import PresetManager from '../../components/PresetManager';
import ProgressBar from '../../components/ProgressBar';
import StatBlock from '../../components/StatBlock';
import { usePreferences } from '../../hooks/usePreferences';
import { useSessionStatus } from '../../hooks/useSessionStatus';
import { useToast } from '../../hooks/useToast';
import { MODULES } from '../../modules';

/**
 * SG_2 — Análise de Tropas das Aldeias (screen=ally&mode=members_troops).
 * Rótulos e formatos fiéis à ferramenta original (docs/MODULOS-SG.md):
 * painel "Dados em Memória" com data da última atualização, coleta completa
 * (membro a membro, com pacing) ou resumo em 1 requisição, e o filtro de
 * tropas por unidade/escopo/coordenadas/eixos. A consulta roda LOCALMENTE
 * no renderer sobre o snapshot guardado em memória no processo principal.
 */

/** Unidades do formulário de filtro: spear..snob (Milícia fica de fora). */
const FILTER_UNIT_ORDER: readonly UnitId[] = [
  'spear',
  'sword',
  'axe',
  'archer',
  'spy',
  'light',
  'marcher',
  'heavy',
  'ram',
  'catapult',
  'knight',
  'snob',
];

function emptyUnitInputs(): Record<UnitId, string> {
  return Object.fromEntries(FILTER_UNIT_ORDER.map((id) => [id, ''])) as Record<UnitId, string>;
}

/** Intervalos do agendador de coleta automática ('0' = desligado). */
const AUTO_COLLECT_OPTIONS = ['0', '4', '6', '12', '24'] as const;
type AutoCollectHours = (typeof AUTO_COLLECT_OPTIONS)[number];

/** Fail-soft: valor fora das opções conhecidas volta a "Desligado". */
function normalizeAutoCollect(value: unknown): AutoCollectHours {
  return (AUTO_COLLECT_OPTIONS as readonly unknown[]).includes(value) ? (value as AutoCollectHours) : '0';
}

/** Ritmo do agendador: a cada 5 minutos ele avalia se o intervalo venceu. */
const AUTO_COLLECT_TICK_MS = 5 * 60 * 1000;

/** Campos de formulário do SG_2 que sobrevivem a F5/reinício (módulo "sg2"). */
type Sg2Prefs = {
  unitInputs: Record<UnitId, string>;
  mode: 'has' | 'lacks';
  scope: 'village' | 'player';
  coordsText: string;
  minXText: string;
  maxXText: string;
  minYText: string;
  maxYText: string;
  kText: string;
  kMode: 'incluir' | 'excluir';
  fullPopText: string;
  semiPopText: string;
  minFullsText: string;
  minSemisText: string;
  fsSort: FullSemiSortBy;
  fsKText: string;
  fsKMode: 'incluir' | 'excluir';
  fsPlayersText: string;
  /** v0.33.1: true depois da migração ÚNICA do separador legado — nick com
   *  espaço salvo no formato novo (;) NUNCA é re-migrado (P2 da revisão). */
  fsPlayersMigrated?: boolean;
  fsPlayersMode: 'incluir' | 'excluir';
  autoCollectHours: AutoCollectHours;
  fonte: 'recrutadas' | 'disponivel-agora';
  paradasTransito: 'paradas' | 'paradas-e-transito';
};

/** Unidades do conjunto OFENSIVO por padrão do contador Full/Semi. */
const OFFENSIVE_UNIT_IDS: ReadonlySet<string> = new Set(['axe', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'snob']);

/** Ks 0-99 de um texto ("55 77" → [55, 77]). */
function parseKs(text: string): number[] {
  return [...new Set((text.match(/\d{1,2}/g) ?? []).map(Number).filter((k) => k >= 0 && k <= 99))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha de comunicação com o processo principal.';
}

/** Mínimo por unidade: número inteiro >= 1; vazio/0/inválido = sem mínimo. */
function parseUnitMinimum(text: string): number | null {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/** Valor de eixo (0..999); vazio/inválido = sem filtro no eixo. */
function parseAxisValue(text: string): number | null {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value) || value < 0 || value > 999) return null;
  return value;
}

export default function Sg2Page() {
  const { push } = useToast();
  const moduleInfo = MODULES.find((module) => module.id === 'sg2');

  // Memória (persistida no processo principal; F5 não perde).
  const [troopsAt, setTroopsAt] = useState<string | null>(null);
  const [collectFailures, setCollectFailures] = useState<{ playerName: string; reason: string }[] | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [snapshot, setSnapshot] = useState<TroopSnapshot | null>(null);
  // v0.31 — fonte "Disponível na aldeia (agora)": defesa por aldeia (SG_3).
  const [defense, setDefense] = useState<DefenseSnapshot | null>(null);
  const [defenseRefreshing, setDefenseRefreshing] = useState(false);
  const [fonte, setFonte] = useState<'recrutadas' | 'disponivel-agora'>('recrutadas');
  const [paradasTransito, setParadasTransito] = useState<'paradas' | 'paradas-e-transito'>('paradas');
  // Página keep-mounted: quando escondida (.sg-page[hidden] = display:none),
  // TOASTS DAQUI são invisíveis. Fluxos em 2º plano (auto-coleta) só avisam
  // com a página visível — a TitleBar (useQueueActivity) e o journal sinalizam
  // o resto globalmente.
  const sectionRef = useRef<HTMLElement | null>(null);
  const [collecting, setCollecting] = useState<'members' | 'summary' | null>(null);
  const [progress, setProgress] = useState<QueueProgress | null>(null);
  const [actionError, setActionError] = useState('');
  // P2-23 — coleta automática agendada ('0' = desligado).
  const [autoCollectHours, setAutoCollectHours] = useState<AutoCollectHours>('0');

  // Formulário de filtro.
  const [showForm, setShowForm] = useState(false);
  const [unitInputs, setUnitInputs] = useState<Record<UnitId, string>>(emptyUnitInputs);
  const [mode, setMode] = useState<'has' | 'lacks'>('has');
  const [scope, setScope] = useState<'village' | 'player'>('village');
  const [coordsText, setCoordsText] = useState('');
  const [kText, setKText] = useState('');
  const [kMode, setKMode] = useState<'incluir' | 'excluir'>('incluir');
  // ---- Contador Full/Semi (relatório premium) + Grupos ----
  const [fullPopText, setFullPopText] = useState('18000');
  const [semiPopText, setSemiPopText] = useState('12000');
  const [minFullsText, setMinFullsText] = useState('0');
  const [minSemisText, setMinSemisText] = useState('0');
  const [fsSort, setFsSort] = useState<FullSemiSortBy>('fulls');
  const [fsUnitMode, setFsUnitMode] = useState<'ofensivas' | 'todas' | 'custom'>('ofensivas');
  const [fsCustomUnits, setFsCustomUnits] = useState<Set<string>>(new Set());
  const [fsKText, setFsKText] = useState('');
  const [fsKMode, setFsKMode] = useState<'incluir' | 'excluir'>('incluir');
  const [fsPlayersText, setFsPlayersText] = useState('');
  const [fsPlayersMode, setFsPlayersMode] = useState<'incluir' | 'excluir'>('excluir');
  const [report, setReport] = useState<FullSemiReport | null>(null);
  const [fsExpanded, setFsExpanded] = useState<Set<number>>(new Set());
  const [fullSemiBusy, setFullSemiBusy] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupPapel, setGroupPapel] = useState<'origem' | 'alvo'>('origem');
  const [groupAuthor, setGroupAuthor] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);
  const unitPopsRef = useRef<{ world: string | null; pops: Record<string, number> } | null>(null);
  const session = useSessionStatus();

  /** Snapshot da fonte ATIVA: recrutadas, ou defesa convertida ("Na Aldeia",
   *  com/sem "a caminho") — todo o filtro/agregação opera nele, sem duplicar
   *  lógica. Resumo Geral e demais painéis seguem no snapshot recrutado. */
  const snapshotConsulta = useMemo<TroopSnapshot | null>(() => {
    if (fonte !== 'disponivel-agora') return snapshot;
    if (defense === null) return null;
    return defenseToTroopSnapshot(defense, paradasTransito === 'paradas-e-transito');
  }, [fonte, defense, paradasTransito, snapshot]);

  /** Rótulo da fonte (resultado/toasts) + data da coleta que a alimenta. */
  const fonteLabel =
    fonte === 'disponivel-agora'
      ? `Disponível na aldeia (${paradasTransito === 'paradas-e-transito' ? 'paradas + a caminho' : 'agora'})`
      : 'Tropas recrutadas';
  const fonteColetadaEm = fonte === 'disponivel-agora' ? defense?.collectedAt ?? null : troopsAt;

  /** Contagem viva do filtro de jogadores (parser por ';' do v0.33 — nick com
   *  espaço/acento funciona; comparação ignora acento e maiúsculas). */
  const fsPlayersParsed = useMemo(() => parsePlayerNames(fsPlayersText), [fsPlayersText]);
  const fsPlayersLabel =
    fsPlayersParsed.names.length === 0
      ? '0 jogadores — separe por ; (a comparação ignora acento e maiúsculas)'
      : `${fsPlayersParsed.names.length} jogador(es) no filtro${fsPlayersParsed.duplicatesRemoved > 0 ? ` · ${fsPlayersParsed.duplicatesRemoved} duplicado(s) ignorado(s)` : ''}`;

  /** Unidades presentes no snapshot (ordem do formulário, depois as demais). */
  const snapshotUnitIds = useMemo<string[]>(() => {
    if (snapshotConsulta === null) return [];
    const present = new Set<string>();
    for (const entry of snapshotConsulta.entries) {
      for (const [unit, count] of Object.entries(entry.units)) {
        if (count > 0) present.add(unit);
      }
    }
    const ordered: string[] = FILTER_UNIT_ORDER.filter((id) => present.has(id));
    for (const unit of [...present].sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
      if (!ordered.includes(unit)) ordered.push(unit);
    }
    return ordered;
  }, [snapshotConsulta]);

  /** IDs contabilizados no modo atual (undefined = todas as unidades). */
  function fsUnitIds(): string[] | undefined {
    if (fsUnitMode === 'todas') return undefined;
    if (fsUnitMode === 'ofensivas') return snapshotUnitIds.filter((id) => OFFENSIVE_UNIT_IDS.has(id));
    return fsCustomUnits.size > 0 ? [...fsCustomUnits] : undefined;
  }
  const [minXText, setMinXText] = useState('');
  const [maxXText, setMaxXText] = useState('');
  const [minYText, setMinYText] = useState('');
  const [maxYText, setMaxYText] = useState('');

  // Preferências do módulo: os formulários sobrevivem a F5/reinício.
  const { prefs, savePrefs, resetPrefs } = usePreferences<Sg2Prefs>('sg2', {
    unitInputs: emptyUnitInputs(),
    mode: 'has',
    scope: 'village',
    coordsText: '',
    minXText: '',
    maxXText: '',
    minYText: '',
    maxYText: '',
    kText: '',
    kMode: 'incluir',
    fullPopText: '18000',
    semiPopText: '12000',
    minFullsText: '0',
    minSemisText: '0',
    fsSort: 'fulls',
    fsKText: '',
    fsKMode: 'incluir',
    fsPlayersText: '',
    fsPlayersMode: 'excluir',
    autoCollectHours: '0',
    fonte: 'recrutadas',
    paradasTransito: 'paradas',
  });

  // Hidratação única: aplica o que veio do store sobre os estados do formulário.
  const prefsHydrated = useRef(false);
  useEffect(() => {
    if (prefs === null || prefsHydrated.current) return;
    prefsHydrated.current = true;
    if (prefs.unitInputs !== undefined) setUnitInputs({ ...emptyUnitInputs(), ...prefs.unitInputs });
    if (prefs.mode !== undefined) setMode(prefs.mode);
    if (prefs.scope !== undefined) setScope(prefs.scope);
    if (prefs.coordsText !== undefined) setCoordsText(prefs.coordsText);
    if (prefs.minXText !== undefined) setMinXText(prefs.minXText);
    if (prefs.maxXText !== undefined) setMaxXText(prefs.maxXText);
    if (prefs.minYText !== undefined) setMinYText(prefs.minYText);
    if (prefs.maxYText !== undefined) setMaxYText(prefs.maxYText);
    if (prefs.kText !== undefined) setKText(prefs.kText);
    if (prefs.kMode !== undefined) setKMode(prefs.kMode);
    if (prefs.fullPopText !== undefined) setFullPopText(prefs.fullPopText);
    if (prefs.semiPopText !== undefined) setSemiPopText(prefs.semiPopText);
    if (prefs.minFullsText !== undefined) setMinFullsText(prefs.minFullsText);
    if (prefs.minSemisText !== undefined) setMinSemisText(prefs.minSemisText);
    if (prefs.fsSort !== undefined) setFsSort(prefs.fsSort);
    if (prefs.fsKText !== undefined) setFsKText(prefs.fsKText);
    if (prefs.fsKMode !== undefined) setFsKMode(prefs.fsKMode);
    if (prefs.fsPlayersText !== undefined) {
      // Migração ÚNICA do legado pré-v0.33 (lista por ESPAÇO): no formato
      // antigo nick com espaço nunca funcionou, então texto com espaço e sem
      // ";" só pode ser lista multi-nick. A flag grava que já migramos — sem
      // ela, nick COM espaço salvo no formato novo seria re-quebrado a cada
      // boot (P2 da revisão integrada v0.33.1).
      if (prefs.fsPlayersMigrated === true) {
        setFsPlayersText(prefs.fsPlayersText);
      } else {
        const migrated = migrateLegacyNamesText(prefs.fsPlayersText);
        setFsPlayersText(migrated);
        savePrefs({ fsPlayersText: migrated, fsPlayersMigrated: true });
      }
    }
    if (prefs.fsPlayersMode !== undefined) setFsPlayersMode(prefs.fsPlayersMode);
    if (prefs.autoCollectHours !== undefined) setAutoCollectHours(normalizeAutoCollect(prefs.autoCollectHours));
    if (prefs.fonte === 'disponivel-agora') setFonte('disponivel-agora');
    if (prefs.paradasTransito === 'paradas-e-transito') setParadasTransito('paradas-e-transito');
  }, [prefs]);

  // Persistência por campo (só depois de hidratado, para não sobrescrever o stored).
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ unitInputs });
  }, [unitInputs, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ mode });
  }, [mode, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ scope });
  }, [scope, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ coordsText });
  }, [coordsText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ minXText });
  }, [minXText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ maxXText });
  }, [maxXText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ minYText });
  }, [minYText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ maxYText });
  }, [maxYText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ kText });
  }, [kText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ kMode });
  }, [kMode, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ fullPopText });
  }, [fullPopText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ semiPopText });
  }, [semiPopText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ minFullsText });
  }, [minFullsText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ minSemisText });
  }, [minSemisText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ fsSort });
  }, [fsSort, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ fsKText });
  }, [fsKText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ fsKMode });
  }, [fsKMode, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ fsPlayersText });
  }, [fsPlayersText, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ fsPlayersMode });
  }, [fsPlayersMode, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ autoCollectHours });
  }, [autoCollectHours, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ fonte });
  }, [fonte, savePrefs]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ paradasTransito });
  }, [paradasTransito, savePrefs]);

  // Resultado.
  const [result, setResult] = useState<Sg2FilterResult | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Carrega o que já está em memória ao abrir a página.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.staffhub.troops.status(),
      window.staffhub.troops.get('troops'),
      window.staffhub.troops.getDefense(),
    ])
      .then(([status, stored, storedDefense]) => {
        if (cancelled) return;
        setTroopsAt(status.troopsAt);
        setSnapshot(stored);
        setDefense(storedDefense);
      })
      .catch((error) => {
        if (cancelled) return;
        // Sem sessão do JOGO os canais protegidos recusam no boot — é o estado
        // esperado do app recém-aberto, não um erro digno de toast (o callout
        // da própria página orienta). Com sessão ativa, aí sim avisa.
        if (session.state === 'logged-in') {
          push('error', errorMessage(error));
        } else {
          console.warn('[sg2] leitura inicial sem sessão do jogo:', error);
        }
      });
    return () => {
      cancelled = true;
    };
    // session.state nas deps: re-lê a memória quando a sessão do jogo muda de
    // estado (login novo) e o toast de falha funciona no 1º boot logado (antes
    // o efeito fechava sobre state 'unknown' e o ramo do toast era morto — P3
    // da revisão integrada).
  }, [push, session.state]);

  // Progresso das coletas do processo principal.
  useEffect(() => {
    const unsubscribe = window.staffhub.events.onQueueProgress(setProgress);
    return unsubscribe;
  }, []);

  async function refreshMemory(): Promise<TroopSnapshot | null> {
    const [status, stored] = await Promise.all([
      window.staffhub.troops.status(),
      window.staffhub.troops.get('troops'),
    ]);
    setTroopsAt(status.troopsAt);
    setSnapshot(stored);
    return stored;
  }

  async function startCollect(kind: 'members' | 'summary', options?: { silent?: boolean }): Promise<void> {
    if (collecting !== null) return;
    setCollecting(kind);
    setProgress(null);
    if (options?.silent !== true) setActionError('');
    if (options?.silent !== true) setResult(null);
    try {
      await (kind === 'members'
        ? window.staffhub.troops.collectMembers('troops')
        : window.staffhub.troops.collectSummary('troops'));
      const stored = await refreshMemory();
      const failed = stored?.failures ?? [];
      setShowSummary(true);
      // Roadmap 19 — histórico: cada coleta POR MEMBRO bem-sucedida arquiva uma
      // versão. Fail-soft de propósito: falha no arquivamento não derruba a
      // coleta nem o toast de sucesso (e o ok não gera toast extra — a seção
      // "Histórico e Evolução" mostra o resultado).
      if (kind === 'members' && stored !== null) {
        void window.staffhub.troopsHistory.archive(stored).catch((error: unknown) => {
          console.warn('Falha ao arquivar versão do histórico de tropas:', error);
        });
      }
      if (failed.length > 0) {
        push('info', `Coleta concluída com ${failed.length} membro(s) com erro — lista abaixo do painel de memória.`);
        setCollectFailures(failed);
      } else {
        push('ok', kind === 'members' ? 'Coleta de tropas concluída — dados em memória atualizados.' : 'Resumo coletado — dados em memória atualizados.');
        setCollectFailures(null);
      }
    } catch (error) {
      const message = errorMessage(error);
      // Fila ocupada por MUTAÇÃO (que não emite progresso): o disparo
      // automático tenta de novo no próximo tick — sem spam de erro.
      if (options?.silent === true && /opera..o .*em andamento|Uma opera/i.test(message)) {
        return;
      }
      setActionError(message);
      push('error', message);
    } finally {
      setCollecting(null);
    }
  }

  // ===== P2-23 — Coleta automática agendada (100% renderer) =====
  // A página é keep-mounted, então o intervalo vive enquanto o app estiver
  // aberto. A cada 5 minutos avalia: intervalo ativado + sessão logada + fila
  // livre (collecting/progress nulos) + intervalo vencido desde a ÚLTIMA
  // coleta — referência `troopsAt` quando existir, senão o instante do mount
  // (app recém-aberto sem dados espera um intervalo inteiro antes de coletar;
  // com dados frescos < intervalo, não dispara). Pacing/single-flight vêm do
  // próprio fluxo de startCollect.
  const autoRunningRef = useRef(false);
  const lastAutoCheckRef = useRef(0);
  const mountedAtRef = useRef(Date.now());
  // Espelhos da última renderização: o intervalo criado uma única vez nunca
  // fecha sobre valores velhos (e não precisa re-assinar a cada mudança).
  const startCollectRef = useRef(startCollect);
  startCollectRef.current = startCollect;
  const pushRef = useRef(push);
  pushRef.current = push;
  const autoStateRef = useRef({ autoCollectHours, collecting, progress, session, troopsAt });
  autoStateRef.current = { autoCollectHours, collecting, progress, session, troopsAt };


  function autoCollectTick(): void {
    const now = Date.now();
    lastAutoCheckRef.current = now;
    const current = autoStateRef.current;
    const hours = Number(current.autoCollectHours);
    if (!Number.isFinite(hours) || hours <= 0) return;
    if (current.session.state !== 'logged-in') return;
    // Fila ocupada só quando a operação AINDA corre (done < total): o último
    // evento de progresso permanece done=total após a conclusão — tratá-lo
    // como ocupado travava o agendador para sempre após a 1ª operação.
    const progressActive =
      current.progress !== null && current.progress.done < current.progress.total;
    if (current.collecting !== null || progressActive) return;
    if (autoRunningRef.current) return;
    const lastMs = current.troopsAt !== null ? Date.parse(current.troopsAt) : Number.NaN;
    const base = Number.isFinite(lastMs) ? lastMs : mountedAtRef.current;
    if (now - base < hours * 60 * 60 * 1000) return;
    autoRunningRef.current = true;
    pushRef.current('info', 'Coleta automática disparada (agendada).');
    void startCollectRef.current('members', { silent: true }).finally(() => {
      autoRunningRef.current = false;
    });
  }
  const autoTickRef = useRef(autoCollectTick);
  autoTickRef.current = autoCollectTick;

  // Um único intervalo com cleanup — seguro no StrictMode (setup→cleanup→setup
  // deixa exatamente um timer; autoRunningRef blinda qualquer disparo duplo).
  useEffect(() => {
    const interval: ReturnType<typeof setInterval> = setInterval(() => autoTickRef.current(), AUTO_COLLECT_TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, []);

  async function exhibit(): Promise<void> {
    try {
      const stored = await refreshMemory();
      // Sem setResult(null): exibir o resumo NÃO pode descartar um resultado
      // de consulta/fulls-semis que o usuário já tem na tela.
      if (stored === null) {
        push('info', 'Nada em memória — colete as informações de tropas primeiro.');
        setShowSummary(false);
        return;
      }
      setShowSummary(true);
      push('ok', 'Memória carregada — resumo geral abaixo.');
    } catch (error) {
      push('error', errorMessage(error));
    }
  }

  function buildFilters(): Sg2Filters {
    const filters: Sg2Filters = { mode: mode === 'has' ? 'possuem' : 'nao-possuem', scope: scope === 'village' ? 'aldeia' : 'jogador' };
    const minimums: UnitCounts = {};
    for (const id of FILTER_UNIT_ORDER) {
      const value = parseUnitMinimum(unitInputs[id] ?? '');
      if (value !== null) minimums[id] = value;
    }
    if (Object.keys(minimums).length > 0) filters.unitMinimums = minimums;
    const coords = parseCoordList(coordsText);
    if (coords.length > 0) filters.coordsFilter = coords;
    const axesRange: AxesRange = {};
    const minX = parseAxisValue(minXText);
    const maxX = parseAxisValue(maxXText);
    const minY = parseAxisValue(minYText);
    const maxY = parseAxisValue(maxYText);
    if (minX !== null) axesRange.minX = minX;
    if (maxX !== null) axesRange.maxX = maxX;
    if (minY !== null) axesRange.minY = minY;
    if (maxY !== null) axesRange.maxY = maxY;
    if (Object.keys(axesRange).length > 0) filters.axesRange = axesRange;
    const ks = [...new Set((kText.match(/\d{1,2}/g) ?? []).map((value) => Number(value)).filter((k) => k >= 0 && k <= 99))];
    if (ks.length > 0) filters.kFilter = { ks, mode: kMode };
    return filters;
  }

  /** Recarrega a defesa em memória (mesma coleta do SG_3 — sem fetch novo). */
  async function refreshDefense(): Promise<DefenseSnapshot | null> {
    const storedDefense = await window.staffhub.troops.getDefense();
    setDefense(storedDefense);
    return storedDefense;
  }

  /** Botão "Atualizar da memória": puxa a coleta mais recente guardada no app
   *  (feita aqui ou no SG_3) sem recoletar — e invalida o resultado da fonte
   *  nova (nunca misturar listas de coletas diferentes). */
  async function refreshDefenseFromMemory(): Promise<void> {
    if (defenseRefreshing) return;
    setDefenseRefreshing(true);
    try {
      const stored = await refreshDefense();
      if (fonte === 'disponivel-agora') {
        setResult(null);
        setActionError('');
      }
      push(
        stored !== null
          ? 'ok'
          : 'info',
        stored !== null
          ? `Defesa atualizada da memória (coleta de ${new Date(stored.collectedAt).toLocaleString('pt-BR')}).`
          : 'Sem defesa em memória neste mundo — colete na Análise de Defesa (SG_3) ou pelo botão "Coletar defesa agora".',
      );
    } catch (error) {
      push('error', errorMessage(error));
    } finally {
      setDefenseRefreshing(false);
    }
  }

  /** Coleta da defesa por aldeia (botão do gate) — reusa o fluxo de coleta
   *  existente com kind='defense' (pacing, progresso e journal idênticos). */
  async function startDefenseCollect(): Promise<void> {
    if (collecting !== null) return;
    setCollecting('members');
    setProgress(null);
    setActionError('');
    try {
      const coletado = await window.staffhub.troops.collectMembers('defense');
      const stored = await refreshDefense();
      const failed = coletado.failures ?? [];
      if (stored === null || stored.entries.length === 0) {
        push(
          'error',
          failed.length > 0
            ? `A coleta de defesa terminou sem dados (${failed.length} membro(s) com erro) — confira a sessão do jogo.`
            : 'A coleta de defesa terminou sem dados — confira a sessão do jogo.',
        );
        if (failed.length > 0) setCollectFailures(failed);
      } else if (failed.length > 0) {
        push('info', `Defesa coletada: ${stored.entries.length} aldeia(s), com ${failed.length} membro(s) em erro — lista abaixo do painel de memória.`);
        setCollectFailures(failed);
      } else {
        push('ok', `Defesa coletada: ${stored.entries.length} aldeia(s) — a fonte "Disponível na aldeia" já pode ser usada.`);
        setCollectFailures(null);
      }
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      push('error', message);
    } finally {
      setCollecting(null);
      setProgress(null);
    }
  }

  /** Trocar fonte/contagem invalida o resultado (nunca misturar listas). */
  function trocarFonte(next: 'recrutadas' | 'disponivel-agora'): void {
    setFonte(next);
    setResult(null);
    setActionError('');
  }
  function trocarContagem(next: 'paradas' | 'paradas-e-transito'): void {
    setParadasTransito(next);
    setResult(null);
    setActionError('');
  }

  function runQuery(): void {
    if (snapshotConsulta === null) {
      const message =
        fonte === 'disponivel-agora'
          ? 'Colete primeiro a defesa por aldeia (Análise de Defesa / botão abaixo) — sem ela não há como medir as tropas disponíveis agora.'
          : 'Colete primeiro — não há dados de tropas em memória.';
      setActionError(message);
      push('error', message);
      return;
    }
    try {
      const next = filterTroops(snapshotConsulta, buildFilters());
      setResult(next);
      setExpanded(new Set());
      setActionError('');
      push('ok', `Consulta concluída: ${next.totalVillages} aldeia(s) no filtro.`);
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      push('error', message);
    }
  }

  function toggleRow(index: number): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  /** Entradas do snapshot restritas ao resultado da filtragem corrente. */
  function resultEntries(): { playerName: string; coord: { x: number; y: number }; units: Record<string, number> }[] {
    if (snapshotConsulta === null || result === null) return [];
    const porJogador = new Map(result.players.map((player) => [player.playerName, new Set(player.coords)]));
    return snapshotConsulta.entries
      .filter((entry) => entry.coord.x >= 0)
      .filter((entry) => porJogador.get(entry.playerName)?.has(`${entry.coord.x}|${entry.coord.y}`) === true)
      .map((entry) => ({ playerName: entry.playerName, coord: entry.coord, units: entry.units as Record<string, number> }));
  }

  async function runFullSemi(): Promise<void> {
    if (result === null || snapshotConsulta === null) return;
    const fullPop = Number(fullPopText);
    const semiPop = Number(semiPopText);
    setFullSemiBusy(true);
    try {
      // Populações por unidade DO MUNDO ATUAL — páginas nunca desmontam, então
      // o cache guarda o mundo: trocar de sessão refaz o fetch (nunca classificar
      // FULL/SEMI com a tabela do mundo antigo).
      if (unitPopsRef.current === null || unitPopsRef.current.world !== session.world) {
        unitPopsRef.current = { world: session.world, pops: await window.staffhub.world.unitPops() };
      }
      const ks = parseKs(fsKText);
      const names = parsePlayerNames(fsPlayersText).names;
      const units = fsUnitIds();
      if (units !== undefined && units.length === 0) {
        // 'ofensivas' sem nenhuma unidade ofensiva no snapshot (ou custom vazio):
        // [] significaria TODAS na engine — inverteria a escolha em silêncio.
        throw new Error('Nenhuma unidade contabilizável selecionada (o snapshot não tem unidades desse conjunto?) — use "todas as unidades" ou marque unidades no personalizado.');
      }
      const next = fullSemiReport(
        { entries: resultEntries(), popByUnit: unitPopsRef.current?.pops ?? {} },
        {
          fullPop,
          semiPop,
          ...(units !== undefined ? { unitIds: units } : {}),
          ...(ks.length > 0 ? { kFilter: { ks, mode: fsKMode } } : {}),
          ...(names.length > 0 ? { playerFilter: { names, mode: fsPlayersMode } } : {}),
          sortBy: fsSort,
          minFulls: Number.isFinite(Number(minFullsText)) ? Math.max(0, Math.round(Number(minFullsText))) : 0,
          minSemis: Number.isFinite(Number(minSemisText)) ? Math.max(0, Math.round(Number(minSemisText))) : 0,
        },
      );
      setReport(next);
      setFsExpanded(new Set());
      push('ok', `Contagem pronta: ${next.totals.players} jogador(es), ${next.totals.fulls} full(s), ${next.totals.semis} semi(s).`);
    } catch (error) {
      const message = errorMessage(error);
      push('error', message);
    } finally {
      setFullSemiBusy(false);
    }
  }

  /** Critério PT-BR dos filtros atuais — vai congelado no grupo. */
  function criterioText(): string {
    const parts: string[] = [];
    const minimums = buildFilters().unitMinimums ?? {};
    const minDesc = Object.entries(minimums).map(([unit, min]) => `${min}+ ${UNITS[unit as UnitId]?.name ?? unit}`).join(', ');
    if (minDesc !== '') parts.push(mode === 'has' ? `possui ${minDesc}` : `não possui ${minDesc}`);
    const ks = parseKs(kText);
    if (ks.length > 0) parts.push(`K consulta ${kMode} ${ks.join(',')}`);
    if (coordsText.trim() !== '') parts.push('lista de coordenadas');
    const fsKs = parseKs(fsKText);
    if (fsKs.length > 0) parts.push(`K contador ${fsKMode} ${fsKs.join(',')}`);
    const units = fsUnitIds();
    if (units !== undefined) parts.push(`unidades: ${units.map((id) => UNITS[id as UnitId]?.name ?? id).join('+')}`);
    const fsNames = parsePlayerNames(fsPlayersText).names;
    if (fsNames.length > 0) parts.push(`jogadores ${fsPlayersMode} ${fsNames.join(',')}`);
    const minF = Number(minFullsText);
    const minS = Number(minSemisText);
    if (Number.isFinite(minF) && minF > 0) parts.push(`mín ${minF} full(s)`);
    if (Number.isFinite(minS) && minS > 0) parts.push(`mín ${minS} semi(s)`);
    parts.push(`FULL≥${fullPopText}, SEMI≥${semiPopText}`);
    return parts.join('; ');
  }

  async function saveGroup(): Promise<void> {
    if (result === null) return;
    const nome = groupName.trim();
    if (nome === '') {
      push('error', 'Dê um nome ao grupo antes de salvar.');
      return;
    }
    const mundo = session.world ?? '';
    if (mundo === '') {
      push('error', 'Sessão sem mundo identificado — faça login antes de salvar o grupo.');
      return;
    }
    setGroupBusy(true);
    try {
      // Sem contador rodado: agrupa sem fulls/semis (0/0) com as coords do
      // resultado; com contador: congelam as contagens e as coords full→semi.
      const perPlayer = report !== null
        ? report.players.map((player) => ({
            playerName: player.playerName,
            fulls: player.fulls,
            semis: player.semis,
            coords: player.villages.map((village) => village.coord),
          }))
        : result.players.map((player) => ({
            playerName: player.playerName,
            fulls: 0,
            semis: 0,
            coords: player.coords,
          }));
      const entry = await window.staffhub.groups.save({
        nome,
        mundo,
        autor: groupAuthor.trim() === '' ? (session.player ?? 'staff') : groupAuthor.trim(),
        papel: groupPapel,
        coords: perPlayer.flatMap((player) => player.coords),
        perPlayer,
        criterio: criterioText(),
      });
      push('ok', `Grupo "${entry.nome}" salvo (${entry.coords.length} coordenadas) — disponível na Sala de Guerra.`);
    } catch (error) {
      push('error', errorMessage(error));
    } finally {
      setGroupBusy(false);
    }
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      push('ok', 'Copiado para a área de transferência.');
    } catch {
      push('error', 'Não foi possível copiar — selecione e use Ctrl+C.');
    }
  }

  async function copySummary(): Promise<void> {
    if (result === null) return;
    const text = playersSummary(result);
    if (text.trim() === '') {
      push('info', 'Sem resultados para copiar.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      push('ok', 'Resumo copiado (nick;qtde;coords).');
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  function updateUnitInput(id: UnitId, value: string): void {
    setUnitInputs((current) => ({ ...current, [id]: value }));
  }

  /**
   * Aplica um preset da consulta nos estados do formulário — NÃO roda a consulta
   * (o usuário confere os campos e clica em "Realizar Consulta").
   */
  function applyConsultaPreset(fields: Record<string, string>): void {
    // unitInputs viaja como JSON dentro do preset (presets só aceitam
    // string→string): parse com try/catch — lixo/ausente vira {} e os mínimos
    // de unidade ficam vazios; o resto do preset é aplicado normalmente.
    let unitsBrutos: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(fields['unitInputs'] ?? '{}');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        unitsBrutos = parsed as Record<string, unknown>;
      }
    } catch {
      unitsBrutos = {};
    }
    const nextUnits = emptyUnitInputs();
    for (const id of FILTER_UNIT_ORDER) {
      const value = unitsBrutos[id];
      if (typeof value === 'string') nextUnits[id] = value;
    }
    setUnitInputs(nextUnits);
    if (fields['mode'] === 'has' || fields['mode'] === 'lacks') setMode(fields['mode']);
    if (fields['scope'] === 'village' || fields['scope'] === 'player') setScope(fields['scope']);
    if (typeof fields['coordsText'] === 'string') setCoordsText(fields['coordsText']);
    if (typeof fields['minXText'] === 'string') setMinXText(fields['minXText']);
    if (typeof fields['maxXText'] === 'string') setMaxXText(fields['maxXText']);
    if (typeof fields['minYText'] === 'string') setMinYText(fields['minYText']);
    if (typeof fields['maxYText'] === 'string') setMaxYText(fields['maxYText']);
    if (typeof fields['kText'] === 'string') setKText(fields['kText']);
    if (fields['kMode'] === 'incluir' || fields['kMode'] === 'excluir') setKMode(fields['kMode']);
    // Fonte/contagem do preset invalidam o resultado quando MUDAM (mesma
    // invariante dos radios — nunca misturar listas de fontes diferentes).
    const nextFonte = fields['fonte'] === 'disponivel-agora' ? 'disponivel-agora' : 'recrutadas';
    const nextContagem = fields['paradasTransito'] === 'paradas-e-transito' ? 'paradas-e-transito' : 'paradas';
    if (nextFonte !== fonte) trocarFonte(nextFonte);
    if (nextContagem !== paradasTransito) trocarContagem(nextContagem);
  }

  /**
   * Aplica um preset do contador Full/Semi nos estados do painel — NÃO roda a
   * contagem ("Contar Full/Semi" continua manual).
   */
  function applyFullSemiPreset(fields: Record<string, string>): void {
    if (typeof fields['fullPopText'] === 'string') setFullPopText(fields['fullPopText']);
    if (typeof fields['semiPopText'] === 'string') setSemiPopText(fields['semiPopText']);
    if (typeof fields['minFullsText'] === 'string') setMinFullsText(fields['minFullsText']);
    if (typeof fields['minSemisText'] === 'string') setMinSemisText(fields['minSemisText']);
    if (typeof fields['fsKText'] === 'string') setFsKText(fields['fsKText']);
    if (typeof fields['fsPlayersText'] === 'string') {
      // Presets salvos antes da v0.33 podem ter lista por espaço (legado).
      setFsPlayersText(migrateLegacyNamesText(fields['fsPlayersText']));
    }
    if (fields['fsKMode'] === 'incluir' || fields['fsKMode'] === 'excluir') setFsKMode(fields['fsKMode']);
    if (fields['fsPlayersMode'] === 'incluir' || fields['fsPlayersMode'] === 'excluir') {
      setFsPlayersMode(fields['fsPlayersMode']);
    }
  }

  /** Volta os formulários aos padrões e apaga as preferências persistidas do módulo. */
  function resetFormPrefs(): void {
    setUnitInputs(emptyUnitInputs());
    setMode('has');
    setScope('village');
    setCoordsText('');
    setMinXText('');
    setMaxXText('');
    setMinYText('');
    setMaxYText('');
    setKText('');
    setKMode('incluir');
    setFullPopText('18000');
    setSemiPopText('12000');
    setMinFullsText('0');
    setMinSemisText('0');
    setFsSort('fulls');
    setFsKText('');
    setFsKMode('incluir');
    setFsPlayersText('');
    setFsPlayersMode('excluir');
    setAutoCollectHours('0');
    setFonte('recrutadas');
    setParadasTransito('paradas');
    void resetPrefs();
  }

  const updatedLabel =
    troopsAt !== null ? new Date(troopsAt).toLocaleString('pt-BR') : 'Nunca coletado';

  /** "Próxima coleta automática": última coleta (ou mount) + intervalo; '—' desligado. */
  const nextAutoCollectLabel = useMemo(() => {
    const hours = Number(autoCollectHours);
    if (!Number.isFinite(hours) || hours <= 0) return '— (desligada)';
    const lastMs = troopsAt !== null ? Date.parse(troopsAt) : Number.NaN;
    const base = Number.isFinite(lastMs) ? lastMs : mountedAtRef.current;
    const next = base + hours * 60 * 60 * 1000;
    return Number.isFinite(next)
      ? `~${new Date(next).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
      : '—';
  }, [autoCollectHours, troopsAt]);

  return (
    <section className="page" ref={sectionRef}>
      <PageHeader
        kicker={moduleInfo !== undefined ? `Módulo ${moduleInfo.id.toUpperCase()} — Fase ${moduleInfo.phase}` : 'Módulo SG2 — Fase 2'}
        title={moduleInfo?.originalLabel ?? 'Análise de Tropas das Aldeias'}
        description="Coleta as tropas recrutadas de cada aldeia da tribo (com progresso e memória local), filtra por unidade, escopo, coordenadas e eixos — e classifica ofensivas vs defensivas sem filtro de tropas."
      />

      {/* Padrão das páginas de módulo (SG_1/SG_3): restaurar sempre visível,
          na mesma âncora abaixo do cabeçalho — inclusive sem dados em memória. */}
      <div className="row">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={resetFormPrefs}
        >
          Restaurar padrões do módulo
        </button>
      </div>

      {collectFailures !== null && (
        <section className="page-section" aria-label="Membros com erro na coleta">
          <div className="card">
            <div className="card-header"><h2 className="card-title">Membros com erro na última coleta ({collectFailures.length})</h2></div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Membro</th><th>Motivo</th></tr></thead>
                <tbody>
                  {collectFailures.map((failure) => (
                    <tr key={failure.playerName}><td className="cell-nowrap">{failure.playerName}</td><td className="cell-detail muted">{failure.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">Os demais membros foram coletados normalmente — filtro e classificação usam o que veio.</p>
          </div>
        </section>
      )}

      {/* ===== Painel Dados em Memória ===== */}
      <section className="page-section" aria-labelledby="sg2-memory-title">
        <h2 className="section-title" id="sg2-memory-title">Dados em Memória</h2>
        <div className="card">
          <div className="card-body">
            <div className="sg2-memory-bar">
              <p className="sg2-memory-date muted">
                Data da última atualização: <strong>{updatedLabel}</strong>
              </p>
              <div className="sg2-memory-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void exhibit()}
                  disabled={collecting !== null || snapshot === null}
                >
                  <Eye size={14} aria-hidden="true" />
                  Exibir Dados
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void startCollect('members')}
                  disabled={collecting !== null}
                >
                  {collecting === 'members' ? (
                    <span className="btn-spinner" aria-hidden="true" />
                  ) : (
                    <Users size={14} aria-hidden="true" />
                  )}
                  Coletar Informações de Tropas
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void startCollect('summary')}
                  disabled={collecting !== null}
                >
                  {collecting === 'summary' ? (
                    <span className="btn-spinner" aria-hidden="true" />
                  ) : (
                    <Layers size={14} aria-hidden="true" />
                  )}
                  Coletar Resumo (1 requisição)
                </button>
              </div>
            </div>
            <div className="sg2-memory-bar" style={{ marginTop: 12 }}>
              <label className="field">
                <span className="field-label">Coleta automática</span>
                <select
                  className="select"
                  value={autoCollectHours}
                  aria-label="Intervalo da coleta automática de tropas"
                  onChange={(event) => setAutoCollectHours(normalizeAutoCollect(event.target.value))}
                >
                  <option value="0">Desligado</option>
                  <option value="4">A cada 4 horas</option>
                  <option value="6">A cada 6 horas</option>
                  <option value="12">A cada 12 horas</option>
                  <option value="24">A cada 24 horas</option>
                </select>
              </label>
              {/* Espelha a estrutura do field ao lado (label em cima, valor em
                  baixo): alinha na mesma linha do select, não no fundo da caixa. */}
              <div className="field sg2-next-autocollect">
                <span className="field-label">Próxima coleta automática</span>
                <p className="sg2-memory-date">
                  <strong>{nextAutoCollectLabel}</strong>
                </p>
              </div>
            </div>
            <p className="hint-note muted">
              A coleta completa percorre todos os membros da tribo com pacing humano — quanto
              maior a tribo, mais demorada. Prefira o resumo (1 requisição) para uma visão rápida.
              A coleta automática dispara a versão completa quando o intervalo vence e a sessão
              está ativa.
            </p>
            {collecting !== null && progress !== null && (
              <div className="sg2-progress">
                <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
              </div>
            )}
          </div>
        </div>
      </section>

      {showSummary && snapshot !== null && (
        <MemorySummarySection
          snapshot={snapshot}
          collectedLabel={new Date(snapshot.collectedAt).toLocaleString('pt-BR')}
          sourceLabel={snapshot.source === 'summary' ? 'resumo (por jogador)' : 'por aldeia (por membro)'}
        />
      )}

      {/* Roadmap 19 — histórico de coletas: autossuficiente (sem props), lê o
          histórico arquivado pelas coletas por membro e compara duas versões. */}
      <HistoryEvolutionSection />

      {actionError !== '' && (
        <div className="callout callout--danger">
          <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
          <div className="callout-body">
            <p className="callout-title">Falha na operação</p>
            <p>{actionError}</p>
          </div>
        </div>
      )}

      {snapshot === null && defense === null ? (
        <div className="card">
          <EmptyState
            icon={Swords}
            title="Nenhuma coleta em memória"
            hint='O painel começa vazio: colete as informações de tropas (membro a membro, com progresso) para os filtros completos — ou a defesa por aldeia (mesma coleta do SG_3) para já usar a fonte "Disponível na aldeia (agora)". Depois da coleta, o formulário abre com mínimo por unidade, jogadores (por ";"), coordenadas, K e eixos.'
            action={
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void startCollect('members')}
                  disabled={collecting !== null}
                >
                  <Users size={14} aria-hidden="true" />
                  Coletar tropas agora
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void startDefenseCollect()}
                  disabled={collecting !== null}
                >
                  Coletar defesa (SG_3)
                </button>
              </div>
            }
          />
        </div>
      ) : (
        <>
          {/* ===== Realizar Filtro de Tropas ===== */}
          <section className="page-section" aria-labelledby="sg2-filter-title">
            <div className="sg2-filter-head">
              <h2 className="section-title" id="sg2-filter-title">Realizar Filtro de Tropas</h2>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-expanded={showForm}
                onClick={() => setShowForm((visible) => !visible)}
              >
                {showForm ? 'Ocultar filtros' : 'Abrir filtros'}
                <ChevronDown
                  size={14}
                  aria-hidden="true"
                  className={showForm ? 'sg2-chevron sg2-chevron--open' : 'sg2-chevron'}
                />
              </button>
            </div>

            {showForm && (
              <div className="card">
                <div className="card-body">
                  {/* Preset FORA do form de propósito — Enter no input de nome
                      não pode submeter o formulário e rodar a consulta. */}
                  <div className="sg2-span-2">
                    <PresetManager
                      module="sg2"
                      scope="consulta"
                      label="da consulta"
                      currentFields={{
                        // unitInputs é objeto: viaja serializado como JSON (presets
                        // só aceitam string→string); o onApply refaz com JSON.parse.
                        unitInputs: JSON.stringify(unitInputs),
                        mode,
                        scope,
                        coordsText,
                        minXText,
                        maxXText,
                        minYText,
                        maxYText,
                        kText,
                        kMode,
                        fonte,
                        paradasTransito,
                      }}
                      onApply={applyConsultaPreset}
                    />
                  </div>
                  <form
                    className="sg2-filter-grid"
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      runQuery();
                    }}
                  >
                    <fieldset className="sg2-fieldset sg2-span-2">
                      <legend className="field-label">Fonte das tropas</legend>
                      <div className="sg2-radio-row">
                        <label className="checkbox-field" data-tip="Tropas RECRUTADAS da aldeia, onde quer que estejam (em casa, apoiando fora, em ataque). É a fonte usada desde sempre.">
                          <input
                            type="radio"
                            name="sg2-fonte"
                            value="recrutadas"
                            checked={fonte === 'recrutadas'}
                            onChange={() => trocarFonte('recrutadas')}
                          />
                          <span>Tropas recrutadas (total de aldeia)</span>
                        </label>
                        <label className="checkbox-field" data-tip="Tropas FISICAMENTE na aldeia neste momento (a linha Na Aldeia da defesa), INCLUINDO apoio recebido de outros jogadores — enxerga a defesa parada na back.">
                          <input
                            type="radio"
                            name="sg2-fonte"
                            value="disponivel-agora"
                            checked={fonte === 'disponivel-agora'}
                            onChange={() => trocarFonte('disponivel-agora')}
                          />
                          <span>Disponível na aldeia (agora)</span>
                        </label>
                      </div>
                    </fieldset>

                    {fonte === 'disponivel-agora' && (
                      <>
                        <fieldset className="sg2-fieldset">
                          <legend className="field-label">Contagem</legend>
                          <div className="sg2-radio-row">
                            <label className="checkbox-field" data-tip="Só as tropas paradas na aldeia agora (sem as que estão chegando).">
                              <input
                                type="radio"
                                name="sg2-contagem"
                                value="paradas"
                                checked={paradasTransito === 'paradas'}
                                onChange={() => trocarContagem('paradas')}
                              />
                              <span>Paradas (só Na Aldeia)</span>
                            </label>
                            <label className="checkbox-field" data-tip="Soma também o apoio a caminho (tropas chegando à aldeia).">
                              <input
                                type="radio"
                                name="sg2-contagem"
                                value="paradas-e-transito"
                                checked={paradasTransito === 'paradas-e-transito'}
                                onChange={() => trocarContagem('paradas-e-transito')}
                              />
                              <span>Paradas + a caminho</span>
                            </label>
                          </div>
                        </fieldset>
                        {defense === null ? (
                          <div className="callout callout--warn sg2-span-2" role="alert">
                            <span className="callout-icon">!</span>
                            <div className="callout-body">
                              <p className="callout-title">Defesa por aldeia ainda não coletada</p>
                              <p>
                                A fonte "Disponível na aldeia" usa a mesma coleta da Análise de Defesa
                                (SG_3). Colete para habilitar a consulta agora.
                              </p>
                              <button
                                type="button"
                                className="btn btn-sm"
                                style={{ marginTop: 8 }}
                                disabled={collecting !== null}
                                onClick={() => void startDefenseCollect()}
                              >
                                {collecting === 'members' ? (
                                  <>
                                    <span className="btn-spinner" aria-hidden="true" /> Coletando defesa…
                                  </>
                                ) : (
                                  'Coletar defesa agora'
                                )}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="field-hint sg2-span-2" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span>
                              Defesa em memória deste mundo: {new Date(defense.collectedAt).toLocaleString('pt-BR')}.
                            </span>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={defenseRefreshing || collecting !== null}
                              onClick={() => void refreshDefenseFromMemory()}
                              data-tip="Relê a última coleta da Análise de Defesa (SG_3) já guardada no app — sem recoletar. Coletou lá? Clique aqui."
                            >
                              {defenseRefreshing ? 'Atualizando…' : 'Atualizar da memória'}
                            </button>
                          </p>
                        )}
                      </>
                    )}

                    <fieldset className="sg2-fieldset sg2-span-2">
                      <legend className="field-label">Unidades (quantidade mínima)</legend>
                      <div className="sg2-units-grid">
                        {FILTER_UNIT_ORDER.map((id) => (
                          <label key={id} className="sg2-unit-row">
                            <img src={TW_UNIT_ICONS[id]} width={18} height={18} alt="" aria-hidden="true" className="tw-icon" />
                            <span className="sg2-unit-name">{UNITS[id].name}</span>
                            <input
                              type="number"
                              className="input sg2-unit-input"
                              min={0}
                              value={unitInputs[id] ?? ''}
                              aria-label={`Quantidade mínima de ${UNITS[id].name}`}
                              onChange={(event) => updateUnitInput(id, event.target.value)}
                            />
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <fieldset className="sg2-fieldset">
                      <legend className="field-label">Modalidade</legend>
                      <div className="sg2-radio-row">
                        <label className="checkbox-field">
                          <input
                            type="radio"
                            name="sg2-mode"
                            value="has"
                            checked={mode === 'has'}
                            onChange={() => setMode('has')}
                          />
                          <span>Possuem as tropas informadas</span>
                        </label>
                        <label className="checkbox-field">
                          <input
                            type="radio"
                            name="sg2-mode"
                            value="lacks"
                            checked={mode === 'lacks'}
                            onChange={() => setMode('lacks')}
                          />
                          <span>Não possuem as tropas informadas</span>
                        </label>
                      </div>
                    </fieldset>

                    <fieldset className="sg2-fieldset">
                      <legend className="field-label">Escopo</legend>
                      <div className="sg2-radio-row">
                        <label className="checkbox-field">
                          <input
                            type="radio"
                            name="sg2-scope"
                            value="village"
                            checked={scope === 'village'}
                            onChange={() => setScope('village')}
                          />
                          <span>Total de aldeia</span>
                        </label>
                        <label className="checkbox-field">
                          <input
                            type="radio"
                            name="sg2-scope"
                            value="player"
                            checked={scope === 'player'}
                            onChange={() => setScope('player')}
                          />
                          <span>Total de jogador</span>
                        </label>
                      </div>
                    </fieldset>

                    <div className="sg2-span-2">
                      <Field
                        id="sg2-coords"
                        label="Coordenadas Filtradas (123|456 456|123 ...)"
                        hint="Separadas por espaço ou Enter — normalmente a saída do SG1."
                      >
                        <textarea
                          id="sg2-coords"
                          className="textarea sg2-coords"
                          rows={3}
                          value={coordsText}
                          aria-describedby="sg2-coords-hint"
                          onChange={(event) => setCoordsText(event.target.value)}
                        />
                      </Field>
                    </div>

                    <div className="sg2-axis-group">
                      <span className="field-label">Eixo X de [ ] a [ ]</span>
                      <div className="sg2-axis-inputs">
                        <label className="sg2-axis-field">
                          <span className="muted">de</span>
                          <input
                            type="number"
                            className="input"
                            min={0}
                            max={999}
                            placeholder="0"
                            value={minXText}
                            aria-label="Eixo X mínimo"
                            onChange={(event) => setMinXText(event.target.value)}
                          />
                        </label>
                        <label className="sg2-axis-field">
                          <span className="muted">a</span>
                          <input
                            type="number"
                            className="input"
                            min={0}
                            max={999}
                            placeholder="999"
                            value={maxXText}
                            aria-label="Eixo X máximo"
                            onChange={(event) => setMaxXText(event.target.value)}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="sg2-axis-group">
                      <span className="field-label">Eixo Y de [ ] a [ ]</span>
                      <div className="sg2-axis-inputs">
                        <label className="sg2-axis-field">
                          <span className="muted">de</span>
                          <input
                            type="number"
                            className="input"
                            min={0}
                            max={999}
                            placeholder="0"
                            value={minYText}
                            aria-label="Eixo Y mínimo"
                            onChange={(event) => setMinYText(event.target.value)}
                          />
                        </label>
                        <label className="sg2-axis-field">
                          <span className="muted">a</span>
                          <input
                            type="number"
                            className="input"
                            min={0}
                            max={999}
                            placeholder="999"
                            value={maxYText}
                            aria-label="Eixo Y máximo"
                            onChange={(event) => setMaxYText(event.target.value)}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="field">
                      <span className="field-label">Continentes K (ex.: 55 77)</span>
                      <div className="sg2-axis-inputs">
                        <input
                          className="input"
                          placeholder="55 77"
                          value={kText}
                          aria-label="Continentes K"
                          onChange={(event) => setKText(event.target.value)}
                        />
                        <div className="sg2-radio-row" role="radiogroup" aria-label="Modo do filtro por continente">
                          <label className="checkbox-field">
                            <input type="radio" name="sg2-kmode" checked={kMode === 'incluir'} onChange={() => setKMode('incluir')} />
                            incluir apenas
                          </label>
                          <label className="checkbox-field">
                            <input type="radio" name="sg2-kmode" checked={kMode === 'excluir'} onChange={() => setKMode('excluir')} />
                            excluir
                          </label>
                        </div>
                      </div>
                    </div>

                    <div className="sg2-span-2 sg2-form-actions">
                      <button type="submit" className="btn">
                        <Swords size={15} aria-hidden="true" />
                        Realizar Consulta
                      </button>
                      <span className="muted">
                        Sem mínimos de unidade, a consulta classifica todas as aldeias em
                        ofensivas e defensivas.
                      </span>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {result !== null && (
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">Contador Full/Semi</h3>
                  <span className="spacer" />
                  <span className="pill pill--muted">
                    {result.totalVillages} aldeia(s) no filtro · fonte: {fonteLabel}
                    {fonteColetadaEm !== null ? ` · coletada em ${new Date(fonteColetadaEm).toLocaleString('pt-BR')}` : ''}
                  </span>
                </div>
                <div className="card-body">
                  <PresetManager
                    module="sg2"
                    scope="fullsemi"
                    label="do contador Full/Semi"
                    currentFields={{
                      fullPopText,
                      semiPopText,
                      minFullsText,
                      minSemisText,
                      fsKText,
                      fsPlayersText,
                      fsKMode,
                      fsPlayersMode,
                    }}
                    onApply={applyFullSemiPreset}
                  />
                  <div className="sg4-params">
                    <label className="field">
                      <span className="field-label">População mínima FULL</span>
                      <input className="input" type="number" min={1} value={fullPopText} aria-label="População mínima para FULL" onChange={(event) => setFullPopText(event.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">População mínima SEMI</span>
                      <input className="input" type="number" min={1} value={semiPopText} aria-label="População mínima para SEMI" onChange={(event) => setSemiPopText(event.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">Mín. de fulls por jogador</span>
                      <input className="input" type="number" min={0} value={minFullsText} aria-label="Mínimo de aldeias full por jogador" onChange={(event) => setMinFullsText(event.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">Mín. de semis por jogador</span>
                      <input className="input" type="number" min={0} value={minSemisText} aria-label="Mínimo de aldeias semi por jogador" onChange={(event) => setMinSemisText(event.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">Ordenar por</span>
                      <select className="select" value={fsSort} aria-label="Ordenação do contador" onChange={(event) => setFsSort(event.target.value as FullSemiSortBy)}>
                        <option value="fulls">Mais fulls</option>
                        <option value="semis">Mais semis</option>
                        <option value="total">Mais aldeias (full+semi)</option>
                        <option value="nick">Nick (A–Z)</option>
                      </select>
                    </label>
                    <div className="field">
                      <span className="field-label">Contagem</span>
                      <button type="button" className="btn" onClick={() => void runFullSemi()} disabled={fullSemiBusy}>
                        {fullSemiBusy ? <><span className="btn-spinner" aria-hidden="true" /> Contando…</> : 'Contar Full/Semi'}
                      </button>
                    </div>
                  </div>

                  <div className="field" style={{ marginTop: 12 }}>
                    <span className="field-label">Unidades contabilizadas na população</span>
                    <div className="sg2-radio-row" role="radiogroup" aria-label="Conjunto de unidades contabilizadas" style={{ marginBottom: 6 }}>
                      <label className="checkbox-field">
                        <input type="radio" name="fs-units-mode" checked={fsUnitMode === 'ofensivas'} onChange={() => setFsUnitMode('ofensivas')} />
                        ofensivas do mundo
                      </label>
                      <label className="checkbox-field">
                        <input type="radio" name="fs-units-mode" checked={fsUnitMode === 'todas'} onChange={() => setFsUnitMode('todas')} />
                        todas as unidades
                      </label>
                      <label className="checkbox-field">
                        <input type="radio" name="fs-units-mode" checked={fsUnitMode === 'custom'} onChange={() => { setFsUnitMode('custom'); if (fsCustomUnits.size === 0) setFsCustomUnits(new Set(snapshotUnitIds.filter((id) => OFFENSIVE_UNIT_IDS.has(id)))); }} />
                        personalizado
                      </label>
                    </div>
                    {fsUnitMode === 'custom' && (
                      <div className="fs-chips">
                        {snapshotUnitIds.map((id) => {
                          const on = fsCustomUnits.has(id);
                          return (
                            <label key={id} className={`fs-chip${on ? ' fs-chip--on' : ''}`}>
                              <input
                                type="checkbox"
                                checked={on}
                                aria-label={`Contabilizar ${UNITS[id as UnitId]?.name ?? id}`}
                                onChange={() => {
                                  setFsCustomUnits((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(id)) next.delete(id);
                                    else next.add(id);
                                    return next;
                                  });
                                }}
                              />
                              {TW_UNIT_ICONS[id as UnitId] !== undefined && <img src={TW_UNIT_ICONS[id as UnitId]} alt="" width={16} height={16} className="tw-icon" />}
                              {UNITS[id as UnitId]?.name ?? id}
                            </label>
                          );
                        })}
                        <span className="muted">{fsCustomUnits.size === 0 ? 'nenhuma marcada = todas contam' : `${fsCustomUnits.size} marcada(s)`}</span>
                      </div>
                    )}
                  </div>

                  <div className="sg4-params">
                    <label className="field">
                      <span className="field-label">Continentes K (ex.: 55 77)</span>
                      <input className="input" placeholder="55 77" value={fsKText} aria-label="Continentes do contador" onChange={(event) => setFsKText(event.target.value)} />
                      <div className="sg2-radio-row" role="radiogroup" aria-label="Modo do K do contador">
                        <label className="checkbox-field">
                          <input type="radio" name="fs-kmode" checked={fsKMode === 'incluir'} onChange={() => setFsKMode('incluir')} />
                          incluir apenas
                        </label>
                        <label className="checkbox-field">
                          <input type="radio" name="fs-kmode" checked={fsKMode === 'excluir'} onChange={() => setFsKMode('excluir')} />
                          excluir
                        </label>
                      </div>
                    </label>
                    <label className="field">
                      <span className="field-label">Jogadores (separe por ; — nick com espaço funciona)</span>
                      <textarea
                        className="textarea"
                        rows={2}
                        placeholder="Jogador Um; Zé; Outro Nick"
                        value={fsPlayersText}
                        aria-label="Filtro por jogadores do contador"
                        onChange={(event) => setFsPlayersText(event.target.value)}
                      />
                      <span className="field-hint">{fsPlayersLabel}</span>
                      <div className="sg2-radio-row" role="radiogroup" aria-label="Modo do filtro por jogadores">
                        <label className="checkbox-field">
                          <input type="radio" name="fs-pmode" checked={fsPlayersMode === 'incluir'} onChange={() => setFsPlayersMode('incluir')} />
                          incluir apenas
                        </label>
                        <label className="checkbox-field">
                          <input type="radio" name="fs-pmode" checked={fsPlayersMode === 'excluir'} onChange={() => setFsPlayersMode('excluir')} />
                          excluir
                        </label>
                      </div>
                    </label>
                  </div>

                  {report !== null && (
                    <>
                      {report.unknownUnits.length > 0 && (
                        <div className="callout callout--warn" role="alert">
                          <AlertTriangle size={16} className="callout-icon" aria-hidden="true" />
                          <span>
                            Unidades sem população no unit-info do mundo ({report.unknownUnits.join(', ')}) — as contagens podem subestimar.
                          </span>
                        </div>
                      )}
                      <div className="stat-row" style={{ marginTop: 12 }}>
                        <StatBlock label="Jogadores" icon={Users} value={report.totals.players} delta="após os filtros do contador" />
                        <StatBlock label="Fulls" icon={Swords} tone="ok" value={report.totals.fulls} delta={`pop ≥ ${fullPopText}`} />
                        <StatBlock label="Semis" icon={ShieldCheck} tone="gold" value={report.totals.semis} delta={`pop ≥ ${semiPopText}`} />
                        <StatBlock label="Aldeias" icon={Layers} value={report.totals.villages} delta="full + semi" />
                      </div>

                      <div className="table-wrap" style={{ marginTop: 12 }}>
                        <table className="table">
                          <thead>
                            <tr>
                              <th scope="col">Jogador</th>
                              <th scope="col" className="cell-num">Fulls</th>
                              <th scope="col" className="cell-num">Semis</th>
                              <th scope="col" className="cell-num">Total</th>
                              <th scope="col">Continentes</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.players.map((player, index) => {
                              const isOpen = fsExpanded.has(index);
                              return (
                                <Fragment key={`${player.playerName}-${index}`}>
                                  <tr>
                                    <td>
                                      <button
                                        type="button"
                                        className="sg2-row-toggle"
                                        aria-expanded={isOpen}
                                        aria-controls={`fs-drilldown-${index}`}
                                        onClick={() => {
                                          setFsExpanded((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(index)) next.delete(index);
                                            else next.add(index);
                                            return next;
                                          });
                                        }}
                                      >
                                        {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                                        <span>{player.playerName}</span>
                                      </button>
                                    </td>
                                    <td className="cell-num tabular"><strong>{player.fulls}</strong></td>
                                    <td className="cell-num tabular">{player.semis}</td>
                                    <td className="cell-num tabular muted">{player.fulls + player.semis}</td>
                                    <td>
                                      <span className="fs-ks">
                                        {player.byK.map((k) => (
                                          <span key={k.k} className="pill pill--muted cell-nowrap" title={`K${k.k}: ${k.fulls} full(s), ${k.semis} semi(s)`}>
                                            K{k.k} · {k.fulls}F{k.semis > 0 ? `/${k.semis}S` : ''}
                                          </span>
                                        ))}
                                      </span>
                                    </td>
                                  </tr>
                                  {isOpen && (
                                    <tr id={`fs-drilldown-${index}`} className="sg2-drilldown">
                                      <td colSpan={5} className="sg2-coords">
                                        <div className="table-wrap">
                                          <table className="table">
                                            <thead>
                                              <tr>
                                                <th scope="col">Coordenada</th>
                                                <th scope="col" className="cell-num">K</th>
                                                <th scope="col" className="cell-num">População</th>
                                                <th scope="col">Nível</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {player.villages.map((village) => (
                                                <tr key={village.coord}>
                                                  <td className="cell-nowrap">{village.coord}</td>
                                                  <td className="cell-num">K{village.k}</td>
                                                  <td className="cell-num tabular">{village.pop.toLocaleString('pt-BR')}</td>
                                                  <td>{village.tier === 'full' ? <span className="ok">FULL</span> : <span className="text-warn">SEMI</span>}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyText(formatFullSemiRows(report.players))}>
                          <Copy size={14} aria-hidden="true" />
                          Copiar contagem (nick;fulls;semis;coords)
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyText(formatOriginsRows(report.players))}>
                          <Copy size={14} aria-hidden="true" />
                          Copiar origens SG_4 (nick;fulls;coords)
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void copyText(report.players.flatMap((player) => player.villages.filter((village) => village.tier === 'full').map((village) => village.coord)).join('\n'))}
                        >
                          <Copy size={14} aria-hidden="true" />
                          Copiar alvos FULL (um por linha)
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void copyText(report.players.flatMap((player) => player.villages.map((village) => village.coord)).join('\n'))}
                        >
                          <Copy size={14} aria-hidden="true" />
                          Copiar alvos FULL+SEMI (um por linha)
                        </button>
                      </div>
                    </>
                  )}

                  <h4 className="section-title" style={{ marginTop: 16 }}>Salvar como grupo</h4>
                  <p className="muted">Congela as coordenadas do resultado atual para reutilizar na montagem de OPs (Sala de Guerra → Grupos).</p>
                  <div className="sg4-params">
                    <label className="field">
                      <span className="field-label">Nome do grupo</span>
                      <input className="input" value={groupName} aria-label="Nome do grupo" placeholder="Ofensivos K55" onChange={(event) => setGroupName(event.target.value)} />
                    </label>
                    <div className="field">
                      <span className="field-label">Papel na OP</span>
                      <div className="sg2-radio-row" role="radiogroup" aria-label="Papel do grupo">
                        <label className="checkbox-field">
                          <input type="radio" name="group-papel" checked={groupPapel === 'origem'} onChange={() => setGroupPapel('origem')} />
                          origem
                        </label>
                        <label className="checkbox-field">
                          <input type="radio" name="group-papel" checked={groupPapel === 'alvo'} onChange={() => setGroupPapel('alvo')} />
                          alvo
                        </label>
                      </div>
                    </div>
                    <label className="field">
                      <span className="field-label">Autor</span>
                      <input className="input" value={groupAuthor} aria-label="Autor do grupo" onChange={(event) => setGroupAuthor(event.target.value)} />
                    </label>
                    <div className="field">
                      <span className="field-label">Salvar</span>
                      <button type="button" className="btn btn-ghost" onClick={() => void saveGroup()} disabled={groupBusy}>
                        {groupBusy ? <><span className="btn-spinner" aria-hidden="true" /> Salvando…</> : 'Salvar como grupo'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* ===== Resultado ===== */}
          {result !== null && (
            <section className="page-section" aria-labelledby="sg2-result-title">
              <h2 className="section-title" id="sg2-result-title">Resultado da Consulta</h2>
              <div className="card card--flush">
                <div className="card-header">
                  <h3 className="card-title">Jogadores</h3>
                  <span className="spacer" />
                  <span className="sg2-total">
                    <span className="sg2-total-value">{result.totalVillages}</span>
                    <span className="sg2-total-label">aldeias</span>
                  </span>
                </div>

                {result.classification !== undefined && (
                  <div className="card-body sg2-classification">
                    <div className="stat-row">
                      <StatBlock
                        label="Ofensivas"
                        icon={Swords}
                        tone="ok"
                        value={result.classification.offensive}
                        delta="aldeias classificadas por população de ataque"
                      />
                      <StatBlock
                        label="Defensivas"
                        icon={ShieldCheck}
                        tone="gold"
                        value={result.classification.defensive}
                        delta="aldeias classificadas por população de defesa"
                      />
                    </div>
                  </div>
                )}

                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Jogador</th>
                        <th scope="col" className="cell-num">Aldeias</th>
                        {report !== null && (<>
                          <th scope="col" className="cell-num" title="Aldeias FULL no contador atual">Fulls</th>
                          <th scope="col" className="cell-num" title="Aldeias SEMI no contador atual">Semis</th>
                        </>)}
                      </tr>
                    </thead>
                    <tbody>
                      {result.players.map((player, index) => {
                        const isOpen = expanded.has(index);
                        const fs = report?.players.find((p) => p.playerName === player.playerName);
                        return (
                          <Fragment key={`${player.playerName}-${index}`}>
                            <tr>
                              <td>
                                <button
                                  type="button"
                                  className="sg2-row-toggle"
                                  aria-expanded={isOpen}
                                  aria-controls={`sg2-drilldown-${index}`}
                                  onClick={() => toggleRow(index)}
                                >
                                  {isOpen ? (
                                    <ChevronDown size={14} aria-hidden="true" />
                                  ) : (
                                    <ChevronRight size={14} aria-hidden="true" />
                                  )}
                                  <span>{player.playerName}</span>
                                </button>
                              </td>
                              <td className="cell-num tabular">{player.villageCount}</td>
                              {report !== null && (<>
                                <td className="cell-num tabular">{fs !== undefined ? <strong>{fs.fulls}</strong> : <span className="muted">—</span>}</td>
                                <td className="cell-num tabular">{fs !== undefined ? fs.semis : <span className="muted">—</span>}</td>
                              </>)}
                            </tr>
                            {isOpen && (
                              <tr id={`sg2-drilldown-${index}`} className="sg2-drilldown">
                                <td colSpan={report !== null ? 4 : 2} className="sg2-coords">
                                  {player.coords.length > 0
                                    ? player.coords.join(' ')
                                    : 'Sem coordenadas'}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="card-body">
                  <div className="sg2-form-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void copySummary()}
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar resumo (nick;qtde;coords)
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}
        </>
      )}

    </section>
  );
}
