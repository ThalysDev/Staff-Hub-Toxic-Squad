// Configuração de mundo obtida de /interface.php?func=get_config.

export interface WorldConfig {
  world: string;
  speed: number;
  unitSpeed: number;
  moralActive: boolean;
  /** Bônus noturno ligado neste mundo. */
  nightBonusActive: boolean;
  /** Hora local (0-23) em que a janela noturna abre, inclusive. */
  nightStartHour: number;
  /** Hora local (0-23) em que a janela noturna fecha, exclusive. Pode ser
   * menor que nightStartHour quando a janela cruza a meia-noite (BR142: 23→7). */
  nightEndHour: number;
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

/** Janela do bônus noturno extraída do bloco <night> do get_config. */
interface NightWindow {
  active: boolean;
  startHour: number;
  endHour: number;
}

// Hora inteira válida (0-23); qualquer outra coisa → null.
function parseHour(value: string | null): number | null {
  const parsed = Number.parseFloat((value ?? '').replace(',', '.'));
  if (!Number.isFinite(parsed)) return null;
  const hour = Math.floor(parsed);
  return hour >= 0 && hour <= 23 ? hour : null;
}

// Bloco <night> real do BR142 no get_config:
//   <night>
//     <active>1</active>
//     <start_hour>23</start_hour>
//     <end_hour>7</end_hour>
//     <def_factor>2</def_factor>
//     <duration>14</duration>
//   </night>
// Mundo sem bônus noturno é legítimo: bloco ausente → active false e horas 0,
// sem lançar erro. Fail-closed para a janela em si: "ativo" com horários
// ausentes/fora de 0-23/iguais não pode ser aplicado com segurança — desligamos
// o bônus em vez de aplicar uma janela inventada.
function parseNightBlock(xml: string): NightWindow {
  const block = new RegExp(`<night[^>]*>([\\s\\S]*?)</night>`, 'i').exec(xml);
  if (!block?.[1]) {
    // XML legado com flag plana <night>N</night>: sem janela conhecida
    // (horas 0/0 = janela vazia, que nunca dispara).
    return { active: parseFlag(tagContent(xml, 'night'), false), startHour: 0, endHour: 0 };
  }
  const inner = block[1];
  const startHour = parseHour(tagContent(inner, 'start_hour'));
  const endHour = parseHour(tagContent(inner, 'end_hour'));
  const active = parseFlag(tagContent(inner, 'active') ?? inner, false);
  if (active && (startHour === null || endHour === null || startHour === endHour)) {
    return { active: false, startHour: 0, endHour: 0 };
  }
  // Bônus desativado mantém as horas parseadas (útil para exibir a janela na UI).
  return { active, startHour: startHour ?? 0, endHour: endHour ?? 0 };
}

// Tags ausentes recebem fallback (speed/unitSpeed 1, flags false) — o XML do
// get_config normalmente traz todas; o fallback é apenas defensivo.
export function parseWorldConfigXml(world: string, xml: string): WorldConfig {
  const night = parseNightBlock(xml);
  return {
    world,
    speed: parseNumber(tagContent(xml, 'speed'), 1),
    unitSpeed: parseNumber(tagContent(xml, 'unit_speed'), 1),
    moralActive: parseFlag(tagContent(xml, 'moral'), false),
    nightBonusActive: night.active,
    nightStartHour: night.startHour,
    nightEndHour: night.endHour,
    hasArchers: parseFlag(tagContent(xml, 'archer'), false),
    hasPaladin: parseFlag(tagContent(xml, 'knight'), false),
    hasMilitia: parseFlag(tagContent(xml, 'militia'), false),
  };
}
