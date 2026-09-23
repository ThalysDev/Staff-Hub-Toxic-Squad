// Parser PURO do inventário do jogo (Onda 5, Parte A) — base dos dois módulos
// que leem `screen=inventory`: Abertura de Pacotes e Agendador de Itens.
// Sem DOM e sem rede: recebe o HTML como texto (a leitura é do plugin, pela
// fila do core) e devolve itens; por isso roda em node nos testes.
//
// LACUNA REGISTRADA (Onda 5): o markup real do inventário do br142 ainda NÃO
// tem fixture no repo (regra do AGENTS: fixture HTML real antes de parser de
// tela nova). O contrato aceito aqui é EXPLÍCITO e fail-closed: só blocos que
// declaram `data-item-id` são reconhecidos — todo o resto é IGNORADO. Um
// parser que "adivinha" nome/quantidade de um bloco ambíguo pode postar a
// ação de um item errado; quando a fixture chegar, é este arquivo (e o teste
// ao lado) que muda.
//
// Contrato aceito por bloco (atributos da PRÓPRIA linha do item):
//   data-item-id       obrigatório — id numérico do item
//   data-item-name     nome (fallback: célula .item-name / alt da img)
//   data-item-count    quantidade (fallback: célula .item-count/.amount / 1)
//   data-item-category categoria declarada (fallback: deduzida do nome)
//   data-action-url    URL canônica de uso/abertura (é o que o plugin posta;
//                      sem ela NADA é postado — fail-closed)

export type InventoryCategory = 'recurso' | 'tropas' | 'construcao' | 'tempo' | 'outro';

export const INVENTORY_CATEGORIES: readonly InventoryCategory[] = [
  'recurso',
  'tropas',
  'construcao',
  'tempo',
  'outro',
];

export const INVENTORY_CATEGORY_LABEL: Record<InventoryCategory, string> = {
  recurso: 'Recursos',
  tropas: 'Tropas',
  construcao: 'Construção',
  tempo: 'Tempo',
  outro: 'Outros',
};

export interface InventoryItem {
  readonly id: string;
  readonly name: string;
  readonly count: number;
  readonly category: InventoryCategory;
  /** Marcado pela página como pacote de recursos (abre, não "usa"). */
  readonly package: boolean;
  /** URL canônica de uso/abertura exposta pela página — undefined = não posta. */
  readonly actionUrl?: string;
}

/** Minúsculas sem acento (nome de item vem em pt-BR com acentuação variável). */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Inteiro pt-BR ("1.234" → 1234); lixo/negativo → 0 (fail-closed). */
function parsePtBrInt(text: string | null | undefined): number {
  if (text === null || text === undefined) return 0;
  const limpo = String(text).replace(/\./g, '').replace(/\s/g, '');
  const n = parseInt(limpo, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Categorização por nome (fallback do data-item-category) ────────────────

const CATEGORY_KEYWORDS: readonly { category: InventoryCategory; words: readonly string[] }[] = [
  { category: 'recurso', words: ['pacote', 'bau', 'caixa', 'recurso', 'recompensa'] },
  { category: 'tropas', words: ['tropa', 'recrutamento', 'unidade', 'nobre', 'paladino'] },
  {
    category: 'construcao',
    words: ['construcao', 'construir', 'edificio', 'muralha', 'quartel', 'estabulo', 'oficina'],
  },
  { category: 'tempo', words: ['tempo', 'instantaneo', 'instantanea', 'reducao', 'acelerar', 'velocidade'] },
];

/** Categoria declarada no HTML (aceita rótulo pt-BR do jogo) ou deduzida. */
export function categorizeItem(raw: string): InventoryCategory {
  const texto = fold(raw);
  if (texto === '') return 'outro';
  const declared = INVENTORY_CATEGORIES.find((category) => texto === category);
  if (declared !== undefined) return declared;
  for (const { category, words } of CATEGORY_KEYWORDS) {
    if (words.some((word) => texto.includes(word))) return category;
  }
  return 'outro';
}

/** Pacote de recursos: categoria de recurso E nome de "pacote/baú/caixa". */
export function isResourcePackage(item: InventoryItem): boolean {
  if (item.category !== 'recurso') return false;
  const texto = fold(item.name);
  return ['pacote', 'bau', 'caixa'].some((word) => texto.includes(word));
}

// ── Parser ─────────────────────────────────────────────────────────────────

function attribute(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  const value = match?.[1]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Nome do item: atributo → célula .item-name/.name → alt da imagem. */
function readName(block: string): string | undefined {
  const declared = attribute(block, 'data-item-name');
  if (declared !== undefined) return decodeEntities(declared);
  const cell = block.match(/<td[^>]*class="[^"]*item-name[^"]*"[^>]*>([^<]*)<\/td>/i);
  if (cell?.[1] !== undefined) {
    const texto = decodeEntities(cell[1]).replace(/\s+/g, ' ').trim();
    if (texto !== '') return texto;
  }
  const firstCell = block.match(/<td[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([^<]*)<\/td>/i);
  if (firstCell?.[1] !== undefined) {
    const texto = decodeEntities(firstCell[1]).replace(/\s+/g, ' ').trim();
    if (texto !== '') return texto;
  }
  const img = block.match(/<img[^>]*alt="([^"]+)"[^>]*>/i);
  if (img?.[1] !== undefined) {
    const texto = decodeEntities(img[1]).replace(/^item:\s*/i, '').trim();
    if (texto !== '') return texto;
  }
  return undefined;
}

/** Quantidade: atributo → célula .item-count/.amount/.quantity → 1. */
function readCount(block: string): number {
  const declared = parsePtBrInt(attribute(block, 'data-item-count'));
  if (declared > 0) return declared;
  const cell = block.match(
    /<td[^>]*class="[^"]*(?:item-count|amount|quantity)[^"]*"[^>]*>([^<]*)<\/td>/i,
  );
  const parsed = parsePtBrInt(cell?.[1]?.replace(/[^\d.]/g, '') ?? null);
  return parsed > 0 ? parsed : 1;
}

/** URL de uso declarada ou href com ação canônica de uso/abertura. */
function readActionUrl(block: string): string | undefined {
  const declared = attribute(block, 'data-action-url');
  if (declared !== undefined) return decodeEntities(declared);
  const href = block.match(/href="([^"]*(?:action|ajaxaction)=[^"]*(?:use|use_item|open|abrir|ativar)[^"]*)"/i);
  const value = href?.[1];
  return value === undefined ? undefined : decodeEntities(value);
}

/**
 * Itens do inventário. Blocos são recortados a partir de cada
 * `data-item-id="N"` até o próximo (mesma técnica do readScavengeMassVillages);
 * bloco sem nome legível é descartado — nunca entra item "sem nome" no plano.
 */
export function parseInventoryItems(html: string): InventoryItem[] {
  const anchors = [...html.matchAll(/data-item-id="(\d+)"/g)];
  const items: InventoryItem[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const id = anchor?.[1];
    if (anchor === undefined || id === undefined || seen.has(id)) continue;
    const block = html.slice(anchor.index, anchors[index + 1]?.index ?? html.length);
    const name = readName(block);
    if (name === undefined) continue;
    seen.add(id);
    const declaredCategory = attribute(block, 'data-item-category');
    const category = declaredCategory !== undefined ? categorizeItem(declaredCategory) : categorizeItem(name);
    const actionUrl = readActionUrl(block);
    const item: InventoryItem = {
      id,
      name,
      count: readCount(block),
      category,
      package: false,
      ...(actionUrl !== undefined ? { actionUrl } : {}),
    };
    items.push({ ...item, package: isResourcePackage(item) });
  }
  return items;
}

/** Item pelo id (o agendador guarda o id digitado pelo usuário). */
export function findInventoryItem(items: readonly InventoryItem[], id: string): InventoryItem | undefined {
  const alvo = String(id).trim();
  return items.find((item) => item.id === alvo);
}

/** Agrupa por categoria (ordem canônica) — usado na prévia/status. */
export function groupItemsByCategory(items: readonly InventoryItem[]): Record<InventoryCategory, InventoryItem[]> {
  const grouped = Object.fromEntries(INVENTORY_CATEGORIES.map((category) => [category, [] as InventoryItem[]])) as Record<
    InventoryCategory,
    InventoryItem[]
  >;
  for (const item of items) grouped[item.category].push(item);
  return grouped;
}

/** Primeiro pacote de recursos ABRÍVEL (com URL canônica) — 1 por ciclo (F2). */
export function pickResourcePackage(items: readonly InventoryItem[]): InventoryItem | undefined {
  return items.find((item) => item.package && item.actionUrl !== undefined);
}

/** Resumo curto para status/prévia: "5 itens (3 recursos, 2 tropas)". */
export function summarizeInventory(items: readonly InventoryItem[]): string {
  if (items.length === 0) return 'Nenhum item reconhecido no inventário.';
  const grouped = groupItemsByCategory(items);
  const partes = INVENTORY_CATEGORIES.filter((category) => grouped[category].length > 0).map(
    (category) => `${grouped[category].length} ${INVENTORY_CATEGORY_LABEL[category].toLowerCase()}`,
  );
  return `${items.length} item(ns): ${partes.join(', ')}.`;
}
