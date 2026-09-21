import { useMemo, useState } from 'react';
import { Bell, Clock, Copy } from 'lucide-react';
import { formatHms, formatSendSchedule } from '@shared/sg4-timing';
import type { SendScheduleRow } from '@shared/sg4-timing';
import type { DistributionResult } from '@shared/sg4-engine';
import Callout from '../../components/Callout';
import { GatedHint } from './Sg4Page';

/** Props da etapa 3 (Agenda): TODO o estado de negócio continua no Sg4Page (a
 *  distribuição e os inputs persistidos são compartilhados com as etapas 2 e 4)
 *  — aqui só entram valores + onChange e o estado de UI local (revelar). */
export interface Sg4AgendaSectionProps {
  /** stepAgendaStatus — mesma linha muted sob o título (stepper no pai). */
  statusText: string;
  distribution: DistributionResult | null;
  /** distributionStale — trava do botão de alertas T-minus. */
  distributionStale: boolean;
  /** scheduleStale — banner e trava de alertas. */
  stale: boolean;
  opTimeText: string;
  onOpTimeTextChange: (value: string) => void;
  opDay: 'hoje' | 'amanha';
  onOpDayChange: (day: 'hoje' | 'amanha') => void;
  noblesText: string;
  onNoblesTextChange: (value: string) => void;
  spacingText: string;
  onSpacingTextChange: (value: string) => void;
  tminusMarksText: string;
  onTminusMarksTextChange: (value: string) => void;
  timingError: string;
  scheduleRows: SendScheduleRow[] | null;
  onCalculate: () => void;
  onActivateAlerts: () => void;
  onCopy: (text: string) => void;
}

/** ===== Etapa 3 — Agenda de Envio =====
 *   Seção PERMANENTE no DOM (a âncora do stepper existe mesmo sem
 *   distribuição): sem distribuição, callout orienta o que fazer antes. */
export default function Sg4AgendaSection(props: Sg4AgendaSectionProps) {
  const {
    statusText,
    distribution,
    distributionStale,
    stale,
    opTimeText,
    onOpTimeTextChange,
    opDay,
    onOpDayChange,
    noblesText,
    onNoblesTextChange,
    spacingText,
    onSpacingTextChange,
    tminusMarksText,
    onTminusMarksTextChange,
    timingError,
    scheduleRows,
    onCalculate,
    onActivateAlerts,
    onCopy,
  } = props;

  // Progressive disclosure (3-J): default COLAPSADA enquanto a distribuição
  // falta; com o pré-requisito satisfeito o flag é ignorado. Nada de lógica
  // nova: só apresenta o que já estava lá.
  const [revealed, setRevealed] = useState(false);
  const collapsed = distribution === null && !revealed;

  /** Coordenadas de origem SEMI segundo a ÚLTIMA DISTRIBUIÇÃO REALIZADA (a
   *  agenda é calculada sobre ela — marcar pelo texto vivo poderia mentir se
   *  o usuário editasse as origens depois de distribuir). */
  const semiOriginCoords = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    if (distribution === null) return set;
    for (const row of distribution.matrix) {
      if (row.tier === 'semi') set.add(row.origin);
    }
    return set;
  }, [distribution]);

  return (
    <section className="page-section" aria-labelledby="sg4-agenda-title">
      <h2 className="section-title" id="sg4-agenda-title">Agenda de envio (timing da OP)</h2>
      <p className="muted">{statusText}</p>
      {collapsed ? (
        <GatedHint
          hint="A agenda abre depois da distribuição — conclua a etapa anterior para liberar."
          onReveal={() => setRevealed(true)}
        />
      ) : distribution === null ? (
        <Callout variant="info">
          <p>
            <strong>A agenda abre depois da distribuição</strong> — feche quem ataca o quê na
            etapa 2 e volte aqui para calcular a que horas cada um precisa enviar.
          </p>
        </Callout>
      ) : (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Horários de envio</h3>
            <span className="spacer" />
            <span className="pill pill--muted">enviar às = chegada desejada − tempo de viagem</span>
          </div>
          <div className="card-body">
            {stale && (
              <Callout variant="warn" title="Agenda possivelmente desatualizada">
                <p>Horários mudaram — recalcule a agenda.</p>
              </Callout>
            )}
            <div className="sg4-params">
              <label className="field">
                <span className="field-label">OP bate às (HH:MM)</span>
                <input
                  className="input"
                  type="time"
                  value={opTimeText}
                  data-tip="Horário de CHEGADA dos ataques, no dia selecionado."
                  onChange={(event) => onOpTimeTextChange(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Dia da chegada</span>
                <select
                  className="select"
                  value={opDay}
                  aria-label="Dia da chegada dos ataques"
                  data-tip="Dia em que os ataques BATEM — os horários de envio saem para chegar nesse dia (Amanhã = base +1 antes de fixar as horas)."
                  onChange={(event) => onOpDayChange(event.target.value as 'hoje' | 'amanha')}
                >
                  <option value="hoje">Hoje</option>
                  <option value="amanha">Amanhã</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Nobres por alvo (trem)</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={noblesText}
                  data-tip="Quantos nobres cada alvo recebe, em sequência."
                  onChange={(event) => onNoblesTextChange(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Espaçamento entre nobres (s)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={spacingText}
                  data-tip="Segundos entre os nobres do trem no mesmo alvo."
                  onChange={(event) => onSpacingTextChange(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Marcas de alerta (minutos)</span>
                <input
                  className="input"
                  inputMode="numeric"
                  placeholder="15 5 1"
                  value={tminusMarksText}
                  data-tip="Minutos antes de cada envio para o Windows notificar (ex.: 15 5 1)."
                  aria-describedby="sg4-tminus-marks-hint"
                  onChange={(event) => onTminusMarksTextChange(event.target.value)}
                />
                <p className="field-hint" id="sg4-tminus-marks-hint">
                  Minutos antes de cada envio para notificar (inteiros 1–1440, sem repetições) — usado pelo botão de alertas T-minus.
                </p>
              </label>
            </div>
            <div className="sg4-form-actions">
              <button
                type="button"
                className="btn"
                onClick={() => void onCalculate()}
                data-tip="Enviar às = chegada − tempo de viagem do nobre (com bônus noturno, se houver)."
              >
                <Clock size={15} aria-hidden="true" />
                Calcular horários de envio
              </button>
            </div>
            {timingError !== '' && <p className="error" role="alert">{timingError}</p>}
            {scheduleRows !== null && scheduleRows.length > 0 && (
              <>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Jogador</th>
                        <th scope="col">Origem</th>
                        <th scope="col">Alvo</th>
                        <th scope="col">Enviar às</th>
                        <th scope="col" className="cell-num">Viagem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scheduleRows.map((row, index) => (
                        <tr key={`${row.nick}-${row.targetCoord}-${index}`}>
                          <td className="cell-nowrap">{row.nick}</td>
                          <td>
                            {row.originCoord}
                            {semiOriginCoords.has(row.originCoord) && (
                              <span className="text-warn" title="Origem SEMI"> semi</span>
                            )}
                          </td>
                          <td>{row.targetCoord}</td>
                          <td className={row.sendAt.getTime() < Date.now() ? 'cell-nowrap text-warn' : 'cell-nowrap'}>
                            {formatHms(row.sendAt)}
                          </td>
                          <td className="cell-num">{row.travelMinutes.toFixed(1)} min</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <label className="field">
                  <span className="field-label">Nick;alvo;enviar às (formato original)</span>
                  <textarea
                    className="textarea sg4-coords"
                    rows={Math.min(12, scheduleRows.length + 2)}
                    readOnly
                    value={formatSendSchedule(scheduleRows)}
                    aria-label="Nick;alvo;enviar às"
                  />
                  <div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void onCopy(formatSendSchedule(scheduleRows))}
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar agenda de envio
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={distributionStale || stale}
                      title={
                        stale
                          ? 'Horários mudaram — recalcule a agenda antes de ativar alertas.'
                          : distributionStale
                            ? 'Os parâmetros mudaram depois da distribuição — redistribua antes de ativar alertas.'
                            : undefined
                      }
                      onClick={() => void onActivateAlerts()}
                    >
                      <Bell size={14} aria-hidden="true" />
                      Ativar alertas T-minus
                    </button>
                  </div>
                </label>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
