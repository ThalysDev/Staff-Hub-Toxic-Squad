// Configuração de mundo obtida de /interface.php?func=get_config.

export interface WorldConfig {
  world: string;
  speed: number;
  unitSpeed: number;
  moralActive: boolean;
  nightBonusActive: boolean;
  hasArchers: boolean;
  hasPaladin: boolean;
  hasMilitia: boolean;
}

/** Fallback para mundo clássico (speed-adjust) antes da config real chegar. */
export const NOBLE_MINUTES_PER_FIELD_DEFAULT = 35;

function tagContent(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, 'i').exec(xml);
  return match?.[1] ?? null;
}

function parseNumber(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Validado contra o XML real do BR142: flags podem ser 1/2/3 (ex. moral=2,
// knight=3 = paladino com itens) e <night> é um BLOCO aninhado — a tag plana
// nunca casa. "Ativo" = qualquer valor diferente de 0.
function parseFlag(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed !== '0';
}

function parseNestedFlag(xml: string, tag: string, fallback: boolean): boolean {
  const block = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!block?.[1]) return parseFlag(tagContent(xml, tag), fallback);
  return parseFlag(tagContent(block[1], 'active') ?? block[1], fallback);
}

// Tags ausentes recebem fallback (speed/unitSpeed 1, flags false) — o XML do
// get_config normalmente traz todas; o fallback é apenas defensivo.
export function parseWorldConfigXml(world: string, xml: string): WorldConfig {
  return {
    world,
    speed: parseNumber(tagContent(xml, 'speed'), 1),
    unitSpeed: parseNumber(tagContent(xml, 'unit_speed'), 1),
    moralActive: parseFlag(tagContent(xml, 'moral'), false),
    nightBonusActive: parseNestedFlag(xml, 'night', false),
    hasArchers: parseFlag(tagContent(xml, 'archer'), false),
    hasPaladin: parseFlag(tagContent(xml, 'knight'), false),
    hasMilitia: parseFlag(tagContent(xml, 'militia'), false),
  };
}
