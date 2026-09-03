// Sala de Guerra · Mapa da OP (v0.33): alvos (e, quando disponível, as
// trajetórias origem→alvo) plotados sobre o mapa do mundo — reuso do
// WorldMapCanvas do SG_1: círculos verdes nas ORIGENS, branco nos ALVOS e
// setas amarelas nas trajetórias. O dump carrega sob demanda (1ª abertura) e
// fica em cache na sessão.
import { useMemo, useState } from 'react';
import { Loader2, Map as MapIcon } from 'lucide-react';
import type { JSX } from 'react';
import type { WorldVillage } from '@shared/types';
import WorldMapCanvas from '../sg1/WorldMapCanvas';
import { useSessionStatus } from '../../hooks/useSessionStatus';
import { useToast } from '../../hooks/useToast';

export interface OpMapSectionProps {
  /** Alvos da OP no formato "x|y" (destaque branco). */
  targets: ReadonlySet<string>;
  /** Origens no formato "x|y" (círculos verdes) — ausentes no arquivado. */
  origins?: ReadonlySet<string>;
  /** Trajetórias origem→alvo (setas) — só o planner gerado possui. */
  connections?: ReadonlyArray<{ from: string; to: string }>;
  /** Rótulo do que está sendo traçado (ex.: título da OP). */
  label: string;
}

/** Cache do dump de aldeias POR MUNDO (module-level): trocar de mundo na mesma
 *  sessão do app refaz o fetch (P3 da revisão integrada — antes o fundo do
 *  mapa ficava do mundo antigo). A página é keep-mounted, o cache morre com o app. */
let villagesCache: { world: string | null; villages: WorldVillage[] } | null = null;

export default function OpMapSection({ targets, origins, connections, label }: OpMapSectionProps): JSX.Element {
  const { push } = useToast();
  const session = useSessionStatus();
  const cacheValido = villagesCache !== null && villagesCache.world === session.world;
  const [villages, setVillages] = useState<WorldVillage[] | null>(cacheValido ? villagesCache?.villages ?? null : null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');

  /** Marcações vazias CONSTANTES: sem tribo pintada, o foco fica na OP. */
  const emptyMarkings = useMemo(() => new Map<number, never>(), []);
  const emptySet = useMemo(() => new Set<string>(), []);

  async function loadVillages(): Promise<void> {
    if (loading || (villagesCache !== null && villagesCache.world === session.world)) return;
    setLoading(true);
    setError('');
    try {
      villagesCache = { world: session.world, villages: await window.staffhub.world.villages() };
      setVillages(villagesCache.villages);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', `Não foi possível carregar o mapa do mundo: ${message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card" aria-labelledby="op-map-title">
      <div className="card-header">
        <h2 className="card-title" id="op-map-title">
          <MapIcon size={16} aria-hidden="true" style={{ marginRight: 6, verticalAlign: -3 }} />
          Mapa da OP
        </h2>
        <span className="spacer" />
        {connections !== undefined && connections.length > 0 && (
          <span className="pill pill--muted">{connections.length} trajetória(s)</span>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={visible}
          onClick={() => {
            const next = !visible;
            setVisible(next);
            if (next) void loadVillages();
          }}
        >
          {visible ? 'Ocultar mapa' : 'Ver no mapa'}
        </button>
      </div>
      {visible && (
        <div className="card-body col" style={{ gap: 10 }}>
          <p className="muted">
            {label}: <strong>{targets.size} alvo(s)</strong>
            {origins !== undefined && origins.size > 0 ? (
              <>
                {' '}de <strong>{origins.size} origem(ns)</strong>. Círculos verdes = origens (quem
                ataca); branco = alvos; setas = trajetórias.
              </>
            ) : (
              '. Em branco os alvos da OP (origens ficam no mapa da geração, na Sala de Guerra).'
            )}
            {' '}Zoom pela roda do mouse, arraste para navegar.
          </p>
          {error !== '' && <p className="error" role="alert">{error}</p>}
          {villages === null ? (
            <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
              {loading ? (
                <>
                  <Loader2 size={16} className="btn-spinner" aria-hidden="true" />
                  <span className="muted">Carregando o mapa do mundo…</span>
                </>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadVillages()}>
                  Tentar carregar de novo
                </button>
              )}
            </div>
          ) : (
            <div className="table-wrap">
              <WorldMapCanvas
                villages={villages}
                markings={emptyMarkings}
                highlights={targets}
                origins={origins ?? emptySet}
                connections={connections ?? []}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
