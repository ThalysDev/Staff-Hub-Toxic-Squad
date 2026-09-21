// Shell de UI: mini-botão flutuante + painel em Shadow DOM (isolamento total
// do CSS do jogo) com abas registradas por módulo. PT-BR.

export interface SectionDef {
  id: string;
  label: string;
  /** Só ativa nesta screen do jogo (undefined = todas). */
  matchScreen?: string;
  render: (container: HTMLElement) => void;
}

const sections: SectionDef[] = [];

export function registerSection(section: SectionDef): void {
  sections.push(section);
}

let panelOpen = false;

export function currentScreen(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('screen') ?? 'overview';
}

export function gameContext(): { player: string; world: string; villageId: string } {
  const data = (window as unknown as {
    game_data?: { player?: { name?: string }; world?: string; village?: { id?: number | string } };
  }).game_data;
  return {
    player: data?.player?.name ?? '—',
    world: data?.world ?? '—',
    villageId: String(data?.village?.id ?? '—'),
  };
}

function styles(): string {
  return `
    .shs-fab { position: fixed; left: 10px; bottom: 10px; z-index: 2147483000;
      width: 40px; height: 40px; border-radius: 10px; border: 1px solid #6b5d3f;
      background: #2e2a20; color: #e8dcc0; cursor: pointer; font-weight: 700;
      font-family: inherit; }
    .shs-fab:hover { background: #3c3626; }
    .shs-panel { position: fixed; left: 10px; bottom: 56px; z-index: 2147483000;
      width: 520px; max-height: 80vh; display: flex; flex-direction: column;
      background: #f4edda; color: #2e2a20; border: 2px solid #6b5d3f;
      border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
      font-family: Verdana, Arial, sans-serif; font-size: 12px; }
    .shs-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
      background: #2e2a20; color: #e8dcc0; border-radius: 8px 8px 0 0; }
    .shs-head strong { font-size: 13px; }
    .shs-close { margin-left: auto; background: none; border: none; color: #e8dcc0;
      cursor: pointer; font-size: 16px; }
    .shs-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px 0; }
    .shs-tab { padding: 4px 10px; border: 1px solid #b7a98d; border-radius: 6px 6px 0 0;
      background: #efe5cc; cursor: pointer; }
    .shs-tab[data-active='true'] { background: #2e2a20; color: #f4edda; }
    .shs-body { overflow: auto; padding: 10px 12px; border-top: 1px solid #b7a98d; }
    .shs-body table { border-collapse: collapse; width: 100%; margin: 6px 0; }
    .shs-body th, .shs-body td { border: 1px solid #c9bb9c; padding: 3px 6px; text-align: left; }
    .shs-body th { background: #efe5cc; }
    .shs-btn { padding: 4px 10px; border: 1px solid #6b5d3f; border-radius: 6px;
      background: #4a7c3f; color: #fff; cursor: pointer; }
    .shs-btn[disabled] { opacity: .55; cursor: default; }
    .shs-btn-ghost { background: transparent; color: #2e2a20; }
    .shs-input { padding: 4px 6px; border: 1px solid #b7a98d; border-radius: 4px; width: 100%; }
    .shs-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    .shs-muted { color: #7a6b55; }
    .shs-danger { color: #a2261f; font-weight: 700; }
    .shs-ok { color: #3f6d35; font-weight: 700; }
    .shs-pill { display: inline-block; padding: 1px 8px; border-radius: 999px;
      border: 1px solid #b7a98d; background: #efe5cc; }
    .shs-pill--error { background: #f3d9d3; border-color: #a2261f; color: #a2261f; }
    .shs-pill--ok { background: #dcead2; border-color: #3f6d35; color: #3f6d35; }
  `;
}

/** Cria o host+estilo se ainda não existem e devolve o ShadowRoot
 *  (P0 da revisão: main.ts criava o host antes, o que fazia o mountShell
 *  retornar cedo e o shell NUNCA montar). */
export function ensureHost(): ShadowRoot {
  let host = document.getElementById('shs-in-game-host');
  if (host === null) {
    host = document.createElement('div');
    host.id = 'shs-in-game-host';
    document.body.appendChild(host);
  }
  if (host.shadowRoot === null) {
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles();
    shadow.appendChild(style);
  }
  return host.shadowRoot as ShadowRoot;
}

export function mountShell(): void {
  const shadow = ensureHost();
  if (shadow.querySelector('.shs-panel') !== null) {
    // Já montado: só garante visível.
    (shadow.querySelector('.shs-panel') as HTMLElement).style.display = 'flex';
    return;
  }

  const fab = document.createElement('button');
  fab.className = 'shs-fab';
  fab.title = 'Staff Hub In-Game';
  fab.textContent = 'SH';
  fab.addEventListener('click', () => {
    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? 'flex' : 'none';
    if (panelOpen) renderTabs();
  });
  shadow.appendChild(fab);

  const panel = document.createElement('div');
  panel.className = 'shs-panel';
  panel.style.display = 'flex';
  shadow.appendChild(panel);

  const head = document.createElement('div');
  head.className = 'shs-head';
  const strong = document.createElement('strong');
  strong.textContent = 'Staff Hub In-Game';
  const who = document.createElement('span');
  who.className = 'shs-muted';
  const ctx = gameContext();
  who.textContent = `${ctx.player} · ${ctx.world}`;
  head.append(strong, who);
  const close = document.createElement('button');
  close.className = 'shs-close';
  close.textContent = '×';
  close.addEventListener('click', () => {
    panelOpen = false;
    panel.style.display = 'none';
  });
  head.appendChild(close);
  panel.appendChild(head);

  const tabs = document.createElement('div');
  tabs.className = 'shs-tabs';
  panel.appendChild(tabs);

  const body = document.createElement('div');
  body.className = 'shs-body';
  body.dataset.section = '';
  panel.appendChild(body);

  function renderTabs(): void {
    const screen = currentScreen();
    tabs.innerHTML = '';
    const available = sections.filter((section) => section.matchScreen === undefined || section.matchScreen === screen);
    for (const section of available) {
      const tab = document.createElement('button');
      tab.className = 'shs-tab';
      tab.textContent = section.label;
      tab.dataset.active = String(body.dataset.section === section.id);
      tab.addEventListener('click', () => {
        body.innerHTML = '';
        body.dataset.section = section.id;
        for (const other of Array.from(tabs.children)) (other as HTMLElement).dataset.active = 'false';
        tab.dataset.active = 'true';
        section.render(body);
      });
      tabs.appendChild(tab);
    }
    // Re-render a aba ativa quando as abas são refeitas (troca de página do jogo).
    const active = sections.find((section) => section.id === body.dataset.section);
    if (active !== undefined && available.includes(active)) active.render(body);
  }

  // Navegação interna do jogo troca o conteúdo sem recarregar: observa e refaz as abas.
  const observer = new MutationObserver(() => renderTabs());
  observer.observe(document.getElementById('content_value') ?? document.body, { childList: true, subtree: false });

  renderTabs();
}
