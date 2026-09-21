// Painel de Guerra ODA/ODD: kills ofensivos (ODA) e defensivos (ODD) por tribo.
//
// Fonte oficial do mundo: /map/kill_att_tribe.txt.gz e /map/kill_def_tribe.txt.gz
// — TSV de 4 colunas `rank\ttribeId\tname\tkills`, com o total CUMULATIVO de
// kills da tribo no mundo. O app arquiva um snapshot { fetchedAt, kills } por
// leitura e o delta entre leituras consecutivas é a curva da guerra (kills
// ganhos/perdidos por dia). A API do jogo permite no máximo 1 download por
// hora por arquivo — essa guarda de pacing vive no serviço (world-data-service);
// aqui ficam só as regras puras: parse fail-closed, diff de snapshots e montagem
// do histórico.
//
// Puro e determinístico: nada de disco/rede; falha estrutural lança PT-BR claro
// (fail-closed, AGENTS.md) em vez de produzir número silenciosamente errado.

/** Linha crua do kill_*_tribe.txt: rank\ttribeId\tname\tkills. */
export interface TribeKillsRow {
  rank: number;
  tribeId: number;
  name: string;
  kills: number;
}

/** Snapshot arquivado de UMA leitura de um dos arquivos de kills. */
export interface TribeKillsSnapshot {
  /** ISO da leitura (momento do download ou do reaproveitamento do cache). */
  fetchedAt: string;
  /** Total cumulativo de kills da tribo no arquivo daquele momento. */
  kills: number;
}

/** Linha do histórico pronto para a UI (delta vs a leitura anterior). */
export interface OdaOddHistoryRow {
  /** ISO da leitura. */
  date: string;
  kills: number;
  /** kills − kills da leitura anterior; null na primeira leitura. */
  delta: number | null;
}

/** Teto do histórico por tipo (att/def): 60 leituras ≈ 2 meses de guerra diária. */
export const MAX_ODA_ODD_HISTORY = 60;

/** Kills precisa ser inteiro ≥ 0 — qualquer outra coisa é dump corrompido. */
function assertKills(kills: number): void {
  if (!Number.isSafeInteger(kills) || kills < 0) {
    throw new Error(`Kills fora do formato esperado (${String(kills)}) — kill_*_tribe.txt corrompido ou incompleto.`);
  }
}

/** Inteiro decimal COM zeros à esquerda permitidos ("007" = 7); o resto falha. */
function parseTribeInt(raw: string, column: string, line: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Coluna "${column}" fora do formato ("${raw}") na linha "${line}" — kill_*_tribe.txt deve ser TSV rank\\ttribeId\\tnome\\tkills.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Coluna "${column}" com número grande demais ("${raw}") na linha "${line}" — dump corrompido.`);
  }
  return value;
}

/**
 * Parse fail-closed do kill_*_tribe.txt: cada linha DEVE ter exatamente 4
 * colunas por tab (rank, tribeId, nome, kills). Linha malformada lança com o
 * conteúdo dela — nunca retorna dado parcial silencioso. tribeId duplicado no
 * MESMO arquivo é dump corrompido e lança. Arquivo sem nenhuma tribo lança
 * (dump incompleto — mesma régua do villages.length === 0 do SG_1). O \\n final
 * do arquivo é o fim dele, não uma linha a mais; qualquer outra linha vazia
 * (truncamento no meio) lança.
 */
export function parseKillsTribeFile(body: string): TribeKillsRow[] {
  const lines = body.split(/\r?\n/);
  // \n(s) final(is) é o fim do arquivo, não conteúdo — qualquer linha vazia
  // DEPOIS disso é truncamento no meio do dump e lança no laço abaixo.
  while (lines[lines.length - 1] === '') lines.pop();

  const rows: TribeKillsRow[] = [];
  const seenTribeIds = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue; // inalcançável (laço sobre o próprio array) — satisfaz noUncheckedIndexedAccess
    if (line.trim() === '') {
      throw new Error(`Linha ${index + 1} vazia no meio do kill_*_tribe.txt — dump truncado ou corrompido.`);
    }
    const columns = line.split('\t');
    if (columns.length !== 4) {
      throw new Error(
        `Linha malformada no kill_*_tribe.txt (linha ${index + 1}): "${line}" — esperadas 4 colunas (rank\\ttribeId\\tnome\\tkills), vieram ${String(columns.length)}.`,
      );
    }
    const rank = parseTribeInt(columns[0] ?? '', 'rank', line);
    const tribeId = parseTribeInt(columns[1] ?? '', 'tribeId', line);
    const name = columns[2] ?? '';
    if (name.trim() === '') {
      throw new Error(`Nome da tribo vazio na linha "${line}" — kill_*_tribe.txt corrompido.`);
    }
    const kills = parseTribeInt(columns[3] ?? '', 'kills', line);
    if (seenTribeIds.has(tribeId)) {
      throw new Error(`Tribo ${String(tribeId)} duplicada no kill_*_tribe.txt (linha ${index + 1}) — cada tribo deve aparecer uma única vez por dump.`);
    }
    seenTribeIds.add(tribeId);
    rows.push({ rank, tribeId, name, kills });
  }
  if (rows.length === 0) {
    throw new Error('kill_*_tribe.txt veio sem nenhuma tribo — dump incompleto; tente atualizar de novo e reporte se persistir.');
  }
  return rows;
}

/**
 * Diff entre o snapshot arquivado e o novo: delta de kills desde a leitura
 * anterior. Sem leitura anterior (first run) devolve null — não existe delta
 * "inventado" contra zero. Fail-closed: kills não inteiro ≥ 0 lança.
 */
export function diffTribeKills(previous: TribeKillsSnapshot | null, nextKills: number): { delta: number } | null {
  assertKills(nextKills);
  if (previous === null) return null;
  assertKills(previous.kills);
  return { delta: nextKills - previous.kills };
}

/**
 * Monta o histórico para a UI a partir dos snapshots arquivados EM ORDEM
 * CRONOLÓGICA (mais recente no FIM — a mesma convenção do cap aqui embaixo).
 * O delta de cada linha é contra a leitura imediatamente anterior; a primeira
 * do histórico sai com delta null. `allyName` (ex.: tag da tribo) só entra nas
 * mensagens de erro fail-closed. Histórico vazio ou snapshot com data/kills
 * inválidos lançam — montar curva a partir de dado corrompido esconderia a
 * guerra errada.
 */
export function buildOdaOddHistory(rows: readonly TribeKillsSnapshot[], allyName: string): OdaOddHistoryRow[] {
  const name = allyName.trim();
  if (name === '') {
    throw new Error('Tribo do painel de OD não identificada — informe o ID da tribo antes de montar a curva.');
  }
  if (rows.length === 0) {
    throw new Error(`Histórico de OD vazio para a tribo ${name} — atualize os ODs antes de montar a curva.`);
  }
  const history: OdaOddHistoryRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue; // inalcançável — satisfaz noUncheckedIndexedAccess
    if (Number.isNaN(Date.parse(row.fetchedAt))) {
      throw new Error(`Snapshot de OD com data inválida ("${row.fetchedAt}") no histórico da tribo ${name} — histórico corrompido.`);
    }
    assertKills(row.kills);
    const previous = index > 0 ? (rows[index - 1] ?? null) : null;
    const delta = diffTribeKills(previous, row.kills)?.delta ?? null;
    history.push({ date: row.fetchedAt, kills: row.kills, delta });
  }
  return history;
}

/**
 * Limita o histórico a MAX_ODA_ODD_HISTORY snapshots por tipo. Convenção:
 * ordem cronológica no array (mais recente no FIM, append) — mantém as últimas
 * MAX_ODA_ODD_HISTORY e descarta as mais antigas. Sempre devolve um NOVO array.
 */
export function capOdaOddHistory(rows: readonly TribeKillsSnapshot[]): TribeKillsSnapshot[] {
  if (rows.length <= MAX_ODA_ODD_HISTORY) return [...rows];
  return rows.slice(rows.length - MAX_ODA_ODD_HISTORY);
}
