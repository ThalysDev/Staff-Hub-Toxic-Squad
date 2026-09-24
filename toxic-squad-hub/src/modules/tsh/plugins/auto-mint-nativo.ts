// Cunhagem nativa (v3.10.0) — mantém ligada a "Criação automática" DO JOGO
// (Academia → sessão de 8h: o servidor cunha sozinho sempre que a aldeia junta
// o custo de 1 moeda, mesmo com o navegador fechado). Este módulo NÃO cunha:
// só religa a sessão quando ela acaba.
//
// Verificado no BR142 (24/09/2026, só leitura): a sessão inativa expõe o form
// action=start_auto_minting_session (só o csrf, "Duração 8h"); o que o jogo
// mostra com a sessão ativa não tem o form "Ativar". O módulo antigo procurava
// um campo auto_mint que NÃO existe — nunca ligou nada.
//
// Ciclo (segundo plano, qualquer tela):
//  1. aldeias-alvo: coordenadas coladas, um grupo do jogo ou todas com Academia
//     (a lista de aldeias vem da própria Cunhagem em massa do jogo, cache 1h);
//  2. só confere quem está "na hora": sessão que ELE ligou volta a ser vista
//     quando as 8h acabam; sessão já ativa (ligada por você) é revista a cada
//     "Conferir a cada (h)";
//  3. lê a Academia; inativa → posta o form do jogo e RELÊ para confirmar.

import { z } from 'zod';
import { registerTsh, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { pacedGet } from '../../../core/net';
import { getGroupVillages } from '../tsh-groups';
import { awaitRoutineMutation } from '../tsh-humanize';
import { postGameForm } from './onda5-form-post';
import { parseCoinOverview, parseSnobScreen, sessionHours, uniqueCoords } from './coin-mass';
import { buildNativeMintPanel, migrateNativeSettings } from './auto-mint-panel';
import { parseQueueTime } from './builder-mass';
import { serverNowMs } from '../../../core/game-clock';
import { gm } from '../../../core/storage';

/** Academias lidas por ciclo (cada leitura passa pela fila com pausa humana). */
const MAX_PER_CYCLE = 20;
const HOUR = 3_600_000;

const settingsSchema = z.object({
  alvo: z.enum(['coords', 'grupo', 'todas']).default('coords'),
  coords: z.string().default(''),
  groupId: z.number().int().min(0).default(0),
  groupName: z.string().default(''),
  checkHours: z.number().min(0.25).max(8).default(1),
});
export type NativeMintSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: NativeMintSettings = { alvo: 'coords', coords: '', groupId: 0, groupName: '', checkHours: 1 };

/** Contrato do formulário declarativo (a tela própria substitui na UI). */
const SETTINGS_FORM: SettingsField[] = [
  { key: 'coords', label: 'Coordenadas das aldeias', type: 'textarea', placeholder: 'Ex.: 501|569 501|566 502|570', help: 'Aldeias suas onde a cunhagem automática do jogo fica sempre ligada.' },
  { key: 'checkHours', label: 'Conferir a cada (h)', type: 'number', min: 0.25, max: 8, step: 0.25, help: 'De quanto em quanto tempo o script confere as sessões que ele não ligou.' },
];

export interface OwnVillage {
  id: string;
  x: number;
  y: number;
  academy: boolean;
}

/** Aldeias do jogador (id, coordenada, tem Academia) — da tela de cunhagem em massa, cache 1h. */
async function ownVillages(ctx: TshCycleContext): Promise<{ list: OwnVillage[]; groupId: number } | null> {
  const cached = ctx.storage.get<{ at: number; list: OwnVillage[]; groupId: number } | null>('villages', null);
  if (cached !== null && Date.now() - cached.at < HOUR && cached.list.length > 0) return cached;
  const parsed = parseCoinOverview(await pacedGet(`/game.php?village=${ctx.villageId}&screen=snob&mode=coin&from=-1`, { fresh: true }));
  if (parsed === null) return null;
  const list = parsed.villages.map((v) => ({ id: v.id, x: v.x, y: v.y, academy: v.max !== null }));
  ctx.storage.set('villages', { at: Date.now(), list, groupId: parsed.groupId });
  return { list, groupId: parsed.groupId };
}

/** Ids-alvo + avisos (coordenadas que não são suas, aldeias sem Academia). */
export function resolveTargets(
  settings: NativeMintSettings,
  own: readonly OwnVillage[],
  groupIds: ReadonlySet<string> | null,
): { ids: string[]; unknown: string[]; noAcademy: number } {
  if (settings.alvo === 'todas') return { ids: own.filter((v) => v.academy).map((v) => v.id), unknown: [], noAcademy: 0 };
  if (settings.alvo === 'grupo') {
    const inGroup = own.filter((v) => groupIds?.has(v.id) ?? false);
    return { ids: inGroup.filter((v) => v.academy).map((v) => v.id), unknown: [], noAcademy: inGroup.filter((v) => !v.academy).length };
  }
  const byCoord = new Map(own.map((v) => [`${v.x}|${v.y}`, v]));
  const ids: string[] = [];
  const unknown: string[] = [];
  let noAcademy = 0;
  for (const c of uniqueCoords(settings.coords)) {
    const v = byCoord.get(c);
    if (v === undefined) unknown.push(c);
    else if (!v.academy) noAcademy += 1;
    else ids.push(v.id);
  }
  return { ids, unknown, noAcademy };
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  // Migração lida do salvo CRU (o ctx completa com os padrões e esconderia o formato antigo).
  const rawSaved = gm.get<Record<string, unknown> | null>(`tsh-auto:${ctx.world}:auto-mint-nativo:settings`, null);
  const merged = { ...ctx.storage.get<Record<string, unknown>>('settings', DEFAULT_SETTINGS), ...(rawSaved !== null ? migrateNativeSettings(rawSaved) : {}) };
  const parsed = settingsSchema.safeParse(merged);
  if (!parsed.success) {
    ctx.status('Configurações da Cunhagem nativa inválidas — nada foi feito. Abra Configurar e salve de novo.', 'warn');
    return;
  }
  const s = parsed.data;
  if (s.alvo === 'coords' && uniqueCoords(s.coords).length === 0) {
    ctx.status('Nenhuma aldeia escolhida — abra Configurar e cole as coordenadas (ou escolha um grupo / todas).', 'info');
    return;
  }
  if (s.alvo === 'grupo' && s.groupId <= 0) {
    ctx.status('Nenhum grupo escolhido — abra Configurar e escolha o grupo do jogo.', 'info');
    return;
  }
  const own = await ownVillages(ctx);
  if (own === null) {
    ctx.status('Não consegui ler suas aldeias na tela "Cunhar moedas de ouro" — nada foi feito. Essa lista só aparece com Conta Premium ativa; sem ela, desligue este módulo e use a Cunhagem em massa no modo "Só na tela da Academia".', 'warn');
    return;
  }
  let groupIds: Set<string> | null = null;
  if (s.alvo === 'grupo') {
    const vs = await getGroupVillages(s.groupId);
    if (vs.length === 0) {
      ctx.status(`Não consegui ler as aldeias do grupo "${s.groupName || s.groupId}" (vazio, apagado ou leitura falhou) — nada foi feito.`, 'warn');
      return;
    }
    groupIds = new Set(vs.map((v) => String(v.villageId)));
  }
  const t = resolveTargets(s, own.list, groupIds);
  const notes: string[] = [];
  if (t.unknown.length > 0) notes.push(`${t.unknown.length} ${t.unknown.length === 1 ? 'coordenada não é aldeia sua' : 'coordenadas não são aldeias suas'}${own.groupId !== 0 ? ' (ou estão fora do grupo que o jogo está mostrando)' : ''}: ${t.unknown.slice(0, 3).join(' ')}${t.unknown.length > 3 ? ' …' : ''}.`);
  if (s.alvo === 'todas' && own.groupId !== 0) notes.push('O jogo está mostrando só um grupo de aldeias: "Todas com Academia" cobre só essas (escolha "todos" no menu de grupos do jogo).');
  if (t.noAcademy > 0) notes.push(`${t.noAcademy} ${t.noAcademy === 1 ? 'aldeia sem Academia fica' : 'aldeias sem Academia ficam'} de fora.`);
  if (t.ids.length === 0) {
    ctx.status(`Nenhuma aldeia com Academia entre as escolhidas. ${notes.join(' ')}`.trim(), 'warn');
    return;
  }

  const coordOf = new Map(own.list.map((v) => [v.id, `${v.x}|${v.y}`]));
  const label = (id: string): string => `aldeia ${coordOf.get(id) ?? id}`;
  const now = Date.now();
  const next = Object.fromEntries(Object.entries(ctx.storage.get<Record<string, number>>('next', {})).filter(([id]) => t.ids.includes(id)));
  const due = t.ids.filter((id) => (next[id] ?? 0) <= now);
  /** Sessões ativas conhecidas (até quando) — a Cunhagem em massa pula essas aldeias. */
  const activeUntil = Object.fromEntries(Object.entries(ctx.storage.get<Record<string, number>>('active', {})).filter(([, until]) => until > now));
  let started = 0;
  let active = 0;
  let unreadable = 0;
  let paused = false;
  let sessionCoins = 0;
  const refused: string[] = [];
  /** Recusas seguidas por aldeia: cada uma dobra a espera (teto 24h) — nunca insiste de hora em hora. */
  const strikes = ctx.storage.get<Record<string, number>>('strikes', {});
  /** Até quando a sessão vai, pelo "Fim: …" que o próprio jogo mostra. */
  const endOf = (endsText: string | null): number | null => {
    if (endsText === null) return null;
    const end = parseQueueTime(endsText, serverNowMs());
    return end === null ? null : Date.now() + (end - serverNowMs());
  };
  for (const id of due.slice(0, MAX_PER_CYCLE)) {
    const html = await pacedGet(`/game.php?village=${id}&screen=snob&mode=train`, { fresh: true });
    const screen = parseSnobScreen(html);
    if (screen === null || screen.autoMint.kind === 'desconhecida') {
      unreadable += 1;
      next[id] = now + s.checkHours * HOUR;
      continue;
    }
    if (screen.autoMint.kind === 'ausente') {
      next[id] = now + 12 * HOUR;
      delete activeUntil[id];
      continue;
    }
    if (screen.autoMint.kind === 'ativa') {
      active += 1;
      sessionCoins += screen.autoMint.coins ?? 0;
      delete strikes[id];
      // Sabendo o fim, volta 1 min depois dele; sem o fim, confere no intervalo.
      const end = endOf(screen.autoMint.endsText);
      next[id] = end !== null && end > now ? end + 60_000 : now + s.checkHours * HOUR;
      activeUntil[id] = next[id];
      continue;
    }
    delete activeUntil[id];
    if (!(await awaitRoutineMutation('cunhagem'))) {
      // Pausa (ex.: sono programado): nada de reler a cada minuto.
      next[id] = now + s.checkHours * HOUR;
      paused = true;
      notes.push('Pausa de humanização ativa — as sessões restantes ficam para depois.');
      break;
    }
    const result = await postGameForm(screen.autoMint.startAction, {});
    if (!result.ok) {
      ctx.storage.set('active', activeUntil);
      ctx.status(
        result.afterMutation
          ? `Resultado incerto ao ligar a cunhagem automática (${label(id)}): ${result.message} — parei este ciclo; confiro na próxima leitura, sem repetir às cegas.`
          : `O jogo não aceitou ligar a cunhagem automática (${label(id)}): ${result.message}`,
        'warn',
      );
      next[id] = now + s.checkHours * HOUR;
      ctx.storage.set('next', next);
      return;
    }
    // Confirmação pelo próprio jogo: relê a Academia.
    const after = parseSnobScreen(await pacedGet(`/game.php?village=${id}&screen=snob&mode=train`, { fresh: true }));
    if (after?.autoMint.kind === 'ativa') {
      started += 1;
      delete strikes[id];
      const end = endOf(after.autoMint.endsText);
      next[id] = (end ?? Date.now() + sessionHours(html) * HOUR) + 60_000;
      activeUntil[id] = next[id];
    } else {
      refused.push(id);
      strikes[id] = (strikes[id] ?? 0) + 1;
      next[id] = now + Math.min(24, s.checkHours * 2 ** strikes[id]) * HOUR;
    }
  }
  ctx.storage.set('next', next);
  ctx.storage.set('active', activeUntil);
  ctx.storage.set('strikes', Object.fromEntries(Object.entries(strikes).filter(([id]) => t.ids.includes(id))));
  const left = paused ? 0 : t.ids.filter((id) => (next[id] ?? 0) <= Date.now()).length;
  if (left > 0) ctx.again?.(60_000);
  const soon = Math.min(...t.ids.map((id) => next[id] ?? now));
  const hhmm = new Date(soon).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const parts = [
    started > 0 ? `${started} sessão(ões) ligada(s) agora (confirmado na Academia)` : '',
    active > 0 ? `${active} já estava(m) ativa(s)${sessionCoins > 0 ? ` (${sessionCoins} moeda(s) cunhada(s) pelo jogo nessas sessões até agora)` : ''}` : '',
    refused.length > 0 ? `${refused.length} não ${refused.length === 1 ? 'ligou' : 'ligaram'} (o jogo não confirmou: ${refused.slice(0, 3).map(label).join(', ')})` : '',
    unreadable > 0 ? `não consegui ler a Academia de ${unreadable} aldeia(s)` : '',
  ].filter((p) => p !== '');
  const head = due.length === 0 ? `Cunhagem automática do jogo em dia nas ${t.ids.length} aldeia(s).` : `${parts.join(', ') || 'Nada a ligar agora'}.`;
  ctx.status(
    `${head}${left > 0 ? ' Sigo nas próximas em 1 min.' : ` Próxima conferência às ${hhmm}.`}${notes.length > 0 ? ` ${notes.join(' ')}` : ''}`,
    refused.length > 0 || unreadable > 0 ? 'warn' : started > 0 ? 'ok' : 'info',
  );
}

registerTsh({
  id: 'auto-mint-nativo',
  label: 'Cunhagem nativa',
  desc: '(Recomendado) Mantém ligada a "Criação automática" da Academia — a sessão do próprio jogo — nas aldeias escolhidas, religando quando ela acaba. O jogo cunha sozinho, mesmo com o navegador fechado.',
  category: 'economia',
  screen: null,
  mutating: true,
  cooldownMs: 10 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  settingsPanel: (settings, world) => buildNativeMintPanel(settings, world),
  runCycle,
});
