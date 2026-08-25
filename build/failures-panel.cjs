const fs = require('fs');
const base = 'C:/Users/Usuário/.zcode/workspace/default/staff-hub-toxic-squad';
let s = fs.readFileSync(`${base}/src/renderer/src/pages/sg2/Sg2Page.tsx`, 'utf8');

if (!s.includes('setCollectFailures')) {
  s = s.replace(
    "  const [memorySummary, setMemorySummary] = useState<{ players: number; villages: number; collectedAt: string; source: string } | null>(null);",
    "  const [collectFailures, setCollectFailures] = useState<{ playerName: string; reason: string }[] | null>(null);\n  const [memorySummary, setMemorySummary] = useState<{ players: number; villages: number; collectedAt: string; source: string } | null>(null);",
  );
}

if (!s.includes('Membros com erro na última coleta')) {
  const panel = [
    '      {collectFailures !== null && (',
    '        <section className="page-section" aria-label="Membros com erro na coleta">',
    '          <div className="card">',
    '            <div className="card-header"><h2 className="card-title">Membros com erro na última coleta ({collectFailures.length})</h2></div>',
    '            <div className="table-wrap">',
    '              <table className="table">',
    '                <thead><tr><th>Membro</th><th>Motivo</th></tr></thead>',
    '                <tbody>',
    '                  {collectFailures.map((failure) => (',
    '                    <tr key={failure.playerName}><td className="cell-nowrap">{failure.playerName}</td><td className="cell-detail muted">{failure.reason}</td></tr>',
    '                  ))}',
    '                </tbody>',
    '              </table>',
    '            </div>',
    '            <p className="muted">Os demais membros foram coletados normalmente — filtro e classificação usam o que veio.</p>',
    '          </div>',
    '        </section>',
    '      )}',
    '',
    '      {/* ===== Painel Dados em Memória ===== */}',
  ].join('\n');
  s = s.replace('      {/* ===== Painel Dados em Memória ===== */}', panel);
}

fs.writeFileSync(`${base}/src/renderer/src/pages/sg2/Sg2Page.tsx`, s);
console.log('ok');
