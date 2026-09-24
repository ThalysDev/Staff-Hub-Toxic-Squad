// Tela "Configurar — Cunhagem em massa" (v3.10.0): onde roda, quanto fica em
// casa (reserva fixa por recurso OU % do armazém), teto por aldeia e a
// convivência com a Cunhagem nativa. Ícones do jogo (Academia, ouro, recursos).

import { icon } from '../../../core/icons';
import { gm } from '../../../core/storage';
import type { TshSettingsPanel } from '../tsh-runtime';
import { el, gameImg, invalid, KIT_CSS, note, numInput, radioCard, RES_ICONS, row, section, switchInput } from './panel-kit';

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function buildCoinMassPanel(settings: Record<string, unknown>, world: string): TshSettingsPanel {
  const root = el('div');
  const style = el('style');
  style.textContent = KIT_CSS;
  root.appendChild(style);
  const uid = Math.random().toString(36).slice(2, 8);
  // Quem já usava (sem execMode gravado) segue em "Só na tela" até escolher aqui.
  const raw = gm.get<Record<string, unknown> | null>(`tsh-auto:${world}:coin-center:settings`, null);
  const usedBefore = gm.get<boolean>('tsh-auto:coin-center:enabled', false) || gm.get<unknown>(`tsh-auto:${world}:coin-center:state`, null) !== null;
  const legacyNoMode = (raw !== null && Object.keys(raw).length > 0 && raw.execMode !== 'fundo' && raw.execMode !== 'tela') || ((raw === null || Object.keys(raw).length === 0) && usedBefore);
  const execMode = legacyNoMode || settings.execMode === 'tela' ? 'tela' : 'fundo';

  const top = el('div', 'pk-hero');
  const heroIc = el('div', 'pk-hero-ic');
  heroIc.append(gameImg('graphic/buildings/snob.png', 26, 'Academia'), gameImg('graphic/gold.webp', 22, 'Moedas de ouro'));
  const heroText = el('div', 'pk-hero-text');
  top.append(heroIc, heroText);
  root.appendChild(note('Para cunhar o dia todo, prefira a Cunhagem nativa: o próprio jogo cunha sozinho, 24h. Use esta para cunhar de uma vez o que já está acumulado.', 'coins'));
  if (legacyNoMode) root.appendChild(note('Você segue em "Só na tela da Academia", como antes. Para cunhar em todas as aldeias sem abrir a Academia, escolha "Segundo plano" abaixo.'));

  // ── Onde roda ──
  const where = section('Onde roda', 'layers');
  const cards = el('div', 'pk-cards');
  const fundo = radioCard(`cm-exec-${uid}`, 'fundo', execMode === 'fundo', icon('layers', 16), 'Segundo plano', 'Todas as aldeias de uma vez, pela Cunhagem em massa do jogo (Conta Premium).');
  const tela = radioCard(`cm-exec-${uid}`, 'tela', execMode === 'tela', gameImg('graphic/buildings/snob.png', 20, 'Academia'), 'Só na tela da Academia', 'Só a aldeia aberta, com a Academia na tela. Funciona sem Premium.');
  cards.append(fundo.card, tela.card);
  where.body.appendChild(cards);
  root.appendChild(where.box);

  // ── O que fica em casa ──
  const keep = section('O que fica em casa', 'home');
  const keepPct = num(settings.keepPercent, 0);
  const seg = el('div', 'pk-cards');
  const mFixo = radioCard(`cm-keep-${uid}`, 'fixo', keepPct <= 0, icon('lock', 16), 'Reserva fixa', 'Uma quantia de cada recurso nunca é usada.');
  const mPct = radioCard(`cm-keep-${uid}`, 'pct', keepPct > 0, gameImg('graphic/buildings/storage.png', 20, 'Armazém'), '% dos recursos', 'Deixa uma fatia do que cada aldeia tem de cada recurso.');
  seg.append(mFixo.card, mPct.card);
  const fixBox = el('div');
  const resIns = RES_ICONS.map((r) => {
    const key = r.key === 'wood' ? 'reserveWood' : r.key === 'stone' ? 'reserveStone' : 'reserveIron';
    const input = numInput(num(settings[key], 0), 0, 10_000_000, 1000, `Reserva de ${r.name}`);
    fixBox.appendChild(row(gameImg(r.img, 18, r.name), r.name, 'Fica sempre em cada aldeia (0 = pode usar tudo).', input));
    return { key, name: r.name, input };
  });
  const pctIn = numInput(keepPct > 0 ? keepPct : 20, 1, 90, 5, 'Percentual dos recursos que fica');
  const pctBox = el('div');
  pctBox.appendChild(row(gameImg('graphic/buildings/storage.png', 20, 'Armazém'), '% que fica em cada aldeia', 'Ex.: 20 = de cada recurso, cada aldeia guarda 20% do que tem e cunha com o resto.', pctIn));
  keep.body.append(seg, fixBox, pctBox);
  root.appendChild(keep.box);

  // ── Ritmo ──
  const rit = section('Ritmo', 'activity');
  const perStart = typeof raw?.perVillage === 'number' ? raw.perVillage : typeof raw?.maxCoinsPerCycle === 'number' ? raw.maxCoinsPerCycle : 0;
  const perIn = numInput(perStart, 0, 100, 1, 'Moedas por aldeia por rodada');
  const skip = switchInput(settings.skipNative !== false, 'Pular aldeias com a cunhagem nativa ativa');
  const perRow = row(gameImg('graphic/gold.webp', 18, 'Moedas'), 'Moedas por aldeia por rodada', '0 = o máximo que o jogo deixa. Um número menor espalha a cunhagem ao longo do dia.', perIn);
  const skipRow = row(icon('coins', 18), 'Pular aldeias da Cunhagem nativa', 'Pula as aldeias em que a Cunhagem nativa deste script mantém a sessão do jogo ligada (elas já cunham sozinhas). Sessão ligada à mão, com a Cunhagem nativa desligada, não é detectada.', skip.wrap);
  rit.body.append(perRow, skipRow);
  root.appendChild(rit.box);

  const refresh = (): void => {
    const isFundo = fundo.input.checked;
    const isPct = mPct.input.checked;
    fixBox.classList.toggle('pk-hide', isPct);
    pctBox.classList.toggle('pk-hide', !isPct);
    skipRow.classList.toggle('pk-hide', !isFundo);
    const fmt = (n: number): string => Math.round(n).toLocaleString('pt-BR');
    heroText.textContent = '';
    heroText.append(
      el('b', undefined, isFundo ? 'Segundo plano, todas as aldeias' : 'Só na tela da Academia'),
      document.createElement('br'),
      document.createTextNode(
        isPct
          ? `Fica em casa: ${Number(pctIn.value) || 0}% de cada recurso`
          : resIns.every((r) => (Number(r.input.value) || 0) === 0)
            ? 'Nada reservado (pode usar tudo)'
            : `Fica em casa: ${resIns.map((r) => `${r.name.toLowerCase()} ${fmt(Number(r.input.value) || 0)}`).join(', ')}`,
      ),
      document.createElement('br'),
      document.createTextNode(
        `${Number(perIn.value) > 0 ? `até ${perIn.value} moeda${Number(perIn.value) === 1 ? '' : 's'} por aldeia por rodada` : 'o máximo que o jogo deixar'}${isFundo && skip.input.checked ? ' · pula as aldeias da Cunhagem nativa' : ''}`,
      ),
    );
  };
  root.addEventListener('input', refresh);
  root.addEventListener('change', refresh);
  refresh();

  return {
    el: root,
    top,
    collect: () => {
      for (const i of root.querySelectorAll('.tsh-input--invalid')) i.classList.remove('tsh-input--invalid');
      const values: Record<string, unknown> = { execMode: fundo.input.checked ? 'fundo' : 'tela' };
      for (const r of resIns) {
        const v = Number(r.input.value);
        if (!Number.isInteger(v) || v < 0) return invalid(r.input, `Reserva de ${r.name}: número inteiro, 0 ou mais.`);
        values[r.key] = v;
      }
      if (mPct.input.checked) {
        const p = Number(pctIn.value);
        if (!Number.isInteger(p) || p < 1 || p > 90) return invalid(pctIn, '% que fica: de 1 a 90.');
        values.keepPercent = p;
      } else values.keepPercent = 0;
      const per = Number(perIn.value);
      if (!Number.isInteger(per) || per < 0 || per > 100) return invalid(perIn, 'Moedas por aldeia: de 0 a 100 (0 = o máximo).');
      values.perVillage = per;
      values.skipNative = skip.input.checked;
      return { ok: true, values };
    },
  };
}
