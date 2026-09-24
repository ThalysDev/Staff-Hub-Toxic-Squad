// Tela "Configurar — Cunhagem nativa" (v3.10.0): quais aldeias mantêm a
// cunhagem automática do jogo ligada (coordenadas, grupo ou todas) e de quanto
// em quanto tempo conferir. As coordenadas são checadas contra a lista das
// suas aldeias que o próprio módulo já leu (quando houver).

import { icon } from '../../../core/icons';
import { gm } from '../../../core/storage';
import { getGroupOptions } from '../tsh-groups';
import type { TshSettingsPanel } from '../tsh-runtime';
import { uniqueCoords } from './coin-mass';
import { el, gameImg, invalid, KIT_CSS, note, numInput, radioCard, row, section } from './panel-kit';

/** Configuração antiga (grupo em texto + reativarDias) → formato novo. */
export function migrateNativeSettings(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.alvo !== undefined) return raw;
  const g = Number.parseInt(typeof raw.grupo === 'string' ? raw.grupo : '', 10);
  return Number.isInteger(g) && g > 0 ? { ...raw, alvo: 'grupo', groupId: g } : raw;
}

export function buildNativeMintPanel(settingsIn: Record<string, unknown>, world: string): TshSettingsPanel {
  const rawSaved = gm.get<Record<string, unknown> | null>(`tsh-auto:${world}:auto-mint-nativo:settings`, null);
  const settings = { ...settingsIn, ...(rawSaved !== null ? migrateNativeSettings(rawSaved) : {}) };
  const root = el('div');
  const style = el('style');
  style.textContent = KIT_CSS;
  root.appendChild(style);
  const uid = Math.random().toString(36).slice(2, 8);
  const own = gm.get<{ list: { x: number; y: number; academy: boolean }[] } | null>(`tsh-auto:${world}:auto-mint-nativo:villages`, null);
  const ownCoords = own === null ? null : new Map(own.list.map((v) => [`${v.x}|${v.y}`, v.academy]));

  // ── Resumo ──
  const top = el('div', 'pk-hero');
  const heroIc = el('div', 'pk-hero-ic');
  heroIc.append(gameImg('graphic/buildings/snob.png', 26, 'Academia'), gameImg('graphic/gold.webp', 22, 'Moedas de ouro'));
  const heroText = el('div', 'pk-hero-text');
  top.append(heroIc, heroText);

  root.appendChild(
    note('O próprio jogo cunha: com a "Criação automática" da Academia ligada, cada aldeia cunha uma moeda sempre que junta o custo, durante a sessão do jogo (8h na maioria dos mundos), mesmo com o navegador fechado. O script só religa a sessão quando ela acaba.', 'coins'),
  );
  root.appendChild(note('Precisa de Conta Premium: o script lê suas aldeias pela tela "Cunhar moedas de ouro" da Academia.', 'info'));

  // ── Quais aldeias ──
  const who = section('Aldeias com "Criação automática" sempre ligada', 'map');
  const cards = el('div', 'pk-cards');
  const alvo = settings.alvo === 'grupo' || settings.alvo === 'todas' ? settings.alvo : 'coords';
  const cCoords = radioCard(`nm-alvo-${uid}`, 'coords', alvo === 'coords', icon('crosshair', 16), 'Coordenadas', 'Cole as coordenadas das suas aldeias.');
  const cGrupo = radioCard(`nm-alvo-${uid}`, 'grupo', alvo === 'grupo', icon('users', 16), 'Grupo do jogo', 'Todas as aldeias de um grupo seu.');
  const cTodas = radioCard(`nm-alvo-${uid}`, 'todas', alvo === 'todas', gameImg('graphic/buildings/snob.png', 20, 'Academia'), 'Todas com Academia', 'Toda aldeia sua que tem Academia.');
  cards.append(cCoords.card, cGrupo.card, cTodas.card);

  const coordsBox = el('div');
  const area = el('textarea', 'tsh-input pk-area');
  area.placeholder = 'Ex.: 501|569 501|566 502|570…';
  area.value = uniqueCoords(typeof settings.coords === 'string' ? settings.coords : '').join(' ');
  area.setAttribute('aria-label', 'Coordenadas das aldeias');
  const chip = el('span', 'pk-chip');
  const coordsHint = el('div', 'pk-hint', 'Só aldeias suas. Coordenadas repetidas são removidas ao salvar; qualquer separador serve (espaço, vírgula, linha).');
  coordsBox.append(area, chip, coordsHint);

  const groupBox = el('div');
  const groupSel = el('select', 'tsh-input');
  groupSel.setAttribute('aria-label', 'Grupo do jogo');
  const savedGroup = typeof settings.groupId === 'number' ? settings.groupId : 0;
  const savedGroupName = typeof settings.groupName === 'string' ? settings.groupName : '';
  const fillGroups = (gs: { groupId: number; name: string }[], state: string): void => {
    groupSel.textContent = '';
    const ph = el('option', undefined, state);
    ph.value = '';
    groupSel.appendChild(ph);
    const list = gs.some((g) => g.groupId === savedGroup) || savedGroup <= 0 ? gs : [...gs, { groupId: savedGroup, name: savedGroupName || `Grupo ${savedGroup}` }];
    for (const g of list) {
      const o = el('option', undefined, g.name);
      o.value = String(g.groupId);
      groupSel.appendChild(o);
    }
    groupSel.value = savedGroup > 0 ? String(savedGroup) : '';
  };
  fillGroups([], 'Carregando grupos do jogo…');
  void getGroupOptions()
    .then((gs) => fillGroups(gs.filter((g) => g.groupId > 0).map((g) => ({ groupId: g.groupId, name: g.name })), 'Escolha um grupo…'))
    .catch(() => fillGroups([], 'Não consegui ler os grupos'));
  groupBox.append(groupSel, el('div', 'pk-hint', 'Aldeias do grupo sem Academia são ignoradas automaticamente.'));
  who.body.append(cards, coordsBox, groupBox);
  root.appendChild(who.box);

  // ── Ciclo ──
  const cyc = section('Ciclo', 'clock');
  const checkIn = numInput(typeof settings.checkHours === 'number' ? settings.checkHours : 1, 0.25, 8, 0.25, 'Conferir a cada (horas)');
  cyc.body.append(
    row(icon('refresh', 18), 'Conferir a cada (h)', 'Sessões ligadas pelo script são religadas sozinhas quando terminam. Este intervalo serve para conferir as que você ligou à mão (ou que o jogo encerrou antes). Não há "reiniciar a cada": o script espera a sessão acabar e religa, sem cortar no meio.', checkIn),
  );
  root.appendChild(cyc.box);

  const refresh = (): void => {
    const mode = cGrupo.input.checked ? 'grupo' : cTodas.input.checked ? 'todas' : 'coords';
    coordsBox.classList.toggle('pk-hide', mode !== 'coords');
    groupBox.classList.toggle('pk-hide', mode !== 'grupo');
    const coords = uniqueCoords(area.value);
    const unknown = ownCoords === null ? [] : coords.filter((c) => !ownCoords.has(c));
    const noAcad = ownCoords === null ? [] : coords.filter((c) => ownCoords.get(c) === false);
    const typed = [...area.value.matchAll(/\d{1,3}\|\d{1,3}/g)].length;
    const dup = typed - coords.length;
    chip.textContent =
      `${coords.length} ${coords.length === 1 ? 'aldeia' : 'aldeias'}` +
      (dup > 0 ? ` · ${dup} ${dup === 1 ? 'repetida removida' : 'repetidas removidas'}` : '') +
      (unknown.length > 0 ? ` · ${unknown.length === 1 ? 'não é sua' : 'não são suas'}: ${unknown.slice(0, 3).join(' ')}${unknown.length > 3 ? ' …' : ''}` : '') +
      (noAcad.length > 0 ? ` · ${noAcad.length} sem Academia` : '') +
      (ownCoords === null && coords.length > 0 ? ' · confiro se são suas no primeiro ciclo' : '');
    chip.classList.toggle('pk-chip--warn', unknown.length + noAcad.length > 0);
    const h = Number(checkIn.value);
    heroText.textContent = '';
    heroText.append(
      el('b', undefined, mode === 'todas' ? 'Todas as aldeias com Academia' : mode === 'grupo' ? `Grupo: ${groupSel.selectedOptions[0]?.value ? groupSel.selectedOptions[0].textContent ?? '' : '— escolha —'}` : `${coords.length} ${coords.length === 1 ? 'aldeia' : 'aldeias'} por coordenada`),
      document.createElement('br'),
      document.createTextNode(`Sessão do jogo religada ao acabar · confere as ligadas à mão a cada ${Number.isFinite(h) ? String(h).replace('.', ',') : '?'} h`),
    );
  };
  root.addEventListener('input', refresh);
  root.addEventListener('change', refresh);
  refresh();

  return {
    el: root,
    top,
    hideCooldown: true,
    collect: () => {
      for (const i of root.querySelectorAll('.tsh-input--invalid')) i.classList.remove('tsh-input--invalid');
      const mode = cGrupo.input.checked ? 'grupo' : cTodas.input.checked ? 'todas' : 'coords';
      const coords = uniqueCoords(area.value);
      if (mode === 'coords' && coords.length === 0) return invalid(area, 'Cole pelo menos uma coordenada (ex.: 501|569) ou escolha "Grupo do jogo" / "Todas com Academia".');
      const gid = Number(groupSel.value);
      if (mode === 'grupo' && !(Number.isInteger(gid) && gid > 0)) return invalid(groupSel, 'Escolha o grupo do jogo.');
      const h = Number(checkIn.value);
      if (!Number.isFinite(h) || h < 0.25 || h > 8) return invalid(checkIn, 'Conferir a cada: de 0,25 a 8 horas.');
      return {
        ok: true,
        values: {
          alvo: mode,
          coords: coords.join(' '),
          groupId: mode === 'grupo' ? gid : savedGroup,
          groupName: mode === 'grupo' ? (groupSel.selectedOptions[0]?.textContent ?? '') : savedGroupName,
          checkHours: h,
        },
      };
    },
  };
}
