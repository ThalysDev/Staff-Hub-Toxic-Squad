import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { AlertTriangle, BrickWall, Crosshair, Eye, Info, MapPin, Shield, Swords } from 'lucide-react';
import {
  DEFAULT_POP_PER_FULL,
  parseSpyReport,
  suggestFulls,
  type SpyReportData,
} from '@shared/spy-report';
import { SUMMARY_UNIT_ORDER } from '@shared/sg2-summary';
import { UNITS, type UnitId } from '@shared/units';
import { TW_UNIT_ICONS } from '../../assets';
import Field from '../../components/Field';
import ToastViewport from '../../components/Toast';
import { useToast } from '../../hooks/useToast';

/**
 * SG_4 — "Análise de Espionagem" (roadmap P2). Seção autossuficiente que consome
 * o motor puro '@shared/spy-report': o usuário cola o CORPO de um relatório de
 * espionagem, o parser fail-closed extrai alvo/unidades/muralha/populações e o
 * painel de sugestão estima quantos fulls ofensivos limpam a defesa espiada.
 *
 * - Único vínculo com a página: `onUseAsTarget` devolve a coordenada espiada
 *   para preencher a COORDENADA CENTRAL da Seção A (criação de OP).
 * - Toasts próprios (useToast + ToastViewport embutido), no padrão da seção
 *   "Histórico e Evolução" do SG_2.
 * - A sugestão de fulls recalcula AO VIVO quando a "População por full" muda.
 */

/** Inteiros pt-BR (10.000) para quantidades e populações. */
const NUMBER_FMT = new Intl.NumberFormat('pt-BR');

/** Pausa curta no "Analisar": o parser é síncrono e rápido, mas o spinner de
 *  feedback deve ser percebido como nos outros botões do módulo. */
const ANALYZE_FEEDBACK_MS = 150;

/** Exemplo compacto do formato aceito (vira placeholder da textarea). */
const REPORT_PLACEHOLDER = [
  'Espionagem em 471|463 no dia 26.08. 21:00',
  'Lanceiro 10.000 Espadachim 5.000',
  'Cavalaria Pesada 1.200',
  'Muralha Nível 12',
].join('\n');

export interface SpyReportSectionProps {
  /** Preenche a coordenada central da seção A com a coord espionada. */
  onUseAsTarget: (coord: string) => void;
}

/** Sugestão viva: ok com o resultado do motor, ou erro PT-BR do campo. */
type SuggestionState = { fulls: number; detail: string } | { error: string } | null;

/** SG_4 — análise de relatórios de espionagem colados + sugestão de fulls. */
export default function SpyReportSection({ onUseAsTarget }: SpyReportSectionProps): JSX.Element {
  const { toasts, push, dismiss } = useToast();

  // Entrada colada + estado da análise (parser é fail-closed: erro PT-BR vira
  // callout de perigo, nunca resultado silencioso errado).
  const [reportText, setReportText] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [report, setReport] = useState<SpyReportData | null>(null);
  const [error, setError] = useState('');

  // Parâmetro da UI da sugestão (default do motor: 20.000 por full).
  const [popPerFullText, setPopPerFullText] = useState(String(DEFAULT_POP_PER_FULL));

  async function runAnalysis(): Promise<void> {
    setAnalyzing(true);
    setError('');
    try {
      await new Promise((resolve) => setTimeout(resolve, ANALYZE_FEEDBACK_MS));
      const parsed = parseSpyReport(reportText);
      setReport(parsed);
      push('ok', `Relatório do alvo ${parsed.coord} analisado.`);
    } catch (caught) {
      setReport(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAnalyzing(false);
    }
  }

  /** Devolve a coord espiada para a coordenada central da OP (Seção A). */
  function useAsCentral(): void {
    if (report === null) return;
    onUseAsTarget(report.coord);
    push('ok', `Coordenada central da OP preenchida com ${report.coord}.`);
  }

  /** Unidades ESPIADAS com quantidade > 0, na ordem canônica do catálogo. */
  const spiedUnits = useMemo<{ id: UnitId; count: number }[]>(() => {
    if (report === null) return [];
    return SUMMARY_UNIT_ORDER.flatMap((id) => {
      const count = report.units[id] ?? 0;
      return count > 0 ? [{ id, count }] : [];
    });
  }, [report]);

  /** Sugestão recalculada ao vivo (muralha e defPop do último relatório). */
  const suggestion = useMemo<SuggestionState>(() => {
    if (report === null) return null;
    const trimmed = popPerFullText.trim();
    const popPerFull = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(popPerFull) || popPerFull <= 0) {
      return { error: 'População por full deve ser um número maior que zero (ex.: 20000).' };
    }
    try {
      return suggestFulls(report.defPop, report.wallLevel, popPerFull);
    } catch (caught) {
      return { error: caught instanceof Error ? caught.message : String(caught) };
    }
  }, [report, popPerFullText]);

  return (
    <section className="page-section spy" aria-labelledby="sg4-spy-title">
      <h2 className="section-title" id="sg4-spy-title">Análise de Espionagem</h2>

      <div className="card spy-report">
        <div className="card-body">
          <Field
            id="sg4-spy-report"
            label="Cole o relatório de espionagem"
            hint="Cole o corpo do relatório do Tribal Wars: linha “Espionagem em x|y”, pares “unidade quantidade” (números pt-BR, ex.: Lanceiro 10.000) e “Muralha Nível X”."
          >
            <textarea
              id="sg4-spy-report"
              className="textarea spy-textarea"
              rows={7}
              placeholder={REPORT_PLACEHOLDER}
              value={reportText}
              aria-describedby="sg4-spy-report-hint"
              onChange={(event) => setReportText(event.target.value)}
            />
          </Field>

          <div className="sg4-form-actions">
            <button type="button" className="btn" disabled={analyzing} onClick={() => void runAnalysis()}>
              {analyzing ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Analisando…
                </>
              ) : (
                <>
                  <Eye size={15} aria-hidden="true" />
                  Analisar
                </>
              )}
            </button>
          </div>

          {error !== '' && (
            <div className="callout callout--danger spy-error">
              <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
              <div className="callout-body">
                <p className="callout-title">Não foi possível analisar o relatório</p>
                <p>{error}</p>
              </div>
            </div>
          )}

          {report === null && error === '' && (
            <div className="callout callout--info spy-empty">
              <Info size={18} className="callout-icon" aria-hidden="true" />
              <div className="callout-body">
                <p className="callout-title">Nenhum relatório analisado ainda</p>
                <p>
                  Formato aceito: coordenada do alvo na linha “Espionagem em 471|463” (ou a
                  primeira coordenada “x|y” do texto), tropas como pares “unidade quantidade” —
                  Lanceiro 10.000, Cavalaria Pesada 1.200 — e a muralha como “Muralha Nível 12”.
                  Linhas de perdas do seu explorador são ignoradas.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {report !== null && (
        <>
          <div className="stat-row spy-stats">
            <div className="stat-block spy-stat">
              <span className="stat-block-label">
                <MapPin size={14} className="stat-block-icon" aria-hidden="true" />
                Alvo espiado
              </span>
              <span className="stat-block-value">{report.coord}</span>
            </div>
            <div className="stat-block spy-stat">
              <span className="stat-block-label">
                <BrickWall size={14} className="stat-block-icon" aria-hidden="true" />
                Muralha
              </span>
              <span
                className="stat-block-value"
                title={report.wallLevel === null ? 'O relatório não trouxe o nível da muralha' : undefined}
              >
                {report.wallLevel === null ? '—' : `Nível ${report.wallLevel}`}
              </span>
            </div>
            <div className="stat-block spy-stat">
              <span className="stat-block-label">
                <Shield size={14} className="stat-block-icon" aria-hidden="true" />
                Pop. defensiva
              </span>
              <span className="stat-block-value">{NUMBER_FMT.format(report.defPop)}</span>
            </div>
            <div className="stat-block spy-stat">
              <span className="stat-block-label">
                <Swords size={14} className="stat-block-icon" aria-hidden="true" />
                Pop. ofensiva
              </span>
              <span className="stat-block-value">{NUMBER_FMT.format(report.offPop)}</span>
            </div>
          </div>

          <div className="row spy-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={useAsCentral}>
              <Crosshair size={15} aria-hidden="true" />
              Usar como coordenada central
            </button>
          </div>

          <div className="card spy-units">
            <div className="card-header">
              <h3 className="card-title">Tropas espiadas ({spiedUnits.length})</h3>
              <span className="spacer" />
              <span className="pill pill--muted">unidade ausente no relatório = 0</span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Unidade</th>
                    <th scope="col" className="cell-num">Quantidade</th>
                  </tr>
                </thead>
                <tbody>
                  {spiedUnits.map(({ id, count }) => (
                    <tr key={id}>
                      <td className="cell-nowrap">
                        <img src={TW_UNIT_ICONS[id]} width={16} height={16} alt="" aria-hidden="true" />{' '}
                        {UNITS[id].name}
                      </td>
                      <td className="cell-num">{NUMBER_FMT.format(count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card spy-suggest">
            <div className="card-header">
              <h3 className="card-title">Sugestão de fulls</h3>
              <span className="spacer" />
              <span className="pill pill--muted">regra-de-polegar</span>
            </div>
            <div className="card-body">
              <Field
                id="sg4-spy-popfull"
                label="População por full"
                hint="População ofensiva que você considera um full (padrão da ferramenta: 20.000)."
              >
                <input
                  id="sg4-spy-popfull"
                  className="input spy-popfull"
                  type="number"
                  min={1}
                  step={1000}
                  value={popPerFullText}
                  aria-describedby="sg4-spy-popfull-hint"
                  onChange={(event) => setPopPerFullText(event.target.value)}
                />
              </Field>

              {suggestion !== null && 'error' in suggestion ? (
                <p className="error" role="alert">{suggestion.error}</p>
              ) : (
                suggestion !== null && (
                  <>
                    <p className="spy-highlight">
                      <span className="sg4-count spy-fulls-count">{NUMBER_FMT.format(suggestion.fulls)}</span>{' '}
                      <span className="spy-fulls-label">
                        {suggestion.fulls === 1 ? 'full recomendado' : 'fulls recomendados'}
                      </span>
                    </p>
                    <p className="muted spy-suggest-detail">{suggestion.detail}</p>
                  </>
                )
              )}
            </div>
          </div>
        </>
      )}

      <p className="muted spy-note">
        ⚠ validar contra fixture real — o parser é sintético (reconhece pares “unidade
        quantidade”, “Muralha Nível X” e coordenada “x|y”); confira o resultado na primeira
        colagem real antes de confiar.
      </p>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
