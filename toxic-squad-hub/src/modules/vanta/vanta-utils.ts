// Utilitários puros da Suite Vanta (port do TW Vanta com as correções P1/P2
// da auditoria de 21/09). Funções PURAS (testáveis em node): nada de DOM aqui.
// Correções embutidas:
// - P1-2: números pt-BR ("8.532") eram truncados por parseInt → parsePtBrInt.
// - P1-3: datetime-local semeado em UTC (3h de erro no BR) → toLocalDatetimeValue.
// - P2:   coordenadas com slice de string quebravam <100 → coordFromXy/coordKey.

/** Escapa texto para interpolagem segura em HTML/atributo (P1-1). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Alias semântico para uso em atributos. */
export const escAttr = escapeHtml;

/**
 * Inteiro a partir de texto do jogo no formato pt-BR (ponto como separador de
 * milhar, ex.: "8.532"). O Vanta original fazia parseInt direto → "8.532"
 * virava 8 (P1-2 da auditoria).
 */
export function parsePtBrInt(text: string | null | undefined): number {
  if (text === null || text === undefined) return 0;
  const limpo = String(text).replace(/\./g, '').replace(/\s/g, '');
  const n = parseInt(limpo, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Float laxo com fallback 0 (inputs do usuário). */
export function parseNumLoose(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Valor para <input type="datetime-local"> a partir de um Date, no FUSO LOCAL
 * da máquina (o input interpreta o valor como local). O Vanta usava
 * toISOString() (UTC) → no Brasil o default ficava 3h no futuro (P1-3).
 */
export function toLocalDatetimeValue(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

/**
 * "Agora" do servidor do jogo a partir dos elementos #serverDate (dd/mm/aaaa)
 * e #serverTime (hh:mm[:ss]), interpretados no fuso local da máquina.
 * Retorna null se os textos não casarem — o chamador decide o fallback.
 * (O Vanta montava `new Date("mm/dd/yyyy hh:mm:ss")` — formato não padrão.)
 */
export function parseServerNow(serverDateText: string, serverTimeText: string): Date | null {
  const dm = serverDateText.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const tm = serverTimeText.trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (dm === null || tm === null) return null;
  const date = new Date(
    Number(dm[3]),
    Number(dm[2]) - 1,
    Number(dm[1]),
    Number(tm[1]),
    Number(tm[2]),
    tm[3] !== undefined ? Number(tm[3]) : 0,
    0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Coordenada robusta a partir do xy compacto do TWMap (x*1000+y). O Vanta
 * fazia `(''+xy).slice(0,3)+'|'+slice(3,6)` — quebrava para x<100 e y<100
 * (aldeia 5|7 tem xy=5007 e virava "500|7"). (P2 da auditoria)
 */
export function coordFromXy(xy: number): { x: number; y: number } {
  return { x: Math.floor(xy / 1000), y: xy % 1000 };
}

/** Chave canônica de coordenada NÃO acolchoada ("5|7"), usada em TODO o código. */
export function coordKey(x: number, y: number): string {
  return `${x}|${y}`;
}

/** "HH:MM:SS" (ou "H:MM:SS") → segundos totais; NaN se não casar. */
export function parseCountdown(text: string): number {
  const m = text.match(/(\d+):(\d{2}):(\d{2})/);
  if (m === null) return Number.NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Segundos → "HH:MM hrs" (mínimo 0). */
export function fmtLead(seconds: number): string {
  const sec = Math.max(0, seconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)} hrs`;
}

/** População por unidade (constante do Vanta, mundo clássico). */
export const UNIT_POP: Record<string, number> = {
  spear: 1,
  sword: 1,
  axe: 1,
  archer: 1,
  spy: 0,
  light: 0,
  marcher: 5,
  heavy: 4,
  ram: 5,
  catapult: 8,
  knight: 10,
  snob: 100,
};

export const UNITS = [
  'spear',
  'sword',
  'axe',
  'archer',
  'spy',
  'light',
  'marcher',
  'heavy',
  'ram',
  'catapult',
  'knight',
  'snob',
] as const;

export type UnitId = (typeof UNITS)[number];
