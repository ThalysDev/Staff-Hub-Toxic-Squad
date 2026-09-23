/**
 * Relógio do servidor do Tribal Wars.
 *
 * O jogo exibe "Hora do servidor" em cada tela. O Hub mede o offset entre o
 * relógio do servidor e o relógio local e usa o tempo do servidor em todo
 * planejamento sensível a horário (ex.: envio de comandos agendados), porque
 * o contrato de envio não admite atraso fora da janela configurada.
 */

const SERVER_CLOCK_OFFSET_KEY = 'serverClockOffsetMs';

/** Aceita "HH:MM:SS DD/MM/YYYY" (e variações com data antes/ordem inversa). */
export function parseServerTimeText(text: string | undefined | null, now = new Date()): Date | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const time = trimmed.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  const date = trimmed.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!time) return undefined;
  const hours = Number(time[1]);
  const minutes = Number(time[2]);
  const seconds = Number(time[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
  const year = date ? Number(date[3]) : now.getFullYear();
  const month = date ? Number(date[2]) - 1 : now.getMonth();
  const day = date ? Number(date[1]) : now.getDate();
  const parsed = new Date(year, month, day, hours, minutes, seconds);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Offset (ms) a somar ao relógio local para obter o horário do servidor. */
export function serverClockOffset(serverText: string | undefined | null, localNow = new Date()): number | undefined {
  const serverTime = parseServerTimeText(serverText, localNow);
  if (!serverTime) return undefined;
  const offset = serverTime.getTime() - localNow.getTime();
  // Offsets absurdos (> 1 dia) indicam parse errado, não deriva de relógio.
  if (Math.abs(offset) > 24 * 60 * 60 * 1000) return undefined;
  return offset;
}

export async function readStoredServerClockOffset(browserStorage: {
  get(keys: string[]): Promise<Record<string, unknown>>;
}): Promise<number> {
  const result = await browserStorage.get([SERVER_CLOCK_OFFSET_KEY]);
  const stored = result[SERVER_CLOCK_OFFSET_KEY];
  return typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
}

export async function storeServerClockOffset(
  browserStorage: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<unknown>;
  },
  offset: number,
): Promise<void> {
  const current = await readStoredServerClockOffset(browserStorage);
  // Só regrava quando a diferença é significativa (evita churn no storage).
  if (Math.abs(offset - current) < 1000) return;
  await browserStorage.set({ [SERVER_CLOCK_OFFSET_KEY]: offset });
}

/** Aplica o offset ao relógio local: o "agora" na perspectiva do servidor. */
export function serverNow(offsetMs: number, localNow = new Date()): Date {
  return new Date(localNow.getTime() + offsetMs);
}
