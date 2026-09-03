// Gera fixtures REAIS (recortes fiéis) a partir da captura canário do dono
// (RODRIGUES, 1156 aldeias, 2 páginas). Mantém pager + cabeçalho + N aldeias
// reais, fechando o HTML como no jogo — os parsers rodam neles como na vida.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, 'canary-out');
const DST = join(import.meta.dirname, '..', 'fixtures', 'br142');
mkdirSync(DST, { recursive: true });

function tablesVis(html) {
  const out = [];
  let idx = 0;
  for (;;) {
    const at = html.indexOf('<table class="vis w100"', idx);
    if (at === -1) break;
    const end = html.indexOf('</table>', at);
    out.push({ start: at, end: end + 8, html: html.slice(at, end + 8) });
    idx = end + 8;
  }
  return out;
}

function trimRows(tableHtml, keep) {
  // mantém o thead/cabeçalho e as primeiras `keep` <tr> de aldeia (com info_village)
  const rows = [...tableHtml.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((m) => m[0]);
  const headerIdx = rows.findIndex((r) => r.includes('<th'));
  const head = headerIdx >= 0 ? rows[headerIdx] : '';
  const villageRows = rows.filter((r) => r.includes('info_village')).slice(0, keep);
  const open = tableHtml.slice(0, tableHtml.indexOf('>') + 1);
  return `${open}${head}${villageRows.join('')}</table>`;
}

function save(name, html) {
  writeFileSync(join(DST, `${name}.html`), html, 'utf-8');
  console.log(`${name}.html: ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB, aldeias: ${(html.match(/info_village/g) || []).length}`);
}

// --- members_troops da própria conta, página 1 (pager ANTES da tabela) ---
const p1 = readFileSync(join(SRC, '02-members-troops-own.html'), 'utf-8');
const t1 = tablesVis(p1);
const pager1 = t1[0]?.html ?? '';
const data1 = t1.find((t) => t.html.includes('<th') && t.html.includes('info_village'));
if (!data1) throw new Error('tabela de dados da p1 não encontrada');
// preâmbulo mínimo com o dropdown (o parser de dropdown não roda aqui, mas mantém contexto real)
const selAt = p1.indexOf('<select');
const selEnd = p1.indexOf('</select>', selAt);
const preamble = `<!DOCTYPE html><html><body>${p1.slice(selAt, selEnd + 9)}`;
save('troops-own-paged-p1-rows', `${preamble}${pager1}${trimRows(data1.html, 5)}`);

// --- página 2 (pager com prev, sem next) ---
const p2 = readFileSync(join(SRC, '03-members-troops-own-page2.html'), 'utf-8');
const t2 = tablesVis(p2);
const pager2 = t2[0]?.html ?? '';
const data2 = t2.find((t) => t.html.includes('<th') && t.html.includes('info_village'));
if (!data2) throw new Error('tabela de dados da p2 não encontrada');
save('troops-own-paged-p2-rows', `${pager2}${trimRows(data2.html, 4)}`);

// --- overview units da própria conta (units_table, também paginada) ---
const u1 = readFileSync(join(SRC, '04-own-units.html'), 'utf-8');
const us = u1.indexOf('<table id="units_table"');
const ue = u1.indexOf('</table>', us);
const unitsTable = u1.slice(us, ue + 8);
// 3 aldeias completas: blocos quickedit-vn até a 4ª ocorrência
const starts = [...unitsTable.matchAll(/<tr[^>]*>(?=[\s\S]*?quickedit-vn)/g)].map((m) => m.index);
const villages = [...unitsTable.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
const headerRowU = villages.find((r) => r.includes('unit_'));
const villageStartIdx = villages.findIndex((r) => r.includes('quickedit-vn'));
const unitSlice = villages.slice(villageStartIdx, villageStartIdx + 15).join(''); // 3 aldeias × 5 sub-linhas
save('own-units-paged-p1-rows', `${unitsTable.slice(0, unitsTable.indexOf('<tr'))}${headerRowU ?? ''}${unitSlice}</table>`);

console.log('fixtures canário geradas em', DST);
