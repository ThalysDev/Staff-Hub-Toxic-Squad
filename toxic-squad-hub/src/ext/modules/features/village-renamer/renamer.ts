// Engine PURA do Renomeador de Aldeias (Onda 5, Parte A): monta o nome final a
// partir de um template de tokens, valida o template e planeja a numeração das
// aldeias (por continente K ou geral, na ordem determinística de coordenada).
// Sem DOM, sem rede e sem storage: o plugin aplica o plano pelo POST de
// renomeação; por isso tudo aqui roda em node nos testes.
//
// Tokens (validados por validateRenameTemplate):
//   {numero}  contador (padding configurável; por continente ou geral)
//   {coord}   coordenada "x|y"
//   {k}       continente no formato K45
//   {pontos}  pontos da aldeia
//   {texto}   texto livre das configurações
//
// Convenção de continente (a mesma dos scripts da comunidade): a coluna é
// floor(x/100)+1 e a linha é floor(y/100)+1 → (450|450) = K55. O contador por
// continente é o "1..N dentro do K", que é como o jogador numera as aldeias.

export const RENAME_TOKENS = ['numero', 'coord', 'k', 'pontos', 'texto'] as const;
export type RenameToken = (typeof RENAME_TOKENS)[number];

/** Tokens que DIFERENCIAM aldeias (sem ao menos um, o plano sai com nomes iguais). */
const IDENTITY_TOKENS: readonly RenameToken[] = ['numero', 'coord', 'k', 'pontos'];

/** Teto do nome final: o jogo aceita mais, mas nome longo estoura colunas de
 *  outras telas — 60 é o teto praticado aqui (excedente é cortado e reportado). */
export const RENAME_MAX_NAME_LENGTH = 60;
export const RENAME_MAX_PADDING = 6;

export interface RenameVars {
  numero: number;
  x: number;
  y: number;
  pontos: number;
  texto: string;
}

/** Aldeia candidata ao rename (coordenada/pontos vêm do /map/village.txt). */
export interface RenameVillage {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly points: number;
}

/** Continente K do par de coordenadas (ver convenção no cabeçalho). */
export function continentOf(x: number, y: number): number {
  const coluna = Math.floor(x / 100) + 1;
  const linha = Math.floor(y / 100) + 1;
  return coluna * 10 + linha;
}

/** Rótulo do continente ("K45"); coordenada inválida → "K??". */
export function continentLabel(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return 'K??';
  return `K${continentOf(x, y)}`;
}

function padded(numero: number, padding: number): string {
  const largura = Math.min(RENAME_MAX_PADDING, Math.max(1, Math.floor(padding) || 1));
  return String(Math.max(0, Math.floor(numero))).padStart(largura, '0');
}

/**
 * Nome final do template com os tokens substituídos. `padding` vale só para
 * {numero} (1..6; fora disso é grampeado). O nome NÃO é truncado aqui — o
 * plano devolve o alvo e o flag `truncated` (o chamador vê o corte).
 */
export function buildVillageName(template: string, vars: RenameVars, padding = 2): string {
  return template
    .replace(/\{numero\}/g, padded(vars.numero, padding))
    .replace(/\{coord\}/g, `${vars.x}|${vars.y}`)
    .replace(/\{k\}/g, continentLabel(vars.x, vars.y))
    .replace(/\{pontos\}/g, String(Math.max(0, Math.floor(vars.pontos))))
    .replace(/\{texto\}/g, vars.texto);
}

/**
 * Valida o template: string vazia, chave desconhecida/aberta e ausência de
 * token de identidade são erros (pt-BR, fail-closed — nada é renomeado).
 * Retorna null quando válido.
 */
export function validateRenameTemplate(template: string): string | null {
  const trimmed = template.trim();
  if (trimmed === '') return 'Informe um template para o nome das aldeias.';
  const tokens = [...trimmed.matchAll(/\{([^}]*)\}/g)];
  const abertos = (trimmed.match(/\{/g) ?? []).length;
  if (abertos !== tokens.length) {
    return 'Template com chave aberta — feche todos os tokens (ex.: {numero}).';
  }
  for (const token of tokens) {
    const nome = (token[1] ?? '').trim();
    if (!RENAME_TOKENS.includes(nome as RenameToken)) {
      return `Token desconhecido no template: "{${nome}}". Disponíveis: ${RENAME_TOKENS.map((t) => `{${t}}`).join(', ')}.`;
    }
  }
  if (!tokens.some((token) => IDENTITY_TOKENS.includes((token[1] ?? '').trim() as RenameToken))) {
    return `O template precisa de pelo menos um token que diferencie as aldeias (${IDENTITY_TOKENS.map((t) => `{${t}}`).join(', ')}) — só {texto} daria o mesmo nome a todas.`;
  }
  return null;
}

export type RenameNumbering = 'continente' | 'geral';

export interface RenamePlanOptions {
  readonly template: string;
  /** Texto de {texto}. */
  readonly texto: string;
  readonly padding: number;
  /** Início da numeração (>= 1; cada continente começa neste número). */
  readonly inicio: number;
  readonly numbering: RenameNumbering;
}

export interface RenamePlanEntry {
  readonly villageId: string;
  readonly continent: string;
  readonly seq: number;
  readonly from: string;
  readonly target: string;
  /** false = o nome atual já é o alvo (idempotência: nada é postado). */
  readonly changed: boolean;
  /** true = o nome final foi cortado em RENAME_MAX_NAME_LENGTH. */
  readonly truncated: boolean;
}

export interface RenamePlan {
  readonly ok: boolean;
  /** Erro de template (pt-BR) quando ok=false. */
  readonly error: string | null;
  readonly entries: readonly RenamePlanEntry[];
  /** Aldeias descartadas do plano com o motivo (coordenada ilegível etc.). */
  readonly ignored: readonly { readonly id: string; readonly reason: string }[];
  /** Contagem por continente ("K45" → quantas aldeias entram no plano). */
  readonly counters: Readonly<Record<string, number>>;
  /** Quantas entradas ainda precisam de POST (nomes diferentes do alvo). */
  readonly pendingCount: number;
}

function coordValid(village: RenameVillage): boolean {
  return (
    Number.isFinite(village.x) &&
    Number.isFinite(village.y) &&
    village.x >= 0 &&
    village.x <= 999 &&
    village.y >= 0 &&
    village.y <= 999
  );
}

/**
 * Plano determinístico de renomeação: ordena por continente → x → y → id,
 * numera com o início configurado (contador reiniciado a cada continente no
 * modo 'continente') e é IDEMPOTENTE — aldeia cujo nome já é o alvo entra com
 * changed=false (o plugin nunca reposta à toa).
 */
export function planVillageRenames(
  villages: readonly RenameVillage[],
  options: RenamePlanOptions,
): RenamePlan {
  const error = validateRenameTemplate(options.template);
  if (error !== null) {
    return { ok: false, error, entries: [], ignored: [], counters: {}, pendingCount: 0 };
  }
  const inicio = Number.isFinite(options.inicio) && options.inicio >= 1 ? Math.floor(options.inicio) : 1;
  const ignoradas: { id: string; reason: string }[] = [];
  const validas = villages.filter((village) => {
    if (coordValid(village)) return true;
    ignoradas.push({ id: village.id, reason: 'coordenada ilegível — sem {coord}/{k} confiáveis.' });
    return false;
  });
  const ordenadas = [...validas].sort((a, b) => {
    const ka = continentOf(a.x, a.y);
    const kb = continentOf(b.x, b.y);
    if (ka !== kb) return ka - kb;
    if (a.x !== b.x) return a.x - b.x;
    if (a.y !== b.y) return a.y - b.y;
    return a.id.localeCompare(b.id);
  });

  const counters: Record<string, number> = {};
  const usados = new Map<string, number>();
  const entries: RenamePlanEntry[] = [];
  let global = inicio;
  let pending = 0;
  for (const village of ordenadas) {
    const k = continentLabel(village.x, village.y);
    let seq: number;
    if (options.numbering === 'continente') {
      seq = (usados.get(k) ?? inicio - 1) + 1;
      usados.set(k, seq);
    } else {
      seq = global;
      global += 1;
    }
    counters[k] = (counters[k] ?? 0) + 1;
    const completo = buildVillageName(
      options.template,
      { numero: seq, x: village.x, y: village.y, pontos: village.points, texto: options.texto },
      options.padding,
    );
    const truncated = completo.length > RENAME_MAX_NAME_LENGTH;
    const target = truncated ? completo.slice(0, RENAME_MAX_NAME_LENGTH) : completo;
    const changed = target !== village.name;
    if (changed) pending += 1;
    entries.push({
      villageId: village.id,
      continent: k,
      seq,
      from: village.name,
      target,
      changed,
      truncated,
    });
  }
  return { ok: true, error: null, entries, ignored: ignoradas, counters, pendingCount: pending };
}
