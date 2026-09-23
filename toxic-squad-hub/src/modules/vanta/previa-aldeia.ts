// Prévia de Aldeia (Onda 3) — screen=map: widget flutuante com toggle (padrão
// do Coletor). ARMADA, o clique numa aldeia do mapa abre um modal PRÓPRIO com o
// conteúdo de info_village (pacedDoc + DOMParser, sanitizado) em vez de navegar/
// abrir o popup do jogo; "Abrir de verdade" navega para a página real. Desarmada
// (ou com o widget fechado), o clique é do jogo: o handler original de
// TWMap.map._handleClick é restaurado no dispose.
//
// Hook: mesmo caminho do Coletor (TWMap.map.coordByEvent → xy = x*1000+y em
// TWMap.villages), com save/restore do handler. O restore é CONDICIONAL
// (`_handleClick === wrapper`): o Coletor também hooka o mesmo método e um
// restore cego devolveria o wrapper morto dele por cima do meu. A referência
// ao original só é zerada DEPOIS de restaurar (restore-then-null) e, quando o
// restore não acontece (wrapper de outro módulo por cima), ela fica viva: o
// meu wrapper segue na cadeia dele e NUNCA pode ficar instalado sem original
// (devolveria false para todo clique e mataria o mapa).
//
// Render da prévia: clone sanitizado (allowlist de tags/atributos, createElement
// + textContent — nada de innerHTML de conteúdo do jogo) do miolo de
// info_village (`#content_value`, id da fixture real
// tests/fixtures/br142/village-info-own.html; fallback `#contentContainer` e
// depois a 1ª `table.vis`). Container ausente = fail-closed com mensagem clara.

import { pageWindow } from '../../core/page';
import { gm } from '../../core/storage';
import type { ModuleScope } from './vanta-lifecycle';
import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import { coordKey } from './vanta-utils';
import { currentVillageId, pacedDoc } from './vanta-net';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

// ── Modelo mínimo do TWMap (cast local tipado — sem `any`, como o coletor) ──

interface TWMapVillage {
  id: number;
  xy: number;
}

interface TWMapMap {
  coordByEvent(e: unknown): number[];
  _handleClick?: TWMapHandleClick | undefined;
}

/** Handler do mapa; wrappers da suíte se marcam com `__tshWrapped`. */
type TWMapHandleClick = ((this: TWMapMap, e: unknown) => boolean | void) & { __tshWrapped?: boolean };

/** O handler é wrapper de algum módulo da suíte (não é o original do jogo)? */
function isWrapped(handler: TWMapHandleClick | undefined): boolean {
  return handler !== undefined && handler.__tshWrapped === true;
}

interface TWMapApi {
  map?: TWMapMap;
  villages?: Record<number, TWMapVillage>;
}

function twMap(): TWMapApi | null {
  return (pageWindow() as unknown as { TWMap?: TWMapApi }).TWMap ?? null;
}

// ── info_village: URL + sanitização do conteúdo ────────────────────────────

/** info_village da aldeia alvo, com o `village=` de contexto da página (padrão dos módulos). */
function infoVillagePath(villageId: string): string {
  const vid = currentVillageId();
  const context = vid !== '' ? `village=${encodeURIComponent(vid)}&` : '';
  return `/game.php?${context}screen=info_village&id=${encodeURIComponent(villageId)}`;
}

/** Tags copiadas para a prévia (tudo fora daqui é descartado ou desembrulhado). */
const ALLOWED_TAGS = new Set([
  'div',
  'span',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'a',
  'img',
  'b',
  'strong',
  'i',
  'em',
  'br',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'ul',
  'ol',
  'li',
  'small',
  'sup',
  'sub',
  'hr',
]);

/** Tags descartadas COM o conteúdo (scripts, mídia, controles de formulário). */
const DROPPED_TAGS = new Set([
  'script',
  'style',
  'link',
  'meta',
  'base',
  'title',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'canvas',
  'noscript',
  'template',
  'video',
  'audio',
  'source',
  'track',
  'input',
  'select',
  'textarea',
  'button',
]);

/** Atributos copiados (href NÃO entra: link dentro da prévia é só texto). */
const ALLOWED_ATTRS = new Set(['src', 'alt', 'title', 'colspan', 'rowspan', 'class', 'width', 'height']);

/** Blocos do jogo que não fazem sentido na prévia (minimapa embutido etc.). */
const SKIPPED_IDS = new Set(['minimap', 'embedmap_village', 'map_toggler']);

/** Só recurso relativo/mesmo host: nada de esquema, protocol-relative ou CDN. */
function safeResourceUrl(value: string): string | null {
  const url = value.trim();
  if (url === '' || url.startsWith('//')) return null;
  const lower = url.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) return null;
  if (url.startsWith('/') || url.startsWith('#') || !url.includes(':')) return url;
  return null;
}

function sanitizeInto(source: Node, target: Element): void {
  source.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.nodeValue ?? '';
      if (text !== '') target.appendChild(document.createTextNode(text));
      return;
    }
    if (!(child instanceof Element)) return;
    const tag = child.tagName.toLowerCase();
    if (DROPPED_TAGS.has(tag)) return;
    if (SKIPPED_IDS.has(child.id)) return;

    if (!ALLOWED_TAGS.has(tag)) {
      sanitizeInto(child, target); // tag desconhecida: mantém só o conteúdo
      return;
    }

    const el = document.createElement(tag);
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) continue;
      if (name === 'src') {
        const safe = safeResourceUrl(attr.value);
        if (safe === null) continue;
        el.setAttribute('src', safe);
        continue;
      }
      el.setAttribute(name, attr.value);
    }
    if (tag === 'img' && !el.hasAttribute('src')) return; // imagem sem fonte segura sai
    sanitizeInto(child, el);
    target.appendChild(el);
  });
}

/** Miolo da página de info_village (null = estrutura desconhecida, fail-closed). */
function previewSource(doc: Document): Element | null {
  return doc.querySelector('#content_value') ?? doc.querySelector('#contentContainer') ?? doc.querySelector('table.vis');
}

function cleanText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

// ── Estado dos hooks do TWMap (nível de módulo: TWMap é compartilhado) ─────

const ARM_KEY = 'tsh-vanta:previa:armed';

let savedHandleClick: TWMapHandleClick | null = null;
let hooksInstalled = false;
/** Widget montado? Sem widget não há interceptação (o hook é restaurado). */
let widgetOpen = false;
/** Toggle do widget: só com a prévia armada o clique é capturado. */
let armed = false;

/**
 * Restaura o handler do mapa. Ordem obrigatória: RESTAURA e só então zera a
 * referência ao original (restore-then-null). Quando o restore não pode
 * acontecer — outro módulo (o Coletor também hooka `_handleClick`) instalou um
 * wrapper por cima do meu — a referência ao original fica VIVA: o meu wrapper
 * segue na cadeia do outro e um wrapper instalado com original nulo engoliria
 * todo clique do mapa (o restore do outro módulo pode devolvê-lo ao mapa).
 */
function restoreHook(): void {
  if (!hooksInstalled) return;
  const map = twMap()?.map;
  if (map === undefined || map._handleClick !== handleClickWrapper) {
    // Restore CONDICIONAL: não piso no wrapper de outro módulo (nem posso
    // restaurar por baixo dele) — só deixo de me considerar instalado.
    hooksInstalled = false;
    return;
  }
  const original = savedHandleClick;
  if (original !== null) map._handleClick = original;
  else delete map._handleClick;
  savedHandleClick = null; // zerado DEPOIS de restaurar (nunca antes)
  hooksInstalled = false;
}

/** Sai da cadeia do mapa (só quando o wrapper é o handler atual). */
function detachWrapper(): void {
  const tw = twMap();
  if (tw !== null && tw.map !== undefined && tw.map._handleClick === handleClickWrapper) {
    delete tw.map._handleClick;
  }
  hooksInstalled = false;
}

// ── Widget + modal (CSS local: os estilos da suíte não cobrem os ids novos) ─

const STYLE_ID = 'vanta-previa-styles';
const MODAL_ID = 'vanta-previa-modal';
const PREVIA_STYLES = `
  #vanta-previa-widget {
    position: fixed; z-index: 99999; width: 250px;
    background: #fffdf3; border: 1px solid #cbb384; border-radius: 12px;
    box-shadow: 0 12px 40px rgba(60,37,10,0.18);
    font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #5a3a16;
  }
  #vanta-previa-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 12px 8px; background: #efe2ba; border-bottom: 1px solid #e0cda0;
    border-radius: 12px 12px 0 0; cursor: grab;
  }
  #vanta-previa-header:active { cursor: grabbing; }
  #vanta-previa-title {
    font-size: 11px; font-weight: 700; letter-spacing: 2px;
    color: #3c250a; text-transform: uppercase;
  }
  #vanta-previa-close {
    background: none; border: none; color: #6f5e40; font-size: 16px;
    line-height: 1; cursor: pointer; padding: 0 2px;
  }
  #vanta-previa-close:hover { color: #c04038; }
  #vanta-previa-body {
    padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px;
  }
  #vanta-previa-toggle-row {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 600; color: #8a5a1e; cursor: pointer;
  }
  #vanta-previa-status { font-size: 11px; color: #6f5e40; }
  #vanta-previa-modal {
    position: fixed; inset: 0; z-index: 100000;
    background: rgba(60,37,10,0.35);
    display: flex; align-items: center; justify-content: center;
    font-family: 'Segoe UI', Arial, sans-serif;
  }
  #vanta-previa-card {
    width: min(760px, 92vw); max-height: 82vh;
    display: flex; flex-direction: column;
    background: #fffdf3; border: 1px solid #cbb384; border-radius: 12px;
    box-shadow: 0 18px 60px rgba(60,37,10,0.35);
  }
  #vanta-previa-card-header {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 14px; background: #efe2ba; border-bottom: 1px solid #e0cda0;
    border-radius: 12px 12px 0 0;
  }
  #vanta-previa-card-title {
    font-size: 13px; font-weight: 700; color: #3c250a; overflow-wrap: anywhere;
  }
  #vanta-previa-card-close {
    background: none; border: none; color: #6f5e40; font-size: 18px;
    line-height: 1; cursor: pointer; padding: 0 2px;
  }
  #vanta-previa-card-close:hover { color: #c04038; }
  #vanta-previa-card-body {
    padding: 12px 14px; overflow: auto; flex: 1;
    font-size: 12px; color: #3c250a;
  }
  #vanta-previa-card-body img { max-width: 100%; }
  #vanta-previa-card-footer {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; border-top: 1px solid #e0cda0;
  }
  #vanta-previa-note { flex: 1; font-size: 11px; color: #6f5e40; }
  .vanta-previa-btn {
    padding: 6px 10px; background: #fbf4de; border: 1px solid #cbb384;
    border-radius: 8px; color: #5a3a16; font-size: 11px; cursor: pointer; white-space: nowrap;
  }
  .vanta-previa-btn:hover { background: #efe2ba; border-color: #834a1a; color: #834a1a; }
  .vanta-previa-error { font-size: 12px; color: #c04038; }
`;

// ── Wrapper do clique (nível de módulo: precisa ser estável p/ comparação) ──

/**
 * Profundidade da delegação: uma cadeia circular (outro módulo pode ter salvo
 * o MEU wrapper como original dele e me chamar de volta) recursaria sem fim —
 * o corte devolve o clique ao jogo em vez de estourar a pilha.
 */
let delegating = false;

/**
 * Clique é do jogo: chama o original salvo. Sem original vivo, o wrapper NUNCA
 * fica instalado engolindo cliques — sai da cadeia e devolve `true` (deixa
 * passar para o comportamento nativo).
 */
function delegateToOriginal(this: TWMapMap, e: unknown): boolean {
  const orig = savedHandleClick;
  if (orig === null) {
    detachWrapper();
    return true;
  }
  if (delegating) return true;
  delegating = true;
  try {
    const result = orig.call(this, e);
    return typeof result === 'boolean' ? result : false;
  } finally {
    delegating = false;
  }
}

function handleClickWrapper(this: TWMapMap, e: unknown): boolean {
  // Desarmada/fechada: clique é do jogo (delega ao handler original).
  if (!armed || !widgetOpen) return delegateToOriginal.call(this, e);

  const tw = twMap();
  const map = tw?.map;
  if (tw === null || map === undefined) return delegateToOriginal.call(this, e);
  const pos = map.coordByEvent(e);
  const x = pos[0];
  const y = pos[1];
  if (typeof x !== 'number' || typeof y !== 'number') return delegateToOriginal.call(this, e);
  const village = tw.villages?.[x * 1000 + y];
  if (village === undefined || !village.id) return delegateToOriginal.call(this, e); // clique fora de aldeia
  // Handler do mount atual; sem ele (mount tardio) o clique segue sendo do jogo.
  if (handleMapClick === null) return delegateToOriginal.call(this, e);

  handleMapClick(String(village.id), x, y);
  return false; // suprime o popup/navegação nativos
}
// Marca de wrapper: outro módulo (o Coletor) distingue original de wrapper.
handleClickWrapper.__tshWrapped = true;

/** Ponte para o handler do mount atual (o wrapper é global, o mount é por escopo). */
let handleMapClick: ((villageId: string, x: number, y: number) => void) | null = null;

// ── Launcher ───────────────────────────────────────────────────────────────

registerVanta({
  id: 'vanta-previa-aldeia',
  label: 'Prévia de Aldeia',
  desc: 'Clique na aldeia do mapa abre a prévia de info_village sem sair do mapa',
  group: 'utilidades',
  match: () => params().get('screen') === 'map',
  url: () => '/game.php?screen=map',
  mount(scope: ModuleScope): void {
    ensureVantaStyles();
    if (document.getElementById('vanta-previa-widget') !== null) return;
    if (document.body === null) return;

    // Sobras de um mount anterior (Fechar) e restore garantido no dispose.
    restoreHook();
    widgetOpen = true;
    armed = gm.get<boolean>(ARM_KEY, false);
    const scopeDispose = scope.dispose.bind(scope);
    scope.dispose = (): void => {
      widgetOpen = false;
      handleMapClick = null;
      restoreHook();
      scopeDispose();
    };

    let previewToken = 0;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = PREVIA_STYLES;
    document.head?.appendChild(scope.owns(style));

    const widget = document.createElement('div');
    widget.id = 'vanta-previa-widget';
    widget.innerHTML = `
        <div id="vanta-previa-header">
            <span id="vanta-previa-title">Prévia de Aldeia</span>
            <button id="vanta-previa-close" title="Fechar">×</button>
        </div>
        <div id="vanta-previa-body">
            <label id="vanta-previa-toggle-row">
                <input type="checkbox" id="vanta-previa-toggle"> Armar prévia no clique
            </label>
            <div id="vanta-previa-status"></div>
        </div>
    `;
    widget.style.left = '16px';
    widget.style.top = '70px';
    document.body.appendChild(scope.owns(widget));

    const toggleEl = document.getElementById('vanta-previa-toggle');
    const statusEl = document.getElementById('vanta-previa-status');
    const closeEl = document.getElementById('vanta-previa-close');
    if (!(toggleEl instanceof HTMLInputElement)) return;
    const toggle: HTMLInputElement = toggleEl;

    function setStatus(text: string, color = '#6f5e40'): void {
      if (statusEl === null) return;
      statusEl.style.color = color;
      statusEl.textContent = text;
    }

    function syncToggle(): void {
      toggle.checked = armed;
      setStatus(
        armed
          ? 'Armada: clicar numa aldeia abre a prévia (não navega).'
          : 'Desarmada: o clique na aldeia continua sendo do jogo.',
      );
    }

    // ── Modal ──

    interface ModalRefs {
      root: HTMLElement;
      title: HTMLElement;
      body: HTMLElement;
      note: HTMLElement;
      /** Aldeia do "Abrir de verdade" (atualizada a cada prévia). */
      villageId: string;
    }

    let modalRefs: ModalRefs | null = null;

    /** Modal único do mount (reutilizado/pré-carregado nas próximas prévias). */
    function ensureModal(): ModalRefs {
      if (modalRefs !== null) return modalRefs;
      document.getElementById(MODAL_ID)?.remove(); // sobra de um mount anterior

      const modal = document.createElement('div');
      modal.id = MODAL_ID;
      modal.style.display = 'none';
      modal.innerHTML = `
          <div id="vanta-previa-card">
              <div id="vanta-previa-card-header">
                  <span id="vanta-previa-card-title"></span>
                  <button id="vanta-previa-card-close" title="Fechar">×</button>
              </div>
              <div id="vanta-previa-card-body"></div>
              <div id="vanta-previa-card-footer">
                  <span id="vanta-previa-note"></span>
                  <button class="vanta-previa-btn" id="vanta-previa-open">Abrir de verdade</button>
                  <button class="vanta-previa-btn" id="vanta-previa-cancel">Fechar</button>
              </div>
          </div>
      `;
      document.body?.appendChild(scope.owns(modal));

      const titleEl = modal.querySelector<HTMLElement>('#vanta-previa-card-title');
      const bodyEl = modal.querySelector<HTMLElement>('#vanta-previa-card-body');
      const noteEl = modal.querySelector<HTMLElement>('#vanta-previa-note');
      const openEl = modal.querySelector<HTMLButtonElement>('#vanta-previa-open');
      const cancelEl = modal.querySelector<HTMLButtonElement>('#vanta-previa-cancel');
      const xEl = modal.querySelector<HTMLElement>('#vanta-previa-card-close');
      if (titleEl === null || bodyEl === null || noteEl === null || openEl === null || cancelEl === null || xEl === null) {
        throw new Error('modal da prévia incompleto');
      }

      const refs: ModalRefs = { root: modal, title: titleEl, body: bodyEl, note: noteEl, villageId: '' };
      scope.on(xEl, 'click', closeModal);
      scope.on(cancelEl, 'click', closeModal);
      scope.on(openEl, 'click', () => {
        window.location.href = infoVillagePath(refs.villageId);
      });
      scope.on(modal, 'click', (event) => {
        if (event.target === modal) closeModal(); // clique no fundo fecha
      });
      modalRefs = refs;
      return refs;
    }

    function closeModal(): void {
      previewToken++; // descarta respostas em voo
      if (modalRefs !== null) modalRefs.root.style.display = 'none';
    }

    function showMessage(refs: ModalRefs, text: string): void {
      refs.body.replaceChildren();
      const el = document.createElement('div');
      el.className = 'vanta-previa-error';
      el.textContent = text;
      refs.body.appendChild(el);
    }

    async function openPreview(villageId: string, x: number, y: number): Promise<void> {
      const token = ++previewToken;
      let refs: ModalRefs;
      try {
        refs = ensureModal();
      } catch (error) {
        setStatus(`Falha ao abrir a prévia: ${error instanceof Error ? error.message : String(error)}`, '#c04038');
        return;
      }
      refs.villageId = villageId;
      refs.root.style.display = 'flex';
      refs.title.textContent = `${coordKey(x, y)} · aldeia ${villageId}`;
      refs.note.textContent = 'Carregando info_village...';
      refs.body.replaceChildren();

      try {
        const doc = await pacedDoc(infoVillagePath(villageId));
        if (token !== previewToken) return; // fechou ou abriu outra aldeia
        const source = previewSource(doc);
        if (source === null) {
          showMessage(refs, 'Estrutura da página mudou — não consegui montar a prévia (fail-closed).');
          refs.note.textContent = 'info_village sem #content_value/#contentContainer/table.vis.';
          return;
        }
        const name = cleanText(doc.querySelector('#content_value h2')?.textContent);
        refs.title.textContent = `${name !== '' ? name : `Aldeia ${villageId}`} (${coordKey(x, y)})`;
        refs.body.replaceChildren();
        sanitizeInto(source, refs.body);
        if (refs.body.childNodes.length === 0) {
          showMessage(refs, 'A prévia veio vazia — estrutura da página mudou (fail-closed).');
          refs.note.textContent = '';
          return;
        }
        refs.note.textContent = 'Prévia somente leitura (links desativados).';
      } catch (error) {
        if (token !== previewToken) return;
        showMessage(refs, `Erro ao carregar a prévia: ${error instanceof Error ? error.message : String(error)}`);
        refs.note.textContent = '';
      }
    }

    handleMapClick = (villageId, x, y) => {
      void openPreview(villageId, x, y);
    };

    // ── Hook do clique (TWMap pode carregar depois do script — retry com teto) ──

    function installHook(): boolean {
      if (!widgetOpen) return false;
      const tw = twMap();
      if (tw === null || tw.map === undefined) return false;
      if (!hooksInstalled) {
        // Nunca capturar o PRÓPRIO wrapper como original (o restore de outro
        // módulo pode devolvê-lo ao mapa): a auto-referência recursaria no
        // clique. Reinstall sobre o wrapper de OUTRO módulo também não troca o
        // original — o primeiro original conhecido fica (capturar o wrapper
        // alheio criaria cadeia cruzada meu wrapper → alheio → meu wrapper).
        // Sem original conhecido, captura: wrapper com original nulo engoliria
        // todo clique do mapa.
        const current = tw.map._handleClick;
        if (current !== handleClickWrapper && (!isWrapped(current) || savedHandleClick === null)) {
          savedHandleClick = current ?? null;
        }
        tw.map._handleClick = handleClickWrapper;
        hooksInstalled = true;
      }
      return true;
    }

    let hookAttempts = 0;
    const tryInstallHook = (): void => {
      if (hooksInstalled || !widgetOpen) return;
      hookAttempts++;
      if (installHook()) return;
      if (hookAttempts < 50) scope.after(tryInstallHook, 100);
    };
    tryInstallHook();

    // ── Toggle ──

    scope.on(toggle, 'change', () => {
      armed = toggle.checked;
      gm.set(ARM_KEY, armed);
      syncToggle();
    });

    scope.on(document, 'keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape' && modalRefs !== null) closeModal();
    });

    // ── Drag (listeners de document rastreados pelo scope — padrão do coletor) ──

    const header = widget.querySelector<HTMLElement>('#vanta-previa-header');
    if (header !== null) {
      let dragging = false;
      let dx = 0;
      let dy = 0;
      scope.on(header, 'mousedown', (event) => {
        const me = event as MouseEvent;
        dragging = true;
        dx = me.clientX - widget.getBoundingClientRect().left;
        dy = me.clientY - widget.getBoundingClientRect().top;
        me.preventDefault();
      });
      scope.on(document, 'mousemove', (event) => {
        if (!dragging) return;
        const me = event as MouseEvent;
        widget.style.right = 'auto';
        widget.style.left = `${me.clientX - dx}px`;
        widget.style.top = `${me.clientY - dy}px`;
      });
      scope.on(document, 'mouseup', () => {
        dragging = false;
      });
    }

    if (closeEl !== null) {
      scope.on(closeEl, 'click', () => {
        closeModal();
        scope.dispose(); // restaura o hook do clique e limpa widget/estilo/listeners
      });
    }

    syncToggle();
  },
});
