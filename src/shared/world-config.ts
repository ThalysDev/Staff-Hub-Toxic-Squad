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
  /** Fator de lentidão das tropas dentro da janela noturna (<def_factor>).
   * 2 = clássico (meia velocidade); 1 = sem lentidão. */
  defFactor: number;
  hasArchers: boolean;
  hasPaladin: boolean;
  hasMilitia: boolean;
}

function tagContent(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, 'i').exec(xml);
  return match?.[1] ?? null;
}

// Fail-closed: tag numérica essencial ausente (ou vazia) ou sem valor finito
// > 0 lança erro — fallback silencioso (ex. speed 1) geraria tempo de envio
// plausível mas ERRADO em todo o app.
function requirePositiveNumber(value: string | null, tag: string): number {
  if (value === null || value.trim() === '') {
    throw new Error(
      `Configuração do mundo sem <${tag}> válida — recolete os dados do mundo (Análise de Aldeias → Obter análise do mundo).`,
    );
  }
  const parsed = Number.parseFloat(value.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Configuração do mundo com <${tag}> inválida ("${value.trim().slice(0, 30)}") — recolete os dados do mundo (Análise de Aldeias → Obter análise do mundo).`,
    );
  }
  return parsed;
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

// Fator noturno clássico (meia velocidade na janela) — usado APENAS quando o
// mundo não traz <def_factor> (nem no bloco <night>, nem plano). Tag presente
// e inválida é fail-closed, igual a speed/unit_speed.
const DEF_FACTOR_DEFAULT = 2;

/** <def_factor> do mundo: vive DENTRO do bloco <night> no XML real do BR142;
 *  mundos sem o bloco podem expor a tag plana (legado). */
function parseDefFactor(xml: string): number {
  const nightBlock = new RegExp(`<night[^>]*>([\\s\\S]*?)</night>`, 'i').exec(xml)?.[1];
  const raw = (nightBlock !== undefined ? tagContent(nightBlock, 'def_factor') : null) ?? tagContent(xml, 'def_factor');
  if (raw === null) return DEF_FACTOR_DEFAULT;
  return requirePositiveNumber(raw, 'def_factor');
}
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

// speed/unitSpeed/def_factor são fail-closed (ausente/inválido lança — nunca
// fallback que distorceria todo cálculo de tempo); flags ausentes recebem
// fallback (false/moral ATIVA) — o XML do get_config normalmente traz todas.
export function parseWorldConfigXml(world: string, xml: string): WorldConfig {
  const night = parseNightBlock(xml);
  // Moral por pontos: o get_config real expõe <disable_morale>1</disable_morale>
  // nos mundos SEM moral (Clássicos). A tag plana <moral> não existe no XML
  // atual — mantida apenas como fallback legado. Default: moral ATIVA
  // (mundos regulares; fail-open aqui é o correto: desligar moral por engano
  // liberaria ataques que o jogo puniria, o contrário só superestima o filtro).
  const disableMorale = tagContent(xml, 'disable_morale');
  return {
    world,
    speed: requirePositiveNumber(tagContent(xml, 'speed'), 'speed'),
    unitSpeed: requirePositiveNumber(tagContent(xml, 'unit_speed'), 'unit_speed'),
    moralActive: disableMorale !== null ? disableMorale.trim() !== '1' : parseFlag(tagContent(xml, 'moral'), true),
    nightBonusActive: night.active,
    nightStartHour: night.startHour,
    nightEndHour: night.endHour,
    defFactor: parseDefFactor(xml),
    hasArchers: parseFlag(tagContent(xml, 'archer'), false),
    hasPaladin: parseFlag(tagContent(xml, 'knight'), false),
    hasMilitia: parseFlag(tagContent(xml, 'militia'), false),
  };
}
