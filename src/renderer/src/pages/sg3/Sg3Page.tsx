import { useEffect, useState } from 'react';
import { ClipboardCopy, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { BlindVillageResult } from '@shared/ipc-types';
import { parseCoordList } from '@shared/coords';
import { TW_UNIT_ICONS } from '../../assets';
import { UNITS, type UnitCounts, type UnitId } from '@shared/units';
import { useToast } from '../../hooks/useToast';
import ToastViewport from '../../components/Toast';

type CountMode = 'paradas' | 'paradas-e-transito';

const BLIND_UNITS: readonly UnitId[] = ['spear', 'sword', 'archer', 'heavy'];

export default function Sg3Page() {
  const { toasts, push, dismiss } = useToast();
  const [defenseAt, setDefenseAt] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [coordsText, setCoordsText] = useState('');
  const [desired, setDesired] = useState<Partial<Record<UnitId, string>>>({});
  const [countMode, setCountMode] = useState<CountMode>('paradas');
  const [results, setResults] = useState<BlindVillageResult[] | null>(null);
  const [bbcode, setBbcode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
          <button type="button" className="btn" onClick={() => void collectDefense()} disabled={collecting}>
            {collecting ? 'Coletando…' : 'Coletar Informações de Defesa'}
          </button>
        </div>
        <p className="muted">
          A coleta passa por todos os membros com pacing humano (1 requisição por membro). Tropas NA aldeia
          e a caminho são guardadas. <strong>Exibir apoiadores</strong> (1 requisição por aldeia) chega em
          breve — precisa de fixture de aldeia com comandos compartilhados.
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
          {busy ? 'Consultando…' : 'Realizar Consulta de Blind'}
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
                void navigator.clipboard.writeText(bbcode).then(() => push('ok', 'Tabela BBCode copiada — cole no tópico de blindagem.'));
              }}
            >
              <ClipboardCopy size={14} aria-hidden="true" />
              Copiar tabela BBCode
            </button>
          </div>
          {results.length === 0 ? (
            <div className="empty">
              <ShieldCheck size={28} aria-hidden="true" />
              <p>Todas as aldeias do filtro estão com o blind completo.</p>
            </div>
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

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
