// Cunhagem (v3.10.0) — leitura PURA das telas reais da Academia no BR142
// (capturadas em 24/09/2026, só leitura):
// - screen=snob: custo da moeda (BuildingSnob…storage_item), máximo "(N)" do
//   formulário action=coin e o bloco "Criação automática" (sessão NATIVA de
//   8h do jogo: form action=start_auto_minting_session, só o csrf);
// - screen=snob&mode=coin: "Cunhar moedas de ouro" em massa (Premium) — até
//   1000 aldeias por página (from=1000, from=-1 = todas), cada uma com um
//   select id_<aldeia> cujo maior valor é o máximo que o jogo deixa cunhar
//   AGORA; aldeia sem Academia não tem select. O botão do jogo posta
//   ajaxaction=coin_multi com villages[<id>]=<qtd> e a resposta traz
//   minted_coins por aldeia (a confirmação vem do próprio jogo).
// Fail-closed: tela diferente do esperado = null (nada é cunhado).

export type Res = { wood: number; stone: number; iron: number };

const digits = (text: string | undefined): number => Number((text ?? '').replace(/<[^>]*>/g, '').replace(/[^\d]/g, '') || 0);

/** Estado da sessão nativa de cunhagem automática (8h) na Academia. */
export type AutoMintState =
  | { kind: 'inativa'; startAction: string }
  /** Prova positiva (status "running" / form Cancelar). endsText = "hoje às 23:42:01". */
  | { kind: 'ativa'; endsText: string | null; coins: number | null }
  /** O bloco existe mas não bate com nenhum estado conhecido — não é "ativa". */
  | { kind: 'desconhecida' }
  /** Aldeia sem Academia (ou tela sem o bloco "Criação automática"). */
  | { kind: 'ausente' };

export interface SnobScreen {
  /** Custo de 1 moeda neste mundo. */
  cost: Res;
  /** Máximo "(N)" que o jogo deixa cunhar agora nesta aldeia. */
  max: number;
  autoMint: AutoMintState;
}

const decode = (s: string): string => s.replace(/&amp;/g, '&');

/** Academia (screen=snob, modo Recrutar). null = não é a Academia esperada. */
export function parseSnobScreen(html: string): SnobScreen | null {
  const item = /storage_item\s*=\s*(\{[^}]*"id":"coin"[^}]*\})/.exec(html)?.[1];
  let cost: Res | null = null;
  if (item !== undefined) {
    try {
      const j = JSON.parse(item) as Partial<Res>;
      if (typeof j.wood === 'number' && typeof j.stone === 'number' && typeof j.iron === 'number') cost = { wood: j.wood, stone: j.stone, iron: j.iron };
    } catch {
      cost = null;
    }
  }
  const hasAutoBlock = /class="vis auto-minting"/.test(html);
  const start = /<form[^>]*action="([^"]*action=start_auto_minting_session[^"]*)"/.exec(html)?.[1];
  const running = /class="running auto-minting-status"/.test(html) || /action=cancel_auto_minting_session/.test(html);
  const autoMint: AutoMintState =
    start !== undefined
      ? { kind: 'inativa', startAction: decode(start) }
      : running
        ? {
            kind: 'ativa',
            endsText: /Fim:\s*([^<]+?)\s*</.exec(html)?.[1]?.trim() ?? null,
            coins: /coletado at[ée] agora:\s*([\d.]+)\s*Moeda/.exec(html)?.[1] !== undefined ? digits(/coletado at[ée] agora:\s*([\d.]+)/.exec(html)?.[1]) : null,
          }
        : hasAutoBlock
          ? { kind: 'desconhecida' }
          : { kind: 'ausente' };
  if (cost === null) {
    // Academia não construída: a tela existe, mas sem moedas nem sessão.
    if (/Academia \(não construído\)/.test(html)) return { cost: { wood: 0, stone: 0, iron: 0 }, max: 0, autoMint: { kind: 'ausente' } };
    return null;
  }
  const max = digits(/id="coin_mint_fill_max"[^>]*>\(([\d.]+)\)/.exec(html)?.[1]);
  return { cost, max, autoMint };
}

export interface CoinVillage {
  id: string;
  name: string;
  x: number;
  y: number;
  res: Res;
  storage: number;
  /** Máximo de moedas que o jogo deixa cunhar agora; null = sem Academia. */
  max: number | null;
}

export interface CoinOverview {
  villages: CoinVillage[];
  /** Link do jogo para a cunhagem em massa (traz o csrf da página). */
  multiLink: string | null;
  /** Grupo que o jogo está mostrando (0 = todas as aldeias). */
  groupId: number;
  /** Há mais aldeias depois desta página (link from=… à frente). */
  more: boolean;
  /** Custo de 1 moeda, lido da opção "1x (madeira, argila, ferro)" do jogo. */
  cost: Res | null;
}

/** "Cunhar moedas de ouro" em massa (screen=snob&mode=coin). null = tela inesperada. */
export function parseCoinOverview(html: string, from = 0): CoinOverview | null {
  const table = /<table id="coin_overview_table"[\s\S]*?<\/table>/.exec(html)?.[0];
  if (table === undefined) return null;
  const villages: CoinVillage[] = [];
  for (const m of table.matchAll(/<tr id="village_(\d+)">([\s\S]*?)<\/tr>/g)) {
    const row = m[2] ?? '';
    const label = /<a [^>]*>([^<]*)<\/a>/.exec(row)?.[1] ?? '';
    const coords = /\((\d{1,3})\|(\d{1,3})\)\s*K\d+/.exec(label) ?? [...label.matchAll(/\((\d{1,3})\|(\d{1,3})\)/g)].at(-1);
    const res = (k: string): number => digits(new RegExp(`class="res ${k}">([\\s\\S]*?)</span>\\s*(?:<span class="res|</td>)`).exec(row)?.[1]);
    const select = /<select id="id_\d+"[\s\S]*?<\/select>/.exec(row)?.[0];
    const opts = select === undefined ? [] : [...select.matchAll(/<option value="(\d+)"/g)].map((o) => Number(o[1]));
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => t[1] ?? '');
    villages.push({
      id: m[1] ?? '',
      name: label.replace(/\s*\(\d{1,3}\|\d{1,3}\)\s*K\d+\s*$/, '').trim(),
      x: Number(coords?.[1] ?? 0),
      y: Number(coords?.[2] ?? 0),
      res: { wood: res('wood'), stone: res('stone'), iron: res('iron') },
      storage: digits(tds[2]),
      max: select === undefined ? null : Math.max(0, ...opts),
    });
  }
  const link = /coin_multi_link\s*=\s*"([^"]+)"/.exec(html)?.[1] ?? null;
  const groupId = Number(/"group_id":"?(\d+)"?/.exec(html)?.[1] ?? 0);
  const more = [...html.matchAll(/screen=snob&amp;mode=coin&amp;from=(\d+)/g)].some((f) => Number(f[1]) > from);
  const c = /<option value="1">1x \(([\d.]+), ([\d.]+), ([\d.]+)\)/.exec(table);
  const cost = c === null ? null : { wood: digits(c[1]), stone: digits(c[2]), iron: digits(c[3]) };
  return { villages, multiLink: link, groupId, more, cost };
}

export interface MassMintOptions {
  /** Recursos que ficam em cada aldeia (reserva fixa). */
  keep: Res;
  /** Ou: % do que a aldeia tem de cada recurso que fica (0 = usa a reserva fixa). */
  keepPct: number;
  /** Teto de moedas por aldeia por rodada (0 = o máximo do jogo). */
  perVillage: number;
}

/**
 * Quantas moedas cunhar em cada aldeia (PURA): o máximo do jogo, limitado
 * pelo que sobra acima da reserva (fixa ou % do armazém) e pelo teto por
 * aldeia. Aldeia sem Academia ou que não cabe 1 moeda fica de fora.
 */
export function planMassMint(villages: readonly CoinVillage[], cost: Res, opts: MassMintOptions, only?: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of villages) {
    if (v.max === null || v.max < 1) continue;
    if (only !== undefined && !only.has(v.id)) continue;
    const keepOf = (k: keyof Res): number => (opts.keepPct > 0 ? Math.ceil((v.res[k] * opts.keepPct) / 100) : opts.keep[k]);
    const fit = Math.min(
      ...(['wood', 'stone', 'iron'] as const).map((k) => (cost[k] > 0 ? Math.floor(Math.max(0, v.res[k] - keepOf(k)) / cost[k]) : 0)),
    );
    const n = Math.min(v.max, fit, opts.perVillage > 0 ? opts.perVillage : v.max);
    if (n >= 1) out[v.id] = n;
  }
  return out;
}

/** Resposta do coin_multi: moedas cunhadas por aldeia (null = resposta fora do contrato). */
export function readMintedCoins(response: unknown): Record<string, number> | null {
  if (typeof response !== 'object' || response === null) return null;
  const r = response as { minted_coins?: unknown; response?: unknown };
  const raw = r.minted_coins ?? (typeof r.response === 'object' && r.response !== null ? (r.response as { minted_coins?: unknown }).minted_coins : undefined);
  if (typeof raw !== 'object' || raw === null) return null;
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(raw as Record<string, unknown>)) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) out[id] = v;
  }
  return out;
}

/** "500|500 501|502" → coordenadas únicas e válidas. */
export function uniqueCoords(text: string): string[] {
  return [...new Set([...text.matchAll(/(\d{1,3})\|(\d{1,3})/g)].map((m) => `${Number(m[1])}|${Number(m[2])}`))];
}

/** Duração da sessão nativa do jogo ("Duração 8h"); 8 se ilegível. */
export function sessionHours(html: string): number {
  const h = Number(/Duração\s*(\d+)\s*h/.exec(html)?.[1] ?? 8);
  return Number.isFinite(h) && h > 0 ? h : 8;
}
