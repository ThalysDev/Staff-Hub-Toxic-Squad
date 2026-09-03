import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { AlertTriangle, ClipboardCheck, RefreshCw } from 'lucide-react';
import type { OpArchiveEntry } from '@shared/ipc-types';
import { formatCoord } from '@shared/coords';
import { filterOutcomes } from '@shared/war-view-filter';
import {
  attributeNoblesPerTarget,
  verifyPostOpLive,
  type PostOpLiveOutcome,
  type PostOpLiveResult,
  type PostOpLiveTarget,
} from '@shared/post-op-live';
import type { DiplomacyRelations, WorldAlly, WorldPlayer } from '@shared/types';
import { parseDistribution } from '@shared/war-room';
import StatBlock from '../../components/StatBlock';
import { loadRelationsShared } from '../../hooks/useDiplomacyRelations';
import { useToast } from '../../hooks/useToast';

export interface PostOpSectionProps {
  /** OP selecionada na Sala de Guerra (com distribuição anexada). */
  op: OpArchiveEntry;
  /** Avisa o pai para recarregar o arquivo (após anexar resultado). */
  onArchived: () => void;
}

type PostOpStatus = PostOpLiveOutcome['status'];

const STATUS_LABEL: Record<PostOpStatus, string> = {
  conquistado: 'Conquistado',
  defendido: 'Defendido',
  desperdiçado: 'Desperdiçado',
  'sem-dados': 'Sem dados',
};

/** Resumo compacto persistido nas preferências do módulo 'guerra'. */
interface PostOpSummary {
  verificadoEm: string;
  conquistado: number;
  defendido: number;
  desperdiçado: number;
  semDados: number;
  conquestRate: number;
  wastedNobles: number;
  noblesSemAlvo: number;
}

/**
 * Chave ÚNICA rolante nas preferências 'guerra': { opId, ...resumo }.
 * Uma chave por OP cresceria sem limite e o contrato de preferências só faz
 * merge (sem delete) — assim o módulo nunca estoura o cap de 200 chaves.
 */
const POSTOP_KEY = 'postopUltimo';

function toSummary(result: PostOpLiveResult, verificadoEm: string): PostOpSummary {
  return {
    verificadoEm,
    conquistado: result.totals.conquistado,
    defendido: result.totals.defendido,
    desperdiçado: result.totals.desperdiçado,
    semDados: result.totals['sem-dados'],
    conquestRate: result.totals.conquestRate,
    wastedNobles: result.totals.wastedNobles,
    noblesSemAlvo: result.totals.noblesSemAlvo,
  };
}

/** Valida o resumo lido das preferências (unknown) — dado estranho vira null. */
function parseSummary(value: unknown): (PostOpSummary & { opId: string }) | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { [key: string]: unknown };
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (
    typeof raw['opId'] !== 'string' ||
    typeof raw['verificadoEm'] !== 'string' ||
    !isNum(raw['conquistado']) ||
    !isNum(raw['defendido']) ||
    !isNum(raw['desperdiçado']) ||
    !isNum(raw['semDados']) ||
    !isNum(raw['conquestRate']) ||
    !isNum(raw['wastedNobles']) ||
    !isNum(raw['noblesSemAlvo'])
  ) {
    return null;
  }
  return {
    opId: raw['opId'],
    verificadoEm: raw['verificadoEm'],
    conquistado: raw['conquistado'],
    defendido: raw['defendido'],
    desperdiçado: raw['desperdiçado'],
    semDados: raw['semDados'],
    conquestRate: raw['conquestRate'],
    wastedNobles: raw['wastedNobles'],
    noblesSemAlvo: raw['noblesSemAlvo'],
  };
}

/** Data legível e à prova de ISO malformado (nunca "Invalid Date" na tela). */
function formatQuando(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('pt-BR');
}

/** Dicionários playerId/allyId → nome/tag para a coluna "Dono atual". */
interface OwnerDictionaries {
  players: Map<number, WorldPlayer>;
  tribes: Map<number, WorldAlly>;
}

function describeOwner(outcome: PostOpLiveOutcome, owners: OwnerDictionaries | null): string {
  if (outcome.ownerPlayerId === null) return '—';
  if (outcome.ownerPlayerId === 0) return 'Bárbaros';
  const player = owners?.players.get(outcome.ownerPlayerId);
  const name = player?.name ?? `jogador ${outcome.ownerPlayerId}`;
  const ally =
    outcome.ownerAllyId !== null && outcome.ownerAllyId !== 0
      ? owners?.tribes.get(outcome.ownerAllyId)
      : undefined;
  return ally !== undefined ? `${name} [${ally.tag}]` : name;
}

/**
 * Verificação Pós-OP (Sala de Guerra). O app não guarda o dump PRÉ-OP, então o
 * motor canônico `verifyPostOp` (post-op.ts) não tem input honesto disponível;
 * este painel usa a variante `verifyPostOpLive` (post-op-live.ts), que
 * classifica cada alvo da distribuição pelo DONO ATUAL no dump do mundo:
 * tribo própria = conquistado; inimiga declarada = defendido; terceiro/bárbara
 * = desperdiçado; fora do dump = sem dados. Antes de classificar, garante um
 * dump pós-OP mínimo (cache vazio ou anterior à OP → world.refresh) e exige a
 * diplomacia do momento (sem ela é impossível separar defendido de terceiro).
 * O resultado é anexado às preferências 'guerra' (chave rolante postopUltimo) —
 * OpArchiveEntry/OpSaveInput não têm campo para isso e ipc-types é intocável.
 */
export default function PostOpSection({ op, onArchived }: PostOpSectionProps): JSX.Element {
  const { push } = useToast();
  const [busy, setBusy] = useState<'verify' | 'attach' | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PostOpLiveResult | null>(null);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [attachedAt, setAttachedAt] = useState<string | null>(null);
  const [owners, setOwners] = useState<OwnerDictionaries | null>(null);
  /** v0.33: busca por alvo na tabela de verificação (fold). */
  const [outcomeQuery, setOutcomeQuery] = useState('');
  const visibleOutcomes = useMemo(
    () => (result === null ? [] : filterOutcomes(result.outcomes, { query: outcomeQuery })),
    [result, outcomeQuery],
  );

  // Troca de OP nunca mistura resultado antigo; o resumo anexado (se houver)
  // volta como referência. Falha da leitura é fail-soft: segue sem banner.
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setVerifiedAt(null);
    setError('');
    window.staffhub.preferences
      .get('guerra')
      .then((prefs) => {
        if (cancelled) return;
        const parsed = parseSummary(prefs[POSTOP_KEY]);
        // Chave rolante: só vale para a OP que a gravou.
        setAttachedAt(parsed?.opId === op.id ? parsed.verificadoEm : null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [op.id]);

  async function runVerify(): Promise<void> {
    setBusy('verify');
    setError('');
    try {
      // Distribuição é a fonte dos alvos; linha malformada interrompe com erro claro.
      const entries = parseDistribution(op.distribution);

      // 1) Garantir dump pós-OP: baixa só se o cache está vazio ou ANTERIOR à OP
      //    (data malformada na OP → compara contra +∞, ou seja, sempre atualiza).
      const status = await window.staffhub.world.status();
      const fetchedMs = status.fetchedAt === null ? null : Date.parse(status.fetchedAt);
      const opMs = Date.parse(op.createdAt);
      const freshLimit = Number.isNaN(opMs) ? Number.POSITIVE_INFINITY : opMs;
      const dumpStale =
        status.villageCount === 0 || fetchedMs === null || Number.isNaN(fetchedMs) || fetchedMs < freshLimit;
      if (dumpStale) {
        push('info', 'Baixando dump pós-operação…');
        await window.staffhub.world.refresh();
      }

      // 2) Diplomacia do momento: sem ownAllyId/inimigas declaradas a
      //    classificação não consegue separar defendido de terceiro — aborta.
      const relations: DiplomacyRelations = await loadRelationsShared();

      // 3) Mundo pós-OP + dicionários de exibição (nome/tag do dono atual).
      const [villages, players, tribes] = await Promise.all([
        window.staffhub.world.villages(),
        window.staffhub.world.players(),
        window.staffhub.world.tribes(),
      ]);

      // 4) Alvos da distribuição: senders por coord + nobres atribuíveis
      //    (só de designado com alvo único — o resto vira noblesSemAlvo).
      const nobles = attributeNoblesPerTarget(entries, op.totals ?? []);
      const sendersByCoord = new Map<string, string[]>();
      for (const entry of entries) {
        for (const coord of entry.coords) {
          const list = sendersByCoord.get(coord) ?? [];
          if (!list.includes(entry.playerName)) list.push(entry.playerName);
          sendersByCoord.set(coord, list);
        }
      }
      const targets: PostOpLiveTarget[] = [...sendersByCoord.entries()].map(([coord, senders]) => ({
        coord,
        senders,
        nobleCount: nobles.byCoord.get(coord) ?? null,
      }));

      const live = verifyPostOpLive({
        targets,
        villages: villages.map((village) => ({
          coord: formatCoord({ x: village.x, y: village.y }),
          playerId: village.playerId,
          allyId: village.allyId,
        })),
        ownAllyId: relations.ownAllyId,
        enemyAllyIds: new Set(relations.enemies.map((enemy) => enemy.allyId)),
        // Nobres de designados com 2+ alvos: contam no total, não desaparecem.
        unattributedNobles: nobles.unattributed,
      });

      setOwners({
        players: new Map(players.map((player) => [player.id, player])),
        tribes: new Map(tribes.map((tribe) => [tribe.id, tribe])),
      });
      const when = new Date().toISOString();
      setResult(live);
      setVerifiedAt(when);
      push(
        'ok',
        `Pós-OP verificado: ${live.totals.conquistado} conquistado(s), ${live.totals.desperdiçado} desperdiçado(s), ${live.totals.defendido} defendido(s), ${live.totals['sem-dados']} sem dados.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(null);
    }
  }

  async function runAttach(): Promise<void> {
    if (result === null) return;
    setBusy('attach');
    setError('');
    try {
      const when = verifiedAt ?? new Date().toISOString();
      await window.staffhub.preferences.save('guerra', { [POSTOP_KEY]: { opId: op.id, ...toSummary(result, when) } });
      setAttachedAt(when);
      push('ok', `Resultado da verificação anexado à OP "${op.title}".`);
      onArchived();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-labelledby="postop-title">
      <div className="card-header">
        <h2 className="card-title" id="postop-title">Verificação Pós-OP</h2>
        <span className="spacer" />
        {result !== null && verifiedAt !== null && (
          <span className="pill pill--muted">verificado às {formatQuando(verifiedAt)}</span>
        )}
      </div>
      <div className="card-body col" style={{ gap: 16 }}>
        <p className="muted">
          Compara os alvos da distribuição com o estado ATUAL do mundo — o app não guarda o dump
          pré-OP, então cada alvo é classificado pelo dono de hoje: tribo própria ={' '}
          <strong>conquistado</strong>; inimiga declarada = <strong>defendido</strong>; terceiro ou
          bárbara = <strong>desperdiçado</strong>; fora do dump = <strong>sem dados</strong>.
        </p>

        {error !== '' && (
          <div className="callout callout--danger" role="alert">
            <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
            <div className="callout-body">
              <p className="callout-title">Falha na verificação pós-OP</p>
              <p>{error}</p>
            </div>
          </div>
        )}

        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            className="btn"
            style={{ minWidth: 200 }}
            onClick={() => void runVerify()}
            disabled={busy !== null}
          >
            {busy === 'verify' ? (
              <>
                <span className="btn-spinner" aria-hidden="true" /> Verificando…
              </>
            ) : (
              <>
                <RefreshCw size={16} aria-hidden="true" /> Verificar Pós-OP
              </>
            )}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void runAttach()}
            disabled={busy !== null || result === null}
          >
            {busy === 'attach' ? (
              <>
                <span className="btn-spinner" aria-hidden="true" /> Anexando…
              </>
            ) : (
              <>
                <ClipboardCheck size={16} aria-hidden="true" /> Anexar resultado à OP
              </>
            )}
          </button>
          {attachedAt !== null && (
            <span className="muted">Resultado anexado em {formatQuando(attachedAt)}.</span>
          )}
        </div>

        {result !== null && (
          <>
            <div className="stat-row">
              <StatBlock
                label="Conquistadas"
                tone="ok"
                value={result.totals.conquistado}
                delta="alvos nas mãos da tribo"
              />
              <StatBlock
                label="Desperdiçadas"
                tone="danger"
                value={result.totals.desperdiçado}
                delta="tomadas por terceiros"
              />
              <StatBlock
                label="Defendidas"
                tone="info"
                value={result.totals.defendido}
                delta="seguem com inimiga declarada"
              />
              <StatBlock
                label="Sem dados"
                value={result.totals['sem-dados']}
                delta="fora do dump pós-OP"
              />
              <StatBlock
                label="Taxa de conquista"
                tone="gold"
                value={`${result.totals.conquestRate}%`}
                delta="conquistadas / alvos com dados"
              />
              <StatBlock
                label="Nobres desperdiçados"
                tone="danger"
                value={result.totals.wastedNobles}
                delta={
                  result.totals.noblesSemAlvo > 0
                    ? `+${result.totals.noblesSemAlvo} sem alvo único`
                    : 'atribuição por alvo único'
                }
              />
            </div>

            {/* v0.33: busca por alvo (fold — ignora acento/caixa). */}
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <input
                className="input"
                style={{ maxWidth: 260 }}
                placeholder="Buscar alvo (ignora acento)…"
                aria-label="Buscar alvo na verificação pós-OP"
                value={outcomeQuery}
                onChange={(event) => setOutcomeQuery(event.target.value)}
              />
              {outcomeQuery !== '' && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOutcomeQuery('')}>
                  Limpar
                </button>
              )}
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Coord</th>
                    <th scope="col">Classificação</th>
                    <th scope="col">Dono atual</th>
                    <th scope="col">Designados</th>
                    <th scope="col" className="cell-num">Nobres</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOutcomes.map((outcome) => (
                    <tr key={outcome.coord}>
                      <td className="cell-nowrap">{outcome.coord}</td>
                      <td className="cell-nowrap">
                        <span className={`postop-pill postop--${outcome.status}`} title={outcome.detail}>
                          {STATUS_LABEL[outcome.status]}
                        </span>
                      </td>
                      <td>{describeOwner(outcome, owners)}</td>
                      <td>
                        {outcome.senders.length > 0 ? (
                          outcome.senders.join(', ')
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="cell-num">
                        {outcome.nobleCount === null ? (
                          <span className="muted" title="Nobres não atribuíveis a um alvo único">?</span>
                        ) : (
                          outcome.nobleCount
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
