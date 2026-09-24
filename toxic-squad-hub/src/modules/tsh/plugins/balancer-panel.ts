// Tela "Configurar — Balanceador" (v3.11.0, Super Balanceador). Ideias da
// tela "Balanceador Inteligente" (foco Construção ↔ Armazém, raio, distância,
// reserva de mercadores) + Costache/Shinko, feitas do nosso jeito: modos
// Equilibrar / Abastecer e prioridades com ícones do jogo. (A prévia
// "Simular" ficou para depois, a pedido do dono.)

import { icon } from '../../../core/icons';
import { getGroupOptions } from '../tsh-groups';
import type { TshSettingsPanel } from '../tsh-runtime';
import { uniqueCoords } from './coin-mass';
import { el, gameImg, invalid, KIT_CSS, note, numInput, radioCard, row, section, switchInput } from './panel-kit';
import { BALANCER_DEFAULTS, balancerSchema, type BalancerSettings } from './super-balancer';

const CSS = `
.sb-focus { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 6px 0 2px; }
.sb-focus-end { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 11px; font-weight: 600; color: var(--shs-ink-strong); min-width: 76px; }
.sb-focus-end b { font-size: 10.5px; color: var(--shs-muted); font-weight: 600; }
.sb-focus input[type=range] { width: 100%; accent-color: var(--shs-action); }
.sb-presets { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.sb-preset { border: 1px solid var(--shs-border-strong); background: var(--shs-bg-card); color: var(--shs-ink); border-radius: 99px; font-size: 12px; padding: 3px 11px; cursor: pointer; }
.sb-preset:hover, .sb-preset[aria-pressed='true'] { border-color: var(--shs-action); color: var(--shs-action); }
.sb-preset[aria-pressed='true'] { font-weight: 600; box-shadow: inset 0 0 0 1px var(--shs-action); }
`;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function buildBalancerPanel(settingsIn: Record<string, unknown>): TshSettingsPanel {
  const parsed = balancerSchema.safeParse(settingsIn);
  const s: BalancerSettings = parsed.success ? parsed.data : BALANCER_DEFAULTS;
  const root = el('div');
  const style = el('style');
  style.textContent = KIT_CSS + CSS;
  root.appendChild(style);
  const uid = Math.random().toString(36).slice(2, 8);

  const top = el('div', 'pk-hero');
  const heroIc = el('div', 'pk-hero-ic');
  heroIc.append(gameImg('graphic/buildings/market.png', 26, 'Mercado'), gameImg('graphic/buildings/storage.png', 24, 'Armazém'));
  const heroText = el('div', 'pk-hero-text');
  top.append(heroIc, heroText);
  if (settingsIn.v311 !== true) {
    const old = typeof settingsIn.targetCoordsText === 'string' || typeof settingsIn.receiverX === 'number';
    root.appendChild(
      note(
        old
          ? 'Novo na 3.11: o Balanceador agora roda em segundo plano em todas as aldeias e envia pelo "Pedido" do Mercado (várias origens de uma vez). Confira abaixo e salve para ativar — até lá ele não envia nada.'
          : 'Ainda não ativo: confira as opções e clique em Salvar. Nada é enviado antes disso.',
        'info',
        true,
      ),
    );
  }

  // ── Modo ──
  const modeSec = section('O que fazer', 'swap');
  const cards = el('div', 'pk-cards');
  const cEq = radioCard(`sb-mode-${uid}`, 'equilibrar', s.mode === 'equilibrar', gameImg('graphic/buildings/storage.png', 20, 'Armazém'), 'Equilibrar', 'Tira de quem sobra e leva para quem falta, em todas as aldeias.');
  const cAb = radioCard(`sb-mode-${uid}`, 'abastecer', s.mode === 'abastecer', icon('target', 16), 'Abastecer aldeias', 'Enche aldeias escolhidas (ex.: a da cunhagem) com recursos das vizinhas.');
  cards.append(cEq.card, cAb.card);
  modeSec.body.appendChild(cards);
  root.appendChild(modeSec.box);

  // ── Abastecer ──
  const abSec = section('Quem recebe', 'target');
  const abCards = el('div', 'pk-cards');
  const aCoords = radioCard(`sb-alvo-${uid}`, 'coords', s.alvo !== 'grupo', icon('crosshair', 16), 'Coordenadas', 'Cole as coordenadas das aldeias que recebem.');
  const aGrupo = radioCard(`sb-alvo-${uid}`, 'grupo', s.alvo === 'grupo', icon('users', 16), 'Grupo do jogo', 'Todas as aldeias de um grupo seu.');
  abCards.append(aCoords.card, aGrupo.card);
  const area = el('textarea', 'tsh-input pk-area');
  area.placeholder = 'Ex.: 501|569 501|566';
  area.value = uniqueCoords(s.targetCoords).join(' ');
  area.setAttribute('aria-label', 'Coordenadas das aldeias que recebem');
  const chip = el('span', 'pk-chip');
  const coordsBox = el('div');
  coordsBox.append(area, chip);
  const groupSel = el('select', 'tsh-input');
  groupSel.setAttribute('aria-label', 'Grupo do jogo');
  const fillGroups = (gs: { groupId: number; name: string }[], ph: string): void => {
    groupSel.textContent = '';
    const o0 = el('option', undefined, ph);
    o0.value = '';
    groupSel.appendChild(o0);
    const list = s.groupId > 0 && !gs.some((g) => g.groupId === s.groupId) ? [...gs, { groupId: s.groupId, name: s.groupName || `Grupo ${s.groupId}` }] : gs;
    for (const g of list) {
      const o = el('option', undefined, g.name);
      o.value = String(g.groupId);
      groupSel.appendChild(o);
    }
    groupSel.value = s.groupId > 0 ? String(s.groupId) : '';
  };
  const exSel = el('select', 'tsh-input');
  exSel.setAttribute('aria-label', 'Grupo fora do balanceamento');
  const fillEx = (gs: { groupId: number; name: string }[], ph: string): void => {
    exSel.textContent = '';
    const o0 = el('option', undefined, ph);
    o0.value = '';
    exSel.appendChild(o0);
    const list = s.excludeGroupId > 0 && !gs.some((g) => g.groupId === s.excludeGroupId) ? [...gs, { groupId: s.excludeGroupId, name: s.excludeGroupName || `Grupo ${s.excludeGroupId}` }] : gs;
    for (const g of list) {
      const o = el('option', undefined, g.name);
      o.value = String(g.groupId);
      exSel.appendChild(o);
    }
    exSel.value = s.excludeGroupId > 0 ? String(s.excludeGroupId) : '';
  };
  fillGroups([], 'Carregando grupos do jogo…');
  fillEx([], 'Carregando grupos do jogo…');
  void getGroupOptions()
    .then((gs) => {
      const list = gs.filter((g) => g.groupId > 0).map((g) => ({ groupId: g.groupId, name: g.name }));
      fillGroups(list, 'Escolha um grupo…');
      fillEx(list, 'Nenhum — todas participam');
    })
    .catch(() => {
      fillGroups([], 'Não consegui ler os grupos');
      fillEx([], 'Não consegui ler os grupos');
    });
  const groupBox = el('div');
  groupBox.appendChild(groupSel);
  const fillIn = numInput(s.fillPct, 10, 95, 5, 'Encher até (% do armazém)');
  const coin = switchInput(s.coinRatio, 'Na proporção da moeda');
  abSec.body.append(
    abCards,
    coordsBox,
    groupBox,
    row(gameImg('graphic/buildings/storage.png', 20, 'Armazém'), 'Encher até (% do armazém)', 'Cada aldeia escolhida recebe até ficar com este % do armazém em cada recurso.', fillIn),
    row(gameImg('graphic/gold.webp', 20, 'Moeda de ouro'), 'Na proporção da moeda', 'Para aldeia de cunhagem: enche madeira, argila e ferro na proporção do custo da moeda (28/30/25), sem sobrar recurso parado.', coin.wrap),
  );
  root.appendChild(abSec.box);

  // ── Foco (Equilibrar) ──
  const focusSec = section('Foco do balanceamento', 'target');
  const focusWrap = el('div', 'sb-focus');
  const left = el('div', 'sb-focus-end');
  left.append(gameImg('graphic/buildings/main.png', 26, 'Construção'), document.createTextNode('Construção'));
  const leftPct = el('b');
  left.appendChild(leftPct);
  const range = el('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.step = '5';
  range.value = String(s.focus);
  range.setAttribute('aria-label', 'Foco: construção ou armazém');
  const right = el('div', 'sb-focus-end');
  right.append(gameImg('graphic/buildings/storage.png', 26, 'Armazém'), document.createTextNode('Armazém'));
  const rightPct = el('b');
  right.appendChild(rightPct);
  focusWrap.append(left, range, right);
  const focusHint = el('div', 'pk-hint');
  const presets = el('div', 'sb-presets');
  const PRESETS: { name: string; title: string; v: { focus: number; radius: number; maxDistance: number; keepPct: number } }[] = [
    { name: 'Crescimento', title: 'Prioriza a construção e busca recurso mais longe.', v: { focus: 70, radius: 20, maxDistance: 50, keepPct: 30 } },
    { name: 'Equilibrado', title: 'Meio a meio entre construção e armazéns.', v: { focus: 50, radius: 15, maxDistance: 30, keepPct: 20 } },
    { name: 'Guerra', title: 'Mexe pouco e só entre vizinhas; guarda mais em casa.', v: { focus: 30, radius: 10, maxDistance: 20, keepPct: 40 } },
  ];
  for (const p of PRESETS) {
    const b = el('button', 'sb-preset', p.name);
    b.type = 'button';
    b.title = `${p.title} (foco ${p.v.focus}%, busca primeiro até ${p.v.radius} campos, máximo ${p.v.maxDistance} campos, prontas guardam ${p.v.keepPct}%)`;
    b.addEventListener('click', () => {
      range.value = String(p.v.focus);
      radiusIn.value = String(p.v.radius);
      maxIn.value = String(p.v.maxDistance);
      keepIn.value = String(p.v.keepPct);
      presetHint.textContent = `${p.name} aplicado: foco ${p.v.focus}%, busca primeiro até ${p.v.radius} campos, máximo ${p.v.maxDistance}, prontas guardam ${p.v.keepPct}%.`;
      refresh();
    });
    presets.appendChild(b);
  }
  const presetHint = el('div', 'pk-hint');
  presetHint.setAttribute('aria-live', 'polite');
  focusSec.body.append(el('div', 'pk-hint', 'Atalhos (você pode ajustar depois):'), presets, presetHint, focusWrap, focusHint);
  root.appendChild(focusSec.box);

  // ── Prioridades ──
  const prSec = section('Prioridades', 'zap');
  const smallIn = numInput(s.smallPoints, 0, 20_000, 100, 'Aldeias pequenas: abaixo de (pontos)');
  const smallFill = numInput(s.smallFillPct, 10, 95, 5, 'Pequenas recebem até (% do armazém)');
  const keepIn = numInput(s.keepPct, 0, 90, 5, 'Prontas guardam (% do armazém)');
  const eqOnly = el('div');
  eqOnly.append(
    row(gameImg('graphic/buildings/main.png', 22, 'Aldeia pequena'), 'Aldeias pequenas: abaixo de (pontos)', 'Recebem primeiro, até o % abaixo. 0 = sem prioridade para pequenas.', smallIn),
    row(gameImg('graphic/buildings/storage.png', 22, 'Armazém'), 'Pequenas recebem até (% do armazém)', 'Quanto o armazém de uma aldeia pequena pode encher.', smallFill),
  );
  const keepRow = row(gameImg('graphic/buildings/farm.png', 22, 'Fazenda'), 'Aldeias prontas guardam (% do armazém)', 'Aldeia com a fazenda cheia (não cresce mais) fica só com este % e doa o resto.', keepIn);
  const keepTitle = keepRow.querySelector('.pk-row-l > span');
  const setKeepLabel = (abastecer: boolean): void => {
    if (keepTitle === null) return;
    keepTitle.textContent = abastecer ? 'Doadoras ficam com (% do armazém)' : 'Aldeias prontas guardam (% do armazém)';
    keepTitle.appendChild(el('small', undefined, abastecer ? 'Cada aldeia que doa guarda este % e manda o resto para as escolhidas.' : 'Aldeia com a fazenda cheia (não cresce mais) fica só com este % e doa o resto.'));
  };
  const exRow = row(icon('lock', 18), 'Fora do balanceamento', 'Aldeias deste grupo nunca doam nem recebem (ex.: sob ataque, fazendo nobres).', exSel);
  prSec.body.append(eqOnly, keepRow, exRow);
  root.appendChild(prSec.box);

  // ── Alcance e mercadores ──
  const alSec = section('Alcance e mercadores', 'map');
  const radiusIn = numInput(s.radius, 1, 999, 1, 'Buscar primeiro até (campos)');
  const maxIn = numInput(s.maxDistance, 1, 999, 1, 'Distância máxima (campos)');
  const resIn = numInput(s.reserveMerchants, 0, 300, 1, 'Reservar mercadores');
  const perIn = numInput(s.perCycle, 1, 100, 1, 'Aldeias que recebem por ciclo');
  alSec.body.append(
    row(icon('crosshair', 18), 'Buscar primeiro até (campos)', 'Doadoras mais perto têm preferência; só depois vai até a distância máxima.', radiusIn),
    row(icon('map', 18), 'Distância máxima (campos)', 'Nunca manda recurso de mais longe que isto.', maxIn),
    row(gameImg('graphic/buildings/market.png', 20, 'Mercado'), 'Reservar mercadores', 'Mercadores que ficam sempre em casa em cada aldeia.', resIn),
    row(icon('send', 18), 'Aldeias que recebem por ciclo', 'Um "Pedido" por aldeia, com pausa humana entre eles. Sobrou? Continua em 1 min.', perIn),
  );
  root.appendChild(alSec.box);

  root.appendChild(el('div', 'pk-hint', 'Este balanceador usa só mercadores: não gasta Pontos Premium nem aceita ofertas do Mercado.'));

  // ── Avançado ──
  const adv = el('details', 'tsh-section');
  adv.appendChild(el('summary', undefined, 'Avançado'));
  const capIn = numInput(s.capPct, 50, 100, 5, 'Teto do armazém (%)');
  const minIn = numInput(s.minTransfer, 1000, 100_000, 1000, 'Envio mínimo (recursos)');
  adv.append(
    row(gameImg('graphic/buildings/storage.png', 20, 'Armazém'), 'Teto do armazém (%)', 'Nenhuma aldeia recebe além disto (para a produção não transbordar).', capIn),
    row(icon('package', 18), 'Envio mínimo (recursos)', 'Ignora envios menores que isto (sempre em múltiplos de 1.000, um mercador cheio).', minIn),
  );
  root.appendChild(adv);

  const current = (): Record<string, unknown> => ({
    mode: cAb.input.checked ? 'abastecer' : 'equilibrar',
    alvo: aGrupo.input.checked ? 'grupo' : 'coords',
    targetCoords: uniqueCoords(area.value).join(' '),
    groupId: Number(groupSel.value) || 0,
    groupName: groupSel.selectedOptions[0]?.value ? (groupSel.selectedOptions[0].textContent ?? '') : '',
    fillPct: Number(fillIn.value),
    coinRatio: coin.input.checked,
    excludeGroupId: Number(exSel.value) || 0,
    excludeGroupName: exSel.selectedOptions[0]?.value ? (exSel.selectedOptions[0].textContent ?? '') : '',
    focus: Number(range.value),
    smallPoints: Number(smallIn.value),
    smallFillPct: Number(smallFill.value),
    keepPct: Number(keepIn.value),
    reserveMerchants: Number(resIn.value),
    maxDistance: Number(maxIn.value),
    radius: Number(radiusIn.value),
    capPct: Number(capIn.value),
    perCycle: Number(perIn.value),
    minTransfer: Number(minIn.value),
  });

  const refresh = (): void => {
    const ab = cAb.input.checked;
    abSec.box.classList.toggle('pk-hide', !ab);
    focusSec.box.classList.toggle('pk-hide', ab);
    eqOnly.classList.toggle('pk-hide', ab);
    coordsBox.classList.toggle('pk-hide', aGrupo.input.checked);
    groupBox.classList.toggle('pk-hide', !aGrupo.input.checked);
    const f = Number(range.value);
    leftPct.textContent = `${f}%`;
    rightPct.textContent = `${100 - f}%`;
    focusHint.textContent =
      f >= 100
        ? 'Só construção: cada aldeia recebe o que falta para o próximo passo da fila do Construtor.'
        : f <= 0
          ? 'Só armazém: iguala os armazéns (todas perto da média).'
          : `Construção ${f}%: prioriza o próximo passo da fila do Construtor. Armazém ${100 - f}%: aproxima os armazéns da média.`;
    focusHint.textContent += ' Sem fila no Construtor, o lado Construção não tem efeito — vale só o equilíbrio dos armazéns.';
    const n = uniqueCoords(area.value).length;
    chip.textContent = n === 0 ? 'Nenhuma coordenada ainda' : `${n} ${n === 1 ? 'aldeia' : 'aldeias'}`;
    chip.classList.toggle('pk-chip--warn', n === 0);
    setKeepLabel(ab);
    range.setAttribute('aria-valuetext', `Construção ${f}%, armazém ${100 - f}%`);
    for (const b of presets.querySelectorAll<HTMLButtonElement>('.sb-preset')) {
      const p = PRESETS.find((x) => x.name === b.textContent);
      const on = p !== undefined && Number(range.value) === p.v.focus && Number(radiusIn.value) === p.v.radius && Number(maxIn.value) === p.v.maxDistance && Number(keepIn.value) === p.v.keepPct;
      b.setAttribute('aria-pressed', String(on));
    }
    heroText.textContent = '';
    heroText.append(
      el('b', undefined, ab ? `Abastecer ${aGrupo.input.checked ? (groupSel.selectedOptions[0]?.value ? `o grupo "${groupSel.selectedOptions[0].textContent ?? ''}"` : 'um grupo') : `${n} ${n === 1 ? 'aldeia' : 'aldeias'}`} até ${fillIn.value}%` : `Equilibrar · construção ${f}% / armazém ${100 - f}%`),
      document.createElement('br'),
      document.createTextNode(`Segundo plano, a cada 30 min (Agenda), todas as aldeias · busca primeiro até ${radiusIn.value} campos, máximo ${maxIn.value} · ${perIn.value} aldeia(s) por ciclo`),
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
      const v = current();
      const checks: [HTMLInputElement, number, number, string][] = [
        [fillIn, 10, 95, 'Encher até: de 10 a 95%.'],
        [smallIn, 0, 20_000, 'Aldeias pequenas: de 0 a 20.000 pontos.'],
        [smallFill, 10, 95, 'Pequenas recebem até: de 10 a 95%.'],
        [keepIn, 0, 90, 'Prontas guardam: de 0 a 90%.'],
        [radiusIn, 1, 999, 'Raio das vizinhas: de 1 a 999 campos.'],
        [maxIn, 1, 999, 'Distância máxima: de 1 a 999 campos.'],
        [resIn, 0, 300, 'Reservar mercadores: de 0 a 300.'],
        [perIn, 1, 100, 'Aldeias por ciclo: de 1 a 100.'],
        [capIn, 50, 100, 'Teto do armazém: de 50 a 100%.'],
        [minIn, 1000, 100_000, 'Envio mínimo: de 1.000 a 100.000.'],
      ];
      const ab = v.mode === 'abastecer';
      for (const [input, min, max, msg] of checks) {
        if (ab && (input === smallIn || input === smallFill)) continue;
        if (!ab && input === fillIn) continue;
        if (input.value.trim() === '') return invalid(input, msg);
        const n = Number(input.value);
        if (!Number.isFinite(n) || n < min || n > max) return invalid(input, msg);
      }
      if (Number(radiusIn.value) > Number(maxIn.value)) return invalid(radiusIn, 'O raio das vizinhas não pode ser maior que a distância máxima.');
      if (v.mode === 'abastecer') {
        if (v.alvo === 'coords' && uniqueCoords(area.value).length === 0) return invalid(area, 'Abastecer: cole pelo menos uma coordenada de aldeia sua (ou escolha um grupo).');
        if (v.alvo === 'grupo' && !(num(v.groupId, 0) > 0)) return invalid(groupSel, 'Abastecer: escolha o grupo do jogo.');
      }
      return { ok: true, values: { ...v, v311: true } };
    },
  };
}
