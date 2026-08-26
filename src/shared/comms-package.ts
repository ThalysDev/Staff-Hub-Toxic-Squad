// Pacote de comunicação da OP (P0-8, parte PURA): a partir da distribuição
// ("nick;coords" do distributionSummary do SG_4) e da agenda de envio colável
// ("nick;alvo;HH:MM:SS" do formatSendSchedule do SG_4-timing), monta o material
// que vai para a tribo — MPs personalizadas, post BBCode do plano no fórum e a
// lista de coordenadas para a Reserva em Massa do SG_6.
// Puro e determinístico: nada de relógio, rede ou DOM; erro de parser é
// fail-closed com mensagem clara em PT-BR.

import { bbcodeTable } from './formatters';

export interface CommsTemplateInput {
  /** Título da OP (ex.: "Ferrovias do Norte") — vira [b]OP …[/b] no BBCode. */
  opTitle: string;
  /** Corpo da MP com placeholders #alvos# e/ou #horarios#. */
  template: string;
  /** Linhas "nick;coord coord" geradas pelo distributionSummary. */
  distribution: string;
  /** Texto colável do formatSendSchedule (com 1ª linha "# Chegada desejada"). */
  sendSchedule: string;
}

/** Material de comunicação de UM jogador: alvos dele + horário de envio de cada um. */
export interface PlayerComms {
  playerName: string;
  /** Coordenadas dos alvos do jogador ("x|y"), na ordem da distribuição. */
  coords: string[];
  /** Horário de envio (HH:MM:SS) de CADA coord, mesma ordem/posição de `coords`. */
  horarios: string[];
}

const DISTRIBUTION_LINE_RE = /^([^;]{2,40});((?:\d{1,3}\|\d{1,3})(?:\s+\d{1,3}\|\d{1,3})*\s*)$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;
const COORD_RE = /^\d{1,3}\|\d{1,3}$/;

// ---------------------------------------------------------------------------
// Agenda de envio (texto colável → linhas estruturadas)
// ---------------------------------------------------------------------------

/**
 * Parseia as linhas "nick;alvo;HH:MM:SS". Ignora linhas vazias e comentários
 * (começando com "#", como o cabeçalho "# Chegada desejada"). Linha fora do
 * formato → erro citando a linha original.
 */
export function parseSendSchedule(text: string): { playerName: string; targetCoord: string; time: string }[] {
  const entries: { playerName: string; targetCoord: string; time: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(';').map((part) => part.trim());
    if (parts.length !== 3) {
      throw new Error(`Linha da agenda de envio inválida (use "nick;123|456;HH:MM:SS"): "${trimmed.slice(0, 60)}"`);
    }
    const playerName = parts[0];
    const targetCoord = parts[1];
    const time = parts[2];
    if (
      playerName === undefined ||
      playerName.length < 2 ||
      targetCoord === undefined ||
      !COORD_RE.test(targetCoord) ||
      time === undefined ||
      !TIME_RE.test(time)
    ) {
      throw new Error(`Linha da agenda de envio inválida (use "nick;123|456;HH:MM:SS"): "${trimmed.slice(0, 60)}"`);
    }
    entries.push({ playerName, targetCoord, time });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Distribuição (texto colável → jogadores)
// ---------------------------------------------------------------------------

/** Linha "nick;coords" → PlayerComms SEM horários (o par com a agenda vem depois). */
function parseDistributionText(distribution: string): PlayerComms[] {
  const players: PlayerComms[] = [];
  for (const line of distribution.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = DISTRIBUTION_LINE_RE.exec(trimmed);
    if (match === null) {
      throw new Error(`Linha de distribuição inválida (use "nick;123|456 456|789"): "${trimmed.slice(0, 60)}"`);
    }
    const coords = (match[2] ?? '').trim().split(/\s+/).filter((coord) => coord !== '');
    players.push({ playerName: match[1] ?? '', coords, horarios: [] });
  }
  return players;
}

/**
 * Cruza distribution × sendSchedule: para cada jogador da distribuição, os alvos
 * dele e o horário de envio de CADA alvo na agenda. Fail-closed quando estão
 * dessincronizadas — jogador sem NENHUMA linha na agenda, ou alvo específico
 * sem horário, aborta com erro claro (nunca texto silenciosamente incompleto).
 * Par repetido na agenda (trem de nobres) usa a PRIMEIRA ocorrência — a
 * referência da OP, igual ao cabeçalho do formatSendSchedule.
 */
export function buildPlayerComms(input: CommsTemplateInput): PlayerComms[] {
  // nick → (alvo → horário da 1ª linha daquele par).
  const horarioPorJogador = new Map<string, Map<string, string>>();
  for (const entry of parseSendSchedule(input.sendSchedule)) {
    let porAlvo = horarioPorJogador.get(entry.playerName);
    if (porAlvo === undefined) {
      porAlvo = new Map();
      horarioPorJogador.set(entry.playerName, porAlvo);
    }
    if (!porAlvo.has(entry.targetCoord)) porAlvo.set(entry.targetCoord, entry.time);
  }

  const players = parseDistributionText(input.distribution);
  if (players.length === 0) {
    throw new Error('Nenhuma linha de distribuição informada — cole as linhas "nick;coords" da OP.');
  }

  return players.map((player) => {
    const porAlvo = horarioPorJogador.get(player.playerName);
    if (porAlvo === undefined) {
      throw new Error(
        `Distribuição e agenda de envio dessincronizadas: o jogador "${player.playerName}" está na distribuição, mas não tem nenhuma linha na agenda.`,
      );
    }
    const horarios = player.coords.map((coord) => {
      const time = porAlvo.get(coord);
      if (time === undefined) {
        throw new Error(`Alvo ${coord} do jogador "${player.playerName}" sem horário na agenda de envio.`);
      }
      return time;
    });
    return { playerName: player.playerName, coords: [...player.coords], horarios };
  });
}

// ---------------------------------------------------------------------------
// Renderização da MP
// ---------------------------------------------------------------------------

/**
 * Bloco #horarios# (fonte ÚNICA de verdade): um "alvo → HH:MM:SS" por linha,
 * na mesma ordem das coordenadas. O sg6-service (envio real) e o mp-preview
 * (prévia) usam ESTA função — prévia e envio nunca divergem.
 */
export function horariosBlock(coords: readonly string[], horarios: readonly string[]): string {
  if (coords.length !== horarios.length) {
    throw new Error(
      `Horários dessincronizados com os alvos: ${coords.length} alvo(s) e ${horarios.length} horário(s).`,
    );
  }
  return coords.map((coord, index) => `${coord} → ${horarios[index] ?? ''}`).join('\n');
}

/**
 * Substitui TODAS as ocorrências de #alvos# (coords separadas por espaço) e
 * #horarios# (um "alvo → HH:MM:SS" por linha, mesma ordem das coords) no template.
 * O template precisa ter #alvos#, #horarios# ou ambos — nenhum placeholder é erro,
 * pois o corpo ficaria idêntico para todo mundo.
 */
export function renderTemplate(template: string, player: PlayerComms): string {
  if (!template.includes('#alvos#') && !template.includes('#horarios#')) {
    throw new Error(
      'Template de MP sem placeholder: inclua #alvos# e/ou #horarios# para que cada jogador receba os dados dele.',
    );
  }
  if (player.coords.length !== player.horarios.length) {
    throw new Error(
      `Dados inconsistentes do jogador "${player.playerName}": ${player.coords.length} alvo(s) e ${player.horarios.length} horário(s) — a agenda está dessincronizada.`,
    );
  }
  return template
    .replaceAll('#alvos#', player.coords.join(' '))
    .replaceAll('#horarios#', horariosBlock(player.coords, player.horarios));
}

// ---------------------------------------------------------------------------
// Post BBCode do plano no fórum
// ---------------------------------------------------------------------------

/** Primeira linha "# Chegada desejada: HH:MM:SS" do texto da agenda (ou null). */
function extractDesiredArrival(sendSchedule: string): string | null {
  for (const line of sendSchedule.split(/\r?\n/)) {
    const match = /^#\s*Chegada desejada:\s*(\d{2}:\d{2}:\d{2})\s*$/.exec(line.trim());
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

/**
 * Post pronto para o fórum da tribo: título da OP, header opcional (data/anotação),
 * tabela Jogador | Alvo | Enviar às (agenda agrupada por jogador, ordem da 1ª
 * aparição) e rodapé com a chegada desejada extraída do comentário da agenda.
 * Sem escaping: conteúdo é interno (nicks/alvos/horários), sem input perigoso.
 */
export function planBbcode(input: CommsTemplateInput & { arrivalHeader?: string }): string {
  const byNick = new Map<string, { targetCoord: string; time: string }[]>();
  for (const entry of parseSendSchedule(input.sendSchedule)) {
    const list = byNick.get(entry.playerName) ?? [];
    list.push({ targetCoord: entry.targetCoord, time: entry.time });
    byNick.set(entry.playerName, list);
  }
  const rows: string[][] = [];
  for (const [nick, entries] of byNick) {
    for (const entry of entries) rows.push([nick, entry.targetCoord, entry.time]);
  }

  const parts: string[] = [`[b]OP ${input.opTitle}[/b]`];
  const arrivalHeader = input.arrivalHeader?.trim();
  if (arrivalHeader !== undefined && arrivalHeader !== '') parts.push(arrivalHeader);
  parts.push(bbcodeTable(['Jogador', 'Alvo', 'Enviar às'], rows));
  const desiredArrival = extractDesiredArrival(input.sendSchedule);
  if (desiredArrival !== null) parts.push('', `[b]Chegada desejada: ${desiredArrival}[/b]`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Saídas para o SG_6
// ---------------------------------------------------------------------------

/**
 * Todos os coords da distribuição (de QUALQUER jogador), únicos pela primeira
 * ocorrência, um por linha — colar direto na textarea da Reserva em Massa.
 */
export function reservationList(distribution: string): string {
  const seen = new Set<string>();
  const coords: string[] = [];
  for (const player of parseDistributionText(distribution)) {
    for (const coord of player.coords) {
      if (!seen.has(coord)) {
        seen.add(coord);
        coords.push(coord);
      }
    }
  }
  return coords.join('\n');
}

/**
 * Entradas estendidas do SG_6, uma linha por jogador:
 * "nick;coord coord;HH:MM:SS,HH:MM:SS" — coords separados por espaço, horários
 * por vírgula na MESMA ordem das coords.
 */
export function sg6EntriesText(players: PlayerComms[]): string {
  return players
    .map((player) => `${player.playerName};${player.coords.join(' ')};${player.horarios.join(',')}`)
    .join('\n');
}
