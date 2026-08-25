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

function parseFlag(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value.trim() === '1';
}

// Tags ausentes recebem fallback (speed/unitSpeed 1, flags false) — o XML do
// get_config normalmente traz todas; o fallback é apenas defensivo.
export function parseWorldConfigXml(world: string, xml: string): WorldConfig {
  return {
    world,
    speed: parseNumber(tagContent(xml, 'speed'), 1),
    unitSpeed: parseNumber(tagContent(xml, 'unit_speed'), 1),
    moralActive: parseFlag(tagContent(xml, 'moral'), false),
    nightBonusActive: parseFlag(tagContent(xml, 'night'), false),
    hasArchers: parseFlag(tagContent(xml, 'archer'), false),
    hasPaladin: parseFlag(tagContent(xml, 'knight'), false),
    hasMilitia: parseFlag(tagContent(xml, 'militia'), false),
  };
}