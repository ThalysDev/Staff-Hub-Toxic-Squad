/**
 * Leitor dos GRUPOS DE ALDEIAS do jogo (engine PURA).
 *
 * Recebe o HTML como STRING e devolve dados normalizados — sem DOM e sem
 * rede: o `DOMParser` só existe no navegador e as engines do ext precisam
 * rodar em node (testes). Aqui a regex tolerante é a única dependência, mesma
 * escolha do resto do ext; quem busca a página é a camada de módulo
 * (`modules/tsh/tsh-groups.ts`).
 *
 * Fontes que o jogo oferece:
 * - `overview_villages`: dropdown de grupos (`<option value="182608">Nome</option>`);
 * - `place&mode=call`: links de grupo (`<a href="…&group=182622">[Nome]</a>`);
 * - `screen=groups` (edição): cada bloco de grupo lista suas aldeias
 *   (`<a href="…screen=info_village&id=NNN">Nome (x|y) K55</a>`);
 * - `overview_villages&group=<id>`: tabela das aldeias filtradas.
 *
 * Regra de leitura: dado ausente/ilegível é DESCARTADO (fail-closed) — nada de
 * preencher com chute. Um id que não seja numérico positivo nunca entra.
 */

export interface GameGroupOption {
  readonly groupId: number;
  readonly name: string;
}

export interface GroupedVillage {
  readonly groupId: number;
  readonly villageId: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

export interface VillageRow {
  readonly villageId: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

// ---------------------------------------------------------------------------
// Leitura de HTML bruto
// ---------------------------------------------------------------------------

const HREF_ATTR_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const VALUE_ATTR_RE = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

const OPTION_RE = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

/** Coordenada do jogo no formato `(533|550)` (tolera espaço/quebra entre os números). */
const COORD_RE = /\(\s*(\d{1,3})\s*\|\s*(\d{1,3})\s*\)/;

const GROUP_PARAM_RE = /[?&]group=(\d+)/;
const INFO_VILLAGE_RE = /screen=info_village/;
const VILLAGE_ID_RE = /\bid=(\d+)/;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Comentário HTML pode esconder markup fantasma (o parser é regex) — fora antes de ler. */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function decodeEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Valor de um atributo (`value`/`href`); null quando ausente. */
function readAttr(attrs: string, pattern: RegExp): string | null {
  const match = pattern.exec(attrs);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** Texto visível de um fragmento: tags viram espaço, entidades decodificadas, espaços colapsados. */
function cleanText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Coordenada dentro de um texto limpo, com a posição (para separar o nome). */
function coordinateIn(text: string): { x: number; y: number; at: number } | null {
  const match = COORD_RE.exec(text);
  if (match === null) return null;
  const x = Number.parseInt(match[1] ?? '', 10);
  const y = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { x, y, at: match.index };
}

// ---------------------------------------------------------------------------
// Opções de grupo (dropdown / links)
// ---------------------------------------------------------------------------

/**
 * O jogo decora o nome com colchetes no link do place (`[🌾 Farm 🌾]`) — sem
 * tirá-los, o mesmo grupo apareceria duas vezes (link e dropdown) na dedupe.
 * Um par de colchetes É o nome real (`[[Farm]]` → `[Farm]`) permanece.
 */
function groupNameFromLinkText(fragment: string): string {
  const text = cleanText(fragment);
  const bracketed = /^\[([^[\]]*)\]$/.exec(text);
  return (bracketed?.[1] ?? text).trim();
}

/**
 * Grupos {id, nome} de QUALQUER página com o dropdown/links de grupos. Dedupe
 * por `id|nome` (o mesmo grupo lido em duas telas entra uma vez; id repetido
 * com nome diferente é preservado — telas diferentes rotulam diferente).
 * Filtros internos do jogo (`value=""`/`value="0"`, sem nome) ficam fora.
 */
export function parseGroupOptions(html: string): GameGroupOption[] {
  const source = stripComments(html);
  const options: GameGroupOption[] = [];
  const seen = new Set<string>();
  const push = (groupId: number, name: string): void => {
    if (groupId <= 0 || name === '') return;
    const key = `${groupId}|${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ groupId, name });
  };

  for (const match of source.matchAll(OPTION_RE)) {
    const rawValue = readAttr(match[1] ?? '', VALUE_ATTR_RE)?.trim() ?? '';
    if (!/^\d+$/.test(rawValue)) continue;
    push(Number.parseInt(rawValue, 10), cleanText(match[2] ?? ''));
  }

  for (const match of source.matchAll(ANCHOR_RE)) {
    const href = decodeEntities(readAttr(match[1] ?? '', HREF_ATTR_RE) ?? '');
    const param = GROUP_PARAM_RE.exec(href);
    if (param === null) continue;
    push(Number.parseInt(param[1] ?? '', 10), groupNameFromLinkText(match[2] ?? ''));
  }

  return options;
}

// ---------------------------------------------------------------------------
// Aldeias
// ---------------------------------------------------------------------------

/**
 * Coordenada fora do link (ex. `Nome</a> (533|550)`): olha só o resto da LINHA
 * (até o próximo `</tr>`, com teto) para não capturar a aldeia seguinte.
 */
function coordinateAfterAnchor(html: string, from: number): { x: number; y: number } | null {
  const rowEnd = html.indexOf('</tr>', from);
  const limit = Math.min(rowEnd === -1 ? html.length : rowEnd, from + 200);
  const coordinate = coordinateIn(cleanText(html.slice(from, limit)));
  return coordinate === null ? null : { x: coordinate.x, y: coordinate.y };
}

/**
 * Aldeias de um trecho HTML: âncora `screen=info_village&id=NNN` + `Nome (x|y)`
 * no texto do link (caso normal) ou logo depois dele. Dedupe por `villageId`.
 * Sem coordenada legível a linha é descartada: sem x/y a aldeia não serve para
 * mirar e inventar 0|0 seria dado errado silencioso.
 */
function collectVillageRows(html: string): VillageRow[] {
  const rows: VillageRow[] = [];
  const seen = new Set<number>();

  for (const match of html.matchAll(ANCHOR_RE)) {
    const href = decodeEntities(readAttr(match[1] ?? '', HREF_ATTR_RE) ?? '');
    if (!INFO_VILLAGE_RE.test(href)) continue;
    const idMatch = VILLAGE_ID_RE.exec(href);
    const villageId = Number.parseInt(idMatch?.[1] ?? '', 10);
    if (!Number.isInteger(villageId) || villageId <= 0 || seen.has(villageId)) continue;

    const anchorText = cleanText(match[2] ?? '');
    const inAnchor = coordinateIn(anchorText);
    const coordinate = inAnchor ?? coordinateAfterAnchor(html, (match.index ?? 0) + match[0].length);
    if (coordinate === null) continue;

    seen.add(villageId);
    const name = (inAnchor === null ? anchorText : anchorText.slice(0, inAnchor.at)).trim();
    rows.push({ villageId, name, x: coordinate.x, y: coordinate.y });
  }

  return rows;
}

/** Aldeias de `overview_villages&group=<id>` (tabela filtrada). */
export function parseVillageRows(html: string): VillageRow[] {
  return collectVillageRows(stripComments(html));
}

// ---------------------------------------------------------------------------
// Grupos com suas aldeias (tela de edição de grupos)
// ---------------------------------------------------------------------------

const GROUP_ID_MARKERS: readonly RegExp[] = [
  // `<span class="group_id">(182622)</span>` (qualquer tag com class group_id).
  /<[a-z]+\b[^>]*\bclass\s*=\s*["'][^"']*\bgroup_id\b[^"']*["'][^>]*>\s*\(?\s*(\d{1,9})/gi,
  // Atributo de dados, quando a tela marca o bloco direto no elemento.
  /data-group-id\s*=\s*["']?(\d{1,9})/gi,
];

interface GroupMarker {
  readonly index: number;
  readonly groupId: number;
}

/**
 * Marcadores de BLOCO de grupo, em ordem de aparição. Só entram marcas fortes
 * (class `group_id` / `data-group-id`): links `…&group=N` NÃO servem de
 * marcador — os links de ação do fim de cada bloco usam o mesmo parâmetro e
 * deslocariam a atribuição das aldeias do bloco seguinte.
 */
function groupMarkers(html: string): GroupMarker[] {
  const found = new Map<number, number>();
  for (const pattern of GROUP_ID_MARKERS) {
    for (const match of html.matchAll(pattern)) {
      const groupId = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isInteger(groupId) || groupId <= 0) continue;
      const index = match.index ?? 0;
      if (!found.has(index)) found.set(index, groupId);
    }
  }
  return [...found.entries()]
    .map(([index, groupId]) => ({ index, groupId }))
    .sort((left, right) => left.index - right.index);
}

/**
 * Grupos com suas aldeias, lidos da tela de edição de grupos: cada bloco vai
 * do seu marcador até o marcador seguinte. Sem nenhum marcador a leitura
 * devolve vazio — sem contexto de grupo não há como atribuir aldeia a grupo
 * (fail-closed em vez de chutar).
 */
export function parseGroupedVillages(html: string): GroupedVillage[] {
  const source = stripComments(html);
  const markers = groupMarkers(source);
  const out: GroupedVillage[] = [];
  const seen = new Set<string>();

  for (const [position, marker] of markers.entries()) {
    const block = source.slice(marker.index, markers[position + 1]?.index ?? source.length);
    for (const village of collectVillageRows(block)) {
      const key = `${marker.groupId}|${village.villageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        groupId: marker.groupId,
        villageId: village.villageId,
        name: village.name,
        x: village.x,
        y: village.y,
      });
    }
  }

  return out;
}
