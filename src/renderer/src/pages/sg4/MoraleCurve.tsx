import type { JSX } from 'react';
import { moraleOf } from '@shared/sg4-engine';

/**
 * SG_4 — Curva visual da moral (calibração visível do motor). Sem estado, sem
 * props: desenha a moral (0–100%) em função da razão def/att usando o PRÓPRIO
 * `moraleOf` como fonte única — se a fórmula do jogo mudar no motor, a curva e
 * os marcadores acompanham sem edição aqui.
 *
 * - Eixo X: razão tamanho do alvo ÷ tamanho do atacante (0,1–3,0), com atacante
 *   exemplar fixo em 1.000.000 pontos e alvo = razão × 1.000.000.
 * - Linha tracejada no piso implícito de 30% (a constante 0,3 da fórmula).
 * - Marcadores nos pontos notáveis (0,1×, 1/3×, 1×, 3×) com a moral CALCULADA.
 * - Prop opcional `minMorale`: linha tracejada em var(--danger) na moral mínima
 *   configurada + marcador vertical na razão-limite (o inverso da fórmula:
 *   razão = (moral/100 − 0,3) ÷ 3) — daí em diante a curva cai abaixo do mínimo.
 * - Cores sempre via var(--…) do tema — nada hardcoded.
 */

/** Atacante exemplar do eixo (pontos) — 1M facilita ler "0,1 = 100 mil". */
const EXEMPLAR_ATTACKER = 1_000_000;
/** Faixa da razão def/att exibida no eixo X. */
const RATIO_MIN = 0.1;
const RATIO_MAX = 3.0;
/** ~60 amostras da curva (especificação da calibração). */
const CURVE_SAMPLES = 60;

// Geometria do viewBox (o SVG escala a ~100% de largura × 160px de altura).
const VIEW_W = 640;
const VIEW_H = 160;
const PAD_L = 34;
const PAD_R = 10;
const PAD_T = 18;
const PAD_B = 28;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

function xOfRatio(ratio: number): number {
  return PAD_L + ((ratio - RATIO_MIN) / (RATIO_MAX - RATIO_MIN)) * PLOT_W;
}

function yOfMorale(morale: number): number {
  return PAD_T + (1 - morale / 100) * PLOT_H;
}

/** Pontos da curva: razão → moral via moraleOf (fonte única, arredondamento do motor). */
const CURVE_POINTS: { x: number; y: number }[] = Array.from({ length: CURVE_SAMPLES }, (_, index) => {
  const ratio = RATIO_MIN + (index / (CURVE_SAMPLES - 1)) * (RATIO_MAX - RATIO_MIN);
  return { x: xOfRatio(ratio), y: yOfMorale(moraleOf(EXEMPLAR_ATTACKER, ratio * EXEMPLAR_ATTACKER)) };
});

const CURVE_PATH = CURVE_POINTS.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');

/** Marcadores notáveis — a moral do rótulo é CALCULADA com moraleOf, nunca escrita à mão. */
const NOTABLE_MARKERS: { ratio: number; ratioLabel: string; anchor: 'start' | 'middle' | 'end' }[] = [
  { ratio: 0.1, ratioLabel: '0,1×', anchor: 'start' },
  { ratio: 1 / 3, ratioLabel: '⅓×', anchor: 'middle' },
  { ratio: 1, ratioLabel: '1×', anchor: 'middle' },
  { ratio: 3, ratioLabel: '3×', anchor: 'end' },
];

/** Ticks do eixo X (razão def/att) em pt-BR. */
const X_TICKS = [0.1, 0.5, 1, 1.5, 2, 2.5, 3];
/** Ticks do eixo Y (moral %) — o 30% ganha linha própria de piso. */
const Y_TICKS = [0, 60, 100];

const RATIO_FMT = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const POINTS_FMT = new Intl.NumberFormat('pt-BR');

export interface MoraleCurveProps {
  /** Moral mínima (0–100) configurada na Distribuição. Quando definida, desenha
   *  a linha tracejada nesse valor e o marcador vertical na razão-limite em que
   *  a curva cruza o mínimo. Fora de 0–100 (ou razão fora do eixo) só o que
   *  couber é desenhado. */
  minMorale?: number;
}

/** Curva da moral do SG_4 — pura, apenas leitura do motor. */
export default function MoraleCurve({ minMorale }: MoraleCurveProps): JSX.Element {
  // Moral mínima: linha horizontal tracejada (só se o valor cabe no eixo Y)…
  const minMoraleY = minMorale !== undefined && Number.isFinite(minMorale) && minMorale >= 0 && minMorale <= 100
    ? yOfMorale(minMorale)
    : null;
  // …e o marcador vertical na razão-limite, o inverso da fórmula do motor:
  // moral = (razão × 3 + 0,3) × 100 ⇒ razão = (moral/100 − 0,3) ÷ 3.
  const minRatio = minMorale === undefined ? null : (minMorale / 100 - 0.3) / 3;
  const marker =
    minRatio !== null && minRatio >= RATIO_MIN && minRatio <= RATIO_MAX
      ? { x: xOfRatio(minRatio), label: `${RATIO_FMT.format(minRatio)}×` }
      : null;
  const minMoralePct = minMorale !== undefined && Number.isFinite(minMorale) ? RATIO_FMT.format(minMorale) : null;

  return (
    <div className="card mcurve">
      <div className="card-header">
        <h3
          className="card-title"
          data-tip="Como a moral varia com a diferença de pontos entre atacante e alvo — use para calibrar a moral mínima da Distribuição."
        >
          Curva da moral
        </h3>
      </div>
      <div className="card-body">
        <svg
          className="mcurve-svg"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          width="100%"
          height={VIEW_H}
          role="img"
          aria-label={
            'Curva da moral (0 a 100%) em função da razão entre o tamanho do alvo e do atacante, com piso de 30%.' +
            (minMoralePct !== null ? ` Linha tracejada: sua moral mínima (${minMoralePct}%).` : '')
          }
        >
          {/* Grade horizontal (moral 0/60/100) */}
          {Y_TICKS.map((tick) => (
            <line
              key={`grid-y-${tick}`}
              x1={PAD_L}
              x2={VIEW_W - PAD_R}
              y1={yOfMorale(tick)}
              y2={yOfMorale(tick)}
              stroke="var(--divider)"
              strokeWidth={1}
            />
          ))}

          {/* Piso implícito de 30% (constante 0,3 da fórmula) */}
          <line
            x1={PAD_L}
            x2={VIEW_W - PAD_R}
            y1={yOfMorale(30)}
            y2={yOfMorale(30)}
            stroke="var(--danger)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
          <text x={VIEW_W - PAD_R} y={yOfMorale(30) - 4} textAnchor="end" fontSize={9} fill="var(--danger)">
            piso 30%
          </text>

          {/* Moral mínima configurada (prop minMorale): linha tracejada + marcador
              vertical na razão-limite em que a curva cruza o mínimo. */}
          {minMoraleY !== null && (
            <line
              x1={PAD_L}
              x2={VIEW_W - PAD_R}
              y1={minMoraleY}
              y2={minMoraleY}
              stroke="var(--danger)"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
          )}
          {marker !== null && minMoraleY !== null && (
            <g>
              <line
                x1={marker.x}
                x2={marker.x}
                y1={PAD_T}
                y2={PAD_T + PLOT_H}
                stroke="var(--danger)"
                strokeWidth={1}
                strokeDasharray="2 3"
              />
              <circle cx={marker.x} cy={minMoraleY} r={3} fill="var(--danger)" stroke="var(--bg-card)" strokeWidth={1} />
              <text x={marker.x} y={PAD_T + PLOT_H - 5} textAnchor="middle" fontSize={9} fill="var(--danger)">
                {marker.label}
              </text>
            </g>
          )}

          {/* Eixos */}
          <line x1={PAD_L} x2={VIEW_W - PAD_R} y1={PAD_T + PLOT_H} y2={PAD_T + PLOT_H} stroke="var(--border-card)" strokeWidth={1} />
          <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={PAD_T + PLOT_H} stroke="var(--border-card)" strokeWidth={1} />

          {/* Ticks Y (moral %) */}
          {Y_TICKS.map((tick) => (
            <g key={`tick-y-${tick}`}>
              <text x={PAD_L - 4} y={yOfMorale(tick) + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">
                {tick}%
              </text>
            </g>
          ))}

          {/* Ticks X (razão def/att) */}
          {X_TICKS.map((tick) => (
            <g key={`tick-x-${tick}`}>
              <line
                x1={xOfRatio(tick)}
                x2={xOfRatio(tick)}
                y1={PAD_T + PLOT_H}
                y2={PAD_T + PLOT_H + 4}
                stroke="var(--border-card)"
                strokeWidth={1}
              />
              <text x={xOfRatio(tick)} y={PAD_T + PLOT_H + 15} textAnchor="middle" fontSize={9} fill="var(--text-muted)">
                {RATIO_FMT.format(tick)}
              </text>
            </g>
          ))}

          {/* Rótulos dos eixos */}
          <text x={4} y={11} fontSize={9} fill="var(--text-muted)">
            Moral %
          </text>
          <text x={PAD_L + PLOT_W / 2} y={VIEW_H - 2} textAnchor="middle" fontSize={9} fill="var(--text-muted)">
            Tamanho do alvo ÷ tamanho do atacante
          </text>

          {/* Curva da moral (calculada com o próprio moraleOf) */}
          <path d={CURVE_PATH} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {/* Marcadores notáveis: razão → moral calculada */}
          {NOTABLE_MARKERS.map(({ ratio, ratioLabel, anchor }) => {
            const morale = moraleOf(EXEMPLAR_ATTACKER, ratio * EXEMPLAR_ATTACKER);
            return (
              <g key={`marker-${ratioLabel}`}>
                <circle cx={xOfRatio(ratio)} cy={yOfMorale(morale)} r={3} fill="var(--accent)" stroke="var(--bg-card)" strokeWidth={1} />
                <text
                  x={xOfRatio(ratio)}
                  y={yOfMorale(morale) - 7}
                  textAnchor={anchor}
                  fontSize={9}
                  fill="var(--text-muted)"
                >
                  {`${ratioLabel} → ${morale}%`}
                </text>
              </g>
            );
          })}
        </svg>

        <p className="muted mcurve-legend">
          Fórmula: (alvo÷atacante × 3 + 0,3) × 100, teto 100. Cada ponto do eixo = alvo com aquele
          tamanho relativo a um atacante de {POINTS_FMT.format(EXEMPLAR_ATTACKER)} pts.
          {minMoralePct !== null && ` Linha tracejada: sua moral mínima (${minMoralePct}%).`}
        </p>
      </div>
    </div>
  );
}
