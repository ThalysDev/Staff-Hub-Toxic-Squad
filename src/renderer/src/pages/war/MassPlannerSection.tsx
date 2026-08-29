// Sala de Guerra · Planner de OP em Massa — UI (BLOCOS 1–4 da spec).
// Vários GRUPOS (fake, nuke, nobre…) com configuração própria; "Gerar Operação"
// junta tudo numa única OP via a engine pura (mass-planner-engine). O rascunho
// (formulário + grupos adicionados + formatos) sobrevive a F5/reinício pelas
// preferências do módulo "guerra". A engine é quem calcula; aqui é só estado,
// validação por campo e apresentação — regras de negócio NUNCA na UI.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ClipboardCopy, Layers, ListPlus, Pencil, RefreshCw, Save, Trash2, TriangleAlert } from 'lucide-react';
import { coordCountLabel, normalizeCoordText } from '@shared/coord-input';
import {
  generateMassPlan,
  parseMassCoordGroups,
  parseMassCoordText,
  validateMassGroup,
} from '@shared/mass-planner-engine';
import { formatColavel, formatRussianPlanner, formatTwMassPlanner, unitLabel } from '@shared/mass-planner-formats';
import {
  MASS_BUILDINGS,
  type MassArrivalKind,
  type MassAssignMode,
  type MassGroupConfig,
  type MassGroupErrors,
  type MassNightBonusMode,
  type MassPlanResult,
} from '@shared/mass-planner-types';
import { formatHms } from '@shared/sg4-timing';
import { listPresets, parsePresets, type FilterPreset } from '@shared/filter-presets';
import type { GroupEntry } from '@shared/groups-rules';
import { UNITS, type UnitId } from '@shared/units';
import { usePreferences } from '../../hooks/usePreferences';
import { useSessionStatus } from '../../hooks/useSessionStatus';
import { useToast } from '../../hooks/useToast';
import EmptyState from '../../components/EmptyState';

/** Ordem de exibição das unidades do mundo (catálogo pt-BR, não a ordem do XML). */
const UNIT_ORDER: readonly UnitId[] = [
  'spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob',
];

/** Tamanho seguro para persistir os grupos como 1 string de preferência (cap 20k). */
const GROUPS_JSON_SAFE_LENGTH = 19_000;

interface PlannerPrefs extends Record<string, unknown> {
  mpNome: string;
  mpOrigins: string;
  mpTargets: string;
  mpTowers: string;
  mpSlowestUnit: string;
  mpAssignMode: MassAssignMode;
  mpPerOrigin: string;
  mpPerTarget: string;
  mpRepeatSamePlayer: boolean;
  mpMinDistance: string;
  mpMaxDistance: string;
  mpArrivalKind: MassArrivalKind;
  mpArrivalBase: string;
  mpWindowStart: string;
  mpWindowEnd: string;
  mpDelay: string;
  mpNightBonus: MassNightBonusMode;
  mpAvoidMs: boolean;
  mpMinMorale: string;
  mpCatapults: string;
  mpFormatRussian: boolean;
  mpFormatTwmp: boolean;
  mpArchiveTitle: string;
  mpGroupsJson: string;
}

const PLANNER_DEFAULTS: PlannerPrefs = {
  mpNome: '',
  mpOrigins: '',
  mpTargets: '',
  mpTowers: '',
  mpSlowestUnit: 'ram',
  mpAssignMode: 'otimizado',
  mpPerOrigin: '1',
  mpPerTarget: '1',
  mpRepeatSamePlayer: false,
  mpMinDistance: '0',
  mpMaxDistance: '2000',
  mpArrivalKind: 'fixa',
  mpArrivalBase: '',
  mpWindowStart: '',
  mpWindowEnd: '',
  mpDelay: '30',
  mpNightBonus: 'desativado',
  mpAvoidMs: false,
  mpMinMorale: '0',
  mpCatapults: '',
  mpFormatRussian: true,
  mpFormatTwmp: false,
  mpArchiveTitle: '',
  mpGroupsJson: '',
};

/** Valor default do datetime de chegada: hoje às 21:00 local (hora comum de OP). */
function defaultArrivalBase(): string {
  const now = new Date();
  const part = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}T21:00:00`;
}

/** "dd/MM HH:MM:SS" — chegada sempre com o dia (viagens D-1 são comuns). */
function formatFullClock(ms: number): string {
  const at = new Date(ms);
  const part = (value: number): string => String(value).padStart(2, '0');
  return `${part(at.getDate())}/${part(at.getMonth() + 1)} ${formatHms(at)}`;
}

/** epoch ms → valor de <input type="datetime-local"> local (vazio se inválido). */
function toLocalInputValue(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const at = new Date(ms);
  const part = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}-${part(at.getMonth() + 1)}-${part(at.getDate())}` +
    `T${part(at.getHours())}:${part(at.getMinutes())}:${part(at.getSeconds())}`
  );
}

export interface MassPlannerSectionProps {
  /** true quando a aba do planner está visível — carrega o mundo na 1ª exibição. */
  visible: boolean;
  /** Leva o líder ao monitoramento após arquivar a OP gerada. */
  onOpenMonitor: () => void;
}

export default function MassPlannerSection({ visible, onOpenMonitor }: MassPlannerSectionProps): JSX.Element {
  const { push } = useToast();
  const session = useSessionStatus();

  // ---- Preferências do módulo "guerra" (rascunho do formulário + grupos) ----
  const { prefs, savePrefs } = usePreferences<PlannerPrefs>('guerra', PLANNER_DEFAULTS);
  const prefsHydrated = useRef(false);
  const [nomeText, setNomeText] = useState(PLANNER_DEFAULTS.mpNome);
  const [originsText, setOriginsText] = useState(PLANNER_DEFAULTS.mpOrigins);
  const [targetsText, setTargetsText] = useState(PLANNER_DEFAULTS.mpTargets);
  const [towersText, setTowersText] = useState(PLANNER_DEFAULTS.mpTowers);
  const [slowestUnit, setSlowestUnit] = useState<UnitId>(PLANNER_DEFAULTS.mpSlowestUnit as UnitId);
  const [assignMode, setAssignMode] = useState<MassAssignMode>(PLANNER_DEFAULTS.mpAssignMode);
  const [perOriginText, setPerOriginText] = useState(PLANNER_DEFAULTS.mpPerOrigin);
  const [perTargetText, setPerTargetText] = useState(PLANNER_DEFAULTS.mpPerTarget);
  const [repeatSamePlayer, setRepeatSamePlayer] = useState(PLANNER_DEFAULTS.mpRepeatSamePlayer);
  const [minDistanceText, setMinDistanceText] = useState(PLANNER_DEFAULTS.mpMinDistance);
  const [maxDistanceText, setMaxDistanceText] = useState(PLANNER_DEFAULTS.mpMaxDistance);
  const [arrivalKind, setArrivalKind] = useState<MassArrivalKind>(PLANNER_DEFAULTS.mpArrivalKind);
  const [arrivalBaseText, setArrivalBaseText] = useState(PLANNER_DEFAULTS.mpArrivalBase);
  const [windowStartText, setWindowStartText] = useState(PLANNER_DEFAULTS.mpWindowStart);
  const [windowEndText, setWindowEndText] = useState(PLANNER_DEFAULTS.mpWindowEnd);
  const [delayText, setDelayText] = useState(PLANNER_DEFAULTS.mpDelay);
  const [nightBonusMode, setNightBonusMode] = useState<MassNightBonusMode>(PLANNER_DEFAULTS.mpNightBonus);
  const [avoidMs, setAvoidMs] = useState(PLANNER_DEFAULTS.mpAvoidMs);
  const [minMoraleText, setMinMoraleText] = useState(PLANNER_DEFAULTS.mpMinMorale);
  const [catapultsText, setCatapultsText] = useState(PLANNER_DEFAULTS.mpCatapults);
  const [formatRussian, setFormatRussian] = useState(PLANNER_DEFAULTS.mpFormatRussian);
  const [formatTwmp, setFormatTwmp] = useState(PLANNER_DEFAULTS.mpFormatTwmp);
  const [archiveTitle, setArchiveTitle] = useState(PLANNER_DEFAULTS.mpArchiveTitle);

  useEffect(() => {
    if (prefs === null || prefsHydrated.current) return;
    prefsHydrated.current = true;
    setNomeText(typeof prefs.mpNome === 'string' ? prefs.mpNome : PLANNER_DEFAULTS.mpNome);
    setOriginsText(typeof prefs.mpOrigins === 'string' ? prefs.mpOrigins : PLANNER_DEFAULTS.mpOrigins);
    setTargetsText(typeof prefs.mpTargets === 'string' ? prefs.mpTargets : PLANNER_DEFAULTS.mpTargets);
    setTowersText(typeof prefs.mpTowers === 'string' ? prefs.mpTowers : PLANNER_DEFAULTS.mpTowers);
    if (typeof prefs.mpSlowestUnit === 'string' && prefs.mpSlowestUnit !== '') setSlowestUnit(prefs.mpSlowestUnit as UnitId);
    if (prefs.mpAssignMode === 'otimizado' || prefs.mpAssignMode === 'mais-perto' || prefs.mpAssignMode === 'mais-longe') {
      setAssignMode(prefs.mpAssignMode);
    }
    setPerOriginText(typeof prefs.mpPerOrigin === 'string' ? prefs.mpPerOrigin : PLANNER_DEFAULTS.mpPerOrigin);
    setPerTargetText(typeof prefs.mpPerTarget === 'string' ? prefs.mpPerTarget : PLANNER_DEFAULTS.mpPerTarget);
    setRepeatSamePlayer(prefs.mpRepeatSamePlayer === true);
    setMinDistanceText(typeof prefs.mpMinDistance === 'string' ? prefs.mpMinDistance : PLANNER_DEFAULTS.mpMinDistance);
    setMaxDistanceText(typeof prefs.mpMaxDistance === 'string' ? prefs.mpMaxDistance : PLANNER_DEFAULTS.mpMaxDistance);
    if (prefs.mpArrivalKind === 'fixa' || prefs.mpArrivalKind === 'intervalo' || prefs.mpArrivalKind === 'sequencial') {
      setArrivalKind(prefs.mpArrivalKind);
    } else if (prefs.mpArrivalKind === 'fixa-por-aldeia') {
      // Migração v0.28→v0.29: o modo virou "sequencial" (delay entre ataques).
      setArrivalKind('sequencial');
    }
    setArrivalBaseText(typeof prefs.mpArrivalBase === 'string' && prefs.mpArrivalBase !== '' ? prefs.mpArrivalBase : defaultArrivalBase());
    setWindowStartText(typeof prefs.mpWindowStart === 'string' ? prefs.mpWindowStart : PLANNER_DEFAULTS.mpWindowStart);
    setWindowEndText(typeof prefs.mpWindowEnd === 'string' ? prefs.mpWindowEnd : PLANNER_DEFAULTS.mpWindowEnd);
    setDelayText(typeof prefs.mpDelay === 'string' ? prefs.mpDelay : PLANNER_DEFAULTS.mpDelay);
    if (prefs.mpNightBonus === 'desativado' || prefs.mpNightBonus === 'reagendar') setNightBonusMode(prefs.mpNightBonus);
    setAvoidMs(prefs.mpAvoidMs === true);
    setMinMoraleText(typeof prefs.mpMinMorale === 'string' ? prefs.mpMinMorale : PLANNER_DEFAULTS.mpMinMorale);
    setCatapultsText(typeof prefs.mpCatapults === 'string' ? prefs.mpCatapults : PLANNER_DEFAULTS.mpCatapults);
    setFormatRussian(prefs.mpFormatRussian !== false);
    setFormatTwmp(prefs.mpFormatTwmp === true);
    setArchiveTitle(typeof prefs.mpArchiveTitle === 'string' ? prefs.mpArchiveTitle : PLANNER_DEFAULTS.mpArchiveTitle);
    if (typeof prefs.mpGroupsJson === 'string' && prefs.mpGroupsJson !== '') {
      try {
        const parsed: unknown = JSON.parse(prefs.mpGroupsJson);
        if (Array.isArray(parsed)) {
          const valid: MassGroupConfig[] = [];
          for (const item of parsed) {
            const group = reviveGroupConfig(item);
            if (group !== null) valid.push(group);
          }
          setGroups(valid);
        }
      } catch (error) {
        console.warn('[planner-massa] rascunho de grupos corrompido foi descartado:', error);
        push('error', 'O rascunho de grupos estava corrompido e foi descartado — os formulários continuam.');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs]);

  // Persistência do formulário (campo a campo, mesma disciplina das páginas SG).
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({
      mpNome: nomeText,
      mpOrigins: originsText,
      mpTargets: targetsText,
      mpTowers: towersText,
      mpSlowestUnit: slowestUnit,
      mpAssignMode: assignMode,
      mpPerOrigin: perOriginText,
      mpPerTarget: perTargetText,
      mpRepeatSamePlayer: repeatSamePlayer,
      mpMinDistance: minDistanceText,
      mpMaxDistance: maxDistanceText,
      mpArrivalKind: arrivalKind,
      mpArrivalBase: arrivalBaseText,
      mpWindowStart: windowStartText,
      mpWindowEnd: windowEndText,
      mpDelay: delayText,
      mpNightBonus: nightBonusMode,
      mpAvoidMs: avoidMs,
      mpMinMorale: minMoraleText,
      mpCatapults: catapultsText,
      mpFormatRussian: formatRussian,
      mpFormatTwmp: formatTwmp,
      mpArchiveTitle: archiveTitle,
    });
  }, [
    savePrefs, nomeText, originsText, targetsText, towersText, slowestUnit, assignMode, perOriginText, perTargetText,
    repeatSamePlayer, minDistanceText, maxDistanceText, arrivalKind, arrivalBaseText, windowStartText,
    windowEndText, delayText, nightBonusMode, avoidMs, minMoraleText, catapultsText, formatRussian, formatTwmp, archiveTitle,
  ]);

  // ---- Grupos adicionados (persistidos como 1 string; acima do cap = aviso explícito) ----
  const [groups, setGroups] = useState<MassGroupConfig[]>([]);
  const [groupsPersistFull, setGroupsPersistFull] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (!prefsHydrated.current) return;
    const json = JSON.stringify(groups);
    if (json.length <= GROUPS_JSON_SAFE_LENGTH) {
      setGroupsPersistFull(false);
      savePrefs({ mpGroupsJson: json });
    } else {
      setGroupsPersistFull(true);
      // NÃO persiste a lista cheia (estouraria o cap silenciosamente): fica em
      // memória nesta sessão e o aviso permanente explica.
      savePrefs({ mpGroupsJson: '' });
    }
  }, [groups, savePrefs]);

  // ---- Dados do mundo (carregam na 1ª vez que a aba aparece) ----
  const [worldLoading, setWorldLoading] = useState(false);
  const [worldError, setWorldError] = useState('');
  const [worldLoadedOnce, setWorldLoadedOnce] = useState(false);
  const [unitMinutes, setUnitMinutes] = useState<Partial<Record<UnitId, number>>>({});
  const [nightCfg, setNightCfg] = useState<{ nightBonusActive: boolean; nightStartHour: number; nightEndHour: number } | null>(null);
  const [moralActive, setMoralActive] = useState(true);
  const [ownerByCoord, setOwnerByCoord] = useState<Map<string, string>>(new Map());
  const [villagePoints, setVillagePoints] = useState<Map<string, number>>(new Map());
  const [playerPoints, setPlayerPoints] = useState<Map<string, number>>(new Map());
  const [villageIdByCoord, setVillageIdByCoord] = useState<Map<string, number>>(new Map());

  const loadWorld = useCallback(async (): Promise<void> => {
    setWorldLoading(true);
    setWorldError('');
    try {
      const [night, morale, speeds, villages, players] = await Promise.all([
        window.staffhub.world.nightBonus(),
        window.staffhub.world.moraleInfo(),
        window.staffhub.world.unitSpeeds(),
        window.staffhub.world.villages(),
        window.staffhub.world.players(),
      ]);
      const playerNameById = new Map<number, string>();
      const pointsByName = new Map<string, number>();
      for (const player of players) {
        playerNameById.set(player.id, player.name);
        pointsByName.set(player.name, player.points);
      }
      const owners = new Map<string, string>();
      const vPoints = new Map<string, number>();
      const vIds = new Map<string, number>();
      for (const village of villages) {
        const key = `${village.x}|${village.y}`;
        vPoints.set(key, village.points);
        vIds.set(key, village.id);
        if (village.playerId !== 0) {
          const owner = playerNameById.get(village.playerId);
          if (owner !== undefined) owners.set(key, owner);
        }
      }
      const minutes: Partial<Record<UnitId, number>> = {};
      for (const [id, speed] of Object.entries(speeds)) {
        if (id in UNITS && speed > 0) minutes[id as UnitId] = speed;
      }
      setNightCfg({ nightBonusActive: night.active, nightStartHour: night.startHour, nightEndHour: night.endHour });
      setMoralActive(morale.active);
      setUnitMinutes(minutes);
      setOwnerByCoord(owners);
      setVillagePoints(vPoints);
      setPlayerPoints(pointsByName);
      setVillageIdByCoord(vIds);
      setWorldLoadedOnce(true);
    } catch (err) {
      setWorldError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorldLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible || worldLoadedOnce || worldLoading) return;
    void loadWorld();
  }, [visible, worldLoadedOnce, worldLoading, loadWorld]);

  const planContext = useMemo(
    () => ({
      unitMinutesPerField: unitMinutes,
      nightBonus: nightCfg ?? { nightBonusActive: false, nightStartHour: 0, nightEndHour: 0 },
      villagePoints,
      ownerByCoord,
      playerPoints,
      villageIdByCoord,
      moralActive,
    }),
    [unitMinutes, nightCfg, villagePoints, ownerByCoord, playerPoints, villageIdByCoord, moralActive],
  );

  const worldReady = nightCfg !== null && Object.keys(unitMinutes).length > 0;

  // ---- Presets da Análise de Tropas (SG_2, escopo "consulta") ----
  const [sg2Presets, setSg2Presets] = useState<FilterPreset[]>([]);
  useEffect(() => {
    if (!visible) return;
    window.staffhub.preferences
      .get('sg2')
      .then((stored) => {
        const raw = stored['presets:consulta'];
        if (typeof raw !== 'string' || raw === '') {
          setSg2Presets([]);
          return;
        }
        setSg2Presets(listPresets(parsePresets(raw)));
      })
      .catch(() => setSg2Presets([]));
  }, [visible]);

  /** Aplica o preset: nome do modelo + unidade mais lenta presente na composição. */
  function applySg2Preset(preset: FilterPreset): void {
    setNomeText(preset.name);
    let slowest: UnitId | null = null;
    let slowestMinutes = -1;
    try {
      const unitsBrutos: unknown = JSON.parse(preset.fields['unitInputs'] ?? '{}');
      if (typeof unitsBrutos === 'object' && unitsBrutos !== null && !Array.isArray(unitsBrutos)) {
        for (const [id, value] of Object.entries(unitsBrutos as Record<string, unknown>)) {
          const quantity = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0;
          const minutes = unitMinutes[id as UnitId];
          if (!(quantity > 0) || minutes === undefined) continue;
          if (minutes > slowestMinutes) {
            slowestMinutes = minutes;
            slowest = id as UnitId;
          }
        }
      }
    } catch {
      // unitInputs ausente/lixo: fica só o nome (o dono escolhe a unidade).
    }
    if (slowest !== null) setSlowestUnit(slowest);
    push(
      'ok',
      slowest !== null
        ? `Preset "${preset.name}" aplicado — unidade mais lenta: ${UNITS[slowest].name}.`
        : `Preset "${preset.name}" aplicado ao nome do modelo — a composição não indicou unidade.`,
    );
  }

  // ---- Grupos salvos (store groups) para importar coordenadas ----
  const [savedGroups, setSavedGroups] = useState<GroupEntry[] | null>(null);
  const [importOriginId, setImportOriginId] = useState('');
  const [importTargetId, setImportTargetId] = useState('');
  useEffect(() => {
    if (!visible) return;
    window.staffhub.groups
      .list()
      .then(setSavedGroups)
      .catch(() => setSavedGroups([]));
  }, [visible]);

  const sameWorldGroups = useMemo(() => {
    if (savedGroups === null || session.world === null) return [];
    return savedGroups.filter((entry) => entry.mundo.toLowerCase() === session.world?.toLowerCase());
  }, [savedGroups, session.world]);

  function importGroupCoords(which: 'origin' | 'target'): void {
    const id = which === 'origin' ? importOriginId : importTargetId;
    const entry = sameWorldGroups.find((group) => group.id === id);
    if (entry === undefined) {
      push('error', 'Escolha um grupo salvo deste mundo para importar.');
      return;
    }
    const text = entry.coords.join(' ');
    const label = coordCountLabel(normalizeCoordText(text));
    if (which === 'origin') {
      setOriginsText(text);
    } else {
      setTargetsText(text);
    }
    push('ok', `Grupo "${entry.nome}" importado (${label}).`);
  }

  // ---- Rascunho → MassGroupConfig + validação ----
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Origem/Destino em GRUPOS ("A B; C D") com cotas ("1" ou "1;2") — semântica
  // da ferramenta real; towers segue texto simples.
  const parsedOrigins = useMemo(() => parseMassCoordGroups(originsText, perOriginText), [originsText, perOriginText]);
  const parsedTargets = useMemo(() => parseMassCoordGroups(targetsText, perTargetText), [targetsText, perTargetText]);
  const parsedTowers = useMemo(() => parseMassCoordText(towersText), [towersText]);
  // Rótulos vivos usam o NormalizedCoords cru (coordCountLabel consome essa forma).
  const normOrigins = useMemo(() => normalizeCoordText(originsText), [originsText]);
  const normTargets = useMemo(() => normalizeCoordText(targetsText), [targetsText]);
  const normTowers = useMemo(() => normalizeCoordText(towersText), [towersText]);
  const totalOriginCommands = useMemo(
    () => parsedOrigins.quotas.reduce((sum, quota) => sum + quota, 0),
    [parsedOrigins.quotas],
  );
  const totalTargetCommands = useMemo(
    () => parsedTargets.quotas.reduce((sum, quota) => sum + quota, 0),
    [parsedTargets.quotas],
  );

  const draftGroup = useMemo<MassGroupConfig | null>(() => {
    const arrivalBaseMs = arrivalBaseText === '' ? Number.NaN : new Date(arrivalBaseText).getTime();
    return {
      id: editingId ?? 'draft',
      nome: nomeText,
      origins: parsedOrigins.entries,
      originQuotas: parsedOrigins.quotas,
      targets: parsedTargets.entries,
      targetQuotas: parsedTargets.quotas,
      towers: parsedTowers.entries,
      towerRadius: 15,
      slowestUnit,
      assignMode,
      repeatOriginSamePlayer: repeatSamePlayer,
      minDistance: Number(minDistanceText),
      maxDistance: Number(maxDistanceText),
      arrivalKind,
      arrivalBaseMs,
      windowStartMs: windowStartText === '' ? Number.NaN : new Date(windowStartText).getTime(),
      windowEndMs: windowEndText === '' ? Number.NaN : new Date(windowEndText).getTime(),
      attackDelaySeconds: Number(delayText),
      nightBonus: nightBonusMode,
      avoidMsConflict: avoidMs,
      minMorale: moralActive ? Number(minMoraleText) : 0,
      catapultTargets: catapultsText === '' ? [] : catapultsText.split(',').filter((id) => id !== ''),
    };
  }, [
    editingId, nomeText, parsedOrigins.entries, parsedOrigins.quotas, parsedTargets.entries, parsedTargets.quotas,
    parsedTowers.entries, slowestUnit, assignMode, repeatSamePlayer, minDistanceText, maxDistanceText, arrivalKind,
    arrivalBaseText, windowStartText, windowEndText, delayText, nightBonusMode, avoidMs, moralActive,
    minMoraleText, catapultsText,
  ]);

  const draftErrors: MassGroupErrors = useMemo(() => {
    if (draftGroup === null) return {};
    return validateMassGroup(draftGroup, planContext);
  }, [draftGroup, planContext]);

  const showFieldError = (field: keyof MassGroupErrors): string | undefined =>
    submitAttempted || touched[field] === true ? draftErrors[field] : undefined;

  function markTouched(field: string): void {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  function resetForm(): void {
    setNomeText('');
    setOriginsText('');
    setTargetsText('');
    setTowersText('');
    setPerOriginText(PLANNER_DEFAULTS.mpPerOrigin);
    setPerTargetText(PLANNER_DEFAULTS.mpPerTarget);
    setRepeatSamePlayer(PLANNER_DEFAULTS.mpRepeatSamePlayer);
    setMinDistanceText(PLANNER_DEFAULTS.mpMinDistance);
    setMaxDistanceText(PLANNER_DEFAULTS.mpMaxDistance);
    setArrivalKind(PLANNER_DEFAULTS.mpArrivalKind);
    setWindowStartText(PLANNER_DEFAULTS.mpWindowStart);
    setWindowEndText(PLANNER_DEFAULTS.mpWindowEnd);
    setDelayText(PLANNER_DEFAULTS.mpDelay);
    setNightBonusMode(PLANNER_DEFAULTS.mpNightBonus);
    setAvoidMs(PLANNER_DEFAULTS.mpAvoidMs);
    setMinMoraleText(PLANNER_DEFAULTS.mpMinMorale);
    setCatapultsText(PLANNER_DEFAULTS.mpCatapults);
    setCatapultOpen(false);
    setSubmitAttempted(false);
    setTouched({});
  }

  function addGroup(): void {
    if (draftGroup === null) return;
    if (Object.keys(draftErrors).length > 0) {
      setSubmitAttempted(true);
      push('error', 'O grupo tem campos inválidos — confira os avisos em vermelho.');
      return;
    }
    if (parsedOrigins.quotaError !== null || parsedTargets.quotaError !== null) {
      setSubmitAttempted(true);
      push('error', parsedOrigins.quotaError ?? parsedTargets.quotaError ?? 'Comandos por origem/alvo inválidos.');
      return;
    }
    const group: MassGroupConfig = { ...draftGroup, id: editingId ?? crypto.randomUUID() };
    setGroups((current) => {
      if (editingId !== null) {
        return current.map((existing) => (existing.id === editingId ? group : existing));
      }
      return [...current, group];
    });
    push('ok', editingId !== null ? `Grupo "${group.nome}" atualizado.` : `Grupo "${group.nome}" adicionado à operação.`);
    setEditingId(null);
    resetForm();
  }

  function editGroup(id: string): void {
    const group = groups.find((entry) => entry.id === id);
    if (group === undefined) return;
    setEditingId(id);
    setNomeText(group.nome);
    setOriginsText(group.origins.map((coord) => coord.coord).join(' '));
    setTargetsText(group.targets.map((coord) => coord.coord).join(' '));
    setTowersText(group.towers.map((coord) => coord.coord).join(' '));
    setSlowestUnit(group.slowestUnit);
    setAssignMode(group.assignMode);
    // Cotas: se todas iguais, um valor só; senão a lista "1;2" (por grupo).
    const quotaText = (quotas: number[]): string =>
      quotas.length === 0 ? '1' : quotas.every((quota) => quota === quotas[0]) ? String(quotas[0] ?? 1) : quotas.join(';');
    setPerOriginText(quotaText(group.originQuotas));
    setPerTargetText(quotaText(group.targetQuotas));
    setRepeatSamePlayer(group.repeatOriginSamePlayer);
    setMinDistanceText(String(group.minDistance));
    setMaxDistanceText(String(group.maxDistance));
    setArrivalKind(
      group.arrivalKind === 'intervalo' || group.arrivalKind === 'sequencial' ? group.arrivalKind : 'fixa',
    );
    setArrivalBaseText(toLocalInputValue(group.arrivalBaseMs));
    setWindowStartText(toLocalInputValue(group.windowStartMs));
    setWindowEndText(toLocalInputValue(group.windowEndMs));
    setDelayText(String(group.attackDelaySeconds));
    setNightBonusMode(group.nightBonus);
    setAvoidMs(group.avoidMsConflict);
    setMinMoraleText(String(group.minMorale));
    setCatapultsText(group.catapultTargets.join(','));
    setCatapultOpen(group.catapultTargets.length > 0);
    setSubmitAttempted(false);
    setTouched({});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function removeGroup(id: string): void {
    const group = groups.find((entry) => entry.id === id);
    if (group === undefined) return;
    if (!window.confirm(`Remover o grupo "${group.nome}" da operação?`)) return;
    if (editingId === id) setEditingId(null);
    setGroups((current) => current.filter((entry) => entry.id !== id));
    setPlan(null);
    push('ok', `Grupo "${group.nome}" removido.`);
  }

  // ---- Gerar Operação ----
  const [plan, setPlan] = useState<{ result: MassPlanResult; groupsSnapshot: string; generatedAt: number } | null>(null);
  const [generating, setGenerating] = useState(false);
  const groupsSnapshot = useMemo(() => JSON.stringify(groups), [groups]);
  const planStale = plan !== null && plan.groupsSnapshot !== groupsSnapshot;

  function generate(): void {
    if (groups.length === 0) {
      push('error', 'Adicione pelo menos um grupo antes de gerar a operação.');
      return;
    }
    if (!worldReady) {
      push('error', 'Os dados do mundo ainda não carregaram — use "Tentar de novo" no topo.');
      return;
    }
    setGenerating(true);
    try {
      const result = generateMassPlan(groups, planContext);
      if (result.commands.length === 0) {
        push('error', 'Nenhum comando sobrou dos filtros — veja os descartes no resultado.');
      } else {
        push('ok', `Operação gerada: ${result.commands.length} comando(s).`);
      }
      setPlan({ result, groupsSnapshot: JSON.stringify(groups), generatedAt: Date.now() });
    } catch (err) {
      push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  // Partidas no passado são checadas AQUI (a engine pura não consulta o relógio).
  const pastSendCount = useMemo(() => {
    if (plan === null) return 0;
    const now = Date.now();
    return plan.result.commands.filter((command) => command.sendMs < now).length;
  }, [plan]);

  // ---- Exportações / arquivamento ----
  async function copyText(text: string, okMessage: string): Promise<void> {
    if (text.trim() === '') {
      push('info', 'Nada para copiar ainda — gere a operação primeiro.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      push('ok', okMessage);
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  const [archiving, setArchiving] = useState(false);
  async function archivePlan(): Promise<void> {
    if (plan === null || plan.result.commands.length === 0) return;
    const title = archiveTitle.trim();
    if (title === '') {
      push('error', 'Dê um título à operação para arquivar (ex.: "OP Cerco Noturno 29/08").');
      return;
    }
    setArchiving(true);
    try {
      const byExecutor = new Map<string, string[]>();
      for (const command of plan.result.commands) {
        // Teto de 40 no nick: a distribuição "nick;coords" é relida pelo parser
        // da Sala de Guerra (nick 2–40) — "Grupo <nome>" precisa caber.
        const executor = (command.originOwner ?? `Grupo ${command.groupName}`).replace(/;/g, '−').slice(0, 40);
        const list = byExecutor.get(executor) ?? [];
        list.push(command.target);
        byExecutor.set(executor, list);
      }
      const distribution = [...byExecutor.entries()].map(([nick, targets]) => `${nick};${targets.join(' ')}`).join('\n');
      const targets = [...new Set(plan.result.commands.map((command) => command.target))];
      await window.staffhub.opArchive.save({
        title,
        targets,
        distribution,
        sendSchedule: formatColavel(plan.result.commands),
      });
      push('ok', `OP "${title}" arquivada — acompanhe no monitoramento da Sala de Guerra.`);
      onOpenMonitor();
    } catch (err) {
      push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setArchiving(false);
    }
  }

  // ---- Seção expansível de catapulta ----
  const [catapultOpen, setCatapultOpen] = useState(false);
  const catapultSet = useMemo(() => new Set(catapultsText === '' ? [] : catapultsText.split(',')), [catapultsText]);
  function toggleCatapult(id: string): void {
    const next = new Set(catapultSet);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setCatapultsText([...next].join(','));
  }

  const planCommands = plan?.result.commands ?? [];
  /** Teto de renderização da tabela: OP gigante não pode derrubar o DOM. */
  const RENDER_LIMIT = 1000;
  const visibleCommands = planCommands.slice(0, RENDER_LIMIT);

  return (
    <div className="col">
      {worldError !== '' && (
        <div className="callout callout--danger" role="alert">
          <span className="callout-icon"><TriangleAlert size={16} aria-hidden="true" /></span>
          <div className="callout-body">
            <p className="callout-title">Dados do mundo indisponíveis</p>
            <p>{worldError}</p>
            <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => void loadWorld()} disabled={worldLoading}>
              <RefreshCw size={14} aria-hidden="true" />
              {worldLoading ? 'Carregando…' : 'Tentar de novo'}
            </button>
          </div>
        </div>
      )}

      {/* ---- BLOCO 1 — Contexto (substitui "Servidor/Chave de Acesso" do tool original) ---- */}
      <section className="card" aria-labelledby="mp-contexto-title">
        <div className="card-header">
          <h2 className="card-title" id="mp-contexto-title">Contexto</h2>
        </div>
        <div className="card-body mp-context">
          {session.world !== null ? (
            <>
              <span className="mp-context-dot" aria-hidden="true" />
              <strong>Mundo: {session.world.toUpperCase()}</strong>
              {session.player !== null && <span>· {session.player}</span>}
              <span className="muted">(usa a sessão/SID já conectada — sem "chave de acesso" do tool original)</span>
            </>
          ) : (
            <span className="muted">Sessão não conectada — abra o jogo (ou importe o SID) para carregar o mundo do planner.</span>
          )}
          {!worldReady && worldError === '' && (
            <span className="muted">{worldLoading ? 'Carregando unidades, bônus noturno e dump do mundo…' : ''}</span>
          )}
        </div>
      </section>

      {/* ---- BLOCO 2 — Adicionar Grupo (campo a campo da spec) ---- */}
      <section className="card" aria-labelledby="mp-add-title">
        <div className="card-header">
          <h2 className="card-title" id="mp-add-title">Adicionar grupo</h2>
          <span className="spacer" />
          {editingId !== null && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setEditingId(null);
                resetForm();
              }}
            >
              Cancelar edição
            </button>
          )}
        </div>
        <div className="card-body col" style={{ gap: 12 }}>
          <div className="mp-grid">
            {/* 1. Coordenadas de Origem */}
            <div className="field mp-field">
              <label className="field-label" htmlFor="mp-origins" data-tip="Aldeias que ENVIAM os ataques deste grupo. Aceita espaço, ; ou quebra de linha.">
                Coordenadas de Origem:
              </label>
              <textarea
                id="mp-origins"
                className="textarea"
                rows={3}
                placeholder="Ex: 500|500 501|501; 502|502"
                value={originsText}
                onChange={(event) => setOriginsText(event.target.value)}
                onBlur={() => markTouched('origins')}
              />
              <span className="field-hint">{coordCountLabel(normOrigins)}</span>
              {showFieldError('origins') !== undefined && <span className="field-error">{draftErrors.origins}</span>}
              <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
                <select
                  className="select select--compact"
                  aria-label="Grupo salvo para importar como origem"
                  value={importOriginId}
                  onChange={(event) => setImportOriginId(event.target.value)}
                >
                  <option value="">— grupo salvo —</option>
                  {sameWorldGroups.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.nome} ({entry.papel} · {entry.coords.length})
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => importGroupCoords('origin')} data-tip="Preenche a Origem com as coordenadas do grupo salvo (mesmo mundo).">
                  Importar grupo salvo <span className="pill pill--gold mp-novo">NOVO</span>
                </button>
              </div>
            </div>

            {/* 2. Coordenadas de Destino */}
            <div className="field mp-field">
              <label className="field-label" htmlFor="mp-targets" data-tip="Aldeias ALVO deste grupo. Mesmo parsing da Origem.">
                Coordenadas de Destino:
              </label>
              <textarea
                id="mp-targets"
                className="textarea"
                rows={3}
                placeholder="Ex: 600|600 601|601; 602|602"
                value={targetsText}
                onChange={(event) => setTargetsText(event.target.value)}
                onBlur={() => markTouched('targets')}
              />
              <span className="field-hint">{coordCountLabel(normTargets)}</span>
              {showFieldError('targets') !== undefined && <span className="field-error">{draftErrors.targets}</span>}
              <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
                <select
                  className="select select--compact"
                  aria-label="Grupo salvo para importar como destino"
                  value={importTargetId}
                  onChange={(event) => setImportTargetId(event.target.value)}
                >
                  <option value="">— grupo salvo —</option>
                  {sameWorldGroups.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.nome} ({entry.papel} · {entry.coords.length})
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => importGroupCoords('target')} data-tip="Preenche o Destino com as coordenadas do grupo salvo (mesmo mundo).">
                  Importar grupo salvo
                </button>
              </div>
            </div>
          </div>

          {/* 3. Coordenadas da Torre (opcional) */}
          <div className="field">
            <label className="field-label" htmlFor="mp-towers" data-tip="Torres de Vigia INIMIGAS: comandos cuja trajetória em linha reta passar a ≤ 15 campos de uma torre são descartados (fugir da detecção antecipada). Deixe vazio no grupo de fakes.">
              Coordenadas da Torre (opcional):
            </label>
            <input
              id="mp-towers"
              className="input"
              placeholder="Ex: 552|552 553|553"
              value={towersText}
              onChange={(event) => setTowersText(event.target.value)}
              onBlur={() => markTouched('towers')}
            />
            <span className="field-hint">
              {towersText.trim() === '' ? 'Raio de detecção: 15 campos.' : coordCountLabel(normTowers)}
            </span>
            {showFieldError('towers') !== undefined && <span className="field-error">{draftErrors.towers}</span>}
          </div>

          <div className="mp-grid">
            {/* 4. Modelo de Tropa (+ preset da Análise de Tropas) */}
            <div className="field">
              <label className="field-label" htmlFor="mp-nome" data-tip="Nome livre que identifica o tipo de ataque deste grupo (ex.: nuke, fake, limpeza).">
                Modelo de Tropa:
              </label>
              <input
                id="mp-nome"
                className="input"
                placeholder="Ex: nuke"
                value={nomeText}
                onChange={(event) => setNomeText(event.target.value)}
                onBlur={() => markTouched('nome')}
                list="mp-presets-list"
              />
              <datalist id="mp-presets-list">
                {sg2Presets.map((preset) => (
                  <option key={preset.name} value={preset.name} />
                ))}
              </datalist>
              <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
                <select
                  className="select select--compact"
                  aria-label="Puxar preset da Análise de Tropas"
                  value=""
                  onChange={(event) => {
                    const preset = sg2Presets.find((entry) => entry.name === event.target.value);
                    if (preset !== undefined) applySg2Preset(preset);
                  }}
                >
                  <option value="">— puxar preset da Análise de Tropas —</option>
                  {sg2Presets.map((preset) => (
                    <option key={preset.name} value={preset.name}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                <span className="field-hint">preenche nome + unidade mais lenta</span>
              </div>
              {showFieldError('nome') !== undefined && <span className="field-error">{draftErrors.nome}</span>}
            </div>

            {/* 5. Unidade mais Lenta */}
            <div className="field">
              <label className="field-label" htmlFor="mp-unit" data-tip="Define a VELOCIDADE do comando (viaja no ritmo da unidade mais lenta). Lista vem do unit-info do mundo atual.">
                Unidade mais Lenta:
              </label>
              <select
                id="mp-unit"
                className="select"
                value={slowestUnit}
                onChange={(event) => {
                  setSlowestUnit(event.target.value as UnitId);
                  markTouched('slowestUnit');
                }}
              >
                {UNIT_ORDER.filter((id) => unitMinutes[id] !== undefined).map((id) => (
                  <option key={id} value={id}>
                    {UNITS[id].name}
                  </option>
                ))}
              </select>
              {showFieldError('slowestUnit') !== undefined && <span className="field-error">{draftErrors.slowestUnit}</span>}
            </div>

            {/* 6/7. Comandos por Origem / por Alvo — listas por grupo "1;2" (tool real) */}
            <div className="field">
              <label className="field-label" htmlFor="mp-per-origin" data-tip="Quantas vezes CADA aldeia de origem pode ser usada. Um número vale para todos os grupos; '1;2' dá cota 1 ao 1º grupo de coordenadas e 2 ao 2º (grupos separados por ; na Origem).">
                Comandos por Origem:
              </label>
              <input
                id="mp-per-origin"
                className="input input--num"
                type="text"
                inputMode="numeric"
                placeholder="Ex: 1;2"
                value={perOriginText}
                onChange={(event) => setPerOriginText(event.target.value)}
                onBlur={() => markTouched('commandsPerOrigin')}
              />
              <span className="field-hint">
                {parsedOrigins.quotaError ?? `Origem: até ${totalOriginCommands} comando(s)`}
              </span>
              {showFieldError('commandsPerOrigin') !== undefined && <span className="field-error">{draftErrors.commandsPerOrigin}</span>}
            </div>
            <div className="field">
              <label className="field-label" htmlFor="mp-per-target" data-tip="Quantas vezes CADA alvo pode ser atacado (ondas). Um número vale para todos os grupos; '1;2' dá cota por grupo de alvos separados por ; no Destino.">
                Comandos por Alvo:
              </label>
              <input
                id="mp-per-target"
                className="input input--num"
                type="text"
                inputMode="numeric"
                placeholder="Ex: 1;1"
                value={perTargetText}
                onChange={(event) => setPerTargetText(event.target.value)}
                onBlur={() => markTouched('commandsPerTarget')}
              />
              <span className="field-hint">
                {parsedTargets.quotaError ?? `Alvos: até ${totalTargetCommands} comando(s)`}
              </span>
              {showFieldError('commandsPerTarget') !== undefined && <span className="field-error">{draftErrors.commandsPerTarget}</span>}
            </div>
          </div>

          {/* 8. Repetir origem no mesmo player */}
          <label className="checkbox-field" data-tip="Permite que a MESMA aldeia de origem ataque mais de uma alvo DO MESMO jogador.">
            <input
              type="checkbox"
              checked={repeatSamePlayer}
              onChange={(event) => setRepeatSamePlayer(event.target.checked)}
            />
            <span>Repetir aldeias de origem no mesmo player?</span>
          </label>

          <div className="mp-grid">
            {/* 9/10. Distância mín/máx + Moral */}
            <div className="field">
              <label className="field-label" htmlFor="mp-min-dist" data-tip="Descarta pares com distância MENOR que este valor (em campos).">
                Distância Mínima:
              </label>
              <input
                id="mp-min-dist"
                className="input input--num"
                type="number"
                min={0}
                value={minDistanceText}
                onChange={(event) => setMinDistanceText(event.target.value)}
                onBlur={() => markTouched('minDistance')}
              />
              {showFieldError('minDistance') !== undefined && <span className="field-error">{draftErrors.minDistance}</span>}
            </div>
            <div className="field">
              <label className="field-label" htmlFor="mp-max-dist" data-tip="Descarta pares com distância MAIOR que este valor (em campos).">
                Distância Máxima:
              </label>
              <input
                id="mp-max-dist"
                className="input input--num"
                type="number"
                min={0}
                value={maxDistanceText}
                onChange={(event) => setMaxDistanceText(event.target.value)}
                onBlur={() => markTouched('maxDistance')}
              />
              {showFieldError('maxDistance') !== undefined && <span className="field-error">{draftErrors.maxDistance}</span>}
            </div>
            {moralActive ? (
              <div className="field">
                <label className="field-label" htmlFor="mp-min-morale" data-tip="Descarta pares cuja moral (por pontos, dono da origem × pontos do alvo) fique abaixo do limiar. 0 = ignorar.">
                  Moral Mínima (%): <span className="pill pill--gold mp-novo">NOVO</span>
                </label>
                <input
                  id="mp-min-morale"
                  className="input input--num"
                  type="number"
                  min={0}
                  max={100}
                  value={minMoraleText}
                  onChange={(event) => setMinMoraleText(event.target.value)}
                  onBlur={() => markTouched('minMorale')}
                />
                <span className="field-hint">0 = ignorar</span>
                {showFieldError('minMorale') !== undefined && <span className="field-error">{draftErrors.minMorale}</span>}
              </div>
            ) : (
              <div className="field">
                <span className="field-label muted" data-tip="Este mundo NÃO tem moral por pontos (ex.: mundos clássicos) — o campo fica oculto.">
                  Moral Mínima (%): — oculto/100% neste mundo (sem moral por pontos)
                </span>
              </div>
            )}
          </div>

          <div className="mp-grid">
            {/* 11. Tipo de Data de Chegada */}
            <div className="field">
              <label className="field-label" htmlFor="mp-arrival-kind" data-tip="Fixa: todos chegam no mesmo horário. Intervalo: espalha as chegadas na janela. Fixa com intervalo por aldeia: ondas por alvo (cada aldeia-alvo desloca pelo intervalo).">
                Tipo de Data de Chegada:
              </label>
              <select
                id="mp-arrival-kind"
                className="select"
                value={arrivalKind}
                onChange={(event) => setArrivalKind(event.target.value as MassArrivalKind)}
              >
                <option value="fixa">Fixa</option>
                <option value="intervalo">Intervalo</option>
                <option value="sequencial">Fixa com intervalo por aldeia</option>
              </select>
            </div>
            {/* 12. Modo de Cálculo */}
            <div className="field">
              <label className="field-label" htmlFor="mp-assign" data-tip="Como as origens são atribuídas aos alvos: Otimizado (melhor conjunto geral, par mais curto primeiro), Mais perto ou Mais longe (por alvo, na ordem digitada).">
                Modo de Cálculo:
              </label>
              <select
                id="mp-assign"
                className="select"
                value={assignMode}
                onChange={(event) => setAssignMode(event.target.value as MassAssignMode)}
              >
                <option value="otimizado">Otimizado</option>
                <option value="por-jogador">Distribuído por players</option>
                <option value="mais-perto">Mais perto</option>
                <option value="mais-longe">Mais longe</option>
              </select>
            </div>
          </div>

          {arrivalKind === 'intervalo' && (
            <div className="mp-grid">
              <div className="field">
                <label className="field-label" htmlFor="mp-window-start" data-tip="As chegadas são espalhadas ENTRE o início e o fim (igual ao tool original).">
                  Início do Intervalo:
                </label>
                <input
                  id="mp-window-start"
                  className="input"
                  type="datetime-local"
                  step={1}
                  value={windowStartText}
                  onChange={(event) => setWindowStartText(event.target.value)}
                  onBlur={() => markTouched('windowStartMs')}
                />
                {showFieldError('windowStartMs') !== undefined && <span className="field-error">{draftErrors.windowStartMs}</span>}
              </div>
              <div className="field">
                <label className="field-label" htmlFor="mp-window-end" data-tip="Fim da janela de chegadas — deve ser depois do início.">
                  Fim do Intervalo:
                </label>
                <input
                  id="mp-window-end"
                  className="input"
                  type="datetime-local"
                  step={1}
                  value={windowEndText}
                  onChange={(event) => setWindowEndText(event.target.value)}
                  onBlur={() => markTouched('windowEndMs')}
                />
                {showFieldError('windowEndMs') !== undefined && <span className="field-error">{draftErrors.windowEndMs}</span>}
              </div>
            </div>
          )}
          {arrivalKind === 'sequencial' && (
            <div className="mp-grid">
              <div className="field">
                <label className="field-label" htmlFor="mp-delay" data-tip="Cada ataque seguinte do grupo chega delay segundos depois do anterior (o mais perto chega na base — igual ao tool original).">
                  Delay entre ataques (segundos):
                </label>
                <input
                  id="mp-delay"
                  className="input input--num"
                  type="number"
                  min={0}
                  value={delayText}
                  onChange={(event) => setDelayText(event.target.value)}
                  onBlur={() => markTouched('attackDelaySeconds')}
                />
                {showFieldError('attackDelaySeconds') !== undefined && <span className="field-error">{draftErrors.attackDelaySeconds}</span>}
              </div>
            </div>
          )}

          <div className="mp-grid">
            {/* 13. Proteção de Bônus Noturno */}
            <div className="field">
              <label className="field-label" htmlFor="mp-night" data-tip={
                nightCfg !== null && !nightCfg.nightBonusActive
                  ? 'Este mundo NÃO tem bônus noturno — a proteção não tem efeito.'
                  : 'Empurra as chegadas que cairiam na janela do bônus noturno para depois que ela termina (janela lida do world-config).'
              }>
                Proteção de Bônus Noturno:
              </label>
              <select
                id="mp-night"
                className="select"
                value={nightBonusMode}
                onChange={(event) => setNightBonusMode(event.target.value as MassNightBonusMode)}
              >
                <option value="desativado">Desativado</option>
                <option value="reagendar">Reagendar após BN</option>
              </select>
            </div>
            {/* 14. Evitar conflito de ms */}
            <div className="field mp-checkbox-center">
              <label className="checkbox-field" data-tip="Evita que dois comandos cheguem no MESMO milissegundo para o MESMO jogador (desloca 1ms em cascata).">
                <input type="checkbox" checked={avoidMs} onChange={(event) => setAvoidMs(event.target.checked)} />
                <span>Evitar conflito de ms (mesmo jogador)</span>
              </label>
            </div>
          </div>

          {/* 15. Data e Hora de Chegada */}
          <div className="field">
            <label className="field-label" htmlFor="mp-arrival" data-tip="Horário-BASE de chegada do grupo (combinado com o Tipo de Data de Chegada).">
              Data e Hora de Chegada:
            </label>
            <input
              id="mp-arrival"
              className="input"
              type="datetime-local"
              step={1}
              value={arrivalBaseText}
              onChange={(event) => setArrivalBaseText(event.target.value)}
              onBlur={() => markTouched('arrivalBaseMs')}
            />
            {showFieldError('arrivalBaseMs') !== undefined && <span className="field-error">{draftErrors.arrivalBaseMs}</span>}
          </div>

          {/* 16. Demolir Edifícios (com Catapultas) — seção expansível */}
          <div className="mp-catapult">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-expanded={catapultOpen}
              onClick={() => setCatapultOpen((open) => !open)}
            >
              {catapultOpen ? '▾' : '▸'} Demolir Edifícios (com Catapultas)
            </button>
            {catapultOpen && (
              <div className="mp-catapult-grid" role="group" aria-label="Edifícios-alvo de catapulta">
                {MASS_BUILDINGS.map((building) => (
                  <label key={building.id} className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={catapultSet.has(building.id)}
                      onChange={() => toggleCatapult(building.id)}
                    />
                    <span>{building.name}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="field-hint">Vale para grupos cuja unidade mais lenta é Catapulta — a mira vai junto nas exportações.</p>
          </div>

          {/* 17. Adicionar Grupo */}
          <div className="row" style={{ justifyContent: 'center' }}>
            <button type="button" className="btn mp-btn-add" onClick={addGroup}>
              <ListPlus size={16} aria-hidden="true" />
              {editingId !== null ? 'Salvar alterações do grupo' : 'Adicionar Grupo'}
            </button>
          </div>
        </div>
      </section>

      {/* ---- BLOCO 3 — Grupos Adicionados ---- */}
      <section className="card" aria-labelledby="mp-groups-title">
        <div className="card-header">
          <h2 className="card-title" id="mp-groups-title">Grupos adicionados</h2>
          <span className="spacer" />
          {groups.length > 0 && (
            <>
              <span className="pill pill--muted">{groups.length} grupo(s)</span>
              <button
                type="button"
                className="btn btn-ghost btn-ghost--danger btn-sm"
                onClick={() => {
                  if (!window.confirm('Remover TODOS os grupos da operação?')) return;
                  setGroups([]);
                  setEditingId(null);
                  setPlan(null);
                }}
              >
                <Trash2 size={14} aria-hidden="true" /> Limpar todos
              </button>
            </>
          )}
        </div>
        {groupsPersistFull && (
          <p className="error" role="alert" style={{ margin: '8px 16px 0' }}>
            A lista de grupos ficou grande demais para persistir — ela vive só nesta sessão (feche o app e ela se perde). Reduza coordenadas para persistir.
          </p>
        )}
        {groups.length === 0 ? (
          <EmptyState
            compact
            icon={Layers}
            title="Nenhum grupo adicionado."
            hint="Monte o primeiro grupo acima (ex.: fakes), depois os demais (nukes, nobres…) e gere a operação de uma vez."
          />
        ) : (
          <div className="card-body col" style={{ gap: 8 }}>
            {groups.map((group) => {
              const unitName = unitMinutes[group.slowestUnit] !== undefined ? UNITS[group.slowestUnit]?.name : group.slowestUnit;
              const editing = editingId === group.id;
              return (
                <div key={group.id} className={`mp-group-row${editing ? ' mp-group-row--editing' : ''}`}>
                  <div className="mp-group-summary">
                    <strong>{group.nome}</strong>{' '}
                    <span className="pill pill--info">{unitName ?? group.slowestUnit}</span>{' '}
                    <span className="cell-nowrap">
                      {group.origins.length} origem(ns) → {group.targets.length} alvo(s)
                    </span>{' '}
                    <span className="muted">
                      chega {group.arrivalKind === 'fixa' ? formatFullClock(group.arrivalBaseMs) : `a partir de ${formatFullClock(group.arrivalKind === 'intervalo' ? group.windowStartMs : group.arrivalBaseMs)}`}
                    </span>
                    <span className="muted">
                      {' '}· dist {group.minDistance}–{group.maxDistance} campos
                      {group.minMorale > 0 ? ` · moral ≥ ${group.minMorale}%` : ''}
                      {group.towers.length > 0 ? ` · ${group.towers.length} torre(s)` : ''}
                      {group.nightBonus === 'reagendar' ? ' · protege BN' : ''}
                      {group.avoidMsConflict ? ' · evita ms' : ''}
                    </span>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => editGroup(group.id)}>
                      <Pencil size={14} aria-hidden="true" /> Editar
                    </button>
                    <button type="button" className="btn btn-ghost btn-ghost--danger btn-sm" onClick={() => removeGroup(group.id)}>
                      <Trash2 size={14} aria-hidden="true" /> Remover
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ---- BLOCO 4 — Rodapé: formatos + Gerar Operação ---- */}
      <section className="card" aria-labelledby="mp-generate-title">
        <div className="card-header">
          <h2 className="card-title" id="mp-generate-title">Gerar operação</h2>
          <span className="spacer" />
          {groups.length > 0 && (
            <span className="pill pill--muted">{groups.length} grupo(s) na operação</span>
          )}
        </div>
        <div className="card-body col" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <label className="checkbox-field" data-tip="Exporta a lista no formato do Russian Planner (origem alvo unidade data hora de ENVIO).">
              <input type="checkbox" checked={formatRussian} onChange={(event) => setFormatRussian(event.target.checked)} />
              <span>Russian Planner</span>
            </label>
            <label className="checkbox-field" data-tip="Exporta a lista no formato do TW Mass Planner (origem alvo unidade dd.mm.aaaa hora de ENVIO).">
              <input type="checkbox" checked={formatTwmp} onChange={(event) => setFormatTwmp(event.target.checked)} />
              <span>TW Mass Planner</span>
            </label>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <button
              type="button"
              className="btn mp-btn-generate"
              onClick={generate}
              disabled={generating || groups.length === 0 || !worldReady}
              title={worldReady ? undefined : 'Aguardando os dados do mundo carregarem.'}
            >
              {generating ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" /> Gerando…
                </>
              ) : (
                <>
                  <Layers size={16} aria-hidden="true" /> Gerar Operação
                </>
              )}
            </button>
          </div>
          {planStale && (
            <p className="error" role="alert">
              Os grupos mudaram depois da última geração — clique em "Gerar Operação" de novo para atualizar os comandos.
            </p>
          )}
        </div>
      </section>

      {/* ---- Operação gerada (tabela + exportações + arquivo) ---- */}
      {plan !== null && (
        <section className="card" aria-labelledby="mp-result-title">
          <div className="card-header">
            <h2 className="card-title" id="mp-result-title">Operação gerada</h2>
            <span className="spacer" />
            <span className="pill pill--muted">{planCommands.length} comando(s)</span>
          </div>
          <div className="card-body col" style={{ gap: 12 }}>
            {plan.result.discards.length > 0 && (
              <div className="col" style={{ gap: 4 }}>
                <strong>Descartes pelos filtros</strong>
                {plan.result.discards.map((discard) => (
                  <span key={discard.reason} className="field-hint">
                    {discard.count} par(es): {discard.reason}
                  </span>
                ))}
              </div>
            )}
            {plan.result.warnings.length > 0 && (
              <div className="callout callout--warn" role="status">
                <span className="callout-icon"><TriangleAlert size={16} aria-hidden="true" /></span>
                <div className="callout-body">
                  <p className="callout-title">Avisos da geração</p>
                  {plan.result.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              </div>
            )}
            {pastSendCount > 0 && (
              <p className="error" role="alert">
                {pastSendCount} comando(s) teriam PARTIDA no passado — adiada a data/hora de chegada (ou reduza a distância máxima).
              </p>
            )}

            {planCommands.length === 0 ? (
              <EmptyState
                compact
                icon={TriangleAlert}
                title="Nenhum comando sobrou dos filtros"
                hint="Veja os descartes acima: distância, torres ou moral podem ter removido todos os pares."
              />
            ) : (
              <>
            {planCommands.length > RENDER_LIMIT && (
              <p className="field-hint">
                Mostrando os primeiros {RENDER_LIMIT} de {planCommands.length} comandos (ordenados pela chegada) — as exportações e o arquivamento incluem TODOS.
              </p>
            )}
            <div className="table-wrap mp-table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Grupo</th>
                    <th scope="col">Origem</th>
                    <th scope="col">Executor</th>
                    <th scope="col">Alvo</th>
                    <th scope="col">Alvo de</th>
                    <th scope="col">Unidade</th>
                    <th scope="col" className="cell-num">Campos</th>
                    <th scope="col">Envia às</th>
                    <th scope="col">Chega às</th>
                    <th scope="col">Mira (cat)</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCommands.map((command, index) => {
                        const sendDay = new Date(command.sendMs).toDateString();
                        const arrivalDay = new Date(command.arrivalMs).toDateString();
                        const suffix =
                          sendDay === arrivalDay
                            ? ''
                            : ` @${String(new Date(command.sendMs).getDate()).padStart(2, '0')}/${String(new Date(command.sendMs).getMonth() + 1).padStart(2, '0')}`;
                        return (
                          <tr key={`${command.groupId}-${command.origin}-${command.target}-${index}`}>
                            <td className="cell-nowrap">{command.groupName}</td>
                            <td className="cell-nowrap">{command.origin}</td>
                            <td className="cell-nowrap">{command.originOwner ?? '—'}</td>
                            <td className="cell-nowrap">{command.target}</td>
                            <td className="cell-nowrap">{command.targetOwner ?? '—'}</td>
                            <td className="cell-nowrap">{unitLabel(command.unit)}</td>
                            <td className="cell-num">{command.distanceFields}</td>
                            <td className="cell-nowrap">
                              <strong>{formatHms(new Date(command.sendMs))}</strong>
                              {suffix}
                            </td>
                            <td className="cell-nowrap">{formatFullClock(command.arrivalMs)}</td>
                            <td className="cell-nowrap">
                              {command.catapultTargets.length > 0
                                ? command.catapultTargets
                                    .map((id) => MASS_BUILDINGS.find((building) => building.id === id)?.name ?? id)
                                    .join(', ')
                                : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {formatRussian && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-tip="BBCode por jogador para o CADERNO DA CONTA PREMIUM — formato real do tool original, com milissegundos e link da praça."
                      onClick={() => copyText(formatRussianPlanner(planCommands, session.world ?? 'br'), 'BBCode Russian Planner copiado — cole no caderno da conta premium.')}
                    >
                      <ClipboardCopy size={14} aria-hidden="true" /> Copiar Russian Planner
                    </button>
                  )}
                  {formatTwmp && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-tip="Igual ao Russian + colunas de chegada e edifício-alvo — formato real do TW Mass Planner."
                      onClick={() => copyText(formatTwMassPlanner(planCommands, session.world ?? 'br'), 'BBCode TW Mass Planner copiado — cole no caderno da conta premium.')}
                    >
                      <ClipboardCopy size={14} aria-hidden="true" /> Copiar TW Mass Planner
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => copyText(formatColavel(planCommands), 'Agenda copiada no formato do app (nick;alvo;hora) — serve no T-minus e na conferência.')}
                  >
                    <ClipboardCopy size={14} aria-hidden="true" /> Copiar agenda do app
                  </button>
                </div>

                <div className="mp-archive">
                  <div className="field" style={{ maxWidth: 420 }}>
                    <label className="field-label" htmlFor="mp-archive-title" data-tip="Nome da OP no Arquivo — ela aparece no monitoramento e no scorecard.">
                      Título da operação
                    </label>
                    <input
                      id="mp-archive-title"
                      className="input"
                      placeholder="Ex.: OP Cerco Noturno 29/08"
                      value={archiveTitle}
                      onChange={(event) => setArchiveTitle(event.target.value)}
                    />
                  </div>
                  <button type="button" className="btn" onClick={() => void archivePlan()} disabled={archiving || planCommands.length === 0}>
                    <Save size={16} aria-hidden="true" />
                    {archiving ? (
                      <>
                        <span className="btn-spinner" aria-hidden="true" /> Arquivando…
                      </>
                    ) : (
                      'Arquivar no Arquivo de OPs'
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** Revalida um grupo vindo do rascunho persistido — lixo no disco é descartado
 *  (com contagem no console), nunca vira estado fantasma. */
function reviveGroupConfig(item: unknown): MassGroupConfig | null {
  if (typeof item !== 'object' || item === null) return null;
  const raw = item as Record<string, unknown>;
  const coordList = (value: unknown): MassGroupConfig['origins'] => {
    if (!Array.isArray(value)) return [];
    const entries: MassGroupConfig['origins'] = [];
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const coord = typeof record.coord === 'string' ? record.coord : '';
      const x = typeof record.x === 'number' ? record.x : Number.NaN;
      const y = typeof record.y === 'number' ? record.y : Number.NaN;
      if (coord === '' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      entries.push({ coord, x, y });
    }
    return entries;
  };
  const id = typeof raw.id === 'string' ? raw.id : '';
  const nome = typeof raw.nome === 'string' ? raw.nome : '';
  const origins = coordList(raw.origins);
  const targets = coordList(raw.targets);
  if (id === '' || nome === '' || origins.length === 0 || targets.length === 0) return null;
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  const quotaList = (value: unknown, size: number): number[] => {
    if (!Array.isArray(value) || value.length !== size) {
      return Array.from({ length: size }, () => 1);
    }
    return value.map((quota) => (typeof quota === 'number' && Number.isInteger(quota) && quota >= 1 ? quota : 1));
  };
  return {
    id,
    nome,
    origins,
    originQuotas: quotaList(raw.originQuotas, origins.length),
    targets,
    targetQuotas: quotaList(raw.targetQuotas, targets.length),
    towers: coordList(raw.towers),
    towerRadius: num(raw.towerRadius, 15),
    slowestUnit: typeof raw.slowestUnit === 'string' ? (raw.slowestUnit as UnitId) : 'ram',
    assignMode:
      raw.assignMode === 'mais-perto' || raw.assignMode === 'mais-longe' || raw.assignMode === 'por-jogador'
        ? raw.assignMode
        : 'otimizado',
    repeatOriginSamePlayer: raw.repeatOriginSamePlayer === true,
    minDistance: num(raw.minDistance, 0),
    maxDistance: num(raw.maxDistance, 2000),
    arrivalKind:
      raw.arrivalKind === 'intervalo' || raw.arrivalKind === 'sequencial'
        ? raw.arrivalKind
        : raw.arrivalKind === 'fixa-por-aldeia'
          ? 'sequencial' // migração v0.28→v0.29
          : 'fixa',
    arrivalBaseMs: num(raw.arrivalBaseMs, Number.NaN),
    windowStartMs: num(raw.windowStartMs, Number.NaN),
    windowEndMs: num(raw.windowEndMs, Number.NaN),
    attackDelaySeconds: num(raw.attackDelaySeconds, num(raw.perVillageSeconds, 30)), // legado v0.28
    nightBonus: raw.nightBonus === 'reagendar' ? 'reagendar' : 'desativado',
    avoidMsConflict: raw.avoidMsConflict === true,
    minMorale: num(raw.minMorale, 0),
    catapultTargets: Array.isArray(raw.catapultTargets)
      ? raw.catapultTargets.filter((catId): catId is string => typeof catId === 'string')
      : [],
  };
}
