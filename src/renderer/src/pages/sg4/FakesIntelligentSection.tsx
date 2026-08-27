import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { AlertTriangle, Check, ChevronDown, Crosshair, Info, Sparkles } from 'lucide-react';
import { parseCoord, type Coord } from '@shared/coords';
import { distributeFakes, type FakeAssignment, type FakeDistributionResult } from '@shared/fakes-intelligent';
import { parseOriginsInput } from '@shared/sg4-engine';
import Field from '../../components/Field';

/**
 * SG_4 — Distribuição inteligente de fakes (P1-16). Seção colapsável que consome
 * o motor puro '@shared/fakes-intelligent': origens com comando sobrando mandam
 * fakes para os alvos que sobraram, espalhando a ilusão entre o máximo de vilas
 * possível.
 *
 * - Modo 'sem-distribuicao' (antes da etapa 2): alvos = caixa ALDEIAS ALVOS da
 *   Seção A (prop `targetCoords`). Um callout avisa que distribuir primeiro é
 *   mais seguro — sem distribuição os fakes podem colidir com ataques reais.
 * - Modo 'pos-distribuicao' (após "Distribuir agora"): alvos = ÓRFÃOS da
 *   distribuição (sem atacante, prop `orphanTargets`) e origens = o que sobrou
 *   da caixa "Origens da tribo" depois de remover as coords já usadas (o pai
 *   filtra; prop `usedOriginCoords` documenta as usadas).
 * - "Aplicar na caixa de fakes" devolve, via `onApply`, uma linha "x|y" por par
 *   origem→alvo (o alvo de cada par), exatamente o formato que a caixa
 *   ALDEIAS FAKES do SG_4 espera (`fakes.join('\n' | ' ')`).
 * - Toda mudança de props (alvos/origens/modo) ZERA resultado e marca "aplicado"
 *   — o resultado anterior nunca fica stale na tela.
 */

/** Teto prático quando "Distância máxima" fica vazio: o motor exige um número
 * finito e a maior distância possível num mapa 1000×1000 é ≈ 1414 campos —
 * 9999 funciona como "sem teto". */
const NO_MAX_FIELDS = 9999;

/** Formato de 2 decimais em pt-BR para as distâncias (o motor já arredonda). */
const DEC2_FMT = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface FakesIntelligentSectionProps {
  /** 'sem-distribuicao': alvos = caixa ALDEIAS ALVOS (etapa 1).
   *  'pos-distribuicao': alvos = órfãos da distribuição (sem atacante). */
  mode: 'sem-distribuicao' | 'pos-distribuicao';
  /** Modo sem-distribuicao: alvos (coords "x|y") da caixa ALDEIAS ALVOS. */
  targetCoords: string[];
  /** Origens disponíveis "nick;fulls;coords" — no modo pos-distribuicao o pai
   *  já removeu as coordenadas usadas na distribuição. */
  originsText: string;
  /** Modo pos-distribuicao: alvos SEM atacante na distribuição atual. */
  orphanTargets?: string[];
  /** Modo pos-distribuicao: coords de origem já usadas nos pares fechados. */
  usedOriginCoords?: string[];
  /** Chamado com as linhas "x|y" (alvo de cada par origem→alvo) para preencher a caixa de FAKES. */
  onApply: (fakeLines: string[]) => void;
}

/** Contagem de fakes por vila de origem (ordem de entrada preservada). */
interface PerOriginCount {
  playerName: string;
  origin: string;
  count: number;
}

function countPerOrigin(assignments: FakeAssignment[]): PerOriginCount[] {
  const counts = new Map<string, PerOriginCount>();
  for (const assignment of assignments) {
    const existing = counts.get(assignment.origin);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    counts.set(assignment.origin, { playerName: assignment.playerName, origin: assignment.origin, count: 1 });
  }
  return [...counts.values()];
}

/** SG_4 — seção colapsável de distribuição inteligente de fakes. */
export default function FakesIntelligentSection({
  mode,
  targetCoords,
  originsText,
  orphanTargets = [],
  usedOriginCoords = [],
  onApply,
}: FakesIntelligentSectionProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [maxPerOriginText, setMaxPerOriginText] = useState('1');
  const [maxFieldsText, setMaxFieldsText] = useState('');
  const [result, setResult] = useState<FakeDistributionResult | null>(null);
  const [warn, setWarn] = useState('');
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);

  // Alvos efetivos conforme o modo: pós-distribuição usa os ÓRFÃOS (quem ficou
  // sem atacante) — nunca os alvos reais da caixa ALDEIAS ALVOS.
  const effectiveTargets = mode === 'pos-distribuicao' ? orphanTargets : targetCoords;

  // Fim do resultado stale: qualquer mudança nas entradas (alvos, origens, modo)
  // zera resultado/marcações — nada calculado com dados antigos sobrevive.
  const inputsKey = `${mode}|${effectiveTargets.join('|')}|${originsText}`;
  useEffect(() => {
    setResult(null);
    setApplied(false);
    setWarn('');
    setError('');
  }, [inputsKey]);

  /** Executa o motor: valida entradas (warn) e propaga erros do motor (danger). */
  function runDistribution(): void {
    setWarn('');
    setError('');
    setApplied(false);
    setResult(null);

    const missing: string[] = [];
    if (!effectiveTargets.some((coord) => coord.trim() !== '')) {
      missing.push(
        mode === 'pos-distribuicao'
          ? 'alvos — a distribuição atual não tem alvos sem atacante (redistribua ou aumente as origens)'
          : 'alvos — selecione jogadores como "alvo" e clique em "Separar alvos e fakes" (caixa ALDEIAS ALVOS)',
      );
    }
    if (originsText.trim() === '') {
      missing.push('origens — preencha a caixa "Origens da tribo (nick;fulls;coords)"');
    }
    if (missing.length > 0) {
      setWarn(`Para distribuir fakes falta: ${missing.join(' e ')}.`);
      return;
    }

    try {
      // Alvos: coords "x|y" válidas, sem duplicatas (primeira ocorrência vence).
      const targetMap = new Map<string, Coord>();
      for (const raw of effectiveTargets) {
        const coord = parseCoord(raw);
        if (coord === null) continue;
        const key = `${coord.x}|${coord.y}`;
        if (targetMap.has(key)) continue;
        targetMap.set(key, coord);
      }

      // Origens: o MESMO parser da caixa "Origens da tribo" (legado e FULL/SEMI);
      // cada vila listada = uma origem candidata a mandar fake.
      const players = parseOriginsInput(originsText);
      const origins = players.flatMap((player) =>
        player.origins.map((village) => ({
          playerName: player.playerName,
          coord: `${village.x}|${village.y}`,
          distanceTo: (target: string): number => {
            const parsed = targetMap.get(target);
            if (parsed === undefined) return Number.POSITIVE_INFINITY; // motor falha fechada
            return Math.hypot(parsed.x - village.x, parsed.y - village.y);
          },
        })),
      );

      // Metadado obrigatório do motor (não participa do pareamento): 0 = sem referência.
      const targets = [...targetMap.values()].map((coord) => ({
        coord: `${coord.x}|${coord.y}`,
        distanceFields: 0,
      }));

      const maxPerOrigin = maxPerOriginText.trim() === '' ? 1 : Number(maxPerOriginText.trim());
      const maxFields = maxFieldsText.trim() === '' ? NO_MAX_FIELDS : Number(maxFieldsText.trim());

      setResult(distributeFakes(origins, targets, { maxPerOrigin, maxFields }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  /** Converte os pares origem→alvo no formato da caixa ALDEIAS FAKES (alvo por par). */
  function applyToFakesBox(): void {
    if (result === null) return;
    onApply(result.assignments.map((assignment) => assignment.target));
    setApplied(true);
  }

  const perOrigin = result !== null ? countPerOrigin(result.assignments) : [];

  return (
    <div className="card fkint">
      <div className="card-body">
        <button
          type="button"
          className="btn btn-ghost btn-sm fkint-toggle"
          aria-expanded={open}
          aria-controls="fkint-content"
          onClick={() => setOpen((visible) => !visible)}
        >
          <Sparkles size={14} aria-hidden="true" />
          Distribuição inteligente de fakes
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={open ? 'fkint-chevron fkint-chevron--open' : 'fkint-chevron'}
          />
        </button>

        {open && (
          <div id="fkint-content" className="col fkint-content" style={{ gap: 12, marginTop: 10 }}>
            {mode === 'sem-distribuicao' ? (
              <>
                <p className="muted fkint-hint">
                  Origens com comando sobrando mandam fakes para os alvos da caixa ALDEIAS ALVOS: a cada passo, a
                  origem com menos fakes pega o alvo livre mais próximo — a ilusão se espalha pelo máximo de vilas.
                </p>
                <div className="callout callout--info">
                  <Info size={18} className="callout-icon" aria-hidden="true" />
                  <div className="callout-body">
                    <p className="callout-title">Distribua primeiro (etapa 2)</p>
                    <p>
                      Os alvos que ficarem SEM atacante voltam aqui como candidatos a fake. Sem distribuição, os
                      fakes podem colidir com ataques reais.
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <p className="muted fkint-hint">
                Modo pós-distribuição: cada alvo SEM atacante (órfão) recebe fakes de origens com comando sobrando —
                as coordenadas já usadas nos pares fechados ficam de fora
                {usedOriginCoords.length > 0 ? ` (${usedOriginCoords.length} origem(ns) em uso)` : ''}.
              </p>
            )}

            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Field
                id="fkint-maxPerOrigin"
                label="Máximo de fakes por origem"
                hint="Padrão do motor: 1 fake por vila de origem."
              >
                <input
                  id="fkint-maxPerOrigin"
                  className="input fkint-input"
                  type="number"
                  min={1}
                  step={1}
                  value={maxPerOriginText}
                  onChange={(event) => setMaxPerOriginText(event.target.value)}
                />
              </Field>
              <Field
                id="fkint-maxFields"
                label="Distância máxima (campos)"
                hint="Vazio = sem teto. Padrão do motor: 70 campos."
              >
                <input
                  id="fkint-maxFields"
                  className="input fkint-input"
                  type="number"
                  min={0}
                  step={1}
                  placeholder="sem teto"
                  value={maxFieldsText}
                  onChange={(event) => setMaxFieldsText(event.target.value)}
                />
              </Field>
            </div>

            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={runDistribution}>
                <Crosshair size={15} aria-hidden="true" />
                Distribuir fakes
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={result === null}
                onClick={applyToFakesBox}
              >
                <Check size={14} aria-hidden="true" />
                Aplicar na caixa de fakes
              </button>
              {applied && result !== null && (
                <span className="muted fkint-applied" role="status">
                  {result.assignments.length} linha(s) enviada(s) para a caixa ALDEIAS FAKES.
                </span>
              )}
            </div>

            {warn !== '' && (
              <div className="callout callout--warn">
                <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
                <div className="callout-body">
                  <p className="callout-title">Falta informação</p>
                  <p>{warn}</p>
                </div>
              </div>
            )}

            {error !== '' && (
              <div className="callout callout--danger">
                <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
                <div className="callout-body">
                  <p className="callout-title">Não foi possível distribuir os fakes</p>
                  <p>{error}</p>
                </div>
              </div>
            )}

            {result !== null && (
              <div className="col fkint-result" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {perOrigin.map((entry) => (
                    <span
                      key={entry.origin}
                      className="pill pill--muted fkint-count"
                    >
                      {entry.playerName} ({entry.origin}): {entry.count} fake(s)
                    </span>
                  ))}
                </div>

                {result.assignments.length === 0 ? (
                  <p className="muted fkint-hint">
                    Nenhum par origem→alvo dentro dos limites — aumente a distância máxima ou confira as origens.
                  </p>
                ) : (
                  <div className="table-wrap">
                    <table className="table fkint-table">
                      <thead>
                        <tr>
                          <th scope="col">Origem</th>
                          <th scope="col">Alvo</th>
                          <th scope="col" className="cell-num">Distância (campos)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.assignments.map((assignment) => (
                          <tr key={`${assignment.origin}->${assignment.target}`}>
                            <td className="cell-nowrap">
                              {assignment.playerName} <span className="muted">({assignment.origin})</span>
                            </td>
                            <td className="cell-nowrap">{assignment.target}</td>
                            <td className="cell-num">{DEC2_FMT.format(assignment.distanceFields)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <p className="muted fkint-summary">
                  {result.assignments.length} fake(s) distribuído(s) · {result.unassignedTargets.length} alvo(s)
                  sem fake · {result.idleOrigins.length} origem(ns) sem nenhum fake.
                </p>
                {result.unassignedTargets.length > 0 && (
                  <p className="muted fkint-summary">Sem fake: {result.unassignedTargets.join(' ')}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
