// Shell de UI: mini-botão flutuante + painel "Nexus" em Shadow DOM (isolamento
// total do CSS do jogo) — janela premium em pergaminho com cabeçalho de marca,
// sidebar de navegação vertical (seções registradas por módulo), conteúdo com
// scroll próprio e faixa de licença no rodapé. PT-BR.

import { licenseState } from './license';
import { gameContextFrom, pageWindow } from './page';
import { gm } from './storage';
import { icon, type IconName } from './icons';
import { shellStyles } from './shell-styles';
import { isHalted } from './halt';

export interface SectionDef {
  id: string;
  label: string;
  /** Ícone da aba (catálogo core/icons.ts). */
  icon?: IconName;
  /** Só ativa nesta screen do jogo (undefined = todas). */
  matchScreen?: string;
  /**
   * Desenha a seção. Pode devolver uma função de LIMPEZA (timers de
   * atualização ao vivo etc.) — o shell a chama ao trocar de seção, ao
   * re-renderizar e ao fechar o painel (Onda B: nada de timer órfão).
   */
  render: (container: HTMLElement) => void | (() => void);
  /** Contador curto na barra lateral (ex.: "12"); null/'' = sem contador. */
  badge?: () => string | null;
}

const sections: SectionDef[] = [];

export function registerSection(section: SectionDef): void {
  sections.push(section);
}

/** Fecha o painel a partir do conteúdo (ex.: ferramenta aberta na página). */
let panelCloser: (() => void) | null = null;
export function closePanel(): void {
  panelCloser?.();
}

/** Troca de seção a partir do CONTEÚDO (ex.: "Abrir Comandos" na Início). */
let sectionSwitcher: ((sectionId: string) => void) | null = null;
export function openSection(sectionId: string): void {
  sectionSwitcher?.(sectionId);
}

// ── Busca rápida (Onda 6): provedores registram entradas; o shell desenha ──

export interface SearchEntry {
  /** id estável da entrada (dedupe/teclas). */
  id: string;
  /** Texto principal exibido. */
  label: string;
  /** Contexto curto (ex.: "Suite Vanta", "Automações"). */
  hint?: string;
  /** Seção do painel para onde o clique navega. */
  sectionId: string;
  icon?: IconName;
  /** Termos extra para casar (ex.: desc da automação). */
  keywords?: string;
  /**
   * Alvo dentro da seção (Onda C): elemento com `data-search-id` igual a
   * este valor é rolado até a vista e destacado após a navegação.
   */
  targetId?: string;
  /** Prepara a seção antes de navegar (ex.: tirar filtro que esconde o alvo). */
  beforeNavigate?: () => void;
}

const searchEntries = new Map<string, SearchEntry>();

export function registerSearchEntries(entries: SearchEntry[]): void {
  for (const entry of entries) searchEntries.set(entry.id, entry);
}

/** Normaliza p/ busca: minúsculas sem acentos (ç→c, ã→a…). */
function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

let panelOpen = false;
const PANEL_OPEN_KEY = 'shs-in-game:panel-open';
const LAST_SECTION_KEY = 'shs-in-game:last-section';

/** Alvo de digitação (campo de texto/número, select, textarea, contenteditable)? */
function isEditableTarget(node: EventTarget | undefined): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true;
  if (node instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(node.type);
  }
  return false;
}

/**
 * Host PRÓPRIO do Toxic Squad Hub. Antes era 'shs-in-game-host' — o MESMO id
 * do Staff Hub In-Game: com os dois instalados, quem carregava depois achava
 * o painel do outro, "reabria" o painel da Staff e nunca montava o seu.
 */
export const TSH_HOST_ID = 'tsh-hub-host';

/**
 * Onda B — isolamento do teclado: fora do Shadow DOM o evento de tecla chega
 * "reapontado" para o host, então os ATALHOS DO JOGO não percebem que você
 * está digitando no painel (cada letra podia disparar um atalho). Tecla
 * digitada num campo do painel para no host; Esc e combinações com Ctrl/⌘
 * seguem (fechar diálogos, Ctrl+K).
 */
function isolateKeyboard(host: HTMLElement): void {
  const stop = (event: Event): void => {
    const key = event as KeyboardEvent;
    // Esc/Tab seguem (diálogos e foco preso); Ctrl/⌘ são comandos — exceto
    // AltGr (teclado ABNT2 reporta ctrlKey no AltGr+Q = "/").
    const comando = (key.ctrlKey || key.metaKey) && !key.getModifierState('AltGraph');
    if (key.key === 'Escape' || key.key === 'Tab' || comando) return;
    if (isEditableTarget(event.composedPath()[0])) event.stopPropagation();
  };
  for (const type of ['keydown', 'keypress', 'keyup']) host.addEventListener(type, stop);
}

/**
 * Onda C — alerta no botão flutuante: com texto, o escudo pulsa em latão e o
 * rótulo acessível/tooltip dizem o motivo (ex.: cravado chegando); null limpa.
 */
export function setFabAlert(text: string | null, kind: 'aim' | 'halt' = 'aim'): void {
  const fab = document.getElementById(TSH_HOST_ID)?.shadowRoot?.querySelector<HTMLButtonElement>('.shs-fab');
  if (fab === null || fab === undefined) return;
  // Só escreve quando muda (leitores de tela não re-anunciam a cada segundo).
  if ((fab.getAttribute('data-tip') ?? null) === text && fab.classList.contains('shs-fab--halt') === (kind === 'halt')) return;
  fab.classList.toggle('shs-fab--alert', text !== null && kind === 'aim');
  // Pausa (disjuntor) em VERMELHO: nunca confundir com o aviso dourado de cravado.
  fab.classList.toggle('shs-fab--halt', text !== null && kind === 'halt');
  if (text !== null) {
    fab.setAttribute('data-tip', text);
    fab.setAttribute('aria-label', `Abrir Toxic Squad Hub — ${text}`);
  } else {
    fab.removeAttribute('data-tip');
    fab.setAttribute('aria-label', 'Abrir Toxic Squad Hub');
  }
}

export function currentScreen(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('screen') ?? 'overview';
}

export function gameContext(): { player: string; world: string; villageId: string } {
  return gameContextFrom(pageWindow().game_data);
}

function styles(): string {
  return shellStyles();
}

/** Cria o host+estilo se ainda não existem e devolve o ShadowRoot
 *  (P0 da revisão: main.ts criava o host antes, o que fazia o mountShell
 *  retornar cedo e o shell NUNCA montar). */
export function ensureHost(): ShadowRoot {
  let host = document.getElementById(TSH_HOST_ID);
  if (host === null) {
    host = document.createElement('div');
    host.id = TSH_HOST_ID;
    document.body.appendChild(host);
  }
  if (host.shadowRoot === null) {
    isolateKeyboard(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles();
    shadow.appendChild(style);
  }
  return host.shadowRoot as ShadowRoot;
}

export function mountShell(): void {
  const shadow = ensureHost();
  // [11] Momento autoral único do shell: classe efêmera de entrada do painel
  // (keyframes shs-open — opacity+scale, 140ms), removida no animationend.
  const animarAbertura = (alvo: HTMLElement): void => {
    alvo.classList.remove('shs-open');
    void alvo.offsetWidth; // força reflow para reiniciar a animação em reaberturas
    alvo.classList.add('shs-open');
  };
  const painelExistente = shadow.querySelector('.shs-panel');
  if (painelExistente !== null) {
    // Já montado: só garante visível (sincronizar o estado — senão o 1º
    // clique no FAB seria no-op).
    const existente = painelExistente as HTMLElement;
    existente.style.display = 'flex';
    panelOpen = true;
    animarAbertura(existente);
    return;
  }

  const ctx = gameContext();

  const fab = document.createElement('button');
  fab.className = 'shs-fab';
  fab.type = 'button';

  fab.setAttribute('aria-label', 'Abrir Toxic Squad Hub');
  fab.appendChild(icon('shield', 22));
  fab.addEventListener('click', () => {
    setPanelOpen(!panelOpen);
  });
  shadow.appendChild(fab);

  const panel = document.createElement('div');
  // .shs-panel--app = janela do hub com tamanho fixo (~1060×720); o diálogo de
  // ativação usa .shs-panel puro e não é afetado.
  panel.className = 'shs-panel shs-panel--app';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Toxic Squad Hub');
  // Onda B: o painel LEMBRA se estava aberto ou fechado (antes reabria sobre o
  // jogo a cada troca de página). 1º uso = aberto.
  panelOpen = gm.get<boolean>(PANEL_OPEN_KEY, true);
  panel.style.display = panelOpen ? 'flex' : 'none';
  // [11] Entrada animada no 1º mount (e a classe se remove sozinha ao terminar).
  panel.addEventListener('animationend', (event) => {
    if (event.target === panel && event.animationName === 'shs-open') panel.classList.remove('shs-open');
    if (event.target === panel && event.animationName === 'shs-open-max') panel.classList.remove('shs-open');
  });
  if (panelOpen) animarAbertura(panel);
  // Preferência de tamanho persistida (maximizado entre sessões).
  const maximizarPref = gm.get<boolean>('shs-in-game:panel-max', false);
  if (maximizarPref) panel.classList.add('shs-panel--max');
  // Posição arrastada persistida (restaurada no tamanho normal).
  const POS_KEY = 'shs-in-game:panel-pos';
  /** Mantém a posição dentro da janela (Onda C: monitor/janela menor escondia o painel). */
  const clampPos = (left: number, top: number): { l: number; t: number } => {
    const width = panel.offsetWidth || Math.min(1060, window.innerWidth - 24);
    return {
      l: Math.min(Math.max(4, left), Math.max(4, window.innerWidth - width - 4)),
      // v3.2.1: a janela inteira cabe (antes só 60 px ficavam garantidos).
      t: Math.min(Math.max(4, top), Math.max(4, window.innerHeight - (panel.offsetHeight || 720) - 4)),
    };
  };
  const restorePanelPos = (): void => {
    const pos = gm.get<{ l: number; t: number } | null>(POS_KEY, null);
    if (pos === null || !Number.isFinite(pos.l) || !Number.isFinite(pos.t)) return;
    const safe = clampPos(pos.l, pos.t);
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${safe.l}px`;
    panel.style.top = `${safe.t}px`;
  };
  window.addEventListener('resize', () => {
    if (!panel.classList.contains('shs-panel--max') && panel.style.top !== '') restorePanelPos();
  });
  restorePanelPos();
  shadow.appendChild(panel);

  // ===== Header: badge chocolate + wordmark + contexto + botões-ícone =====
  const head = document.createElement('div');
  head.className = 'shs-head';
  const badge = document.createElement('span');
  badge.className = 'shs-brand-badge';
  badge.appendChild(icon('shield', 17));
  const headTxt = document.createElement('span');
  headTxt.className = 'shs-head-txt';
  const strong = document.createElement('strong');
  strong.textContent = 'Toxic Squad Hub';
  const sub = document.createElement('span');
  sub.className = 'shs-head-sub';
  sub.textContent = `${ctx.world.toUpperCase()} · v${__SHS_VERSION__}`;
  headTxt.append(strong, sub);
  head.append(badge, headTxt);
  // Busca rápida logo após a marca (Onda B: antes ficava à direita do X).
  const searchWrap = document.createElement('div');
  searchWrap.className = 'shs-searchwrap';
  head.appendChild(searchWrap);

  // Maximizar/restaurar (⤢): painel largo persistido em GM storage.
  const maximize = document.createElement('button');
  maximize.className = 'shs-headbtn';
  maximize.type = 'button';
  maximize.setAttribute('data-max', 'true');
  const defineMax = (max: boolean): void => {
    panel.classList.toggle('shs-panel--max', max);
    // Posição arrastada só vale no tamanho normal — maximizado é centrado.
    if (max) {
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
    } else {
      restorePanelPos();
    }
    maximize.replaceChildren(icon(max ? 'compress' : 'maximize', 14));
    // Onda B: só o tooltip do painel (o title nativo gerava DOIS tooltips).
    const rotulo = max ? 'Restaurar tamanho' : 'Maximizar painel';
    maximize.setAttribute('aria-label', rotulo);
    maximize.setAttribute('data-tip', rotulo);
    gm.set('shs-in-game:panel-max', max);
  };
  maximize.addEventListener('click', () => {
    defineMax(!panel.classList.contains('shs-panel--max'));
  });
  defineMax(maximizarPref);
  head.appendChild(maximize);

  // Minimizar REAL: recolhe TUDO exceto o header (faixa/sidebar/conteúdo/rodapé
  // escondidos e a janela encolhe); o botão vira restaurar. Diferente de fechar
  // (some da tela).
  const minimize = document.createElement('button');
  minimize.className = 'shs-headbtn';
  minimize.type = 'button';
  const defineMin = (min: boolean): void => {
    panel.classList.toggle('shs-panel--min', min);
    minimize.replaceChildren(icon(min ? 'maximize' : 'minus', 14));
    const rotulo = min ? 'Restaurar painel' : 'Minimizar painel';
    minimize.setAttribute('aria-label', rotulo);
    minimize.setAttribute('data-tip', rotulo);
  };
  minimize.addEventListener('click', () => {
    defineMin(!panel.classList.contains('shs-panel--min'));
  });
  defineMin(false);
  head.appendChild(minimize);

  const close = document.createElement('button');
  close.className = 'shs-headbtn';
  close.type = 'button';
  close.appendChild(icon('x', 14));
  close.setAttribute('aria-label', 'Fechar painel');
  close.setAttribute('data-tip', 'Fechar painel');
  close.addEventListener('click', () => {
    setPanelOpen(false);
  });
  head.appendChild(close);
  panel.appendChild(head);

  // ===== Busca rápida (Onda 6): Ctrl+K foca; resultados navegam à seção =====
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'shs-search';
  searchInput.placeholder = 'Buscar ferramenta ou automação  (Ctrl K)';
  searchInput.setAttribute('aria-label', 'Busca rápida de ferramentas');
  const searchPop = document.createElement('div');
  searchPop.className = 'shs-searchpop';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'shs-search-ic';
  searchIcon.appendChild(icon('search', 15));
  searchWrap.append(searchIcon, searchInput, searchPop);
  // Clique na lista (inclusive na barra de rolagem) não tira o foco do campo.
  searchPop.addEventListener('mousedown', (event) => event.preventDefault());

  // Seção ativa: desenha com LIMPEZA do anterior (timers ao vivo) e lembra a
  // escolha entre páginas (Onda B: antes voltava sempre para "Início").
  let sectionCleanup: (() => void) | null = null;
  const disposeSection = (): void => {
    const cleanup = sectionCleanup;
    sectionCleanup = null;
    try {
      cleanup?.();
    } catch {
      /* limpeza nunca derruba o painel */
    }
  };
  const drawSection = (section: SectionDef): void => {
    disposeSection();
    body.replaceChildren();
    const cleanup = section.render(body);
    sectionCleanup = typeof cleanup === 'function' ? cleanup : null;
  };
  const switchToSection = (sectionId: string, targetId?: string): void => {
    const section = sections.find((s) => s.id === sectionId);
    if (section === undefined) return;
    body.dataset.section = section.id;
    gm.set(LAST_SECTION_KEY, section.id);
    for (const other of Array.from(nav.children)) {
      (other as HTMLElement).dataset.active = 'false';
      (other as HTMLElement).setAttribute('aria-selected', 'false');
    }
    const item = Array.from(nav.children).find(
      (child) => (child as HTMLElement).dataset.sectionId === section.id,
    );
    if (item instanceof HTMLElement) {
      item.dataset.active = 'true';
      item.setAttribute('aria-selected', 'true');
    }
    drawSection(section);
    body.scrollTop = 0;
    if (targetId !== undefined) highlightTarget(targetId);
  };
  sectionSwitcher = (sectionId: string): void => switchToSection(sectionId);
  /** Rola até o item da busca e pisca o destaque (Onda C). */
  const highlightTarget = (targetId: string): void => {
    const alvo = Array.from(body.querySelectorAll<HTMLElement>('[data-search-id]')).find(
      (el) => el.dataset.searchId === targetId,
    );
    if (alvo === undefined) return;
    alvo.scrollIntoView({ block: 'center' });
    alvo.classList.remove('shs-flash');
    void alvo.offsetWidth;
    alvo.classList.add('shs-flash');
    window.setTimeout(() => alvo.classList.remove('shs-flash'), 3_400);
  };

  const setPanelOpen = (open: boolean): void => {
    panelOpen = open;
    gm.set(PANEL_OPEN_KEY, open);
    panel.style.display = open ? 'flex' : 'none';
    // Reabrir volta do estado minimizado para o painel completo.
    defineMin(false);
    if (open) {
      renderedScreen = null; // redesenha a seção ativa (dados frescos)
      renderNav();
      animarAbertura(panel);
    } else {
      disposeSection(); // painel fechado: nenhum timer de seção fica rodando
    }
  };
  panelCloser = (): void => setPanelOpen(false);

  const closeSearch = (): void => {
    searchPop.replaceChildren();
    searchPop.classList.remove('shs-searchpop--open');
  };

  searchInput.addEventListener('input', () => {
    const raw = searchInput.value.trim();
    if (raw.length < 2) {
      closeSearch();
      return;
    }
    const needle = normalizeSearch(raw);
    const matches = [...searchEntries.values()]
      .filter((entry) => {
        const haystack = normalizeSearch(`${entry.label} ${entry.hint ?? ''} ${entry.keywords ?? ''}`);
        return haystack.includes(needle);
      })
      // v3.2.1: nome que COMEÇA com o termo > nome que contém > só descrição.
      .map((entry) => {
        const nome = normalizeSearch(entry.label);
        return { entry, rank: nome.startsWith(needle) ? 0 : nome.includes(needle) ? 1 : 2 };
      })
      .sort((a, b) => a.rank - b.rank)
      .map(({ entry }) => entry)
      .slice(0, 12);
    searchPop.replaceChildren();
    if (matches.length === 0) {
      const vazio = document.createElement('div');
      vazio.className = 'shs-searchempty';
      vazio.textContent = 'Nada encontrado.';
      searchPop.appendChild(vazio);
    }
    for (const entry of matches) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'shs-searchitem';
      if (entry.icon !== undefined) botao.appendChild(icon(entry.icon, 14));
      const texto = document.createElement('span');
      texto.className = 'shs-searchitem-label';
      texto.textContent = entry.label;
      botao.appendChild(texto);
      if (entry.hint !== undefined && entry.hint !== '') {
        const hint = document.createElement('span');
        hint.className = 'shs-searchitem-hint';
        hint.textContent = entry.hint;
        botao.appendChild(hint);
      }
      botao.addEventListener('click', () => {
        entry.beforeNavigate?.();
        switchToSection(entry.sectionId, entry.targetId);
        searchInput.value = '';
        closeSearch();
        searchInput.blur();
      });
      searchPop.appendChild(botao);
    }
    searchPop.classList.add('shs-searchpop--open');
  });
  // Onda C: ↑/↓ percorrem os resultados, Enter abre o destacado (ou o 1º).
  let activeIndex = -1;
  const resultButtons = (): HTMLButtonElement[] =>
    Array.from(searchPop.querySelectorAll<HTMLButtonElement>('.shs-searchitem'));
  const markActive = (index: number): void => {
    const buttons = resultButtons();
    if (buttons.length === 0) return;
    activeIndex = (index + buttons.length) % buttons.length;
    buttons.forEach((button, i) => {
      button.dataset.active = String(i === activeIndex);
    });
    buttons[activeIndex]?.scrollIntoView({ block: 'nearest' });
  };
  searchInput.addEventListener('input', () => {
    activeIndex = -1;
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      searchInput.value = '';
      closeSearch();
      searchInput.blur();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      markActive(activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      markActive(activeIndex - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const buttons = resultButtons();
      buttons[activeIndex >= 0 ? activeIndex : 0]?.click();
    }
  });
  searchInput.addEventListener('blur', () => {
    closeSearch();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      // Onda B: Ctrl+K também ABRE o painel fechado/minimizado.
      if (!panelOpen) setPanelOpen(true);
      if (panel.classList.contains('shs-panel--min')) defineMin(false);
      searchInput.focus();
      searchInput.select();
    }
  });

  // Onda C: Esc fecha o painel quando o foco está nele (e não há diálogo
  // aberto nem campo sendo editado — Esc no campo só sai do campo).
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !panelOpen) return;
    if (shadow.querySelector('.tsh-overlay') !== null) return;
    if (isEditableTarget(event.composedPath()[0])) {
      (event.composedPath()[0] as HTMLElement).blur();
      return;
    }
    setPanelOpen(false);
    fab.focus();
  });

  // ===== Arraste pelo header (Onda 22): posição persistida, botões excluídos =====
  head.style.cursor = 'grab';
  head.addEventListener('mousedown', (event) => {
    if (!(event.target instanceof Element)) return;
    // Onda B: botões E a busca não arrastam (o mousedown com preventDefault
    // impedia clicar no campo de busca).
    if (event.target.closest('.shs-headbtn, .shs-searchwrap, input, button, select, textarea') !== null) return;
    if (panel.classList.contains('shs-panel--max')) return; // maximizado é fixo
    if (event.button !== 0) return;
    const rect = panel.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    head.style.cursor = 'grabbing';
    const onMove = (move: MouseEvent): void => {
      const left = Math.min(Math.max(4, move.clientX - dx), Math.max(4, window.innerWidth - panel.offsetWidth - 4));
      const top = Math.min(Math.max(4, move.clientY - dy), Math.max(4, window.innerHeight - panel.offsetHeight - 4));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      head.style.cursor = 'grab';
      const final = panel.getBoundingClientRect();
      const safe = clampPos(Math.round(final.left), Math.round(final.top));
      panel.style.left = `${safe.l}px`;
      panel.style.top = `${safe.t}px`;
      gm.set(POS_KEY, safe);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    event.preventDefault();
  });
  // Duplo clique no header alterna maximizar (como janelas de desktop).
  head.addEventListener('dblclick', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('.shs-headbtn, .shs-searchwrap, input, button') !== null) return;
    defineMax(!panel.classList.contains('shs-panel--max'));
  });

  // Faixa de estado da licença em modo graça (rede caiu / revalidação 24h) —
  // entre o header e o layout.
  // (Onda C: a faixa de modo offline no topo repetia o rodapé — o aviso agora
  //  vive só no rodapé, com o horário da revalidação.)
  const license = licenseState();

  // ===== Layout em colunas: sidebar de navegação + conteúdo =====
  const layout = document.createElement('div');
  layout.className = 'shs-layout';

  const side = document.createElement('div');
  side.className = 'shs-side';
  const nav = document.createElement('div');
  nav.className = 'shs-nav';
  nav.role = 'tablist';
  nav.setAttribute('aria-orientation', 'vertical');
  side.appendChild(nav);
  // Rodapé da barra lateral: licença (ponto de estado) + aldeia atual.
  const sideFoot = document.createElement('div');
  sideFoot.className = 'shs-sidefoot';
  const licRow = document.createElement('div');
  licRow.className = 'shs-sidefoot-row';
  const licDot = document.createElement('span');
  licDot.className = `shs-dot${license.kind === 'valida' ? '' : license.kind === 'graca' ? ' shs-dot--off' : ' shs-dot--err'}`;
  const licTxt = document.createElement('span');
  licTxt.textContent =
    license.kind === 'valida'
      ? license.licenseExpiresAt !== null
        ? `Licença até ${new Date(license.licenseExpiresAt).toLocaleDateString('pt-BR')}`
        : 'Licença ativa'
      : license.kind === 'graca'
        ? 'Licença offline'
        : 'Licença inativa';
  if (license.kind === 'valida') licRow.setAttribute('data-tip', `Chave de ${license.accountName}. Renove com o líder antes de vencer.`);
  licRow.append(licDot, licTxt);
  sideFoot.appendChild(licRow);
  const village = (pageWindow().game_data as { village?: { name?: string; x?: number; y?: number } } | undefined)?.village;
  if (village !== undefined && typeof village.x === 'number' && typeof village.y === 'number') {
    const vRow = document.createElement('div');
    vRow.className = 'shs-sidefoot-row shs-sidefoot-muted';
    const vTxt = document.createElement('span');
    vTxt.textContent = `${village.name ?? 'Aldeia'} · ${village.x}|${village.y}`;
    vRow.appendChild(vTxt);
    sideFoot.appendChild(vRow);
  }
  side.appendChild(sideFoot);
  layout.appendChild(side);

  const main = document.createElement('div');
  main.className = 'shs-main';
  const body = document.createElement('div');
  body.className = 'shs-body';
  body.role = 'tabpanel';
  body.dataset.section = '';
  main.appendChild(body);

  // Faixa de licença no rodapé do conteúdo: estado (com validade) + versão.
  const foot = document.createElement('div');
  foot.className = 'shs-foot';
  if (license.kind !== 'valida') foot.classList.add('shs-foot--warn');
  const selo = document.createElement('span');
  selo.className = `shs-selo ${license.kind === 'graca' ? 'shs-selo--warn' : 'shs-selo--ok'}`;
  selo.appendChild(icon(license.kind === 'graca' ? 'clock' : 'key', 12));
  if (license.kind === 'valida') {
    selo.appendChild(document.createTextNode(`Licença de ${license.accountName}`));
    const validade = document.createElement('span');
    validade.className = 'shs-pill shs-pill--ok';
    validade.setAttribute('data-tip', 'Validade da sua chave — emita a próxima com o líder.');
    validade.textContent =
      license.licenseExpiresAt !== null
        ? `válida até ${new Date(license.licenseExpiresAt).toLocaleDateString('pt-BR')}`
        : 'ativa';
    selo.appendChild(validade);
  } else if (license.kind === 'graca') {
    const ate = new Date(license.offlineAte).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    selo.appendChild(
      document.createTextNode(`Modo offline — a licença revalida no próximo carregamento da página (a partir das ${ate})`),
    );
  } else {
    selo.className = 'shs-selo shs-selo--warn';
    selo.appendChild(document.createTextNode('Licença inativa'));
  }
  const versao = document.createElement('span');
  versao.className = 'shs-foot-ver';
  versao.textContent = `v${__SHS_VERSION__}`;
  foot.append(selo, versao);
  // Instrumento: licença válida já aparece na barra lateral — a faixa do
  // rodapé só existe quando há algo a avisar (offline/inativa).
  if (license.kind !== 'valida') main.appendChild(foot);

  layout.appendChild(main);
  panel.appendChild(layout);

  // Última screen do jogo renderizada (null = nenhuma ainda): o re-render
  // automático da seção ativa só acontece quando a screen MUDA — mutações de
  // DOM sem navegação não descartam o estado do usuário.
  let renderedScreen: string | null = null;

  function renderNav(): void {
    const screen = currentScreen();
    nav.innerHTML = '';
    const available = sections.filter((section) => section.matchScreen === undefined || section.matchScreen === screen);
    // Seção padrão (Onda 22 — corrige conteúdo em branco): sem seleção salva
    // ou se a selecionada não está disponível nesta tela → a primeira disponível.
    const atualValida = available.some((section) => section.id === body.dataset.section);
    if (body.dataset.section === '' || body.dataset.section === undefined || !atualValida) {
      // Onda B: volta para a última seção usada (se disponível nesta tela).
      // Pausa (disjuntor) aberta: abre SEMPRE na Início, onde está o retomar.
      const lembrada = isHalted() ? 'inicio' : gm.get<string>(LAST_SECTION_KEY, '');
      const escolhida = available.find((section) => section.id === lembrada) ?? available[0];
      if (escolhida !== undefined) body.dataset.section = escolhida.id;
    }
    for (const section of available) {
      const item = document.createElement('button');
      item.className = 'shs-navitem';
      item.type = 'button';
      if (section.icon !== undefined) item.appendChild(icon(section.icon, 17));
      const labelEl = document.createElement('span');
      labelEl.textContent = section.label;
      item.appendChild(labelEl);
      let badgeText: string | null = null;
      try {
        badgeText = section.badge?.() ?? null;
      } catch {
        badgeText = null; // registro estranho no storage não pode derrubar a navegação
      }
      if (badgeText !== null && badgeText !== '') {
        const count = document.createElement('span');
        count.className = 'shs-navcount';
        count.textContent = badgeText;
        item.appendChild(count);
      }
      item.role = 'tab';
      item.dataset.sectionId = section.id;
      const selected = String(body.dataset.section === section.id);
      item.dataset.active = selected;
      item.setAttribute('aria-selected', selected);
      item.addEventListener('click', () => {
        switchToSection(section.id);
      });
      nav.appendChild(item);
    }
    // Re-render a seção ativa SÓ quando a screen do jogo mudou (troca de
    // página); no 1º render renderedScreen é null, então renderiza.
    if (screen !== renderedScreen && panelOpen) {
      renderedScreen = screen;
      const active = sections.find((section) => section.id === body.dataset.section);
      if (active !== undefined && available.includes(active)) {
        // P1 (revisão Nexus): limpa ANTES de renderizar — as seções só fazem
        // appendChild; sem isto, navegar in-game duplicava a seção inteira.
        drawSection(active);
      }
    }
  }

  // Navegação interna do jogo troca o conteúdo sem recarregar: observa e refaz a sidebar.
  const observer = new MutationObserver(() => renderNav());
  observer.observe(document.getElementById('content_value') ?? document.body, { childList: true, subtree: false });

  renderNav();
}
