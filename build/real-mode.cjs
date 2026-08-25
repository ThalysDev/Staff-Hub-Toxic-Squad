const fs = require('fs');
const base = 'C:/Users/Usuário/.zcode/workspace/default/staff-hub-toxic-squad';

// AGENTS.md
let a = fs.readFileSync(`${base}/AGENTS.md`, 'utf8');
a = a.replace(
  "- Leituras: até 3 tentativas em falha transitória. Mutações: 1 tentativa, confirmação dupla\n  na UI, journal obrigatório. `dryRun` padrão ON até validação na tribo.",
  "- Leituras: até 3 tentativas em falha transitória. Mutações: 1 tentativa, confirmação dupla\n  na UI, journal obrigatório. **DRY-RUN DESATIVADO PERMANENTEMENTE pelo dono em\n  25/08/2026** (\"tudo sempre com dados reais\") — mutações executam de verdade;\n  journal e confirmação dupla seguem obrigatórios.",
);
fs.writeFileSync(`${base}/AGENTS.md`, a);

// Sg6Page
let s6 = fs.readFileSync(`${base}/src/renderer/src/pages/sg6/Sg6Page.tsx`, 'utf8');
s6 = s6.replace(
  `Estas ações <strong>alteram o jogo</strong> (mutações). Cada uma exige confirmação dupla, faz
          <strong> uma única tentativa</strong> por item, guarda tudo no Journal e respeita o <strong>DRY-RUN</strong>{' '}
          das Configurações (ligado por padrão — nada é enviado enquanto estiver ativo).`,
  `Estas ações <strong>alteram o jogo de verdade</strong> (modo real permanente). Cada uma exige
          confirmação dupla, faz <strong>uma única tentativa</strong> por item com pacing humano e guarda tudo no
          Journal para auditoria.`,
);
s6 = s6.replace(
  /const okCount = results\.filter\(\(r\) => r\.ok === true\)\.length;\n      const dryCount = results\.filter\(\(r\) => r\.dryRun\)\.length;\n/,
  'const okCount = results.filter((r) => r.ok === true).length;\n',
);
s6 = s6.replace(
  /push\('ok', dryCount > 0 \? `\$\{dryCount\} reserva\(s\) SIMULADA\(S\).*?`\);/s,
  "push('ok', `Reservas: ${okCount} ok, ${results.length - okCount} com aviso (veja o detalhe).`);",
);
s6 = s6.replace(
  /const sent = results\.filter\(\(r\) => r\.ok === true\)\.length;\n      const dry = results\.filter\(\(r\) => r\.dryRun\)\.length;\n/,
  'const sent = results.filter((r) => r.ok === true).length;\n',
);
s6 = s6.replace(
  /push\('ok', dry > 0 \? `\$\{dry\} MP\(s\) SIMULADA\(S\).*?`\);/s,
  "push('ok', `MPs: ${sent} enviadas, ${results.length - sent} com problema.`);",
);
s6 = s6.replace(
  /<td>\{result\.dryRun \? <span className="muted">Simulado<\/span> : result\.ok \? <span className="ok">Enviado<\/span> : <span className="error">Falhou<\/span>\}<\/td>/,
  '<td>{result.ok ? <span className="ok">Enviado</span> : <span className="error">Falhou</span>}</td>',
);
s6 = s6.replace(
  /<td>\{result\.dryRun \? <span className="muted">Simulado<\/span> : result\.ok \? <span className="ok">Enviada<\/span> : <span className="error">Falhou<\/span>\}<\/td>/,
  '<td>{result.ok ? <span className="ok">Enviada</span> : <span className="error">Falhou</span>}</td>',
);
s6 = s6.replace(
  `Confirmar reserva em massa de <strong>{reservePending.length}</strong> aldeia(s)? Cada uma faz 1
              tentativa; “já reservada” é tolerada.`,
  `Confirmar reserva em massa de <strong>{reservePending.length}</strong> aldeia(s)? Ação REAL no
              jogo — cada uma faz 1 tentativa; “já reservada” é tolerada.`,
);
fs.writeFileSync(`${base}/src/renderer/src/pages/sg6/Sg6Page.tsx`, s6);

// Sg7Page
let s7 = fs.readFileSync(`${base}/src/renderer/src/pages/sg7/Sg7Page.tsx`, 'utf8');
s7 = s7.replace(
  `O ajuste do post é <strong>mutação</strong> (confirmação dupla +
          journal + DRY-RUN).`,
  `Ajuste e exclusão são <strong>mutações reais</strong> (confirmação
          dupla + journal + verificação pós-envio).`,
);
s7 = s7.replace(
  /push\(result\.dryRun \? 'info' : result\.ok \? 'ok' : 'error', result\.detail\);/,
  "push(result.ok === false ? 'error' : 'ok', result.detail);",
);
s7 = s7.replace("Uma única tentativa; tudo vai para o Journal.", "Ação REAL — uma única tentativa; tudo vai para o Journal.");
fs.writeFileSync(`${base}/src/renderer/src/pages/sg7/Sg7Page.tsx`, s7);

// Settings: remover o checkbox dry-run
let st = fs.readFileSync(`${base}/src/renderer/src/pages/SettingsPage.tsx`, 'utf8');
st = st.replace(/<label className="checkbox-field">[\s\S]*?DRY-RUN[\s\S]*?<\/label>/, '<p className="muted">Mutações rodam sempre em modo real (decisão do dono, 25/08) — confirmação dupla e journal seguem ativos.</p>');
fs.writeFileSync(`${base}/src/renderer/src/pages/SettingsPage.tsx`, st);

console.log('copy ok');
console.log('sg6 dryRun refs:', (s6.match(/dryRun|DRY-RUN/g) || []).length);
console.log('sg7 dryRun refs:', (s7.match(/dryRun|DRY-RUN/g) || []).length);
