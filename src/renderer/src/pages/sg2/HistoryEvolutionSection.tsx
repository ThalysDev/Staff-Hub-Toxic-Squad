import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import {
  DEFAULT_MIN_OFF_POP_GROWTH,
  DEFAULT_MIN_VILLAGE_GROWTH,
  MAX_TROOPS_HISTORY,
  detectMassiveRecruitment,
  diffTroopsVersions,
  type TroopsDiffRow,
  type TroopsHistoryVersion,
} from '@shared/snapshot-history';
import { useToast } from '../../hooks/useToast';

/**
 * SG_2 — "Histórico e Evolução" (roadmap 19: perfis ao longo do tempo).
 * Seção autossuficiente (sem props): no mount lê `troopsHistory.list()` —
 * versões COMPACTAS agregadas por jogador, mais recente primeiro — e compara
 * duas delas com o motor puro '@shared/snapshot-history'. O arquivamento em si
 * não vive aqui: cada coleta por membro feita no painel "Dados em Memória"
 * arquiva uma versão, e esta seção apenas consome o histórico acumulado.
 */

const NUMBER_FMT = new Intl.NumberFormat('pt-BR');

const SOURCE_LABEL: Record<TroopsHistoryVersion['source'], string> = {
  summary: 'Resumo',
  'per-member': 'Por membro',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha de comunicação com o processo principal.';
}

/** Data legível e à prova de ISO malformado (nunca "Invalid Date" na tela). */
function formatQuando(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('pt-BR');
}

/** Rótulo do seletor: data da coleta + origem (ex.: "26/08/2026 21:34 · Por membro"). */
function versionLabel(version: TroopsHistoryVersion): string {
  return `${formatQuando(version.collectedAt)} · ${SOURCE_LABEL[version.source]}`;
}

/** Delta com sinal explícito: +1.234 / −500 / ±0 (Intl pt-BR nos valores). */
function formatSigned(value: number): string {
  if (value > 0) return `+${NUMBER_FMT.format(value)}`;
  if (value < 0) return `−${NUMBER_FMT.format(Math.abs(value))}`;
  return '±0';
}

/** Cor do delta: verde para crescimento, vermelho para perda, neutro para estável. */
function DeltaValue({ delta }: { delta: number }): JSX.Element {
  if (delta > 0) return <span className="hist-delta hist-delta--up">{formatSigned(delta)}</span>;
  if (delta < 0) return <span className="hist-delta hist-delta--down">{formatSigned(delta)}</span>;
  return <span className="hist-delta hist-delta--flat">{formatSigned(delta)}</span>;
}

/** Célula "A → B (Δ)" das colunas numéricas da evolução. */
function EvolutionCell({ a, b, delta }: { a: number; b: number; delta: number }): JSX.Element {
  return (
    <span className="hist-transition">
      <span className="tabular">{NUMBER_FMT.format(a)}</span>
      <span className="hist-arrow" aria-hidden="true">→</span>
      <span className="tabular">{NUMBER_FMT.format(b)}</span>
      {' '}
      <DeltaValue delta={delta} />
    </span>
  );
}

export default function HistoryEvolutionSection(): JSX.Element {
  const { push } = useToast();

  /** null = carregando; [] com erro = falha no IPC (callout danger, sem crash). */
  const [versions, setVersions] = useState<TroopsHistoryVersion[] | null>(null);
  const [error, setError] = useState('');
  /** Ids das versões selecionadas — A (antiga) → B (nova). Vazios até o load. */
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');

  // Mount: lista o histórico (mais recente primeiro). Defaults de comparação:
  // A = penúltima (índice 1), B = primeira/mais recente (índice 0).
  useEffect(() => {
    let cancelled = false;
    window.staffhub.troopsHistory
      .list()
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        setBId(list[0]?.id ?? '');
        setAId(list[1]?.id ?? '');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = errorMessage(err);
        setError(message);
        setVersions([]);
        push('error', message);
      });
    return () => {
      cancelled = true;
    };
  }, [push]);

  /**
   * Diff A→B + detecção de recrutamento massivo, recalculados a cada troca de
   * seletor. `diffTroopsVersions` já ordena por crescimento de pop ofensiva
   * (maior primeiro) — a ordem é preservada como vem do motor.
   */
  const analysis = useMemo<{ diff: TroopsDiffRow[]; massive: TroopsDiffRow[] } | null>(() => {
    if (versions === null || versions.length < 2) return null;
    const a = versions.find((version) => version.id === aId);
    const b = versions.find((version) => version.id === bId);
    if (a === undefined || b === undefined || a.id === b.id) return null;
    const diff = diffTroopsVersions(a, b);
    return { diff, massive: detectMassiveRecruitment(diff) };
  }, [versions, aId, bId]);

  return (
    <section className="sg2-hist page-section" aria-labelledby="sg2-hist-title">
      <h2 className="section-title" id="sg2-hist-title">Histórico e Evolução</h2>
      <div className="card">
        <div className="card-body col" style={{ gap: 16 }}>
          {error !== '' && (
            <div className="callout callout--danger" role="alert">
              <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
              <div className="callout-body">
                <p className="callout-title">Falha ao carregar o histórico</p>
                <p>{error}</p>
              </div>
            </div>
          )}

          {versions === null && error === '' && <p className="muted">Carregando histórico de coletas…</p>}

          {versions !== null && versions.length < 2 && (
            <div className="callout callout--info">
              <Info size={18} className="callout-icon" aria-hidden="true" />
              <div className="callout-body">
                <p className="callout-title">Arquive ao menos duas coletas para comparar</p>
                <p>
                  Cada coleta por membro ("Coletar Informações de Tropas" no painel acima) arquiva
                  automaticamente uma versão do histórico. Com duas versões arquivadas, esta seção
                  passa a mostrar a evolução de população e aldeias de cada jogador da tribo.
                  {versions.length === 1
                    ? ' Atualmente há 1 versão arquivada.'
                    : ' Nenhuma versão arquivada ainda.'}
                </p>
              </div>
            </div>
          )}

          {versions !== null && versions.length >= 2 && (
            <>
              {/* ===== Seletores de versão ===== */}
              <div className="hist-selectors">
                <label className="hist-selector">
                  <span className="muted">Versão A (antiga)</span>
                  <select
                    className="select"
                    value={aId}
                    onChange={(event) => setAId(event.target.value)}
                    aria-label="Versão A (antiga) do histórico"
                  >
                    {versions.map((version) => (
                      <option key={version.id} value={version.id} disabled={version.id === bId}>
                        {versionLabel(version)}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="hist-arrow" aria-hidden="true">→</span>
                <label className="hist-selector">
                  <span className="muted">Versão B (nova)</span>
                  <select
                    className="select"
                    value={bId}
                    onChange={(event) => setBId(event.target.value)}
                    aria-label="Versão B (nova) do histórico"
                  >
                    {versions.map((version) => (
                      <option key={version.id} value={version.id} disabled={version.id === aId}>
                        {versionLabel(version)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {analysis === null ? (
                <p className="muted">Selecione duas versões distintas para comparar.</p>
              ) : (
                <>
                  {/* ===== Alerta de recrutamento massivo ===== */}
                  <div className="hist-alert-panel">
                    <h3 className="hist-panel-title">
                      <AlertTriangle size={16} aria-hidden="true" /> Alerta de recrutamento massivo
                    </h3>
                    <p className="muted">
                      Jogadores com crescimento de {formatSigned(DEFAULT_MIN_OFF_POP_GROWTH)} de
                      população ofensiva ou {formatSigned(DEFAULT_MIN_VILLAGE_GROWTH)} aldeias entre
                      as versões selecionadas.
                    </p>
                    {analysis.massive.length === 0 ? (
                      <p className="muted">Nenhum recrutamento massivo detectado.</p>
                    ) : (
                      <ul className="hist-alert-list" role="list">
                        {analysis.massive.map((row) => (
                          <li key={row.playerName} className="hist-alert-item" role="listitem">
                            <strong className="hist-alert-name">{row.playerName}</strong>
                            <span className="pill pill--error">Δoff {formatSigned(row.offPopDelta)}</span>
                            <span className="pill pill--error">Δaldeias {formatSigned(row.villageCountDelta)}</span>
                            <span className="hist-alert-hint muted">possível preparação de OP</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* ===== Tabela de evolução ===== */}
                  <div className="table-wrap">
                    <table className="table" aria-label="Evolução das tropas por jogador entre as versões selecionadas">
                      <thead>
                        <tr>
                          <th scope="col">Jogador</th>
                          <th scope="col" className="cell-num">Pop Off (A→B)</th>
                          <th scope="col" className="cell-num">Pop Def (A→B)</th>
                          <th scope="col" className="cell-num">Aldeias (A→B)</th>
                          <th scope="col">Novo?</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analysis.diff.map((row) => (
                          <tr key={row.playerName} className={row.isNew ? 'hist-row-new' : undefined}>
                            <td className="cell-nowrap">{row.playerName}</td>
                            <td className="cell-num">
                              <EvolutionCell a={row.offPopA} b={row.offPopB} delta={row.offPopDelta} />
                            </td>
                            <td className="cell-num">
                              <EvolutionCell a={row.defPopA} b={row.defPopB} delta={row.defPopDelta} />
                            </td>
                            <td className="cell-num">
                              <EvolutionCell a={row.villageCountA} b={row.villageCountB} delta={row.villageCountDelta} />
                            </td>
                            <td className="cell-nowrap">
                              {row.isNew ? (
                                <span className="pill pill--ok">Novo</span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted">Ordenado por crescimento de pop ofensiva no período (maior primeiro).</p>
                </>
              )}
            </>
          )}

          {versions !== null && versions.length > 0 && (
            <p className="muted hist-footer">
              {NUMBER_FMT.format(versions.length)} de {NUMBER_FMT.format(MAX_TROOPS_HISTORY)} versões
              arquivadas · Coletas: {versions.map((version) => formatQuando(version.collectedAt)).join(' · ')}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
