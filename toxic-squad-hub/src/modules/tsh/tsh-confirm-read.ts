// Leitura da tela de CONFIRMAÇÃO do comando (v3.5.0) e decisões puras.
//
// 1) DURAÇÃO REAL: só a confirmação mostra a viagem de verdade — com o Sinal
//    de Aflição do alvo (apoios mais rápidos) ou qualquer outro bônus. O
//    agendador compara com a planejada: viagem mais CURTA num comando por
//    chegada → calcula a % de aflição e REAGENDA (sai mais tarde, chega na
//    hora); mais LONGA → não dá para chegar na hora: aborta com o motivo.
// 2) RECUSA DO JOGO: quando o passo 1 volta com a caixa de erro do jogo
//    ("Não existem unidades suficientes"…), a mensagem DELE vira o motivo —
//    o script não pré-bloqueia o que o jogo decide (decisão do dono).
//
// Estrutura esperada (Praça do TW): linha "Duração:" com H:MM:SS e/ou
// #date_arrival .relative_time[data-duration] (segundos). Ilegível = null
// (fail-open: segue como antes, sem conferência).

/** Duração da viagem mostrada na confirmação, em ms (null = ilegível). */
export function readConfirmDurationMs(doc: Document): number | null {
  const rel = doc.querySelector<HTMLElement>('#date_arrival [data-duration], #date_arrival[data-duration]');
  const attr = rel?.getAttribute('data-duration');
  if (attr !== null && attr !== undefined && /^\d+$/.test(attr.trim())) return Number(attr.trim()) * 1000;
  for (const cell of Array.from(doc.querySelectorAll<HTMLTableCellElement>('#command-data-form td, form td, table.vis td'))) {
    if (!/^Dura[çc][ãa]o\s*:?$/i.test((cell.textContent ?? '').trim())) continue;
    const next = cell.nextElementSibling;
    const ms = parseHmsMs(next?.textContent ?? '');
    if (ms !== null) return ms;
  }
  return null;
}

/** "1:02:03" / "0:26:40" → ms. */
export function parseHmsMs(text: string): number | null {
  const m = /(\d+):(\d{2}):(\d{2})/.exec(text);
  if (m === null) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

/** Texto da caixa de erro do jogo (null = sem erro visível). */
export function readGameErrorText(doc: Document): string | null {
  const box = doc.querySelector<HTMLElement>('.error_box, div.error, #error_box');
  const text = (box?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text.slice(0, 200);
}

export type DurationVerdict =
  | { kind: 'ok' }
  /** Mais curta, novo envio em até 60 s: mira o novo horário NA MESMA confirmação. */
  | { kind: 'mirar-novo'; newSendAtMs: number; boostPct: number; realMs: number; plannedMs: number }
  /** Mais curta, novo envio bem mais tarde: reagenda e arma de novo na hora. */
  | { kind: 'reagendar'; newSendAtMs: number; boostPct: number; realMs: number; plannedMs: number }
  /** Mais curta, mas o novo horário de envio já passou. */
  | { kind: 'curta-demais'; realMs: number; plannedMs: number; lateByMs: number }
  /** Viagem mais longa num comando por chegada: não chega na hora. */
  | { kind: 'atrasaria'; lateMs: number; realMs: number; plannedMs: number }
  /** Comando por envio: só a chegada muda (informativo). */
  | { kind: 'nova-chegada'; newArrivalAtMs: number; realMs: number; plannedMs: number };

/** Diferença abaixo disso é arredondamento do jogo, não bônus. */
export const DURATION_TOLERANCE_MS = 1_500;
/** Até esse atraso extra a confirmação aberta espera; acima, rearma depois. */
export const SAME_CONFIRM_MAX_DELAY_MS = 60_000;

/**
 * Decide o que fazer com a duração real. `arrivalLocked` = comando pensado
 * pela CHEGADA (snipe/dodge/"Chegar às") — a chegada é sagrada.
 * `boostPct` = quanto a viagem ficou mais rápida (p na fórmula base ÷ (1+p/100)).
 */
export function durationVerdict(input: {
  sendAtMs: number;
  arrivalAtMs: number;
  realMs: number;
  arrivalLocked: boolean;
  nowMs: number;
}): DurationVerdict {
  const plannedMs = input.arrivalAtMs - input.sendAtMs;
  const diff = input.realMs - plannedMs;
  if (!(plannedMs > 0) || Math.abs(diff) <= DURATION_TOLERANCE_MS) return { kind: 'ok' };
  if (!input.arrivalLocked) {
    return { kind: 'nova-chegada', newArrivalAtMs: input.sendAtMs + input.realMs, realMs: input.realMs, plannedMs };
  }
  if (diff > 0) return { kind: 'atrasaria', lateMs: diff, realMs: input.realMs, plannedMs };
  const newSendAtMs = input.arrivalAtMs - input.realMs;
  const boostPct = Math.round((plannedMs / input.realMs - 1) * 100);
  if (newSendAtMs - input.nowMs <= 300) {
    return { kind: 'curta-demais', realMs: input.realMs, plannedMs, lateByMs: input.nowMs - newSendAtMs };
  }
  if (newSendAtMs - input.sendAtMs <= SAME_CONFIRM_MAX_DELAY_MS) {
    return { kind: 'mirar-novo', newSendAtMs, boostPct, realMs: input.realMs, plannedMs };
  }
  return { kind: 'reagendar', newSendAtMs, boostPct, realMs: input.realMs, plannedMs };
}

/** "0:26:40" a partir de ms (para mensagens). */
export function formatHms(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
