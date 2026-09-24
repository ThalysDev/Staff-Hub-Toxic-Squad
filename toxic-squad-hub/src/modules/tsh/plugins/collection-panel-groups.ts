// Regras por grupo da Coleta — montador VISUAL (v3.6.0). Cada regra é um
// cartão: grupo escolhido pelo NOME (lista do próprio jogo), como coletar
// (retratos dos níveis, Equilibrada ou Não coletar), tempo-alvo com os ícones
// de ataque/defesa do jogo e as tropas do grupo só pelos ícones. Uma frase no
// pé do cartão diz o que a regra faz — sem formato para decorar.

import { icon } from '../../../core/icons';
import { getGroupOptions } from '../tsh-groups';
import { unitIcon, unitLabelOrKey } from '../tsh-units';
import { SCAVENGE_UNITS } from './collection-levels';
import { profileSummary, type GroupMode, type GroupProfile } from './collection-groups';

export const GROUP_RULES_CSS = `
.colg-list { display: flex; flex-direction: column; gap: 10px; }
.colg-card { border: 1px solid var(--shs-border-strong); border-radius: 10px; padding: 10px; background: var(--shs-bg-card); }
.colg-head { display: flex; gap: 8px; align-items: center; }
.colg-head .shs-ic { color: var(--shs-action); flex: none; }
.colg-head select { flex: 1; min-width: 0; }
.colg-del { border: 0; background: transparent; color: var(--shs-muted); cursor: pointer; padding: 4px; border-radius: 6px; }
.colg-del:hover { color: var(--shs-danger); background: var(--shs-danger-bg); }
.colg-lbl { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--shs-muted); margin: 10px 0 5px; }
.colg-modes { display: flex; gap: 6px; flex-wrap: wrap; }
.colg-mode { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px; cursor: pointer; font-size: 10.5px;
  color: var(--shs-muted); width: 52px; text-align: center; }
.colg-mode input { position: absolute; opacity: 0; pointer-events: none; }
.colg-mode-ic { width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; border: 2px solid transparent;
  background: var(--shs-bg-inset) center / cover no-repeat; color: var(--shs-action); opacity: .55; filter: grayscale(.7); }
.colg-mode:has(input:checked) { color: var(--shs-ink-strong); font-weight: 600; }
.colg-mode:has(input:checked) .colg-mode-ic { opacity: 1; filter: none; border-color: var(--shs-action); }
.colg-mode:has(input:focus-visible) .colg-mode-ic { outline: 2px solid var(--shs-brass); }
.colg-mode.skip:has(input:checked) .colg-mode-ic { border-color: var(--shs-danger); color: var(--shs-danger); }
.colg-times { display: flex; gap: 14px; flex-wrap: wrap; }
.colg-time { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--shs-ink); }
.colg-time .tsh-input { width: 88px; }
.colg-units { display: flex; gap: 4px; flex-wrap: wrap; }
.colg-unit { position: relative; cursor: pointer; width: 32px; height: 32px; border-radius: 7px; display: grid; place-items: center;
  border: 1px solid var(--shs-border-strong); background: var(--shs-bg-card); }
.colg-unit input { position: absolute; opacity: 0; pointer-events: none; }
.colg-unit img { opacity: .3; filter: grayscale(1); }
.colg-unit:has(input:checked) { border-color: var(--shs-action); background: var(--shs-bg-inset); }
.colg-unit:has(input:checked) img { opacity: 1; filter: none; }
.colg-unit:has(input:focus-visible) { outline: 2px solid var(--shs-brass); }
.colg-sum { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--shs-border); font-size: 11.5px; color: var(--shs-ink-strong); display: flex; gap: 6px; }
.colg-sum .shs-ic { flex: none; margin-top: 1px; color: var(--shs-action); }
.colg-add { margin-top: 10px; width: 100%; justify-content: center; border-style: dashed !important; }
.colg-empty { font-size: 12px; color: var(--shs-muted); padding: 8px 0; }
.colg-hide { display: none !important; }
.colg-warn { margin: 8px 0; padding: 8px 10px; border-radius: 8px; background: var(--shs-warn-soft, var(--shs-bg-inset)); color: var(--shs-ink-strong); font-size: 12px; line-height: 1.4; }
`;

const MODES: { mode: GroupMode; label: string; level?: number }[] = [
  { mode: 'geral', label: 'Igual ao geral' },
  { mode: 'equilibrada', label: 'Equilibrada' },
  { mode: 'pequena', label: 'Pequena', level: 1 },
  { mode: 'media', label: 'Média', level: 2 },
  { mode: 'grande', label: 'Grande', level: 3 },
  { mode: 'extrema', label: 'Extrema', level: 4 },
  { mode: 'pular', label: 'Não coletar' },
];

interface CardRefs {
  card: HTMLDivElement;
  select: HTMLSelectElement;
  modes: HTMLInputElement[];
  off: HTMLInputElement;
  def: HTMLInputElement;
  units: { unit: string; input: HTMLInputElement }[];
  /** true depois que o usuário mexeu nas tropas DESTE cartão. */
  custom: () => boolean;
  refresh(): void;
}

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function hoursInput(value: number | null, label: string): HTMLInputElement {
  const i = mk('input', 'tsh-input tsh-input--num');
  i.type = 'number';
  i.min = '0';
  i.max = '48';
  i.step = '0.5';
  i.placeholder = 'igual';
  i.value = value === null ? '' : String(value);
  i.setAttribute('aria-label', label);
  return i;
}

export function buildGroupRules(
  initial: readonly GroupProfile[],
  generalSkip: () => ReadonlySet<string>,
): { el: HTMLElement; refreshAll(): void; collect(): { ok: true; profiles: GroupProfile[] } | { ok: false; error: string } } {
  const root = mk('div');
  const intro = mk(
    'div',
    'col-hint',
    'Quer que um grupo de aldeias colete diferente do resto? Ex.: o grupo "Defesa" só na Extrema, ou o grupo "Ataque a caminho" sem coletar. Aldeia em mais de um grupo segue o cartão mais acima. Regras de grupo não usam o Lote fixo.',
  );
  const list = mk('div', 'colg-list');
  const empty = mk('div', 'colg-empty', 'Nenhuma regra: todas as aldeias seguem a configuração acima.');
  const add = mk('button', 'tsh-btn tsh-btn--ghost colg-add');
  add.type = 'button';
  add.append(icon('plus', 12), document.createTextNode('Adicionar regra para um grupo'));
  const warn = mk('div', 'colg-warn colg-hide');
  root.append(intro, warn, empty, list, add);

  const cards: CardRefs[] = [];
  let groupNames: { groupId: number; name: string }[] = initial.map((p) => ({ groupId: p.groupId, name: p.groupName || `Grupo ${p.groupId}` }));
  let groupsState: 'carregando' | 'ok' | 'vazio' | 'erro' = 'carregando';

  const fillSelect = (select: HTMLSelectElement, chosen: number | null): void => {
    select.textContent = '';
    const ph = mk('option', undefined, groupsState === 'carregando' ? 'Carregando grupos do jogo…' : 'Escolha um grupo…');
    ph.value = '';
    select.appendChild(ph);
    for (const g of groupNames) {
      const o = mk('option', undefined, g.name);
      o.value = String(g.groupId);
      select.appendChild(o);
    }
    select.value = chosen === null ? '' : String(chosen);
  };

  const syncEmpty = (): void => {
    empty.classList.toggle('colg-hide', cards.length > 0);
  };

  const addCard = (p: Partial<GroupProfile>): void => {
    const uid = Math.random().toString(36).slice(2, 8);
    const card = mk('div', 'colg-card');
    const head = mk('div', 'colg-head');
    const select = mk('select', 'tsh-input');
    select.setAttribute('aria-label', 'Grupo de aldeias');
    fillSelect(select, p.groupId ?? null);
    const del = mk('button', 'colg-del');
    del.type = 'button';
    del.title = 'Remover esta regra';
    del.setAttribute('aria-label', 'Remover esta regra');
    del.appendChild(icon('trash', 14));
    head.append(icon('users', 14), select, del);

    const modesLbl = mk('div', 'colg-lbl', 'Como coletar');
    const modesWrap = mk('div', 'colg-modes');
    const modes: HTMLInputElement[] = [];
    for (const m of MODES) {
      const lab = mk('label', `colg-mode${m.mode === 'pular' ? ' skip' : ''}`);
      const input = mk('input');
      input.type = 'radio';
      input.name = `colg-mode-${uid}`;
      input.value = m.mode;
      input.checked = (p.mode ?? 'geral') === m.mode;
      const ic = mk('span', 'colg-mode-ic');
      if (m.level !== undefined) ic.style.backgroundImage = `url("graphic/scavenging/options/${m.level}.png")`;
      else ic.appendChild(icon(m.mode === 'pular' ? 'x' : m.mode === 'geral' ? 'check' : 'layers', 16));
      lab.title =
        m.mode === 'geral'
          ? 'Mesma divisão da configuração geral acima'
          : m.mode === 'equilibrada'
            ? 'Todos os níveis livres, voltando juntos'
            : m.mode === 'pular'
              ? 'As aldeias deste grupo não coletam'
              : `Só a ${m.label} Coleta`;
      lab.append(input, ic, mk('span', undefined, m.label));
      modesWrap.appendChild(lab);
      modes.push(input);
    }

    const extra = mk('div');
    const timesLbl = mk('div', 'colg-lbl', 'Voltar em até (vazio = igual ao geral · 0 = sem limite)');
    const times = mk('div', 'colg-times');
    const off = hoursInput(p.hoursOff ?? null, 'Tempo-alvo das ofensivas do grupo');
    const def = hoursInput(p.hoursDef ?? null, 'Tempo-alvo das defensivas do grupo');
    const tOff = mk('label', 'colg-time');
    const imgOff = mk('img');
    imgOff.src = 'graphic/unit/att.png';
    imgOff.alt = imgOff.title = 'Aldeias ofensivas';
    tOff.append(imgOff, off, document.createTextNode('h'));
    const tDef = mk('label', 'colg-time');
    const imgDef = mk('img');
    imgDef.src = 'graphic/unit/def.png';
    imgDef.alt = imgDef.title = 'Aldeias defensivas';
    tDef.append(imgDef, def, document.createTextNode('h'));
    times.append(tOff, tDef);

    const unitsLbl = mk('div', 'colg-lbl', 'Tropas que coletam neste grupo');
    const unitsWrap = mk('div', 'colg-units');
    let custom = p.skipUnits != null;
    const skip = new Set(p.skipUnits ?? [...generalSkip()]);
    const units = SCAVENGE_UNITS.map((unit) => {
      const lab = mk('label', 'colg-unit');
      lab.title = unitLabelOrKey(unit);
      const input = mk('input');
      input.type = 'checkbox';
      input.checked = !skip.has(unit);
      input.setAttribute('aria-label', `${unitLabelOrKey(unit)} coleta neste grupo`);
      input.addEventListener('change', () => {
        custom = true;
      });
      lab.append(input, unitIcon(unit, 22));
      unitsWrap.appendChild(lab);
      return { unit, input };
    });
    extra.append(timesLbl, times, unitsLbl, unitsWrap);

    const sum = mk('div', 'colg-sum');
    const sumTxt = mk('span');
    sum.append(icon('info', 12), sumTxt);

    card.append(head, modesLbl, modesWrap, extra, sum);
    list.appendChild(card);

    const refs: CardRefs = {
      card,
      select,
      modes,
      off,
      def,
      units,
      custom: () => custom,
      refresh: () => {
        const mode = (modes.find((i) => i.checked)?.value ?? 'geral') as GroupMode;
        extra.classList.toggle('colg-hide', mode === 'pular');
        const general = generalSkip();
        if (!custom) for (const u of units) u.input.checked = !general.has(u.unit); // segue as gerais
        const skipNow = units.filter((u) => !u.input.checked).map((u) => u.unit);
        const same = !custom || (skipNow.length === general.size && skipNow.every((u) => general.has(u)));
        const gid = Number(select.value);
        const name = groupNames.find((g) => g.groupId === gid)?.name ?? '';
        const h = (i: HTMLInputElement): number | null => (i.value.trim() === '' ? null : Number(i.value));
        sumTxt.textContent =
          select.value === ''
            ? 'Escolha o grupo para esta regra valer.'
            : profileSummary({ groupId: gid, groupName: name, mode, hoursOff: h(off), hoursDef: h(def), skipUnits: same ? null : skipNow });
      },
    };
    card.addEventListener('input', refs.refresh);
    card.addEventListener('change', refs.refresh);
    del.addEventListener('click', () => {
      const idx = cards.indexOf(refs);
      card.remove();
      cards.splice(idx, 1);
      syncEmpty();
      (cards[idx]?.select ?? add).focus();
      root.dispatchEvent(new Event('change', { bubbles: true }));
    });
    cards.push(refs);
    refs.refresh();
    syncEmpty();
  };

  for (const p of initial) addCard(p);
  add.addEventListener('click', () => {
    addCard({});
    cards[cards.length - 1]?.select.focus();
  });
  syncEmpty();

  // Grupos do jogo pelo nome (cache de 10 min do tsh-groups).
  void getGroupOptions()
    .then((groups) => {
      groupsState = groups.length > 0 ? 'ok' : 'vazio';
      const known = new Map(groupNames.map((g) => [g.groupId, g.name]));
      for (const g of groups) known.set(g.groupId, g.name);
      groupNames = [...known].map(([groupId, name]) => ({ groupId, name }));
    })
    .catch(() => {
      groupsState = 'erro';
    })
    .finally(() => {
      for (const c of cards) {
        fillSelect(c.select, c.select.value === '' ? null : Number(c.select.value));
        c.refresh();
      }
      if (groupsState !== 'ok') {
        warn.classList.remove('colg-hide');
        warn.textContent =
          groupsState === 'vazio'
            ? 'Você ainda não tem grupos de aldeias. Crie em Visualizações → Grupos e reabra esta tela.'
            : 'Não consegui ler seus grupos agora. As regras salvas continuam valendo; tente reabrir em instantes.';
        add.disabled = groupNames.length === 0;
      }
    });

  return {
    el: root,
    refreshAll: () => {
      for (const c of cards) c.refresh();
    },
    collect: () => {
      const out: GroupProfile[] = [];
      const general = generalSkip();
      for (const c of cards) {
        c.select.classList.remove('tsh-input--invalid');
        if (c.select.value === '') {
          c.select.classList.add('tsh-input--invalid');
          c.select.focus();
          return { ok: false, error: 'Regras por grupo: escolha o grupo de cada cartão (ou remova o cartão vazio).' };
        }
        const groupId = Number(c.select.value);
        const name = groupNames.find((g) => g.groupId === groupId)?.name ?? `Grupo ${groupId}`;
        if (out.some((p) => p.groupId === groupId)) {
          c.select.classList.add('tsh-input--invalid');
          c.select.focus();
          return { ok: false, error: `Regras por grupo: o grupo "${name}" aparece em dois cartões. Deixe só um.` };
        }
        const hours = (i: HTMLInputElement, qual: string): number | null | string => {
          if (i.value.trim() === '') return null;
          const v = Number(i.value);
          if (!Number.isFinite(v) || v < 0 || v > 48) {
            i.classList.add('tsh-input--invalid');
            i.focus();
            return `Regras por grupo ("${name}"): "voltar em até" das ${qual} vai de 0 a 48 horas (vazio = igual ao geral).`;
          }
          return v;
        };
        const hOff = hours(c.off, 'ofensivas');
        if (typeof hOff === 'string') return { ok: false, error: hOff };
        const hDef = hours(c.def, 'defensivas');
        if (typeof hDef === 'string') return { ok: false, error: hDef };
        const skip = c.units.filter((u) => !u.input.checked).map((u) => u.unit);
        const mode = (c.modes.find((i) => i.checked)?.value ?? 'geral') as GroupMode;
        if (mode !== 'pular' && skip.length === SCAVENGE_UNITS.length) {
          c.units[0]?.input.focus();
          return { ok: false, error: `Regras por grupo ("${name}"): ligue pelo menos uma tropa, ou escolha "Não coletar".` };
        }
        const sameAsGeneral = !c.custom() || (skip.length === general.size && skip.every((u) => general.has(u)));
        out.push({ groupId, groupName: name, mode, hoursOff: hOff, hoursDef: hDef, skipUnits: sameAsGeneral ? null : skip });
      }
      return { ok: true, profiles: out };
    },
  };
}
