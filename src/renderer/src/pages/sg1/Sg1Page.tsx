import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Copy, Map as MapIcon, Radar, Swords } from 'lucide-react';
import { parseCoordList } from '@shared/coords';
import type { QueueProgress } from '@shared/ipc-types';
import type {
  DiplomacyRelations,
  Sg1BucketResult,
  Sg1Input,
  Sg1Result,
  TribeMarking,
  WorldAlly,
  WorldVillage,
} from '@shared/types';
import Field from '../../components/Field';
import PageHeader from '../../components/PageHeader';
import ProgressBar from '../../components/ProgressBar';
import ToastViewport from '../../components/Toast';
import { loadRelationsShared, useDiplomacyRelations } from '../../hooks/useDiplomacyRelations';
import { usePreferences } from '../../hooks/usePreferences';
import { useToast } from '../../hooks/useToast';
import { MODULES } from '../../modules';
import WorldMapCanvas, { MARKING_OPTIONS } from './WorldMapCanvas';

/**
 * SG_1 — Análise de Aldeias e Distâncias + Mapa do Mundo (screen=wars).
 * Rótulos e formatos fiéis à ferramenta original (docs/MODULOS-SG.md):
 * tags separadas por ";", coordenadas "123|456" separadas por espaço,
 * Ks separados por espaço; saída com opção "Separação com Enter".
 */

function parseTags(text: string): string[] {
  return text
    .split(';')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function parseKList(text: string): number[] {
  const values: number[] = [];
  for (const token of text.split(/\s+/)) {
    const value = Number(token);
    if (Number.isInteger(value) && value >= 0) values.push(value);
  }
  return values;
}

/** Deriva o rótulo original da lista de coords a partir do label do bucket. */
function listLabelFromBucket(label: string): string {
  const segment = label.replace(/^A MENOS DE /, 'MENOR QUE ').replace(/^A MAIS DE /, 'DE MAIS DE ');
  return `ALDEIAS COM DISTANCIA DE NOBRE ${segment} DO INIMIGO`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha de comunicação com o processo principal.';
}

export default function Sg1Page() {
  const { toasts, push, dismiss } = useToast();
  const moduleInfo = MODULES.find((module) => module.id === 'sg1');
  // Diplomacia: carrega no boot, refaz quando a sessão entra em logged-in
  // (as páginas SG são keep-mounted e montam ANTES do login sid) e expõe
  // retry manual — ver useDiplomacyRelations.
  const {
    relations,
    relationsFailed,
    relationsBusy: prefillBusy,
    retryRelations,
    setRelations,
  } = useDiplomacyRelations();
  const [worldRefreshBusy, setWorldRefreshBusy] = useState(false);

  // Formulário — análise de aldeias (rótulos originais).
  const [ownTag, setOwnTag] = useState('');
  const [enemyTagsText, setEnemyTagsText] = useState('');
  const [kDesiredText, setKDesiredText] = useState('');
  const [enemyCoordsDiscardText, setEnemyCoordsDiscardText] = useState('');
  const [kEnemyDiscardText, setKEnemyDiscardText] = useState('');
  const [enemyCoordsConsiderText, setEnemyCoordsConsiderText] = useState('');
  const [allyCoordsConsiderText, setAllyCoordsConsiderText] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Preferências do módulo: o formulário sobrevive a F5/reinício. `sepByEnter`
  // fica de fora de propósito — é estado efêmero do resultado.
  const { prefs, savePrefs, resetPrefs } = usePreferences<Record<string, string>>('sg1', {
    ownTag: '',
    enemyTagsText: '',
    kDesiredText: '',
    enemyCoordsDiscardText: '',
    kEnemyDiscardText: '',
    enemyCoordsConsiderText: '',
    allyCoordsConsiderText: '',
  });
  const prefsHydrated = useRef(false);

  // Hidratação (uma única vez, quando as preferências chegam): cada chave salva
  // sobrescreve o estado — a preferência do usuário vence, inclusive sobre o
  // prefill da diplomacia.
  useEffect(() => {
    if (prefs === null || prefsHydrated.current) return;
    if (prefs.ownTag !== undefined) setOwnTag(prefs.ownTag);
    if (prefs.enemyTagsText !== undefined) setEnemyTagsText(prefs.enemyTagsText);
    if (prefs.kDesiredText !== undefined) setKDesiredText(prefs.kDesiredText);
    if (prefs.enemyCoordsDiscardText !== undefined) setEnemyCoordsDiscardText(prefs.enemyCoordsDiscardText);
    if (prefs.kEnemyDiscardText !== undefined) setKEnemyDiscardText(prefs.kEnemyDiscardText);
    if (prefs.enemyCoordsConsiderText !== undefined) setEnemyCoordsConsiderText(prefs.enemyCoordsConsiderText);
    if (prefs.allyCoordsConsiderText !== undefined) setAllyCoordsConsiderText(prefs.allyCoordsConsiderText);
    prefsHydrated.current = true;
  }, [prefs]);

  // Persistência: qualquer mudança nos campos dispara um save com todas as
  // chaves (o hook agrupa as chamadas com debounce de 800ms).
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({
      ownTag,
      enemyTagsText,
      kDesiredText,
      enemyCoordsDiscardText,
      kEnemyDiscardText,
      enemyCoordsConsiderText,
      allyCoordsConsiderText,
    });
  }, [
    savePrefs,
    ownTag,
    enemyTagsText,
    kDesiredText,
    enemyCoordsDiscardText,
    kEnemyDiscardText,
    enemyCoordsConsiderText,
    allyCoordsConsiderText,
  ]);

  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<Sg1Result | null>(null);
  const [analyzeError, setAnalyzeError] = useState('');
  const [progress, setProgress] = useState<QueueProgress | null>(null);
  const [sepByEnter, setSepByEnter] = useState<Record<number, boolean>>({});

  // Mapa do mundo.
  const [worldLoading, setWorldLoading] = useState(false);
  const [tribes, setTribes] = useState<WorldAlly[]>([]);
  const [villages, setVillages] = useState<WorldVillage[]>([]);
  const [markings, setMarkings] = useState<Map<number, TribeMarking>>(new Map());
  const [highlightText, setHighlightText] = useState('');
  const [showMap, setShowMap] = useState(false);

  // Tag da própria tribo vinda da diplomacia (não sobrescreve o que o usuário
  // digitou). O dump é garantido pela carga do hook ANTES da diplomacia.
  useEffect(() => {
    if (relations === null) return;
    setOwnTag((typed) => (typed.trim() === '' ? relations.ownTag : typed));
  }, [relations]);

  // Progresso das operações do main (download de dumps / coleta da análise).
  useEffect(() => {
    const unsubscribe = window.staffhub.events.onQueueProgress(setProgress);
    return unsubscribe;
  }, []);

  /** Dumps com mais de 6h são atualizados automaticamente (aldeias mudam de dono). */
  async function ensureWorldData(): Promise<void> {
    const status = await window.staffhub.world.status();
    const stale =
      status.fetchedAt === null ||
      status.villageCount === 0 ||
      Date.now() - Date.parse(status.fetchedAt) > 6 * 60 * 60 * 1000;
    if (!stale) return;
    push('info', status.fetchedAt === null ? 'Baixando dados do mundo…' : 'Dados do mundo antigos — atualizando…');
    await window.staffhub.world.refresh();
  }

  function validateForm(): boolean {
    const next: Record<string, string> = {};
    if (ownTag.trim() === '') next.ownTag = 'Informe a tag da tribo analisada.';
    const hasTags = parseTags(enemyTagsText).length > 0;
    const hasCoords = parseCoordList(enemyCoordsConsiderText).length > 0;
    if (!hasTags && !hasCoords) {
      next.enemyTags = 'Informe as tribos inimigas ou as coordenadas inimigas consideradas.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function runAnalyze(): Promise<void> {
    if (analyzing) return;
    if (!validateForm()) return;
    setAnalyzing(true);
    setResult(null);
    setAnalyzeError('');
    try {
      await ensureWorldData();
      const input: Sg1Input = {
        ownTag: ownTag.trim(),
        enemyTags: parseTags(enemyTagsText),
        kDesired: parseKList(kDesiredText),
        enemyCoordsDiscard: parseCoordList(enemyCoordsDiscardText),
        kEnemyDiscard: parseKList(kEnemyDiscardText),
        enemyCoordsConsider: parseCoordList(enemyCoordsConsiderText),
        allyCoordsConsider: parseCoordList(allyCoordsConsiderText),
      };
      const analysis = await window.staffhub.sg1.analyze(input);
      setResult(analysis);
      push('ok', `Análise concluída: ${analysis.ownVillageCount} aldeias da tribo classificadas.`);
    } catch (error) {
      const message = errorMessage(error);
      setAnalyzeError(message);
      push('error', message);
    } finally {
      setAnalyzing(false);
    }
  }

  function useEnemyTagsFromDiplomacy(): void {
    if (relations === null) {
      push(
        'error',
        relationsFailed
          ? 'Diplomacia indisponível — clique em "Tentar novamente" no aviso vermelho.'
          : 'Diplomacia ainda carregando — tente de novo em instantes.',
      );
      return;
    }
    setEnemyTagsText(relations.enemies.map((enemy) => enemy.tag).join(';'));
    push('ok', `Inimigas da diplomacia preenchidas: ${relations.enemies.length} tribo(s).`);
  }

  /** Volta o formulário aos padrões originais e apaga as preferências salvas. */
  function resetFormDefaults(): void {
    setOwnTag('');
    setEnemyTagsText('');
    setKDesiredText('');
    setEnemyCoordsDiscardText('');
    setKEnemyDiscardText('');
    setEnemyCoordsConsiderText('');
    setAllyCoordsConsiderText('');
    setErrors({});
    void resetPrefs();
  }

  async function copyCoords(bucket: Sg1BucketResult): Promise<void> {
    if (bucket.coords.length === 0) {
      push('info', 'Faixa sem aldeias — nada para copiar.');
      return;
    }
    const separator = sepByEnter[bucket.index] === true ? '\n' : ' ';
    try {
      await navigator.clipboard.writeText(bucket.coords.join(separator));
      push('ok', `Copiado: ${bucket.coords.length} coordenada(s).`);
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  async function loadWorld(): Promise<void> {
    if (worldLoading) return;
    setWorldLoading(true);
    setShowMap(false);
    try {
      await ensureWorldData();
      const [tribesValue, villagesValue] = await Promise.all([
        window.staffhub.world.tribes(),
        window.staffhub.world.villages(),
      ]);
      let relationsValue: DiplomacyRelations | null = null;
      try {
        // Loader coalescido: reaproveita a carga em andamento (ex.: recarga
        // automática pós-login) em vez de disputar a fila do main.
        relationsValue = await loadRelationsShared();
      } catch {
        relationsValue = null; // sem sessão: mapa fica todo marrom, sem pré-marcação
      }
      setTribes(tribesValue);
      setVillages(villagesValue);
      if (relationsValue !== null) setRelations(relationsValue);

      // Pré-marcação pela diplomacia: inimigas em Vermelho, aliadas em Azul Ally,
      // tribo própria em Azul, o resto em Marrom.
      const next = new Map<number, TribeMarking>();
      for (const ally of tribesValue) next.set(ally.id, 'Marrom');
      if (relationsValue !== null) {
        for (const enemy of relationsValue.enemies) next.set(enemy.allyId, 'Vermelho');
        for (const ally of relationsValue.allies) next.set(ally.allyId, 'Azul Ally');
        next.set(relationsValue.ownAllyId, 'Azul');
      }
      setMarkings(next);
      push('ok', `Mapa carregado: ${villagesValue.length} aldeias e ${tribesValue.length} tribos.`);
    } catch (error) {
      push('error', errorMessage(error));
    } finally {
      setWorldLoading(false);
    }
  }

  function updateMarking(allyId: number, marking: TribeMarking): void {
    setMarkings((current) => {
      const next = new Map(current);
      next.set(allyId, marking);
      return next;
    });
  }

  const sortedTribes = useMemo(() => {
    const enemyIds = new Set((relations?.enemies ?? []).map((enemy) => enemy.allyId));
    const allyIds = new Set((relations?.allies ?? []).map((ally) => ally.allyId));
    const ownId = relations?.ownAllyId;
    const rank = (ally: WorldAlly): number =>
      ally.id === ownId ? 0 : enemyIds.has(ally.id) ? 1 : allyIds.has(ally.id) ? 2 : 3;
    return [...tribes].sort((a, b) => rank(a) - rank(b) || b.points - a.points);
  }, [tribes, relations]);

  const highlights = useMemo(
    () => new Set(parseCoordList(highlightText).map((coord) => `${coord.x}|${coord.y}`)),
    [highlightText],
  );

  return (
    <section className="page">
      <PageHeader
        kicker={moduleInfo !== undefined ? `Módulo ${moduleInfo.id.toUpperCase()} — Fase ${moduleInfo.phase}` : 'Módulo SG1 — Fase 1'}
        title={moduleInfo?.originalLabel ?? 'Análise de Aldeias e Distâncias'}
        description="Tempo de nobre de cada aldeia da tribo até o inimigo mais próximo, com filtros de tags, continentes K e coordenadas — e o mapa do mundo com a sua diplomacia."
      />

      {/* ===== Seção A — Análise de Aldeias ===== */}
      <section className="page-section" aria-labelledby="sg1-analyse-title">
        <h2 className="section-title" id="sg1-analyse-title">Análise de Aldeias</h2>
        <div className="card">
          <div className="card-body">
            {relationsFailed && (
              <div className="callout callout--danger">
                <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
                <div className="callout-body">
                  <p className="callout-title">Diplomacia indisponível</p>
                  <p>
                    Não foi possível carregar as relações diplomáticas — se você acabou
                    de entrar no jogo, elas recarregam sozinhas; senão, tente de novo agora.
                  </p>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={prefillBusy}
                    onClick={() => void retryRelations()}
                  >
                    Tentar novamente
                  </button>
                </div>
              </div>
            )}
            <form
              className="sg1-form-grid"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void runAnalyze();
              }}
            >
              <Field id="ownTag" label="Tag da tribo analisada" error={errors.ownTag} hint={prefillBusy ? 'Carregando a tag da sua tribo (baixa os dados do mundo na 1ª vez)…' : undefined}>
                <input
                  id="ownTag"
                  className="input"
                  placeholder="TOX"
                  value={ownTag}
                  aria-describedby={errors.ownTag !== undefined ? 'ownTag-error' : undefined}
                  onChange={(event) => setOwnTag(event.target.value)}
                />
              </Field>

              <div className="sg1-span-2">
                <Field
                  id="enemyTags"
                  label="Tags das tribos inimigas"
                  hint="Separe as tags com ; ou use o botão abaixo para preencher com a diplomacia."
                  error={errors.enemyTags}
                >
                  <textarea
                    id="enemyTags"
                    className="textarea"
                    rows={2}
                    placeholder="DARK;SAV;NEW"
                    value={enemyTagsText}
                    aria-describedby={
                      errors.enemyTags !== undefined ? 'enemyTags-error' : 'enemyTags-hint'
                    }
                    onChange={(event) => setEnemyTagsText(event.target.value)}
                  />
                </Field>
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={useEnemyTagsFromDiplomacy}
                  >
                    <Swords size={14} aria-hidden="true" />
                    Usar inimigas da diplomacia
                  </button>
                </div>
              </div>

              <Field id="kDesired" label="Ks desejados">
                <input
                  id="kDesired"
                  className="input"
                  placeholder="45 46 55"
                  value={kDesiredText}
                  onChange={(event) => setKDesiredText(event.target.value)}
                />
              </Field>

              <div className="sg1-span-2">
                <Field
                  id="enemyCoordsDiscard"
                  label="Coordenadas inimigas desconsideradas"
                >
                  <textarea
                    id="enemyCoordsDiscard"
                    className="textarea sg1-coords"
                    rows={3}
                    placeholder="123|456 456|123 111|222"
                    value={enemyCoordsDiscardText}
                    onChange={(event) => setEnemyCoordsDiscardText(event.target.value)}
                  />
                </Field>
              </div>

              <Field
                id="kEnemyDiscard"
                label="Ks das aldeias inimigas desconsideradas"
              >
                <input
                  id="kEnemyDiscard"
                  className="input"
                  placeholder="45 46 55"
                  value={kEnemyDiscardText}
                  onChange={(event) => setKEnemyDiscardText(event.target.value)}
                />
              </Field>

              <div className="sg1-span-2">
                <Field
                  id="enemyCoordsConsider"
                  label="Coordenadas inimigas consideradas"
                  hint="Se informadas, substituem as aldeias das tags inimigas."
                >
                  <textarea
                    id="enemyCoordsConsider"
                    className="textarea sg1-coords"
                    rows={3}
                    placeholder="123|456 456|123 111|222"
                    value={enemyCoordsConsiderText}
                    aria-describedby="enemyCoordsConsider-hint"
                    onChange={(event) => setEnemyCoordsConsiderText(event.target.value)}
                  />
                </Field>
              </div>

              <div className="sg1-span-2">
                <Field
                  id="allyCoordsConsider"
                  label="Coordenadas aliadas consideradas"
                  hint="Acrescentam ao conjunto de aldeias da tribo analisada."
                >
                  <textarea
                    id="allyCoordsConsider"
                    className="textarea sg1-coords"
                    rows={3}
                    placeholder="123|456 456|123 111|222"
                    value={allyCoordsConsiderText}
                    aria-describedby="allyCoordsConsider-hint"
                    onChange={(event) => setAllyCoordsConsiderText(event.target.value)}
                  />
                </Field>
              </div>

              <div className="sg1-span-2 sg1-form-actions">
                <button type="submit" className="btn" disabled={analyzing}>
                  {analyzing ? (
                    <>
                      <span className="btn-spinner" aria-hidden="true" />
                      Obtendo dados…
                    </>
                  ) : (
                    <>
                      <Radar size={15} aria-hidden="true" />
                      Obter Dados Aldeias
                    </>
                  )}
                </button>
                {analyzing && progress !== null && (
                  <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={resetFormDefaults}>
                  Restaurar padrões do módulo
                </button>
              </div>
            </form>

            {analyzeError !== '' && (
              <div className="callout callout--danger">
                <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
                <div className="callout-body">
                  <p className="callout-title">Falha na análise</p>
                  <p>{analyzeError}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {result !== null && (
          <div className="sg1-buckets">
            {result.buckets.map((bucket) => {
              const useEnter = sepByEnter[bucket.index] === true;
              const coordsText = bucket.coords.join(useEnter ? '\n' : ' ');
              return (
                <article className="card sg1-bucket" key={bucket.index}>
                  <div className="sg1-bucket-head">
                    <div className="sg1-bucket-titles">
                      <h3 className="sg1-bucket-title">QUANTIDADE DE ALDEIAS {bucket.label}</h3>
                      <span className="sg1-bucket-sub">{listLabelFromBucket(bucket.label)}</span>
                    </div>
                    <span className="sg1-count">{bucket.count}</span>
                  </div>
                  <textarea
                    className="textarea sg1-coords"
                    rows={6}
                    readOnly
                    value={coordsText}
                    aria-label={`Coordenadas — ${bucket.label}`}
                  />
                  <div className="sg1-bucket-actions">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={useEnter}
                        onChange={(event) =>
                          setSepByEnter((current) => ({
                            ...current,
                            [bucket.index]: event.target.checked,
                          }))
                        }
                      />
                      <span>Separação com Enter</span>
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void copyCoords(bucket)}
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* ===== Seção B — Obter Análise do Mundo (Mapa do Mundo) ===== */}
      <section className="page-section" aria-labelledby="sg1-world-title">
        <h2 className="section-title" id="sg1-world-title">Obter Análise do Mundo</h2>
        <div className="card">
          <div className="card-body">
            <div className="sg1-form-actions">
              <button
                type="button"
                className="btn"
                onClick={() => void loadWorld()}
                disabled={worldLoading}
              >
                {worldLoading ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Carregando…
                  </>
                ) : (
                  <>
                    <MapIcon size={15} aria-hidden="true" />
                    Obter Análise do Mundo
                  </>
                )}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  void (async () => {
                    setWorldRefreshBusy(true);
                    push('info', 'Atualizando dados do mundo…');
                    try {
                      await window.staffhub.world.refresh();
                      push('ok', 'Dados do mundo atualizados.');
                    } catch (err) {
                      push('error', err instanceof Error ? err.message : String(err));
                    } finally {
                      setWorldRefreshBusy(false);
                    }
                  })();
                }}
                disabled={worldRefreshBusy}
              >
                {worldRefreshBusy ? 'Atualizando…' : 'Atualizar dados do mundo'}
              </button>
              {worldLoading && progress !== null && (
                <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
              )}
            </div>
            {villages.length > 0 && (
              <p className="hint-note">
                {villages.length.toLocaleString('pt-BR')} aldeias carregadas — marque as tribos e
                gere o mapa abaixo.
              </p>
            )}
          </div>
        </div>

        {tribes.length > 0 && (
          <div className="card card--flush">
            <div className="card-header">
              <h3 className="card-title">Tribos do Mundo</h3>
              <span className="spacer" />
              <span className="pill pill--muted">
                {tribes.length} tribos · {villages.length.toLocaleString('pt-BR')} aldeias
              </span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Tribo</th>
                    <th scope="col">Marcação</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTribes.map((ally) => (
                    <tr key={ally.id}>
                      <td className="cell-nowrap">
                        {ally.tag}
                        <span className="muted">
                          {' '}
                          ({ally.name}) · {ally.points.toLocaleString('pt-BR')} pts
                        </span>
                      </td>
                      <td>
                        <select
                          className="select sg1-marking-select"
                          value={markings.get(ally.id) ?? 'Marrom'}
                          aria-label={`Marcação da tribo ${ally.tag}`}
                          onChange={(event) => updateMarking(ally.id, event.target.value as TribeMarking)}
                        >
                          {MARKING_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tribes.length > 0 && (
          <div className="card">
            <div className="card-body">
              <Field
                id="highlightCoords"
                label="Aldeias destacadas"
                hint="Separadas por espaço ou Enter. Aparecem em branco no mapa."
              >
                <textarea
                  id="highlightCoords"
                  className="textarea sg1-coords"
                  rows={3}
                  placeholder="123|456 456|321 999|444"
                  value={highlightText}
                  aria-describedby="highlightCoords-hint"
                  onChange={(event) => setHighlightText(event.target.value)}
                />
              </Field>
              <div className="sg1-form-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowMap(true)}
                  disabled={villages.length === 0}
                >
                  <MapIcon size={15} aria-hidden="true" />
                  Gerar Mapa
                </button>
              </div>
            </div>
          </div>
        )}

        {showMap && villages.length > 0 && (
          <WorldMapCanvas villages={villages} markings={markings} highlights={highlights} />
        )}
      </section>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}