import { useEffect, useRef, useState } from 'react';
import { ClipboardCopy, Radar, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import type { BlindVillageResult } from '@shared/ipc-types';
import type { SupportersResult } from '@shared/types';
import { blindBbcodeTable, type BlindCheckInput } from '@shared/sg3-engine';
import { normalizeCoordText, coordCountLabel, type NormalizedCoords } from '@shared/coord-input';
import { DEFAULT_THREAT_THRESHOLDS, rankVillagesByThreat, threatSummary, type VillageThreat, type VillageThreatInput } from '@shared/incoming-risk';
import { TW_UNIT_ICONS } from '../../assets';
import { UNITS, defensivePopulation, type UnitCounts, type UnitId } from '@shared/units';
import type { TroopSnapshot } from '@shared/sg2-engine';
import { usePreferences } from '../../hooks/usePreferences';
import { useToast } from '../../hooks/useToast';
import ToastViewport from '../../components/Toast';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import ProgressBar from '../../components/ProgressBar';
import { MODULES } from '../../modules';

type CountMode = 'paradas' | 'paradas-e-transito';

/** Métrica de "tamanho" da aldeia para filtrar a blindagem. */
type SizeMetric = 'pontos' | 'populacao';

const BLIND_UNITS: readonly UnitId[] = ['spear', 'sword', 'archer', 'heavy'];

/** Padrões dos campos persistidos do módulo sg3 (só ENTRADAS de formulário —
 * resultados de consulta, apoiadores, triagem e estados de ocupação ficam voláteis). */
const SG3_DEFAULTS = {
  desired: {} as Partial<Record<UnitId, string>>,
  countMode: 'paradas' as CountMode,
  sizeMetric: 'pontos' as SizeMetric,
  minSizeText: '',
  coordsText: '',
  supportersCoordsText: '',
  // Triagem de ataques recebidos: thresholds como TEXTO (o campo é livre na
  // digitação; a validação inteiro ≥0 só roda ao usar a varredura).
  threatMinResist: String(DEFAULT_THREAT_THRESHOLDS.minResistPop),
  threatNobleDanger: String(DEFAULT_THREAT_THRESHOLDS.nobleDangerPop),
  // Escala do blind pelo tamanho da aldeia (roadmap 13): ligado/desligado em
  // boolean JSON puro + pontos de referência como TEXTO (validação inteiro >0
  // só roda ao consultar, mesma convenção dos demais campos numéricos).
  blindScaleOn: false,
  blindRefPoints: '9000',
};

/** Trecho incompleto no fim do campo (ex.: "123|") — presente enquanto o usuário digita. */
const PARTIAL_TOKEN_TAIL = /[^\t ;,\r\n]+$/;

/** Converte os tokens "x|y" do parser normalizado para o filtro {x,y} do engine. */
function coordsToFilter(coords: readonly string[]): { x: number; y: number }[] {
  return coords.map((token) => {
    const [x, y] = token.split('|');
    return { x: Number(x), y: Number(y) };
  });
}

/**
 * População da aldeia somando unidades × população por unidade do mundo
 * (unitPops); unidade ausente no dump do mundo cai no catálogo fixo pt-BR.
 */
function villagePopulation(units: UnitCounts, popsByUnit: Record<string, number>): number {
  let total = 0;
  for (const [unit, count] of Object.entries(units)) {
    const pop = popsByUnit[unit] ?? UNITS[unit as UnitId]?.population ?? 0;
    total += (count ?? 0) * pop;
  }
  return total;
}

/**
 * Threshold da triagem digitado como texto: aceita separador de milhar "."
 * (mesma convenção do tamanho mínimo) e devolve o inteiro ≥0, ou null quando
 * o valor não é um inteiro ≥0 (vazio incluso). A validação só dispara ao usar.
 */
function parseThresholdText(text: string): number | null {
  const value = Number(text.trim() === '' ? Number.NaN : text.replace(/\./g, ''));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export default function Sg3Page() {
  const { toasts, push, dismiss } = useToast();
  const moduleInfo = MODULES.find((module) => module.id === 'sg3');
  const { prefs, savePrefs, resetPrefs } = usePreferences('sg3', SG3_DEFAULTS);

  useEffect(() => {
    const unsubscribe = window.staffhub.events.onQueueProgress(setProgress);
    return unsubscribe;
  }, []);
  const [defenseAt, setDefenseAt] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [coordsText, setCoordsText] = useState(SG3_DEFAULTS.coordsText);
  // Parser normalizado do campo "Coordenadas do front" — contador e ignorados.
  const [coordsMeta, setCoordsMeta] = useState<NormalizedCoords>(() => normalizeCoordText(SG3_DEFAULTS.coordsText));
  // Campo próprio dos apoiadores (vazio = usar o front de cima).
  const [supportersCoordsText, setSupportersCoordsText] = useState(SG3_DEFAULTS.supportersCoordsText);
  const [supportersCoordsMeta, setSupportersCoordsMeta] = useState<NormalizedCoords>(() => normalizeCoordText(SG3_DEFAULTS.supportersCoordsText));
  // ---- Tamanho mínimo da blindagem (entrega 2) ----
  const [sizeMetric, setSizeMetric] = useState<SizeMetric>(SG3_DEFAULTS.sizeMetric);
  const [minSizeText, setMinSizeText] = useState(SG3_DEFAULTS.minSizeText);
  // ---- Escala do blind pelo tamanho da aldeia (roadmap 13) ----
  const [blindScaleOn, setBlindScaleOn] = useState(SG3_DEFAULTS.blindScaleOn);
  const [blindRefPoints, setBlindRefPoints] = useState(SG3_DEFAULTS.blindRefPoints);
  const [desired, setDesired] = useState<Partial<Record<UnitId, string>>>(SG3_DEFAULTS.desired);
  const [countMode, setCountMode] = useState<CountMode>(SG3_DEFAULTS.countMode);
  // Resultado da blindagem já filtrado pelo tamanho mínimo: valor "Tam." por
  // aldeia na métrica escolhida (null = tamanho desconhecido, ex.: fora do dump).
  const [results, setResults] = useState<{
    rows: BlindVillageResult[];
    tamByKey: Record<string, number | null>;
    metric: SizeMetric;
  } | null>(null);
  const [bbcode, setBbcode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [supportersBusy, setSupportersBusy] = useState(false);
  const [supportersResult, setSupportersResult] = useState<SupportersResult | null>(null);
  const [supportersError, setSupportersError] = useState('');
  // ---- P0-5 — Ataques recebidos (triagem "esta aldeia vai cair") ----
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState('');
  const [threats, setThreats] = useState<VillageThreat[] | null>(null);
  // Thresholds da triagem, editáveis no painel (texto; derivados no uso).
  const [threatMinResistText, setThreatMinResistText] = useState(SG3_DEFAULTS.threatMinResist);
  const [threatNobleDangerText, setThreatNobleDangerText] = useState(SG3_DEFAULTS.threatNobleDanger);
const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);

  // Preferências do módulo: os formulários sobrevivem a F5/reinício (resultados,
  // apoiadores, triagem e estados de ocupação continuam voláteis).
  const prefsHydrated = useRef(false);

  // Hidratação (uma única vez, após prefs chegar do main): aplica só as chaves
  // presentes, para não pisar em estado que o usuário já editou.
  useEffect(() => {
    if (prefs === null || prefsHydrated.current) return;
    prefsHydrated.current = true;
    if (prefs.desired !== null && typeof prefs.desired === 'object') {
      const restored: Partial<Record<UnitId, string>> = {};
      for (const [unit, value] of Object.entries(prefs.desired)) {
        if (typeof value === 'string') restored[unit as UnitId] = value;
      }
      setDesired(restored);
    }
    if (prefs.countMode === 'paradas' || prefs.countMode === 'paradas-e-transito') setCountMode(prefs.countMode);
    if (prefs.sizeMetric === 'pontos' || prefs.sizeMetric === 'populacao') setSizeMetric(prefs.sizeMetric);
    if (typeof prefs.minSizeText === 'string') setMinSizeText(prefs.minSizeText);
    if (typeof prefs.coordsText === 'string') {
      setCoordsText(prefs.coordsText);
      setCoordsMeta(normalizeCoordText(prefs.coordsText));
    }
    if (typeof prefs.supportersCoordsText === 'string') {
      setSupportersCoordsText(prefs.supportersCoordsText);
      setSupportersCoordsMeta(normalizeCoordText(prefs.supportersCoordsText));
    }
    if (typeof prefs.threatMinResist === 'string') setThreatMinResistText(prefs.threatMinResist);
    if (typeof prefs.threatNobleDanger === 'string') setThreatNobleDangerText(prefs.threatNobleDanger);
    if (typeof prefs.blindScaleOn === 'boolean') setBlindScaleOn(prefs.blindScaleOn);
    if (typeof prefs.blindRefPoints === 'string') setBlindRefPoints(prefs.blindRefPoints);
  }, [prefs]);

  // Persistência com guard: só grava DEPOIS da hidratação — nunca sobrescreve o
  // storage com os defaults do primeiro render. savePrefs é debounced.
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({
      desired,
      countMode,
      sizeMetric,
      minSizeText,
      coordsText,
      supportersCoordsText,
      threatMinResist: threatMinResistText,
      threatNobleDanger: threatNobleDangerText,
      blindScaleOn,
      blindRefPoints,
    });
  }, [
    desired,
    countMode,
    sizeMetric,
    minSizeText,
    coordsText,
    supportersCoordsText,
    threatMinResistText,
    threatNobleDangerText,
    blindScaleOn,
    blindRefPoints,
    savePrefs,
  ]);

  // Caches de dados auxiliares da consulta de blindagem — cada fonte carrega UMA vez.
  const unitPopsRef = useRef<Record<string, number>>({});
  const worldPointsRef = useRef<Map<string, number> | null>(null);
  const worldPointsStateRef = useRef<'idle' | 'ok' | 'failed'>('idle');
  const defenseRef = useRef<TroopSnapshot | null>(null);
  const defenseLoadedRef = useRef(false);

  useEffect(() => {
    void window.staffhub.troops
      .status()
      .then((status) => setDefenseAt(status.defenseAt))
      .catch(() => undefined);
  }, []);

  async function collectDefense(): Promise<void> {
    setCollecting(true);
    setError('');
    try {
      await window.staffhub.troops.collectMembers('defense');
      const status = await window.staffhub.troops.status();
      setDefenseAt(status.defenseAt);
      defenseRef.current = null; // coleta nova substitui o snapshot em memória
      defenseLoadedRef.current = false;
      push('ok', 'Defesa coletada por aldeia — dados em memória.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setCollecting(false);
    }
  }

  /** População por unidade do mundo — 1 IPC na sessão; fallback = catálogo fixo. */
  async function ensureUnitPops(): Promise<void> {
    if (Object.keys(unitPopsRef.current).length > 0) return;
    try {
      unitPopsRef.current = await window.staffhub.world.unitPops();
    } catch {
      push('info', 'População por unidade do mundo indisponível — usando os valores padrão do catálogo.');
    }
  }

  /** Snapshot de defesa em memória (fonte da população por aldeia). */
  async function ensureDefense(): Promise<boolean> {
    if (defenseLoadedRef.current) return defenseRef.current !== null;
    defenseLoadedRef.current = true;
    try {
      defenseRef.current = await window.staffhub.troops.get('defense');
    } catch {
      push('error', 'Não consegui ler a coleta de defesa em memória — consulte sem filtro ou colete novamente.');
    }
    return defenseRef.current !== null;
  }

  /** Pontos das aldeias pelo mapa do mundo — 1 download (cacheado no main). */
  async function ensureWorldPoints(): Promise<boolean> {
    if (worldPointsStateRef.current === 'ok') return true;
    if (worldPointsStateRef.current === 'failed') return false;
    try {
      const villages = await window.staffhub.world.villages();
      worldPointsRef.current = new Map(villages.map((village) => [`${village.x}|${village.y}`, village.points]));
      worldPointsStateRef.current = 'ok';
      return true;
    } catch {
      push('error', 'Não consegui os pontos das aldeias do mundo — o filtro/coluna por pontos ficam sem dados nesta consulta.');
      worldPointsStateRef.current = 'failed';
      return false;
    }
  }

  async function runBlind(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const desiredUnits: Partial<UnitCounts> = {};
      for (const unit of BLIND_UNITS) {
        const raw = desired[unit];
        if (raw !== undefined && raw.trim() !== '') {
          const value = Number(raw.replace(/\./g, ''));
          if (Number.isFinite(value) && value > 0) desiredUnits[unit] = value;
        }
      }
      if (Object.keys(desiredUnits).length === 0) {
        throw new Error('Informe ao menos uma unidade desejada (ex.: lanceiros/espadachins).');
      }
      // Parser normalizado é a fonte da verdade (o campo já reescrito pode ter
      // sido alterado à mão entre renders).
      const parsedCoords = normalizeCoordText(coordsText);
      const minSizeRaw = Number(minSizeText.trim() === '' ? '0' : minSizeText.replace(/\./g, ''));
      if (!Number.isFinite(minSizeRaw) || minSizeRaw < 0) {
        throw new Error('Tamanho mínimo deve ser um número maior ou igual a 0 (0 = todas as aldeias).');
      }
      const minSize = Math.floor(minSizeRaw);

      // Escala por nível (roadmap 13): levelScaling só vai na consulta quando a
      // escala está LIGADA e os pontos de referência são um inteiro >0 — valor
      // inválido cai no erro inline existente da consulta (throw → setError).
      let levelScaling: BlindCheckInput['levelScaling'];
      if (blindScaleOn) {
        const refPointsRaw = Number(blindRefPoints.trim() === '' ? Number.NaN : blindRefPoints.replace(/\./g, ''));
        if (!Number.isInteger(refPointsRaw) || refPointsRaw <= 0) {
          throw new Error('Pontos de referência deve ser um inteiro maior que 0.');
        }
        levelScaling = { referencePoints: refPointsRaw, minFactor: 0.5, maxFactor: 2 };
      }

      const response = await window.staffhub.sg3.checkBlind({
        desiredUnits,
        countMode,
        coordsFilter: coordsToFilter(parsedCoords.coords),
        ...(levelScaling !== undefined ? { levelScaling } : {}),
      });

      // Tamanho por aldeia na métrica escolhida (carrega cada fonte uma vez).
      let sizeSourceOk = true;
      const tamByKey: Record<string, number | null> = {};
      if (sizeMetric === 'populacao') {
        await ensureUnitPops();
        sizeSourceOk = await ensureDefense();
        if (sizeSourceOk && defenseRef.current !== null) {
          for (const entry of defenseRef.current.entries) {
            if (entry.coord.x < 0) continue; // linha de resumo por jogador
            const key = `${entry.coord.x}|${entry.coord.y}`;
            tamByKey[key] =
              (tamByKey[key] ?? 0) + villagePopulation(entry.units, unitPopsRef.current);
          }
        }
      } else {
        sizeSourceOk = await ensureWorldPoints();
        if (worldPointsRef.current !== null) {
          for (const [key, points] of worldPointsRef.current) tamByKey[key] = points;
        }
      }

      let rows = response.results;
      let excluded = 0;
      if (minSize > 0) {
        if (!sizeSourceOk) {
          push('info', 'Filtro de tamanho ignorado nesta consulta — fonte de dados indisponível.');
        } else {
          const before = rows.length;
          rows = rows.filter((row) => {
            const size = tamByKey[`${row.coord.x}|${row.coord.y}`];
            return typeof size === 'number' && size >= minSize;
          });
          excluded = before - rows.length;
        }
      }

      setResults({ rows, tamByKey, metric: sizeMetric });
      // BBCode regenerado localmente JÁ filtrado — fórum e tabela nunca divergem.
      setBbcode(blindBbcodeTable(rows));
      push(
        'ok',
        `${rows.length} aldeia(s) com falta${
          minSize > 0
            ? ` · tamanho mínimo ${minSize.toLocaleString('pt-BR')} ${sizeMetric === 'pontos' ? 'pontos' : 'pop.'}`
            : ''
        }.`,
      );
      if (excluded > 0) {
        push('info', `${excluded} aldeia(s) ficaram fora: abaixo do tamanho mínimo ou sem tamanho conhecido.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(false);
    }
  }

  /** P0-5: varre as aldeias próprias (info_village) e cruza com a defesa do SG_3. */
  async function runScanIncoming(): Promise<void> {
    // Thresholds derivados do painel: validação inteiro ≥0 só ao usar — erro
    // inline aqui mantém a última triagem na tela enquanto o campo estiver inválido.
    const minResistPop = parseThresholdText(threatMinResistText);
    if (minResistPop === null) {
      setScanError('População mínima resistente deve ser um inteiro maior ou igual a 0.');
      return;
    }
    const nobleDangerPop = parseThresholdText(threatNobleDangerText);
    if (nobleDangerPop === null) {
      setScanError('Perigo de nobre (população) deve ser um inteiro maior ou igual a 0.');
      return;
    }
    setScanBusy(true);
    setScanError('');
    setThreats(null);
    try {
      const [scan, defense] = await Promise.all([
        window.staffhub.sg5.scanOwnVillages(),
        window.staffhub.troops.get('defense').catch(() => null),
      ]);
      // Peso DEFENSIVO presente por coordenada (mesma métrica do blind:
      // spear/sword/archer + heavy×4 — população bruta esconderia stacks
      // ofensivos atrás de um veredito "resistente" otimista).
      const popByCoord = new Map<string, number>();
      if (defense !== null) {
        for (const entry of defense.entries) {
          if (entry.coord.x < 0) continue; // linha de resumo (sem aldeia específica)
          const key = `${entry.coord.x}|${entry.coord.y}`;
          popByCoord.set(key, (popByCoord.get(key) ?? 0) + defensivePopulation(entry.units));
        }
      }
      const inputs: VillageThreatInput[] = scan.villages.map((village) => {
        const defensePop = popByCoord.get(village.coord);
        return { coord: village.coord, commands: village.commands, ...(defensePop !== undefined ? { defensePop } : {}) };
      });
      const ranked = rankVillagesByThreat(inputs, { minResistPop, nobleDangerPop });
      setThreats(ranked);
      push('ok', threatSummary(ranked));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setScanError(message);
      push('error', message);
    } finally {
      setScanBusy(false);
    }
  }

  async function runSupporters(): Promise<void> {
    setSupportersBusy(true);
    setSupportersError('');
    try {
      // Campo próprio dos apoiadores tem prioridade; vazio = herda o front.
      const source = supportersCoordsText.trim() === '' ? coordsText : supportersCoordsText;
      const parsed = normalizeCoordText(source);
      if (parsed.count === 0) throw new Error('Nenhuma coordenada reconhecida — cole as aldeias no campo do front ou no dos apoiadores.');
      const result = await window.staffhub.sg3.supporters(parsed.coords);
      setSupportersResult(result);
      push('ok', `Apoiadores: ${result.villages.length} aldeia(s) consultadas.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSupportersError(message);
      push('error', message);
    } finally {
      setSupportersBusy(false);
    }
  }

  /**
   * Normalização que respeita a digitação: cola/blur/limpeza reescrevem o
   * campo com a linha limpa do parser; tecla a tecla, o contador atualiza e o
   * texto só é reescrito quando termina em separador (nunca come um "123|"
   * pela metade).
   */
  function handleCoordTyping(
    raw: string,
    setText: (next: string) => void,
    setMeta: (meta: NormalizedCoords) => void,
  ): void {
    const parsed = normalizeCoordText(raw);
    setMeta(parsed);
    if (!PARTIAL_TOKEN_TAIL.test(raw) && parsed.display !== raw) setText(parsed.display);
  }

  /** Cola nas coordenadas: insere o clipboard normalizado direto na linha limpa. */
  function handleCoordPaste(
    event: React.ClipboardEvent<HTMLTextAreaElement>,
    currentText: string,
    setText: (next: string) => void,
    setMeta: (meta: NormalizedCoords) => void,
  ): void {
    event.preventDefault();
    const pasted = event.clipboardData.getData('text');
    const parsed = normalizeCoordText(`${currentText} ${pasted}`);
    setText(parsed.display);
    setMeta(parsed);
  }

  const formatted = defenseAt === null ? '—' : new Date(defenseAt).toLocaleString('pt-BR');

  return (
    <section className="page">
      <PageHeader
        kicker={moduleInfo !== undefined ? `Módulo ${moduleInfo.id.toUpperCase()} — Fase ${moduleInfo.phase}` : 'Módulo SG3 — Fase 3'}
        title={moduleInfo?.originalLabel ?? 'Análise de Defesa das Aldeias'}
        description="Tropas presentes em cada aldeia — paradas e a caminho —, verificação de blindagem com BBCode para o fórum e apoiadores por aldeia."
      />

      <div className="row">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setDesired(SG3_DEFAULTS.desired);
            setCountMode(SG3_DEFAULTS.countMode);
            setSizeMetric(SG3_DEFAULTS.sizeMetric);
            setMinSizeText(SG3_DEFAULTS.minSizeText);
            setCoordsText(SG3_DEFAULTS.coordsText);
            setCoordsMeta(normalizeCoordText(SG3_DEFAULTS.coordsText));
            setSupportersCoordsText(SG3_DEFAULTS.supportersCoordsText);
            setSupportersCoordsMeta(normalizeCoordText(SG3_DEFAULTS.supportersCoordsText));
            setThreatMinResistText(SG3_DEFAULTS.threatMinResist);
            setThreatNobleDangerText(SG3_DEFAULTS.threatNobleDanger);
            setBlindScaleOn(SG3_DEFAULTS.blindScaleOn);
            setBlindRefPoints(SG3_DEFAULTS.blindRefPoints);
            void resetPrefs();
          }}
        >
          Restaurar padrões do módulo
        </button>
      </div>

      <section className="page-section" aria-labelledby="sg3-memory-title">
        <h2 className="section-title" id="sg3-memory-title">Dados em Memória</h2>
        <div className="card">
          <div className="card-body">
            <div className="row">
              <p className="muted">
                Data da última atualização: <strong>{formatted}</strong>
              </p>
              <button type="button" className="btn" onClick={() => void collectDefense()} disabled={collecting}>
                {collecting ? <><span className="btn-spinner" aria-hidden="true" /> Coletando…</> : 'Coletar Informações de Defesa'}
              </button>
              {(collecting || supportersBusy) && progress !== null && (
                <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
              )}
            </div>
            <p className="hint-note muted">
              A coleta passa por todos os membros com pacing humano (1 requisição por membro) e guarda as tropas
              na aldeia e a caminho. A consulta de apoiadores é feita aldeia por aldeia (1 requisição cada,
              com pacing).
            </p>
          </div>
        </div>
      </section>

      <section className="page-section" aria-labelledby="sg3-blind-title">
        <h2 className="section-title" id="sg3-blind-title">Verificação de Blindagem</h2>
        <div className="card">
          <div className="card-body">
            <div className="sg2-units-grid">
              {BLIND_UNITS.map((unit) => (
                <label key={unit} className="field">
                  <span className="field-label sg2-unit-label">
                    <img src={TW_UNIT_ICONS[unit]} width={18} height={18} alt="" aria-hidden="true" />
                    {UNITS[unit].name}
                  </span>
                  <input
                    className="input"
                    type="text"
                    inputMode="numeric"
                    placeholder="quantidade desejada"
                    value={desired[unit] ?? ''}
                    onChange={(event) => setDesired((prev) => ({ ...prev, [unit]: event.target.value }))}
                  />
                </label>
              ))}
            </div>
            <div className="field">
              <span className="field-label" id="sg3-count-label">Contagem</span>
              <div className="sg2-radio-row" role="radiogroup" aria-labelledby="sg3-count-label">
                <label className="checkbox-field">
                  <input type="radio" name="sg3-count" checked={countMode === 'paradas'} onChange={() => setCountMode('paradas')} />
                  Paradas (só tropas na aldeia)
                </label>
                <label className="checkbox-field">
                  <input type="radio" name="sg3-count" checked={countMode === 'paradas-e-transito'} onChange={() => setCountMode('paradas-e-transito')} />
                  Paradas + a caminho (desconta apoio chegando)
                </label>
              </div>
            </div>
            <label className="field">
              <span className="field-label">Coordenadas do front (cole da análise SG1 — vazio = todas)</span>
              <textarea
                className="textarea"
                rows={3}
                placeholder="123|456 456|123 111|222 ..."
                value={coordsText}
                onChange={(event) => handleCoordTyping(event.target.value, setCoordsText, setCoordsMeta)}
                onPaste={(event) => handleCoordPaste(event, coordsText, setCoordsText, setCoordsMeta)}
                onBlur={() => handleCoordTyping(`${coordsText} `, setCoordsText, setCoordsMeta)}
              />
              {(coordsMeta.count > 0 || coordsMeta.duplicatesRemoved > 0 || coordsMeta.invalidTokens > 0) && (
                <p className="field-hint" aria-live="polite">{coordCountLabel(coordsMeta)}</p>
              )}
            </label>
            <fieldset className="field">
              <legend className="field-label" id="sg3-size-metric-label">Medir tamanho por</legend>
              <div className="sg4-radio-row" role="radiogroup" aria-labelledby="sg3-size-metric-label">
                <label className="checkbox-field">
                  <input
                    type="radio"
                    name="sg3-size-metric"
                    checked={sizeMetric === 'pontos'}
                    onChange={() => setSizeMetric('pontos')}
                  />
                  Pontos da aldeia
                </label>
                <label className="checkbox-field">
                  <input
                    type="radio"
                    name="sg3-size-metric"
                    checked={sizeMetric === 'populacao'}
                    onChange={() => setSizeMetric('populacao')}
                  />
                  População de tropas
                </label>
              </div>
            </fieldset>
            <label className="field">
              <span className="field-label">Tamanho mínimo (0 = todas)</span>
              <input
                className="input input--num"
                type="text"
                inputMode="numeric"
                placeholder="0"
                value={minSizeText}
                aria-describedby="sg3-minsize-hint"
                onChange={(event) => setMinSizeText(event.target.value)}
              />
              <p className="field-hint" id="sg3-minsize-hint">
                Na consulta, aldeias menores ficam fora da tabela e do BBCode. População usa a última coleta de defesa.
              </p>
            </label>
            <div className="field">
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={blindScaleOn}
                  onChange={(event) => setBlindScaleOn(event.target.checked)}
                />
                <span>Escalar blind pelo tamanho da aldeia</span>
              </label>
              {blindScaleOn && (
                <>
                  <label className="field" htmlFor="sg3-blind-ref">
                    <span className="field-label">Pontos de referência</span>
                    <input
                      id="sg3-blind-ref"
                      className="input input--num"
                      type="text"
                      inputMode="numeric"
                      placeholder="9000"
                      value={blindRefPoints}
                      aria-describedby="sg3-blind-ref-hint"
                      onChange={(event) => setBlindRefPoints(event.target.value)}
                    />
                  </label>
                  <p className="field-hint" id="sg3-blind-ref-hint">
                    Aldeia com o dobro dos pontos de referência pede o dobro de blind
                    (limitado por fator de 0,5× a 2×).
                  </p>
                </>
              )}
            </div>
            {error !== '' && <p className="error" role="alert">{error}</p>}
            <button type="button" className="btn" onClick={() => void runBlind()} disabled={busy}>
              <ShieldAlert size={16} aria-hidden="true" />
              {busy ? <><span className="btn-spinner" aria-hidden="true" /> Consultando…</> : 'Realizar Consulta de Blindagem'}
            </button>
          </div>
        </div>
      </section>

      {results !== null && (
        <section className="page-section" aria-labelledby="sg3-results-title">
          <h2 className="section-title" id="sg3-results-title">Aldeias com falta ({results.rows.length})</h2>
          <div className="card card--flush">
            <div className="card-header">
              <h3 className="card-title">BBCode para o fórum</h3>
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={bbcode === ''}
                onClick={() => {
                  void navigator.clipboard.writeText(bbcode).then(() => push('ok', 'Tabela BBCode copiada — cole no tópico de blindagem.')).catch(() => push('error', 'Não consegui copiar — selecione o texto e use Ctrl+C.'));
                }}
              >
                <ClipboardCopy size={14} aria-hidden="true" />
                Copiar tabela BBCode
              </button>
            </div>
            {results.rows.length === 0 ? (
              <div className="card-body">
                <EmptyState icon={ShieldCheck} title="Blindagem completa" hint="Nenhuma aldeia do filtro ficou devendo tropas." />
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Jogador</th>
                      <th>Aldeia</th>
                      <th>{results.metric === 'pontos' ? 'Tam. (pontos)' : 'Tam. (população)'}</th>
                      <th>Falta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.rows.map((result) => {
                      const tam = results.tamByKey[`${result.coord.x}|${result.coord.y}`] ?? null;
                      return (
                        <tr key={`${result.playerId}-${result.coord.x}-${result.coord.y}`}>
                          <td className="cell-nowrap">{result.playerName}</td>
                          <td className="cell-nowrap">
                            {result.villageName} ({result.coord.x}|{result.coord.y})
                          </td>
                          <td className="cell-num">
                            {tam === null
                              ? <span className="muted" title="Tamanho desconhecido nesta métrica">—</span>
                              : tam.toLocaleString('pt-BR')}
                          </td>
                          <td className="cell-detail">
                            {Object.entries(result.missing)
                              .map(([unit, amount]) => `${UNITS[unit as UnitId]?.name ?? unit}: ${amount?.toLocaleString('pt-BR')}`)
                              .join(' · ')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="page-section" aria-labelledby="sg3-supporters-title">
        <h2 className="section-title" id="sg3-supporters-title">Exibir Apoiadores</h2>
        <div className="card">
          <div className="card-body">
            <p className="muted">
              Consulta aldeia por aldeia (<strong>1 requisição por aldeia</strong>) — para listas grandes confira o
              teto em Configurações. Mostra quem tem suportes compartilhados chegando, totais por apoiador e marca
              auto-apoio (dono da aldeia).
            </p>
            <label className="field">
              <span className="field-label">Coordenadas das aldeias (vazio = usar o campo do front)</span>
              <textarea
                className="textarea"
                rows={3}
                placeholder="123|456 456|123 111|222 ..."
                value={supportersCoordsText}
                onChange={(event) => handleCoordTyping(event.target.value, setSupportersCoordsText, setSupportersCoordsMeta)}
                onPaste={(event) => handleCoordPaste(event, supportersCoordsText, setSupportersCoordsText, setSupportersCoordsMeta)}
                onBlur={() => handleCoordTyping(`${supportersCoordsText} `, setSupportersCoordsText, setSupportersCoordsMeta)}
              />
              {(supportersCoordsMeta.count > 0 || supportersCoordsMeta.duplicatesRemoved > 0 || supportersCoordsMeta.invalidTokens > 0) && (
                <p className="field-hint" aria-live="polite">{coordCountLabel(supportersCoordsMeta)}</p>
              )}
            </label>
            {supportersError !== '' && <p className="error" role="alert">{supportersError}</p>}
            <div className="row">
              <button type="button" className="btn" onClick={() => void runSupporters()} disabled={supportersBusy}>
                <Users size={16} aria-hidden="true" />
                {supportersBusy ? <><span className="btn-spinner" aria-hidden="true" /> Consultando…</> : 'Exibir Apoiadores'}
              </button>
            </div>
            {supportersResult !== null && (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Aldeia</th>
                      <th>Apoiadores</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {supportersResult.villages.map((village) => (
                      <tr key={village.coord}>
                        <td className="cell-nowrap">
                          {village.villageName} ({village.coord}){village.ownerName !== null ? <span className="muted"> · {village.ownerName}</span> : null}
                        </td>
                        <td className="cell-detail">
                          {village.supporters.length === 0
                            ? <span className="muted">Nenhum suporte compartilhado visível.</span>
                            : village.supporters.map((sup) => (
                                <span key={sup.playerName} className={sup.selfSupport ? 'ok' : ''} title={sup.selfSupport ? 'Auto-apoio (dono da aldeia)' : undefined}>
                                  {sup.playerName} ({sup.count}){sup.selfSupport ? ' ★' : ''}
                                </span>
                              )).reduce<React.ReactNode[]>((acc, item, index) => (index === 0 ? [item] : [...acc, ' · ', item]), [])}
                        </td>
                        <td className="cell-nowrap">{village.totalSupports}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="page-section" aria-labelledby="sg3-incoming-title">
        <h2 className="section-title" id="sg3-incoming-title">Ataques Recebidos (aldeias próprias)</h2>
        <div className="card">
          <div className="card-body">
            <p className="muted">
              Varre as aldeias do jogador logado (1 requisição por aldeia, com pacing) e cruza com a última coleta de
              defesa: <strong>esta aldeia vai cair</strong> quando chega nobre/ataque grande e a defesa presente está
              abaixo do patamar. Sem coleta de defesa, a aldeia fica "sem dados" (nunca chutado).
            </p>
            <div className="sg2-units-grid">
              <label className="field">
                <span className="field-label">População mínima resistente</span>
                <input
                  className="input input--num"
                  type="text"
                  inputMode="numeric"
                  placeholder={String(DEFAULT_THREAT_THRESHOLDS.minResistPop)}
                  value={threatMinResistText}
                  aria-describedby="sg3-threat-min-hint"
                  onChange={(event) => setThreatMinResistText(event.target.value)}
                />
                <p className="field-hint" id="sg3-threat-min-hint">
                  Abaixo disso a aldeia fica "pressionada" — ou "vai cair" com ataque grande chegando.
                </p>
              </label>
              <label className="field">
                <span className="field-label">Perigo de nobre (população)</span>
                <input
                  className="input input--num"
                  type="text"
                  inputMode="numeric"
                  placeholder={String(DEFAULT_THREAT_THRESHOLDS.nobleDangerPop)}
                  value={threatNobleDangerText}
                  aria-describedby="sg3-threat-noble-hint"
                  onChange={(event) => setThreatNobleDangerText(event.target.value)}
                />
                <p className="field-hint" id="sg3-threat-noble-hint">
                  Nobre chegando com defesa abaixo disso é "vai cair", mesmo sem ataque grande.
                </p>
              </label>
            </div>
            <div className="row">
              <button type="button" className="btn" disabled={scanBusy} onClick={() => void runScanIncoming()}>
                <Radar size={16} aria-hidden="true" />
                {scanBusy ? <><span className="btn-spinner" aria-hidden="true" /> Varrendo…</> : 'Varrer ataques recebidos'}
              </button>
              {scanBusy && progress !== null && (
                <>
                  <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      void window.staffhub.queue
                        .cancel()
                        .then(() => push('info', 'Cancelamento pedido — a varredura para na próxima requisição.'))
                        .catch(() => push('error', 'Não foi possível pedir o cancelamento.'));
                    }}
                  >
                    Cancelar
                  </button>
                </>
              )}
            </div>
            {scanError !== '' && <p className="error" role="alert">{scanError}</p>}
            {threats !== null && (
              <>
                <p className={threats.some((threat) => threat.level === 'vai-cair') ? 'error' : 'ok'}>{threatSummary(threats)}</p>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Aldeia</th>
                        <th>Triagem</th>
                        <th className="cell-num">Ataques</th>
                        <th className="cell-num">Com nobre</th>
                        <th>Detalhe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {threats.map((threat) => (
                        <tr key={threat.coord}>
                          <td className="cell-nowrap">{threat.coord}</td>
                          <td className="cell-nowrap">
                            {threat.level === 'vai-cair' && <span className="error">VAI CAIR</span>}
                            {threat.level === 'pressionada' && <span className="text-warn">Pressionada</span>}
                            {threat.level === 'resistente' && <span className="ok">Resistente</span>}
                            {threat.level === 'sem-dados' && <span className="muted">Sem dados</span>}
                          </td>
                          <td className="cell-num">{threat.attackCount}</td>
                          <td className="cell-num">{threat.nobleCount > 0 ? <strong>{threat.nobleCount}</strong> : 0}</td>
                          <td className="cell-detail">{threat.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
