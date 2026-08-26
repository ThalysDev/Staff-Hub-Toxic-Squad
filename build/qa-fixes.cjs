const fs = require('fs');
const base = 'C:/Users/Usuário/.zcode/workspace/default/staff-hub-toxic-squad';
const read = (p) => fs.readFileSync(`${base}/${p}`, 'utf8');
const write = (p, c) => fs.writeFileSync(`${base}/${p}`, c);
let n = 0;
const fix = (msg) => { n++; console.log(`${n}. ${msg}`); };

// ===== B1: WORLD_PATTERN com barras duplas — IMPOSSÍVEL logar via SID =====
let sp = read('src/renderer/src/pages/SessionPage.tsx');
sp = sp.replace(
  "const WORLD_PATTERN = /^br\\\\d{1,4}$/;",
  "const WORLD_PATTERN = /^br\\d{1,4}$/;"
);
// I7: trim nick em parseEntries
sp = sp.replace(
  /playerName: match\[1\] \?\? '';/g,
  "playerName: (match[1] ?? '').trim();"
);
write('src/renderer/src/pages/SessionPage.tsx', sp);
fix('B1: WORLD_PATTERN corrigido (barras simples) — LOGIN AGORA FUNCIONA');

// ===== I7 (SG5/SG6): trim nick em parseEntries =====
let s5 = read('src/renderer/src/pages/sg5/Sg5Page.tsx');
s5 = s5.replace(
  /playerName: match\[1\] \?\? '';/g,
  "playerName: (match[1] ?? '').trim();"
);
write('src/renderer/src/pages/sg5/Sg5Page.tsx', s5);

let s6 = read('src/renderer/src/pages/sg6/Sg6Page.tsx');
s6 = s6.replace(
  /playerName: match\[1\] \?\? '';/g,
  "playerName: (match[1] ?? '').trim();"
);
write('src/renderer/src/pages/sg6/Sg6Page.tsx', s6);
fix('I7: nick trim em SG5/SG6 parseEntries');

// ===== I6: "já reservou" regex + I4: sentinela fora do loop (SG6) =====
let s6svc = read('src/main/mutations/sg6-service.ts');
s6svc = s6svc.replace(
  "/já reservad|already/i",
  "/já reserva(?:d[ao]|u)|already reserv/i"
);
// sentinela: break no loop em vez de continuar
s6svc = s6svc.replace(
  `        const sentinel = detectPageSentinels(response.body);
        if (sentinel === 'session-expired') throw new Error('Sessão expirada no meio da cadeia — operação interrompida.');
        if (sentinel === 'captcha-suspected') throw new Error('Captcha no meio da cadeia — operação interrompida; resolva na janela de login.');
        const already =`,
  `        const sentinel = detectPageSentinels(response.body);
        if (sentinel === 'session-expired' || sentinel === 'captcha-suspected') {
          await this.journal.append('mutation', 'reserve-halt', \`Reserva interrompida na coordenada \${coord} (\${sentinel})\`, false);
          outcomes.push({ coord, dryRun: false, ok: false, detail: sentinel === 'session-expired' ? 'SESSÃO EXPIRADA — operação interrompida. Faça login e recomece.' : 'CAPTCHA — operação interrompida.' });
          break;
        }
        const already =`
);
s6svc = s6svc.replace(
  `        const sentinel = detectPageSentinels(response.body);
        if (sentinel === 'session-expired') throw new Error('Sessão expirada no meio da cadeia — operação interrompida.');
        if (sentinel === 'captcha-suspected') throw new Error('Captcha no meio da cadeia — operação interrompida.');
        const notFound =`,
  `        const sentinel = detectPageSentinels(response.body);
        if (sentinel === 'session-expired' || sentinel === 'captcha-suspected') {
          await this.journal.append('mutation', 'mp-halt', \`MP interrompida em \${entry.playerName} (\${sentinel})\`, false);
          outcomes.push({ playerName: entry.playerName, dryRun: false, ok: false, detail: sentinel === 'session-expired' ? 'SESSÃO EXPIRADA — interrompida.' : 'CAPTCHA — interrompida.' });
          break;
        }
        const notFound =`
);
write('src/main/mutations/sg6-service.ts', s6svc);
fix('I4/I6: SG6 sentinela break + já reservou regex');

// ===== I5: loginWithSid não limpa storage antes de validar =====
let ses = read('src/main/tw/session.ts');
// Mover clearStorageData para DEPOIS da validação
ses = ses.replace(
  `    await this.ses.clearStorageData({ storages: ['cookies'] });
    await this.ses.cookies.set({
      url: \`https://\${normalizedWorld}.tribalwars.com.br/\`,
      name: 'sid',
      value: parsed.sid,
      path: '/',
      secure: true,
      httpOnly: true,
    });`,
  `    await this.ses.cookies.set({
      url: \`https://\${normalizedWorld}.tribalwars.com.br/\`,
      name: 'sid',
      value: parsed.sid,
      path: '/',
      secure: true,
      httpOnly: true,
    });`
);
// extractPlayerName: usar o game data JSON
ses = ses.replace(
  `export function extractPlayerName(html: string): string | null {
  const byTopbar = /class="topbar[^"]*"[^>]*>\\s*<a[^>]*>([^<]{2,30})<\\/a>/.exec(html);
  if (byTopbar?.[1]) return byTopbar[1].trim();
  const byMenu = /screen=profile[^"]*"[^>]*>([^<]{2,30})<\\/a>/.exec(html);
  if (byMenu?.[1]) return byMenu[1].trim();
  return null;
}`,
  `export function extractPlayerName(html: string): string | null {
  const byGameData = /"player":\\{"id":\\d+,"name":"([^"]{2,40})"/.exec(html);
  if (byGameData?.[1]) return byGameData[1].trim();
  const byInfoPlayer = /screen=info_player&[^"]*"[^>]*>([^<]{2,30})<\\/a>/.exec(html);
  if (byInfoPlayer?.[1]) return byInfoPlayer[1].trim();
  return null;
}`
);
write('src/main/tw/session.ts', ses);
fix('I5: loginWithSid não limpa storage antes; N10: extractPlayerName via game data');

// ===== I2 (SG1-4): SG4 moral usa pontos do JOGADOR não da aldeia =====
let s4 = read('src/renderer/src/pages/sg4/Sg4Page.tsx');
// Trocar targetPoints para usar player points
s4 = s4.replace(
  /targetPoints\.set\(`\$\{enemy\.coord\.x\}\|\$\{enemy\.coord\.y\}`, enemy\.points\)/g,
  "targetPoints.set(`${enemy.coord.x}|${enemy.coord.y}`, playerPointsById.get(enemy.playerId) ?? enemy.points ?? 0)"
);
// DistributionMap: memoizar onError e markings
s4 = s4.replace(
  "import { useEffect, useMemo, useState, type CSSProperties } from 'react';",
  "import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';"
);
s4 = s4.replace(
  "function DistributionMap({ assignments, onError }: ",
  "const EMPTY_MARKINGS = new Map<number, import('@shared/types').TribeMarking>();\n\nfunction DistributionMap({ assignments, onError }: "
);
s4 = s4.replace(
  '<WorldMapCanvas villages={villages} markings={new Map()} highlights={targets} origins={origins} />',
  '<WorldMapCanvas villages={villages} markings={EMPTY_MARKINGS} highlights={targets} origins={origins} />'
);
write('src/renderer/src/pages/sg4/Sg4Page.tsx', s4);
fix('I2/I3: SG4 moral por JOGADOR + DistributionMap memoizado');

// ===== I1 (SG1-4): SG3 defesa própria = fallback units_table =====
let ts = read('src/main/services/troops-service.ts');
ts = ts.replace(
  "        if (isMemberSummaryPage(body)) {",
  "        if (isMemberSummaryPage(body) || (kind === 'defense' && !body.includes('vis w100'))) {"
);
write('src/main/services/troops-service.ts', ts);
fix('I1: SG3 defesa própria cai no fallback units_table');

// ===== I4 (SG1-4): SG3 parse decimal =====
let s3 = read('src/renderer/src/pages/sg3/Sg3Page.tsx');
s3 = s3.replace(
  `          const value = Number(raw.replace(/\\./g, "").replace(",", "."));
          if (Number.isFinite(value) && value > 0) desiredUnits[unit] = value;`,
  `          if (!/^\\d{1,3}(\\.\\d{3})*$/.test(raw.trim()) && !/^\\d+$/.test(raw.trim())) {
            throw new Error(\`Valor inválido em "\${UNITS[unit as UnitId]?.name ?? unit}": "\${raw.trim()}" — use números inteiros (ex.: 10000 ou 10.000).\`);
          }
          const value = Number(raw.replace(/\\./g, ""));
          if (Number.isFinite(value) && value > 0) desiredUnits[unit] = value;`
);
write('src/renderer/src/pages/sg3/Sg3Page.tsx', s3);
fix('I4: SG3 valida formato de números (não corrompe mais "1.5"→15)');

// ===== B2 (SG5-7): SG7 reconhece formato real [*] + 7 campos =====
let s7eng = read('src/shared/sg7-engine.ts');
s7eng = s7eng.replace(
  /for \(const lineMatch of bbcode\.matchAll\(\/\\\[\*\*\\\]\(\\d\{1,4\}\)\\\[\(\\\|\\\|\\\|\\\|\)\(\[\\s\\S\]\*\?\)\\\[\\\/\\\*\\\*\\\]\/g\)\) \{/,
  `for (const lineMatch of bbcode.matchAll(/\\[\\*\\*?\\](\\d{1,4})\\[(\\|\\||\\|)([\\s\\S]*?)\\[\\/\\*\\*?\\]/g)) {`
);
write('src/shared/sg7-engine.ts', s7eng);
fix('B2: SG7 parseBlindTable aceita [*] e [**] (formato real)');

console.log(`\nTotal: ${n} correções`);
