import { useState } from 'react';
import { Copy, Send } from 'lucide-react';
import { planBbcode, renderTemplate, reservationList, sg6EntriesText } from '@shared/comms-package';
import type { buildPlayerComms } from '@shared/comms-package';
import { formatSendSchedule } from '@shared/sg4-timing';
import type { SendScheduleRow } from '@shared/sg4-timing';
import type { DistributionResult } from '@shared/sg4-engine';
import Callout from '../../components/Callout';
import TemplateLibrary from '../../components/TemplateLibrary';
import { GatedHint } from './Sg4Page';

/** Props da etapa 4 (Comunicação): TODO o estado de negócio continua no
 *  Sg4Page (o template é preferência persistida e o post trava com o stale das
 *  etapas 2/3) — aqui só entram valores + onChange e o estado de UI local. */
export interface Sg4CommsSectionProps {
  /** stepCommsStatus — mesma linha muted sob o título (stepper no pai). */
  statusText: string;
  distribution: DistributionResult | null;
  /** distributionStale — trava e título do POSTAR (mutação real). */
  distributionStale: boolean;
  scheduleRows: SendScheduleRow[] | null;
  /** Jogadores com alvos+horários prontos (null = agenda de outra distribuição). */
  commsPlayers: ReturnType<typeof buildPlayerComms> | null;
  commsTemplate: string;
  onCommsTemplateChange: (value: string) => void;
  /** distributionSummary da distribuição atual — reservas e BBCode do plano. */
  commsDistributionText: string;
  opTitle: string;
  planThreadUrl: string;
  onPlanThreadUrlChange: (value: string) => void;
  planPending: boolean;
  planPosting: boolean;
  planResult: string | null;
  /** Passo 1 da confirmação dupla: limpa o resultado e pede confirmação. */
  onBeginPost: () => void;
  /** Passo 2: confirmação — mutação real no fórum (runPostPlan no pai). */
  onConfirmPost: () => void;
  onCancelPost: () => void;
  onCopy: (text: string) => void;
  onNavigate: ((page: string) => void) | undefined;
}

/** ===== Etapa 4 — Pacote de Comunicação =====
 *   Também PERMANENTE no DOM: sem distribuição, callout orienta. */
export default function Sg4CommsSection(props: Sg4CommsSectionProps) {
  const {
    statusText,
    distribution,
    distributionStale,
    scheduleRows,
    commsPlayers,
    commsTemplate,
    onCommsTemplateChange,
    commsDistributionText,
    opTitle,
    planThreadUrl,
    onPlanThreadUrlChange,
    planPending,
    planPosting,
    planResult,
    onBeginPost,
    onConfirmPost,
    onCancelPost,
    onCopy,
    onNavigate,
  } = props;

  // Progressive disclosure (3-J): default COLAPSADA enquanto a distribuição
  // falta; com o pré-requisito satisfeito o flag é ignorado. Nada de lógica
  // nova: só apresenta o que já estava lá.
  const [revealed, setRevealed] = useState(false);
  const collapsed = distribution === null && !revealed;

  /** Prévia da MP do 1º jogador — erro NÃO silencioso: devolve {preview,error}
   *  e a falha de template aparece em callout vermelho na tela. */
  function commsPreview(): { preview: string | null; error: string } {
    if (commsPlayers === null || commsPlayers.length === 0) return { preview: null, error: '' };
    try {
      return {
        preview: renderTemplate(commsTemplate, commsPlayers[0] ?? { playerName: '?', coords: [], horarios: [] }),
        error: '',
      };
    } catch (error) {
      return {
        preview: null,
        error: error instanceof Error ? error.message : 'Template da MP inválido — revise #alvos# e #horarios#.',
      };
    }
  }

  // Prévia da MP calculada UMA vez por render — falha vira callout, não some.
  const mpPreview = commsPreview();

  return (
    <section className="page-section" aria-labelledby="sg4-comms-title">
      <h2 className="section-title" id="sg4-comms-title">Pacote de comunicação</h2>
      <p className="muted">{statusText}</p>
      {collapsed ? (
        <GatedHint
          hint="MPs e plano aparecem depois da distribuição — conclua a etapa anterior para liberar."
          onReveal={() => setRevealed(true)}
        />
      ) : distribution === null ? (
        <Callout variant="info">
          <p>
            <strong>MPs e plano aparecem depois da distribuição</strong> — cada jogador só tem
            alvos e horários para receber quando a OP está distribuída e agendada.
          </p>
        </Callout>
      ) : (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">MPs, plano e reservas</h3>
            <span className="spacer" />
            <span className="pill pill--muted">MPs com #horarios# · BBCode do plano · reservas</span>
          </div>
          <div className="card-body">
            <label className="field">
              <span className="field-label">Template da MP (use #alvos# e #horarios#)</span>
              <textarea
                className="textarea"
                rows={5}
                value={commsTemplate}
                data-tip="Texto base da MP. #alvos# vira os alvos do jogador e #horarios# os horários."
                aria-label="Template da MP"
                onChange={(event) => onCommsTemplateChange(event.target.value)}
              />
            </label>
            {/* Biblioteca de templates (só corpo no SG_4): aplica/substitui o
                template da MP da OP e salva o atual como novo template. */}
            <TemplateLibrary
              variant="sg4"
              currentSubject=""
              currentBody={commsTemplate}
              onApply={(_subject, body) => onCommsTemplateChange(body)}
            />
            {scheduleRows === null || scheduleRows.length === 0 ? (
              <p className="muted">
                Calcule a agenda de envio acima para gerar MPs com #horarios# — BBCode e lista de reservas já funcionam só com a distribuição.
              </p>
            ) : commsPlayers === null ? (
              <p className="error" role="alert">
                A agenda foi calculada para outra distribuição — rode a distribuição e a agenda de
                novo, na ordem, para as MPs saírem certas.
              </p>
            ) : (
              <>
                {mpPreview.error !== '' && (
                  <Callout variant="danger" title="Prévia da MP falhou">
                    <p>{mpPreview.error}</p>
                  </Callout>
                )}
                {mpPreview.preview !== null && (
                  <div>
                    <p className="field-label">Prévia da MP de {commsPlayers[0]?.playerName}:</p>
                    <pre className="sg7-code">{mpPreview.preview}</pre>
                  </div>
                )}
                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void onCopy(sg6EntriesText(commsPlayers))}
                  >
                    <Copy size={14} aria-hidden="true" />
                    Copiar destinatários (Reservas e MPs)
                  </button>
                  {/* Hand-off: leva a lista de destinatários ao módulo certo
                      (Reservas e MPs) — só existe com onNavigate injetado. */}
                  {onNavigate !== undefined && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onNavigate('sg6')}
                      data-tip="Abre o módulo de Reservas e MPs para disparar as MPs desta OP."
                    >
                      <Send size={14} aria-hidden="true" />
                      Ir para Reservas e MPs
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      void onCopy(
                        planBbcode({
                          opTitle,
                          template: commsTemplate,
                          distribution: commsDistributionText,
                          sendSchedule: formatSendSchedule(scheduleRows),
                        }),
                      )
                    }
                  >
                    <Copy size={14} aria-hidden="true" />
                    Copiar BBCode do plano (fórum)
                  </button>
                </div>
              </>
            )}
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={commsDistributionText === ''}
                onClick={() => void onCopy(reservationList(commsDistributionText))}
              >
                <Copy size={14} aria-hidden="true" />
                Copiar lista de reservas
              </button>
            </div>
            <div className="sg4-params" style={{ marginTop: 12 }}>
              <label className="field">
                <span className="field-label">URL do tópico do plano (o 1º post será substituído)</span>
                <input
                  className="input"
                  placeholder="https://br142.tribalwars.com.br/game.php?screen=forum&screenmode=view_thread&forum_id=…&thread_id=…"
                  value={planThreadUrl}
                  data-tip="Abra o tópico do plano no fórum do jogo e cole a URL aqui — o POSTAR substitui o 1º post."
                  aria-label="URL do tópico do plano"
                  onChange={(event) => onPlanThreadUrlChange(event.target.value)}
                />
              </label>
              <div className="field">
                <span className="field-label">Postar no fórum — mutação real</span>
                {!planPending ? (
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={planPosting || distributionStale || !/thread_id=\d+/.test(planThreadUrl) || scheduleRows === null || scheduleRows.length === 0}
                    title={
                      distributionStale
                        ? 'Os parâmetros mudaram depois da distribuição — redistribua antes de postar.'
                        : undefined
                    }
                    data-tip="Substitui o 1º post do tópico pelo plano. Confirmação dupla."
                    onClick={onBeginPost}
                  >
                    Postar plano no fórum
                  </button>
                ) : (
                  <div className="sg6-confirm">
                    <p>
                      Substituir o <strong>primeiro post</strong> do tópico pelo plano BBCode desta OP? Mutação única
                      com verificação — e o Windows ainda pedirá confirmação nativa.
                    </p>
                    <div className="row">
                      <button type="button" className="btn btn-danger" disabled={planPosting} onClick={() => void onConfirmPost()}>
                        {planPosting ? <><span className="btn-spinner" aria-hidden="true" /> Postando…</> : 'Confirmar post do plano'}
                      </button>
                      <button type="button" className="btn btn-ghost" disabled={planPosting} onClick={onCancelPost}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
                {(scheduleRows === null || scheduleRows.length === 0) && (
                  <p className="muted">Calcule a agenda de envio antes de postar — o plano do fórum sem horários não serve ao time.</p>
                )}
              </div>
            </div>
            {planResult !== null && <p className="muted">{planResult}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
