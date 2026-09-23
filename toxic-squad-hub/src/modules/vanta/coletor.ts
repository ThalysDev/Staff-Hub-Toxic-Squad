// Coletor e Alocador — port do injectColetorUI do TW Vanta (linhas 2262-3174
// do original). Widget arrastável sobre screen=map: captura cliques em aldeias
// (hook em TWMap.map._handleClick), grupos salvos com cor (highlight via
// override de TWMap.mapHandler.spawnSector), copiar/copiar com ID via
// /map/village.txt e "Grupo do Jogo" (screen=groups, add/remove em lote).
//
// Correções embutidas (linha do original entre parênteses):
// - P2: coordenadas <100 quebravam com slice de string (2377-2381) →
//   coordFromXy/coordKey em TODO lugar (spawnSector, clique, village.txt).
// - Hooks do TWMap: o original tinha a flag confusa `originalHandleClick = true`
//   e variável morta (2282, 2625-2665) → installHooks()/restoreHooks() com
//   guarda, restaurados no dispose do scope, no botão Fechar e no remount.
// - P2: posInterval cru (3141-3145) → scope.after com teto de 50×100ms;
//   mousemove/mouseup do drag → scope.on(document, ...).
// - P1-1: nomes de grupos (próprios e do jogo) injetados crus (2446, 2776,
//   3084) → escapeHtml/escAttr.
// - Rede: fetch cru de /map/village.txt (2522) e dos ajax de groups (2830 etc.)
//   → pacedGet/vantaPostJson (fila global ≥200ms — o delay(200) manual entre
//   aldeias do original foi absorvido pela fila, sem delay duplicado).

import { iconMarkup } from '../../core/icons';
import { gm } from '../../core/storage';
import { pageWindow } from '../../core/page';
import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import { currentCsrf, currentVillageId, pacedGet, vantaPostJson } from './vanta-net';
import { coordFromXy, coordKey, escAttr, escapeHtml } from './vanta-utils';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

// ── Modelo mínimo do TWMap (cast local tipado — sem `any`) ───────────────────

interface TWMapVillage {
  id: number;
  xy: number;
}

interface TWMapSectorData {
  x: number;
  y: number;
  tiles: Record<string, Record<string, unknown>>;
}

interface TWMapSector {
  x: number;
  y: number;
}

interface TWMapMap {
  coordByEvent(e: unknown): number[];
  _handleClick?: TWMapHandleClick;
}

type TWMapHandleClick = ((this: TWMapMap, e: unknown) => boolean | void) & { __tshWrapped?: boolean };
type TWMapSpawnSector = (this: TWMapHandler, data: TWMapSectorData, sector: TWMapSector) => void;

interface TWMapHandler {
  spawnSector?: TWMapSpawnSector;
}

interface TWMapApi {
  map?: TWMapMap;
  mapHandler?: TWMapHandler;
  villages?: Record<number, TWMapVillage>;
  mapSubSectorSize?: number;
  reload(): void;
}

interface TWMapPage {
  TWMap?: TWMapApi;
}

function twMap(): TWMapApi | null {
  return (pageWindow() as unknown as TWMapPage).TWMap ?? null;
}

// ── Tipos e storage ─────────────────────────────────────────────────────────

interface ColetorGroup {
  id: number;
  name: string;
  color: string;
  villages: string[];
}

interface VillageTxtEntry {
  id: string;
  key: string;
}

interface InGameGroup {
  group_id: number | string;
  name: string;
  type?: string;
  in_group?: boolean;
}

interface LoadGroupsJson {
  result?: InGameGroup[];
  csrf?: string;
}

const KEY_VILLAGES = 'tsh-vanta:coletor:villages';
const KEY_GROUPS = 'tsh-vanta:coletor:groups';

function loadSelectedVillages(): string[] {
  const raw: unknown = gm.get<unknown>(KEY_VILLAGES, []);
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function loadGroups(): ColetorGroup[] {
  const raw: unknown = gm.get<unknown>(KEY_GROUPS, []);
  if (!Array.isArray(raw)) return [];
  const groups: ColetorGroup[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'number' || typeof o.name !== 'string' || typeof o.color !== 'string') continue;
    const villages = Array.isArray(o.villages) ? o.villages.filter((v): v is string => typeof v === 'string') : [];
    groups.push({ id: o.id, name: o.name, color: o.color, villages });
  }
  return groups;
}

// ── Estado dos hooks do TWMap (nível de módulo: TWMap é compartilhado) ──────
// O dispose do ModuleScope não conhece os hooks do TWMap — quem restaura sou
// eu: no Fechar do widget, no dispose (wrapper abaixo) e no remount seguinte.

let savedHandleClick: TWMapHandleClick | null = null;
let savedSpawnSector: TWMapSpawnSector | null = null;
/** Wrapper de clique que EU instalei (o handler do TWMap é global; o wrapper é por mount). */
let installedHandleClick: TWMapHandleClick | null = null;
let hooksInstalled = false;
// Widget aberto? O retry de instalação dos hooks (TWMap pode carregar tarde)
// e os wrappers checam esta flag para NUNCA interceptar cliques com o widget
// fechado (race Fechar-durante-retry apontada na revisão da Onda 2).
let widgetOpen = false;

function restoreHooks(): void {
  if (!hooksInstalled) return;
  const tw = twMap();
  if (tw !== null) {
    // Restore CONDICIONAL: se outro módulo (a Prévia também hooka o mesmo
    // método) instalou o wrapper dele por cima do meu, não piso nele nem
    // restauro por baixo — o meu wrapper pode estar na cadeia dele, então o
    // original salvo fica VIVO (com original nulo eu engoliria o clique).
    if (tw.map !== undefined && tw.map._handleClick === installedHandleClick && savedHandleClick !== null) {
      tw.map._handleClick = savedHandleClick;
      savedHandleClick = null;
    }
    if (tw.mapHandler !== undefined && savedSpawnSector !== null) tw.mapHandler.spawnSector = savedSpawnSector;
  }
  savedSpawnSector = null;
  installedHandleClick = null;
  hooksInstalled = false;
}

// ── Cache de /map/village.txt (TTL 5min, como o original) ────────────────────

const VILLAGE_TXT_TTL = 5 * 60 * 1000;
let villageTxtCache: VillageTxtEntry[] | null = null;
let villageTxtCacheTime = 0;

function clearVillageTxtCache(): void {
  villageTxtCache = null;
  villageTxtCacheTime = 0;
}

async function fetchVillageTxt(): Promise<VillageTxtEntry[]> {
  if (villageTxtCache !== null && Date.now() - villageTxtCacheTime < VILLAGE_TXT_TTL) return villageTxtCache;
  const text = await pacedGet('/map/village.txt');
  const villages = text
    .trim()
    .split('\n')
    .map((line): VillageTxtEntry | null => {
      const parts = line.split(',');
      const id = parts[0] ?? '';
      const x = parseInt(parts[2] ?? '', 10);
      const y = parseInt(parts[3] ?? '', 10);
      if (id === '' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { id, key: coordKey(x, y) };
    })
    .filter((v): v is VillageTxtEntry => v !== null);
  villageTxtCache = villages;
  villageTxtCacheTime = Date.now();
  return villages;
}

// ── Utilidades puras ─────────────────────────────────────────────────────────

function normalizeGroupColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#7ddb82';
}

/** Tinge os ícones do mapa na cor do grupo via cadeia de filtros CSS. */
function hexToGroupFilter(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min) + 6) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h *= 60;
  }
  return `sepia(1) saturate(5) hue-rotate(${Math.round(h - 30)}deg) brightness(1.2)`;
}

const PALETTE_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function hueToHex(h: number): string {
  // Cor saturada com S=80%, L=55%.
  const s = 0.8;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Cor mais distante (em matiz) das já usadas pelos grupos existentes. */
function pickDistinctColor(existingGroups: ColetorGroup[]): string {
  const existingHues = existingGroups.map((g) => hexToHue(g.color));
  let bestHue = PALETTE_HUES[0] ?? 0;
  let bestMinDist = -1;
  for (const h of PALETTE_HUES) {
    const minDist =
      existingHues.length > 0 ? Math.min(...existingHues.map((eh) => hueDist(h, eh))) : Number.POSITIVE_INFINITY;
    if (minDist > bestMinDist) {
      bestMinDist = minDist;
      bestHue = h;
    }
  }
  return hueToHex(bestHue);
}

/** "5|7 005|007 12|345" → ["5|7","5|7","12|345"] — chave sempre via coordKey. */
function normalizeCoordList(raw: string): string[] {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => {
      const m = c.match(/^(\d+)\|(\d+)$/);
      if (m === null || m[1] === undefined || m[2] === undefined) return c;
      return coordKey(parseInt(m[1], 10), parseInt(m[2], 10));
    });
}

function fallbackCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body?.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function copyToClipboard(text: string): void {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function applyVillageFilter(villageId: number, filter: string): void {
  const el = document.querySelector(`[id="map_village_${villageId}"]`);
  if (el !== null) (el as HTMLElement).style.filter = filter;
}

function clearAllVillageFilters(): void {
  document.querySelectorAll('[id^="map_village_"]').forEach((el) => {
    (el as HTMLElement).style.filter = 'none';
  });
}

// ── Launcher ─────────────────────────────────────────────────────────────────

registerVanta({
  id: 'vanta-coletor',
  label: 'Coletor e Alocador',
  icon: 'crosshair',
  desc: 'Seleção de coordenadas no mapa',
  group: 'utilidades',
  match: () => params().get('screen') === 'map',
  url: () => '/game.php?screen=map',
  mount(scope) {
    ensureVantaStyles();
    if (document.getElementById('vanta-coletor-widget')) return;
    if (document.body === null) return;

    // Restaura sobras de um mount anterior e garante restore no dispose do
    // scope (o dispose do lifecycle não conhece os hooks do TWMap).
    restoreHooks();
    widgetOpen = true;
    const scopeDispose = scope.dispose.bind(scope);
    scope.dispose = (): void => {
      widgetOpen = false;
      restoreHooks();
      scopeDispose();
    };

    // ── State ──
    let selectedVillages = loadSelectedVillages();
    let groups = loadGroups();
    let saveMode: 'novo' | 'add' = 'novo';
    let cachedCsrf = '';
    const filterMap: Record<string, string> = {};

    const saveVillages = (): void => {
      gm.set(KEY_VILLAGES, selectedVillages);
    };
    const saveGroups = (): void => {
      gm.set(KEY_GROUPS, groups);
    };

    function required(id: string): HTMLElement {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`#${id} ausente no widget do Coletor`);
      return el;
    }

    function updateUI(): void {
      const textarea = document.getElementById('vanta-coletor-list') as HTMLTextAreaElement | null;
      const count = document.getElementById('vanta-coletor-count');
      if (textarea !== null) textarea.value = selectedVillages.join(' ');
      if (count !== null) count.textContent = String(selectedVillages.length);
    }

    function flashBtn(id: string, text: string, ms = 1500): void {
      const btn = document.getElementById(id);
      if (btn === null) return;
      const orig = btn.textContent;
      btn.textContent = text;
      scope.after(() => {
        btn.textContent = orig;
      }, ms);
    }

    // ── Highlight (override de spawnSector) ──

    function refreshFilterMap(): void {
      for (const k of Object.keys(filterMap)) delete filterMap[k];
      groups.forEach((g) => {
        const filter = hexToGroupFilter(normalizeGroupColor(g.color));
        g.villages.forEach((coord) => {
          filterMap[coord] = filter;
        });
      });
      selectedVillages.forEach((coord) => {
        filterMap[coord] = 'grayscale(100%) brightness(200%)';
      });
    }

    function installHighlight(): void {
      refreshFilterMap();
      const tw = twMap();
      if (tw !== null && hooksInstalled) tw.reload();
    }

    function spawnSectorWrapper(this: TWMapHandler, data: TWMapSectorData, sector: TWMapSector): void {
      const orig = savedSpawnSector;
      if (orig !== null) orig.call(this, data, sector);
      if (!widgetOpen) return; // fechado: só o desenho original do jogo.
      const tw = twMap();
      if (tw === null) return;
      const sub = tw.mapSubSectorSize ?? 20;
      const beginX = sector.x - data.x;
      const endX = beginX + sub;
      const beginY = sector.y - data.y;
      const endY = beginY + sub;
      for (const xStr of Object.keys(data.tiles)) {
        const x = parseInt(xStr, 10);
        if (Number.isNaN(x) || x < beginX || x >= endX) continue;
        const column = data.tiles[xStr];
        if (column === undefined) continue;
        for (const yStr of Object.keys(column)) {
          const y = parseInt(yStr, 10);
          if (Number.isNaN(y) || y < beginY || y >= endY) continue;
          const village = tw.villages?.[(data.x + x) * 1000 + (data.y + y)];
          if (village === undefined) continue;
          // FIX P2 (original 2377-2381): xy→coord sem slice de string.
          const { x: vx, y: vy } = coordFromXy(village.xy);
          const filter = filterMap[coordKey(vx, vy)];
          if (filter !== undefined) applyVillageFilter(village.id, filter);
        }
      }
    }

    function handleClickWrapper(this: TWMapMap, e: unknown): boolean {
      // Pass-through defensivo: com o widget fechado, o clique é do jogo.
      if (!widgetOpen) {
        const orig = savedHandleClick;
        if (orig === null) return false;
        const r = orig.call(this, e);
        return typeof r === 'boolean' ? r : false;
      }
      const tw = twMap();
      if (tw === null || tw.map === undefined) return false;
      const pos = tw.map.coordByEvent(e);
      const x = pos[0];
      const y = pos[1];
      if (typeof x !== 'number' || typeof y !== 'number') return false;
      const village = tw.villages?.[x * 1000 + y];
      if (village !== undefined && village.id) {
        // FIX (original 2636): chave do clique coerente com o spawnSector.
        const coord = coordKey(x, y);
        const idx = selectedVillages.indexOf(coord);
        if (idx === -1) {
          selectedVillages.push(coord);
          applyVillageFilter(village.id, 'grayscale(100%) brightness(200%)');
        } else {
          selectedVillages.splice(idx, 1);
          applyVillageFilter(village.id, 'none');
        }
        updateUI();
        saveVillages();
        installHighlight();
      }
      return false;
    }
    // Marca de wrapper: outros módulos (a Prévia hooka o mesmo método)
    // distinguem original de wrapper para não capturar um ao outro.
    handleClickWrapper.__tshWrapped = true;

    /** Salva os originais UMA vez e instala os wrappers; false se o TWMap ainda não existe. */
    function installHooks(): boolean {
      if (!widgetOpen) return false; // fechado entre mounts: não intercepta nada.
      const tw = twMap();
      if (tw === null || tw.map === undefined || tw.mapHandler === undefined) return false;
      if (!hooksInstalled) {
        savedHandleClick = tw.map._handleClick ?? null;
        savedSpawnSector = tw.mapHandler.spawnSector ?? null;
        tw.map._handleClick = handleClickWrapper;
        installedHandleClick = handleClickWrapper;
        tw.mapHandler.spawnSector = spawnSectorWrapper;
        hooksInstalled = true;
        // Aplica highlights pendentes (auto-highlight na abertura).
        if (selectedVillages.length > 0 || groups.length > 0) tw.reload();
      }
      return true;
    }

    // TWMap pode carregar depois do script — retry com teto (no lugar do
    // posInterval cru do original, linhas 3141-3145).
    let hookAttempts = 0;
    const tryInstallHooks = (): void => {
      if (hooksInstalled || !widgetOpen) return;
      hookAttempts++;
      if (installHooks()) return;
      if (hookAttempts < 50) scope.after(tryInstallHooks, 100);
    };
    tryInstallHooks();

    // ── Grupos salvos ──

    function renderGroups(): void {
      const container = document.getElementById('vanta-coletor-groups');
      if (container === null) return;
      container.innerHTML = '';
      const title = document.getElementById('vanta-coletor-groups-title');
      if (title !== null) title.style.display = groups.length > 0 ? '' : 'none';
      groups.forEach((g) => {
        const color = normalizeGroupColor(g.color);
        const item = document.createElement('div');
        item.className = 'vanta-group-item';
        // P1-1 (original 2446): nome escapado em texto e atributo.
        item.innerHTML = `
            <input class="vanta-group-color-input" type="color" value="${escAttr(color)}">
            <span class="vanta-group-swatch" style="background:${escAttr(color)}" title="Mudar cor"></span>
            <span class="vanta-group-name" title="${escAttr(g.name)}">${escapeHtml(g.name)}</span>
            <span class="vanta-group-count">${g.villages.length} aldeias</span>
            <button type="button" class="vanta-group-edit" title="Renomear" aria-label="Renomear">${iconMarkup('edit', 12)}</button>
            <button type="button" class="vanta-group-del" title="Excluir">×</button>
        `;

        const swatch = item.querySelector<HTMLElement>('.vanta-group-swatch');
        const colorInput = item.querySelector<HTMLInputElement>('.vanta-group-color-input');
        if (swatch !== null && colorInput !== null) {
          swatch.addEventListener('click', () => colorInput.click());
          colorInput.addEventListener('input', (e) => {
            const idx = groups.findIndex((x) => x.id === g.id);
            if (idx === -1) return;
            const value = (e.target as HTMLInputElement).value;
            groups[idx]!.color = value;
            swatch.style.background = value;
            saveGroups();
            installHighlight();
          });
        }

        const nameSpan = item.querySelector<HTMLElement>('.vanta-group-name');
        if (nameSpan !== null) {
          nameSpan.addEventListener('click', () => {
            const current = groups.find((x) => x.id === g.id);
            selectedVillages = [...(current !== undefined ? current.villages : g.villages)];
            saveVillages();
            updateUI();
            installHighlight();
          });
        }

        const editBtn = item.querySelector<HTMLElement>('.vanta-group-edit');
        if (editBtn !== null && nameSpan !== null) {
          editBtn.addEventListener('click', () => {
            const current = groups.find((x) => x.id === g.id);
            const input = document.createElement('input');
            input.type = 'text';
            input.value = current !== undefined ? current.name : g.name;
            input.className = 'vanta-group-name-edit';
            input.maxLength = 40;
            nameSpan.replaceWith(input);
            input.focus();
            input.select();
            const commit = (): void => {
              const newName = input.value.trim();
              const idx = groups.findIndex((x) => x.id === g.id);
              if (newName !== '' && idx !== -1) {
                groups[idx]!.name = newName;
                saveGroups();
              }
              renderGroups();
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') input.blur();
              if (e.key === 'Escape') {
                e.preventDefault();
                renderGroups();
              }
            });
          });
        }

        const delBtn = item.querySelector<HTMLElement>('.vanta-group-del');
        if (delBtn !== null) {
          delBtn.addEventListener('click', () => {
            groups = groups.filter((x) => x.id !== g.id);
            saveGroups();
            renderGroups();
            installHighlight();
          });
        }

        container.appendChild(item);
      });
    }

    // ── Widget ──

    const widget = document.createElement('div');
    widget.id = 'vanta-coletor-widget';
    widget.innerHTML = `
        <div id="vanta-coletor-header">
            <span id="vanta-coletor-title">Coletor e Alocador</span>
            <button type="button" id="vanta-coletor-close" title="Fechar">×</button>
        </div>
        <div id="vanta-coletor-body">
            <div id="vanta-coletor-label">
                Aldeias selecionadas: <span id="vanta-coletor-count">0</span>
            </div>
            <textarea id="vanta-coletor-list" placeholder="Clique nas aldeias no mapa..."></textarea>
            <div id="vanta-coletor-buttons">
                <button type="button" class="vanta-coletor-btn" id="vanta-coletor-reset">Resetar</button>
                <button type="button" class="vanta-coletor-btn" id="vanta-coletor-copy">Copiar</button>
                <button type="button" class="vanta-coletor-btn" id="vanta-coletor-copy-id">Copiar c/ ID</button>
                <button type="button" class="vanta-coletor-btn" id="vanta-coletor-highlight">Destacar</button>
                <button type="button" class="vanta-coletor-btn" id="vanta-coletor-save-grupo">Salvar Grupo</button>
                <button type="button" class="vanta-coletor-btn" id="vanta-coletor-ingame-btn">Grupo do Jogo</button>
            </div>
            <div id="vanta-coletor-save-row" style="display:none">
                <div id="vanta-coletor-mode-row" style="display:none">
                    <button type="button" class="vanta-coletor-btn" id="vanta-coletor-mode-novo" style="flex:1">Novo grupo</button>
                    <button type="button" class="vanta-coletor-btn" id="vanta-coletor-mode-add" style="flex:1">Adicionar ao grupo</button>
                </div>
                <div id="vanta-coletor-novo-row">
                    <input id="vanta-coletor-group-color" type="color" value="#7ddb82" title="Cor do grupo">
                    <input id="vanta-coletor-name-input" type="text" placeholder="Nome do grupo..." maxlength="40">
                </div>
                <div id="vanta-coletor-add-row" style="display:none">
                    <select id="vanta-coletor-group-select"></select>
                </div>
                <div id="vanta-coletor-ok-row">
                    <button type="button" class="vanta-coletor-btn" id="vanta-coletor-save-ok" style="flex:1">OK</button>
                    <button type="button" class="vanta-coletor-btn" id="vanta-coletor-save-cancel" style="flex:0 0 auto" aria-label="Cancelar">${iconMarkup('x', 12)}</button>
                </div>
            </div>
            <div id="vanta-coletor-groups-title" style="display:none">Grupos Salvos</div>
            <div id="vanta-coletor-groups"></div>
            <div id="vanta-coletor-ingame-section" style="display:none">
                <div id="vanta-coletor-ingame-label">Grupo do jogo</div>
                <div id="vanta-coletor-ingame-row">
                    <select id="vanta-coletor-ingame-select" disabled>
                        <option value="">Carregando...</option>
                    </select>
                    <button type="button" class="vanta-coletor-btn" id="vanta-coletor-ingame-add" disabled>Adicionar</button>
                    <button type="button" class="vanta-coletor-btn" id="vanta-coletor-ingame-remove" disabled>Remover</button>
                </div>
                <div id="vanta-coletor-ingame-progress" style="display:none"></div>
            </div>
        </div>
    `;
    // Posição default (o original posicionava relativo ao painel do Vanta,
    // que não existe nesta arquitetura); o widget continua arrastável.
    widget.style.left = '16px';
    widget.style.top = '70px';
    document.body.appendChild(scope.owns(widget));

    // ── Drag (listeners de document rastreados pelo scope) ──

    function makeDraggable(): void {
      const header = widget.querySelector<HTMLElement>('#vanta-coletor-header');
      if (header === null) return;
      let dragging = false;
      let dx = 0;
      let dy = 0;
      scope.on(header, 'mousedown', (e) => {
        const me = e as MouseEvent;
        dragging = true;
        dx = me.clientX - widget.getBoundingClientRect().left;
        dy = me.clientY - widget.getBoundingClientRect().top;
        me.preventDefault();
      });
      scope.on(document, 'mousemove', (e) => {
        if (!dragging) return;
        const me = e as MouseEvent;
        widget.style.right = 'auto';
        widget.style.left = `${me.clientX - dx}px`;
        widget.style.top = `${me.clientY - dy}px`;
      });
      scope.on(document, 'mouseup', () => {
        dragging = false;
      });
    }

    // ── Botões de seleção ──

    function setupSelectionButtons(): void {
      required('vanta-coletor-reset').addEventListener('click', () => {
        selectedVillages = [];
        saveVillages();
        updateUI();
        clearAllVillageFilters();
        // Remove o highlight de rabisco e reaplica só os grupos salvos. O
        // original restaurava/reinstalava o spawnSector aqui; como o wrapper é
        // dirigido pelo filterMap, basta reconstruí-lo sem a seleção de rabisco.
        installHighlight();
      });

      required('vanta-coletor-copy').addEventListener('click', () => {
        const coords = (required('vanta-coletor-list') as HTMLTextAreaElement).value.trim();
        if (coords === '') {
          flashBtn('vanta-coletor-copy', 'Vazio!');
          return;
        }
        copyToClipboard(coords);
        flashBtn('vanta-coletor-copy', 'Copiado!');
      });

      required('vanta-coletor-copy-id').addEventListener('click', () => {
        void (async () => {
          const coords = (required('vanta-coletor-list') as HTMLTextAreaElement).value.trim();
          if (coords === '') {
            flashBtn('vanta-coletor-copy-id', 'Vazio!');
            return;
          }
          const btn = required('vanta-coletor-copy-id') as HTMLButtonElement;
          const origLabel = btn.textContent;
          btn.textContent = '...';
          btn.disabled = true;
          try {
            const villages = await fetchVillageTxt();
            const coordSet = new Set(normalizeCoordList(coords));
            const withId = villages
              .filter((v) => coordSet.has(v.key))
              .map((v) => `${v.key}:${v.id}`)
              .join(' ');
            btn.textContent = withId !== '' ? 'Copiado!' : 'Sem dados!';
            if (withId !== '') copyToClipboard(withId);
          } catch (err) {
            btn.textContent = 'Erro!';
            console.error('[tsh vanta coletor] fetchVillageTxt:', err);
          } finally {
            btn.disabled = false;
            scope.after(() => {
              btn.textContent = origLabel;
            }, 1500);
          }
        })();
      });

      required('vanta-coletor-highlight').addEventListener('click', () => {
        const raw = (required('vanta-coletor-list') as HTMLTextAreaElement).value.trim();
        if (raw === '') {
          flashBtn('vanta-coletor-highlight', 'Vazio!');
          return;
        }
        if (twMap() === null) return;
        selectedVillages = normalizeCoordList(raw);
        saveVillages();
        updateUI();
        installHighlight();
        flashBtn('vanta-coletor-highlight', 'Destacado!');
      });
    }

    // ── Gestão de grupos salvos ──

    function setupGroupManagement(): void {
      function saveGroup(name: string): void {
        const colorInput = document.getElementById('vanta-coletor-group-color') as HTMLInputElement | null;
        const color = colorInput !== null ? normalizeGroupColor(colorInput.value) : '#7ddb82';
        groups.push({ id: Date.now(), name, color, villages: [...selectedVillages] });
        saveGroups();
        renderGroups();
      }

      function addToGroup(id: number): void {
        const idx = groups.findIndex((g) => g.id === id);
        if (idx === -1) return;
        const existing = new Set(groups[idx]!.villages);
        selectedVillages.forEach((v) => existing.add(v));
        groups[idx]!.villages = [...existing];
        saveGroups();
        renderGroups();
        installHighlight();
      }

      function setSaveMode(mode: 'novo' | 'add'): void {
        saveMode = mode;
        const isNovo = mode === 'novo';
        required('vanta-coletor-novo-row').style.display = isNovo ? 'flex' : 'none';
        required('vanta-coletor-add-row').style.display = isNovo ? 'none' : 'flex';
        required('vanta-coletor-mode-novo').style.fontWeight = isNovo ? 'bold' : '';
        required('vanta-coletor-mode-add').style.fontWeight = isNovo ? '' : 'bold';
        if (!isNovo) {
          const sel = required('vanta-coletor-group-select') as HTMLSelectElement;
          // P1-1 (original 2776): nome do grupo escapado.
          sel.innerHTML = groups
            .map((g) => `<option value="${escAttr(String(g.id))}">${escapeHtml(g.name)} (${g.villages.length})</option>`)
            .join('');
        } else {
          (required('vanta-coletor-name-input') as HTMLInputElement).focus();
        }
      }

      renderGroups();

      required('vanta-coletor-save-grupo').addEventListener('click', () => {
        if (selectedVillages.length === 0) {
          flashBtn('vanta-coletor-save-grupo', 'Vazio!');
          return;
        }
        required('vanta-coletor-save-row').style.display = 'flex';
        required('vanta-coletor-mode-row').style.display = groups.length > 0 ? 'flex' : 'none';
        (required('vanta-coletor-name-input') as HTMLInputElement).value = '';
        (required('vanta-coletor-group-color') as HTMLInputElement).value = pickDistinctColor(groups);
        setSaveMode('novo');
      });

      required('vanta-coletor-mode-novo').addEventListener('click', () => setSaveMode('novo'));
      required('vanta-coletor-mode-add').addEventListener('click', () => setSaveMode('add'));

      required('vanta-coletor-save-ok').addEventListener('click', () => {
        if (saveMode === 'novo') {
          const name = (required('vanta-coletor-name-input') as HTMLInputElement).value.trim();
          if (name === '') return;
          saveGroup(name);
        } else {
          const sel = required('vanta-coletor-group-select') as HTMLSelectElement;
          const id = Number(sel.value);
          if (!id) return;
          addToGroup(id);
        }
        required('vanta-coletor-save-row').style.display = 'none';
      });

      required('vanta-coletor-save-cancel').addEventListener('click', () => {
        required('vanta-coletor-save-row').style.display = 'none';
      });

      required('vanta-coletor-name-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') required('vanta-coletor-save-ok').click();
        if (e.key === 'Escape') required('vanta-coletor-save-cancel').click();
      });
    }

    // ── Grupo do Jogo (screen=groups via ajax) ──

    function setupGrupoDoJogo(): void {
      async function loadGroupsJson(villageId: string): Promise<LoadGroupsJson> {
        const vid = currentVillageId();
        if (vid === '') throw new Error('game_data indisponível');
        const url = `/game.php?village=${vid}&screen=groups&ajax=load_groups&village_id=${encodeURIComponent(villageId)}`;
        const json = JSON.parse(await pacedGet(url)) as LoadGroupsJson;
        if (typeof json.csrf === 'string' && json.csrf !== '') cachedCsrf = json.csrf;
        return json;
      }

      async function fetchInGameGroups(): Promise<InGameGroup[]> {
        const vid = currentVillageId();
        const json = await loadGroupsJson(vid);
        const result = Array.isArray(json.result) ? json.result : [];
        return result.filter((g) => g.type !== 'builtin');
      }

      async function groupsOfVillage(villageId: string): Promise<number[]> {
        const json = await loadGroupsJson(villageId);
        const result = Array.isArray(json.result) ? json.result : [];
        return result
          .filter((g) => g.in_group === true)
          .map((g) => Number(g.group_id))
          .filter((id) => Number.isFinite(id));
      }

      async function setVillageGroups(villageId: string, ids: number[]): Promise<void> {
        const vid = currentVillageId();
        const csrf = cachedCsrf !== '' ? cachedCsrf : currentCsrf();
        const postUrl = `/game.php?village=${vid}&screen=groups&ajaxaction=village&h=${encodeURIComponent(csrf)}`;
        const body = new URLSearchParams();
        ids.forEach((id) => body.append('groups[]', String(id)));
        body.append('village_id', villageId);
        body.append('mode', 'village');
        // URLSearchParams passado "como Record": o construtor de URLSearchParams
        // clona outra instância preservando as chaves `groups[]` repetidas.
        const result = await vantaPostJson(postUrl, body as unknown as Record<string, string>);
        if (result.csrf !== '') cachedCsrf = result.csrf;
      }

      interface ResolvedSelection {
        resolved: Array<{ coord: string; id: string }>;
        unresolved: string[];
      }

      async function resolveSelection(
        progressEl: HTMLElement,
        addBtn: HTMLButtonElement,
        removeBtn: HTMLButtonElement,
      ): Promise<ResolvedSelection | null> {
        try {
          const villageTxt = await fetchVillageTxt();
          const coordToId: Record<string, string> = {};
          villageTxt.forEach((v) => {
            coordToId[v.key] = v.id;
          });
          const resolved: Array<{ coord: string; id: string }> = [];
          const unresolved: string[] = [];
          selectedVillages.forEach((coord) => {
            const id = coordToId[coord];
            if (id !== undefined) resolved.push({ coord, id });
            else unresolved.push(coord);
          });
          if (resolved.length === 0) {
            progressEl.style.color = '#c04038';
            progressEl.textContent =
              'Nenhuma coordenada encontrada em village.txt' +
              (unresolved.length > 0 ? ` (${unresolved.length} não resolvidas)` : '');
            addBtn.disabled = false;
            removeBtn.disabled = false;
            return null;
          }
          return { resolved, unresolved };
        } catch (e) {
          progressEl.style.color = '#c04038';
          progressEl.textContent = 'Erro ao carregar village.txt: ' + (e instanceof Error ? e.message : String(e));
          addBtn.disabled = false;
          removeBtn.disabled = false;
          return null;
        }
      }

      async function processInGameGroup(groupId: number, add: boolean): Promise<void> {
        const progressEl = required('vanta-coletor-ingame-progress');
        const addBtn = required('vanta-coletor-ingame-add') as HTMLButtonElement;
        const removeBtn = required('vanta-coletor-ingame-remove') as HTMLButtonElement;
        addBtn.disabled = true;
        removeBtn.disabled = true;
        progressEl.style.display = 'block';
        progressEl.style.color = '#5a3a16';
        progressEl.textContent = 'Resolvendo coordenadas...';

        const selection = await resolveSelection(progressEl, addBtn, removeBtn);
        if (selection === null) return;
        const { resolved, unresolved } = selection;

        // P3 (revisão Onda 2): lote mutante com confirmação, como os demais.
        const acao = add ? 'Adicionar' : 'Remover';
        if (
          !window.confirm(
            `${acao} ${resolved.length} aldeia(s) do grupo selecionado do jogo?` +
              (unresolved.length > 0 ? ` (${unresolved.length} coordenada(s) não resolvida(s) serão ignoradas)` : ''),
          )
        ) {
          progressEl.style.display = 'none';
          addBtn.disabled = false;
          removeBtn.disabled = false;
          return;
        }

        let changed = 0;
        let skipped = 0;
        let errors = 0;
        const verb = add ? 'Adicionando' : 'Removendo';
        for (let i = 0; i < resolved.length; i++) {
          const entry = resolved[i]!;
          progressEl.textContent = `${verb} ${i + 1}/${resolved.length}...`;
          try {
            const currentIds = await groupsOfVillage(entry.id);
            const target = Number(groupId);
            const belongs = currentIds.includes(target);
            if (add === belongs) {
              skipped++;
              continue;
            }
            const newIds = add ? [...currentIds, target] : currentIds.filter((id) => id !== target);
            await setVillageGroups(entry.id, newIds);
            changed++;
          } catch {
            errors++;
          }
        }

        const noun = add ? 'adicionada' : 'removida';
        let msg = `Concluído! ${changed} aldeia${changed !== 1 ? 's' : ''} ${noun}${changed !== 1 ? 's' : ''}.`;
        if (skipped > 0) {
          msg += add
            ? ` ${skipped} já pertencia${skipped !== 1 ? 'm' : ''} ao grupo.`
            : ` ${skipped} não pertencia${skipped !== 1 ? 'm' : ''} ao grupo.`;
        }
        if (unresolved.length > 0) {
          msg += ` ${unresolved.length} coord${unresolved.length !== 1 ? 's' : ''} não encontrada${unresolved.length !== 1 ? 's' : ''}.`;
        }
        if (errors > 0) msg += ` ${errors} erro${errors !== 1 ? 's' : ''}.`;

        progressEl.style.color = errors > 0 ? '#c04038' : '#3f8f43';
        progressEl.textContent = msg;
        addBtn.disabled = false;
        removeBtn.disabled = false;
      }

      required('vanta-coletor-ingame-btn').addEventListener('click', () => {
        void (async () => {
          const section = required('vanta-coletor-ingame-section');
          if (section.style.display !== 'none') {
            section.style.display = 'none';
            return;
          }
          if (selectedVillages.length === 0) {
            flashBtn('vanta-coletor-ingame-btn', 'Vazio!');
            return;
          }

          section.style.display = '';
          const sel = required('vanta-coletor-ingame-select') as HTMLSelectElement;
          const addBtn = required('vanta-coletor-ingame-add') as HTMLButtonElement;
          const removeBtn = required('vanta-coletor-ingame-remove') as HTMLButtonElement;
          const progressEl = required('vanta-coletor-ingame-progress');
          sel.disabled = true;
          addBtn.disabled = true;
          removeBtn.disabled = true;
          sel.innerHTML = '<option value="">Carregando...</option>';
          progressEl.style.display = 'none';

          try {
            const gameGroups = await fetchInGameGroups();
            if (gameGroups.length === 0) {
              sel.innerHTML = '<option value="">Nenhum grupo encontrado</option>';
              return;
            }
            // P1-1 (original 3084): nome do grupo do jogo escapado.
            sel.innerHTML = gameGroups
              .map((g) => `<option value="${escAttr(String(g.group_id))}">${escapeHtml(g.name)}</option>`)
              .join('');
            sel.disabled = false;
            addBtn.disabled = false;
            removeBtn.disabled = false;
          } catch {
            sel.innerHTML = '<option value="">Erro — recarregue a página</option>';
          }
        })();
      });

      required('vanta-coletor-ingame-add').addEventListener('click', () => {
        const sel = required('vanta-coletor-ingame-select') as HTMLSelectElement;
        const groupId = Number(sel.value);
        if (!groupId) return;
        void processInGameGroup(groupId, true);
      });

      required('vanta-coletor-ingame-remove').addEventListener('click', () => {
        const sel = required('vanta-coletor-ingame-select') as HTMLSelectElement;
        const groupId = Number(sel.value);
        if (!groupId) return;
        void processInGameGroup(groupId, false);
      });
    }

    // ── Orquestração ──

    updateUI();
    makeDraggable();
    setupSelectionButtons();
    setupGroupManagement();
    setupGrupoDoJogo();

    required('vanta-coletor-close').addEventListener('click', () => {
      widgetOpen = false;
      restoreHooks();
      twMap()?.reload();
      clearVillageTxtCache();
      widget.remove();
    });

    // Auto-highlight na abertura (seleção de rabisco + grupos salvos).
    if (selectedVillages.length > 0 || groups.length > 0) {
      scope.after(() => {
        installHighlight();
      }, 0);
    }
  },
});
