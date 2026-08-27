import { useState } from 'react';
import type { JSX } from 'react';
import { AlertTriangle, Check, ChevronDown, Crosshair, Sparkles } from 'lucide-react';
import { parseCoord, type Coord } from '@shared/coords';
import { distributeFakes, type FakeAssignment, type FakeDistributionResult } from '@shared/fakes-intelligent';
import { parseOriginsInput } from '@shared/sg4-engine';
import Field from '../../components/Field';

/**
 * SG_4 — Distribuição inteligente de fakes (P1-16). Seção colapsável que consome
 * o motor puro '@shared/fakes-intelligent': origens com comando sobrando mandam
 * fakes para os alvos que sobraram da separação da Seção A, espalhando a ilusão
 * entre o máximo de vilas possível.
 *
 * - Alvos vêm da caixa ALDEIAS ALVOS (coords "x|y") via prop `targetCoords`.
 * - Origens vêm da MESMA caixa "Informações de origem" da distribuição principal
 *   (formato nick;fulls;coords ou nick;fulls;semis;coords) e são lidas com o
 *   parser canônico `parseOriginsInput` — cada coordenada de vila vira uma
 *   origem candidata com `distanceTo` euclidiana em campos.
 * - "Aplicar na caixa de fakes" devolve, via `onApply`, uma linha "x|y" por par
 *   origem→alvo (o alvo de cada par), exatamente o formato que a caixa
 *   ALDEIAS FAKES do SG_4 espera (`fakes.join('\n' | ' ')`).
 */

/** Teto prático quando "Distância máxima" fica vazio: o motor exige um número
 * finito e a maior distância possível num mapa 1000×1000 é ≈ 1414 campos —
 * 9999 funciona como "sem teto". */
const NO_MAX_FIELDS = 9999;

/** Formato de 2 decimais em pt-BR para as distâncias (o motor já arredonda). */
const DEC2_FMT = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface FakesIntelligentSectionProps {
  /** Alvos (coordenadas "x|y") selecionados como ALVOS na seção A do SG_4. */
  targetCoords: string[];
  /** Origens disponíveis "nick;fulls;coords" (mesmo formato da caixa de distribuição). */
  originsText: string;
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
  targetCoords,
  originsText,
  onApply,
}: FakesIntelligentSectionProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [maxPerOriginText, setMaxPerOriginText] = useState('1');
  const [maxFieldsText, setMaxFieldsText] = useState('');
  const [result, setResult] = useState<FakeDistributionResult | null>(null);
  const [warn, setWarn] = useState('');
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);

  /** Executa o motor: valida entradas (warn) e propaga erros do motor (danger). */
  function runDistribution(): void {
    setWarn('');
    setError('');
    setApplied(false);
    setResult(null);

    const missing: string[] = [];
    if (!targetCoords.some((coord) => coord.trim() !== '')) {
      missing.push('alvos — selecione jogadores como "alvo" e clique em "Obter Alvos e Fakes" (caixa ALDEIAS ALVOS)');
    }
    if (originsText.trim() === '') {
      missing.push('origens — preencha a caixa "Informações de origem" (formato nick;fulls;coords)');
    }
    if (missing.length > 0) {
      setWarn(`Para distribuir fakes falta: ${missing.join(' e ')}.`);
      return;
    }

    try {
      // Alvos: coords "x|y" válidas, sem duplicatas (primeira ocorrência vence).
      const targetMap = new Map<string, Coord>();
      for (const raw of targetCoords) {
        const coord = parseCoord(raw);
        if (coord === null) continue;
        const key = `${coord.x}|${coord.y}`;
        if (targetMap.has(key)) continue;
        targetMap.set(key, coord);
      }

      // Origens: o MESMO parser da caixa "Informações de origem" (legado e FULL/SEMI);
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
            <p className="muted fkint-hint">
              Origens com comando sobrando mandam fakes para os alvos que ficaram de fora da distribuição
              principal: a cada passo, a origem com menos fakes pega o alvo livre mais próximo — a ilusão
              se espalha pelo máximo de vilas.
            </p>

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
