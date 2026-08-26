import { useEffect, useState } from 'react';
import { ClipboardCopy, Radar, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import type { BlindVillageResult } from '@shared/ipc-types';
import type { SupportersResult } from '@shared/types';
import { parseCoordList } from '@shared/coords';
import { rankVillagesByThreat, threatSummary, type VillageThreat, type VillageThreatInput } from '@shared/incoming-risk';
import { TW_UNIT_ICONS } from '../../assets';
import { UNITS, defensivePopulation, type UnitCounts, type UnitId } from '@shared/units';
import { useToast } from '../../hooks/useToast';
import ToastViewport from '../../components/Toast';
import EmptyState from '../../components/EmptyState';
import ProgressBar from '../../components/ProgressBar';

type CountMode = 'paradas' | 'paradas-e-transito';

const BLIND_UNITS: readonly UnitId[] = ['spear', 'sword', 'archer', 'heavy'];

export default function Sg3Page() {
  const { toasts, push, dismiss } = useToast();

  useEffect(() => {
    const unsubscribe = window.staffhub.events.onQueueProgress(setProgress);
    return unsubscribe;
  }, []);
  const [defenseAt, setDefenseAt] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [coordsText, setCoordsText] = useState('');
  const [desired, setDesired] = useState<Partial<Record<UnitId, string>>>({});
  const [countMode, setCountMode] = useState<CountMode>('paradas');
  const [results, setResults] = useState<BlindVillageResult[] | null>(null);
  const [bbcode, setBbcode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [supportersBusy, setSupportersBusy] = useState(false);
  const [supportersResult, setSupportersResult] = useState<SupportersResult | null>(null);
  const [supportersError, setSupportersError] = useState('');
  // ---- P0-5 — Ataques recebidos (triagem "esta aldeia vai cair") ----
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState('');
  const [threats, setThreats] = useState<VillageThreat[] | null>(null);
const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);

  useEffect(() => {
    void window.staffhub.troops
      .status()
      .then((status) => setDefenseAt(status.defenseAt))
      .catch(() => undefined);
  }, []);

  async function collectDefense(): Promise<void> {
    setCollecting(true);
    setError('');
    try {
      await window.staffhub.troops.collectMembers('defense');
      const status = await window.staffhub.troops.status();
      setDefenseAt(status.defenseAt);
      push('ok', 'Defesa coletada por aldeia — dados em memória.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setCollecting(false);
    }
  }

  async function runBlind(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const desiredUnits: Partial<UnitCounts> = {};
      for (const unit of BLIND_UNITS) {
        const raw = desired[unit];
        if (raw !== undefined && raw.trim() !== '') {
          const value = Number(raw.replace(/\./g, ''));
          if (Number.isFinite(value) && value > 0) desiredUnits[unit] = value;
        }
      }
      if (Object.keys(desiredUnits).length === 0) {
        throw new Error('Informe ao menos uma unidade desejada (ex.: lanceiros/espadachins).');
      }
      const response = await window.staffhub.sg3.checkBlind({
        desiredUnits,
        countMode,
        coordsFilter: parseCoordList(coordsText),
      });
      setResults(response.results);
      setBbcode(response.bbcode);
      push('ok', `${response.results.length} aldeia(s) com falta.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(false);
    }
  }

  /** P0-5: varre as aldeias próprias (info_village) e cruza com a defesa do SG_3. */
  async function runScanIncoming(): Promise<void> {
    setScanBusy(true);
    setScanError('');
    setThreats(null);
    try {
      const [scan, defense] = await Promise.all([
        window.staffhub.sg5.scanOwnVillages(),
        window.staffhub.troops.get('defense').catch(() => null),
      ]);
      // Peso DEFENSIVO presente por coordenada (mesma métrica do blind:
      // spear/sword/archer + heavy×4 — população bruta esconderia stacks
      // ofensivos atrás de um veredito "resistente" otimista).
      const popByCoord = new Map<string, number>();
      if (defense !== null) {
        for (const entry of defense.entries) {
          if (entry.coord.x < 0) continue; // linha de resumo (sem aldeia específica)
          const key = `${entry.coord.x}|${entry.coord.y}`;
          popByCoord.set(key, (popByCoord.get(key) ?? 0) + defensivePopulation(entry.units));
        }
      }
      const inputs: VillageThreatInput[] = scan.villages.map((village) => {
        const defensePop = popByCoord.get(village.coord);
        return { coord: village.coord, commands: village.commands, ...(defensePop !== undefined ? { defensePop } : {}) };
      });
      const ranked = rankVillagesByThreat(inputs);
      setThreats(ranked);
      push('ok', threatSummary(ranked));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setScanError(message);
      push('error', message);
    } finally {
      setScanBusy(false);
    }
  }

  async function runSupporters(): Promise<void> {
    setSupportersBusy(true);
    setSupportersError('');
    try {
      const coords = parseCoordList(coordsText).map((c) => `${c.x}|${c.y}`);
      if (coords.length === 0) throw new Error('Cole as coordenadas no campo do front acima (ou a lista que quiser consultar).');
      const result = await window.staffhub.sg3.supporters(coords);
      setSupportersResult(result);
      push('ok', `Apoiadores: ${result.villages.length} aldeia(s) consultadas.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSupportersError(message);
      push('error', message);
    } finally {
      setSupportersBusy(false);
    }
  }

  const formatted = defenseAt === null ? '—' : new Date(defenseAt).toLocaleString('pt-BR');

  return (
    <div className="col" style={{ gap: 16 }}>
      <header className="page-header">
        <div>
          <p className="kicker">Análise de Defesa das Aldeias</p>
          <h1>Defesa & Blind</h1>
        </div>
      </header>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Dados em Memória</h2>
          <span className="spacer" />
          <span className="muted">Data da Última Atualização: {formatted}</span>
          {(collecting || supportersBusy) && progress !== null && (
            <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
          )}
          <button type="button" className="btn" onClick={() => void collectDefense()} disabled={collecting}>
            {collecting ? <><span className="btn-spinner" aria-hidden="true" /> Coletando…</> : 'Coletar Informações de Defesa'}
          </button>
        </div>
        <p className="muted">
          A coleta passa por todos os membros com pacing humano (1 requisição por membro). Tropas NA aldeia
          e a caminho são guardadas. O botão <strong>Exibir Apoiadores</strong> abaixo consulta aldeia por
          aldeia (1 requisição cada, com pacing).
        </p>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Verificação de Blind</h2>
        </div>
        <div className="sg2-units-grid">
          {BLIND_UNITS.map((unit) => (
            <label key={unit} className="field">
              <span className="field-label sg2-unit-label">
                <img src={TW_UNIT_ICONS[unit]} width={18} height={18} alt="" aria-hidden="true" />
                {UNITS[unit].name}
              </span>
              <input
                className="input"
                type="text"
                inputMode="numeric"
                placeholder="quantidade desejada"
                value={desired[unit] ?? ''}
                onChange={(event) => setDesired((prev) => ({ ...prev, [unit]: event.target.value }))}
              />
            </label>
          ))}
        </div>
        <fieldset className="field">
          <legend className="field-label">Contagem</legend>
          <label className="checkbox-field">
            <input type="radio" name="sg3-count" checked={countMode === 'paradas'} onChange={() => setCountMode('paradas')} />
            Paradas (só tropas na aldeia)
          </label>
          <label className="checkbox-field">
            <input type="radio" name="sg3-count" checked={countMode === 'paradas-e-transito'} onChange={() => setCountMode('paradas-e-transito')} />
            Paradas + a caminho (desconta apoio chegando)
          </label>
        </fieldset>
        <label className="field">
          <span className="field-label">Coordenadas do front (cole da análise SG_1 — vazio = todas)</span>
          <textarea
            className="textarea"
            rows={3}
            placeholder="123|456 456|123 111|222 ..."
            value={coordsText}
            onChange={(event) => setCoordsText(event.target.value)}
          />
        </label>
        {error !== '' && <p className="error" role="alert">{error}</p>}
        <button type="button" className="btn" onClick={() => void runBlind()} disabled={busy}>
          <ShieldAlert size={16} aria-hidden="true" />
          {busy ? <><span className="btn-spinner" aria-hidden="true" /> Consultando…</> : 'Realizar Consulta de Blind'}
        </button>
      </section>

      {results !== null && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Aldeias com falta ({results.length})</h2>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={bbcode === ''}
              onClick={() => {
                void navigator.clipboard.writeText(bbcode).then(() => push('ok', 'Tabela BBCode copiada — cole no tópico de blindagem.')).catch(() => push('error', 'Não consegui copiar — selecione o texto e use Ctrl+C.'));
              }}
            >
              <ClipboardCopy size={14} aria-hidden="true" />
              Copiar tabela BBCode
            </button>
          </div>
          {results.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="Blind completo" hint="Nenhuma aldeia do filtro ficou devendo tropas." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Jogador</th>
                    <th>Aldeia</th>
                    <th>Falta</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <tr key={`${result.playerId}-${result.coord.x}-${result.coord.y}`}>
                      <td className="cell-nowrap">{result.playerName}</td>
                      <td className="cell-nowrap">
                        
                        {result.villageName} ({result.coord.x}|{result.coord.y})
                      </td>
                      <td className="cell-detail">
                        {Object.entries(result.missing)
                          .map(([unit, amount]) => `${UNITS[unit as UnitId]?.name ?? unit}: ${amount?.toLocaleString('pt-BR')}`)
                          .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Exibir Apoiadores</h2>
        </div>
        <p className="muted">
          Usa as coordenadas do campo de front acima. <strong>1 requisição por aldeia</strong> — para listas grandes
          confira o teto em Configurações. Mostra quem tem suportes compartilhados chegando, totais por apoiador
          e marca auto-apoio (dono da aldeia).
        </p>
        {supportersError !== '' && <p className="error" role="alert">{supportersError}</p>}
        <button type="button" className="btn" onClick={() => void runSupporters()} disabled={supportersBusy}>
          <Users size={16} aria-hidden="true" />
          {supportersBusy ? <><span className="btn-spinner" aria-hidden="true" /> Consultando…</> : 'Exibir Apoiadores'}
        </button>
        {supportersResult !== null && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Aldeia</th>
                  <th>Apoiadores</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {supportersResult.villages.map((village) => (
                  <tr key={village.coord}>
                    <td className="cell-nowrap">
                      {village.villageName} ({village.coord}){village.ownerName !== null ? <span className="muted"> · {village.ownerName}</span> : null}
                    </td>
                    <td className="cell-detail">
                      {village.supporters.length === 0
                        ? <span className="muted">Nenhum suporte compartilhado visível.</span>
                        : village.supporters.map((sup) => (
                            <span key={sup.playerName} className={sup.selfSupport ? 'ok' : ''} title={sup.selfSupport ? 'Auto-apoio (dono da aldeia)' : undefined}>
                              {sup.playerName} ({sup.count}){sup.selfSupport ? ' ★' : ''}
                            </span>
                          )).reduce<React.ReactNode[]>((acc, item, index) => (index === 0 ? [item] : [...acc, ' · ', item]), [])}
                    </td>
                    <td className="cell-nowrap">{village.totalSupports}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Ataques Recebidos (aldeias próprias)</h2>
        </div>
        <p className="muted">
          Varre as aldeias do jogador logado (1 requisição por aldeia, com pacing) e cruza com a última coleta de
          defesa: <strong>esta aldeia vai cair</strong> quando chega nobre/ataque grande e a defesa presente está
          abaixo do patamar. Sem coleta de defesa, a aldeia fica "sem dados" (nunca chutado).
        </p>
        <div className="row">
          <button type="button" className="btn" disabled={scanBusy} onClick={() => void runScanIncoming()}>
            <Radar size={16} aria-hidden="true" />
            {scanBusy ? <><span className="btn-spinner" aria-hidden="true" /> Varrendo…</> : 'Varrer ataques recebidos'}
          </button>
          {scanBusy && progress !== null && (
            <>
              <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  void window.staffhub.queue
                    .cancel()
                    .then(() => push('info', 'Cancelamento pedido — a varredura para na próxima requisição.'))
                    .catch(() => push('error', 'Não foi possível pedir o cancelamento.'));
                }}
              >
                Cancelar
              </button>
            </>
          )}
        </div>
        {scanError !== '' && <p className="error" role="alert">{scanError}</p>}
        {threats !== null && (
          <>
            <p className={threats.some((threat) => threat.level === 'vai-cair') ? 'error' : 'ok'}>{threatSummary(threats)}</p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Aldeia</th>
                    <th>Triagem</th>
                    <th className="cell-num">Ataques</th>
                    <th className="cell-num">Com nobre</th>
                    <th>Detalhe</th>
                  </tr>
                </thead>
                <tbody>
                  {threats.map((threat) => (
                    <tr key={threat.coord}>
                      <td className="cell-nowrap">{threat.coord}</td>
                      <td className="cell-nowrap">
                        {threat.level === 'vai-cair' && <span className="error">VAI CAIR</span>}
                        {threat.level === 'pressionada' && <span className="text-warn">Pressionada</span>}
                        {threat.level === 'resistente' && <span className="ok">Resistente</span>}
                        {threat.level === 'sem-dados' && <span className="muted">Sem dados</span>}
                      </td>
                      <td className="cell-num">{threat.attackCount}</td>
                      <td className="cell-num">{threat.nobleCount > 0 ? <strong>{threat.nobleCount}</strong> : 0}</td>
                      <td className="cell-detail">{threat.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
