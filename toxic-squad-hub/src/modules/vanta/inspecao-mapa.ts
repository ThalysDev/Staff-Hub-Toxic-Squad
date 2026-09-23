// Inspeção de Aldeias (Onda 3) — screen=map: widget flutuante com toggle ON/OFF
// no padrão do Coletor (arrastável, ModuleScope, dispose limpo, idempotente).
// LIGADA, passar o mouse sobre uma aldeia do mapa mostra nome, coordenada, dono
// e pontos (village.txt via villageAt/allVillages do tsh-game-data) no painel; o
// botão "Detalhes" busca SOB DEMANDA /game.php?screen=info_village&id=N
// (pacedDoc + DOMParser) e lê muralha/paladino/recursos/lealdade da visão geral,
// com cache GM de 30min por aldeia (o próprio botão vira "Atualizar" para forçar).
//
// Hover (abordagem escolhida): o mapa é desenhado em canvas e o TWMap já resolve
// as coordenadas do evento (TWMap.map.coordByEvent — o MESMO caminho que o clique
// do coletor usa); `xy = x*1000+y` indexa TWMap.villages. O listener fica em
// document na fase de CAPTURA (o canvas pode parar a propagação do mousemove) com
// filtro de alvo (canvas ou dentro de #map, nunca sobre a UI Vanta) e só
// re-renderiza quando a aldeia sob o cursor MUDA — sem timer por mousemove.
//
// Parse de info_village: as linhas da visão geral são pares rótulo→valor em
// tabelas (fixture real tests/fixtures/br142/village-info-own.html: "Coordenadas:",
// "Pontos:", "Jogador:", "Tribo:"). O parser varre as linhas de 2 células e as
// células únicas no formato "Rótulo: valor", casando por rótulo normalizado
// (PT-BR + EN); nenhum rótulo conhecido = estrutura desconhecida → fail-closed
// ("não lido"), nunca exceção silenciosa nem dado inventado.

import { pageWindow } from '../../core/page';
import { gm } from '../../core/storage';
import { allVillages, villageAt } from '../tsh/tsh-game-data';
import type { ModuleScope } from './vanta-lifecycle';
import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import { coordKey } from './vanta-utils';
import { currentVillageId, pacedDoc, pacedGet } from './vanta-net';

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
}

interface TWMapApi {
  map?: TWMapMap;
  villages?: Record<number, TWMapVillage>;
}

function twMap(): TWMapApi | null {
  return (pageWindow() as unknown as { TWMap?: TWMapApi }).TWMap ?? null;
}

// ── info_village: URL + visão geral (pares rótulo→valor) ────────────────────

/** info_village da aldeia alvo, com o `village=` de contexto da página (padrão dos módulos). */
function infoVillagePath(villageId: string): string {
  const vid = currentVillageId();
  const context = vid !== '' ? `village=${encodeURIComponent(vid)}&` : '';
  return `/game.php?${context}screen=info_village&id=${encodeURIComponent(villageId)}`;
}

interface OverviewRow {
  label: string;
  value: string;
}

interface VillageOverview {
  /** Linhas lidas da visão geral (rótulo ORIGINAL do jogo, para exibição). */
  rows: OverviewRow[];
  wall: string | null;
  paladin: string | null;
  loyalty: string | null;
  resources: string | null;
}

type FieldName = 'wall' | 'paladin' | 'loyalty' | 'resources';

/** Rótulos aceitos por campo (PT-BR do jogo + EN como rede de segurança). */
const FIELD_LABELS: Record<FieldName, string[]> = {
  wall: ['muralha', 'wall'],
  paladin: ['paladino', 'paladin'],
  loyalty: ['lealdade', 'loyalty'],
  resources: ['recursos', 'resources'],
};

/** Recursos podem vir em linhas separadas (madeira/argila/ferro) em vez de uma só. */
const RESOURCE_PART_LABELS = ['madeira', 'argila', 'ferro', 'wood', 'clay', 'iron'];

/** Rótulos que os 4 campos consomem (o resto da visão geral vai para "Visão geral"). */
const FIELD_CONSUMED_LABELS = new Set<string>([
  ...FIELD_LABELS.wall,
  ...FIELD_LABELS.paladin,
  ...FIELD_LABELS.loyalty,
  ...FIELD_LABELS.resources,
  ...RESOURCE_PART_LABELS,
]);

/** Qualquer um destes = estrutura da visão geral reconhecida (senão fail-closed). */
const RECOGNIZED_LABELS = new Set<string>([
  ...FIELD_CONSUMED_LABELS,
  'coordenadas',
  'coordinates',
  'pontos',
  'points',
  'jogador',
  'player',
  'tribo',
  'tribe',
  'nome',
  'name',
  'populacao',
  'population',
  'distancia',
  'distance',
  'moral',
]);

/** Minúsculas, sem acento e sem dois-pontos final ("Muralha: " → "muralha"). */
function normalizeLabel(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[:.\s]+$/, '')
    .trim();
}

function cleanText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

/** Pares rótulo→valor da página: linhas de 2 células e células "Rótulo: valor". */
function collectOverviewRows(doc: Document): OverviewRow[] {
  const rows: OverviewRow[] = [];
  doc.querySelectorAll('tr').forEach((tr) => {
    const cells = Array.from(tr.children).filter((c): c is HTMLTableCellElement => c instanceof HTMLTableCellElement);
    if (cells.length === 2) {
      const label = cleanText(cells[0]?.textContent);
      const value = cleanText(cells[1]?.textContent);
      if (label !== '' && value !== '') rows.push({ label, value });
      return;
    }
    if (cells.length === 1) {
      const text = cleanText(cells[0]?.textContent);
      const match = text.match(/^([^:]{2,40}):\s*(.+)$/);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        rows.push({ label: match[1].trim(), value: match[2].trim() });
      }
    }
  });
  return rows;
}

/**
 * Visão geral de info_village. null = nenhum rótulo conhecido encontrado
 * (estrutura desconhecida → o chamador mostra "não lido", fail-closed).
 */
function parseVillageOverview(doc: Document): VillageOverview | null {
  const rows = collectOverviewRows(doc);
  const byLabel = new Map<string, string>();
  for (const row of rows) {
    const key = normalizeLabel(row.label);
    if (!byLabel.has(key)) byLabel.set(key, row.value);
  }

  const pick = (aliases: string[]): string | null => {
    for (const alias of aliases) {
      const value = byLabel.get(alias);
      if (value !== undefined && value !== '') return value;
    }
    return null;
  };

  if (!rows.some((row) => RECOGNIZED_LABELS.has(normalizeLabel(row.label)))) return null;

  const resourceParts = RESOURCE_PART_LABELS.map((label) => {
    const value = byLabel.get(label);
    return value !== undefined && value !== '' ? `${label}: ${value}` : null;
  }).filter((part): part is string => part !== null);

  return {
    rows,
    wall: pick(FIELD_LABELS.wall),
    paladin: pick(FIELD_LABELS.paladin),
    loyalty: pick(FIELD_LABELS.loyalty),
    resources: pick(FIELD_LABELS.resources) ?? (resourceParts.length > 0 ? resourceParts.join(' · ') : null),
  };
}

// ── Cache GM (TTL 30min por aldeia) ────────────────────────────────────────

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_PREFIX = 'tsh-vanta:inspecao:cache:';

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** Entrada válida e dentro do TTL; qualquer desvio = cache miss (fail-closed). */
function readCache(villageId: string): VillageOverview | null {
  const raw: unknown = gm.get<unknown>(CACHE_PREFIX + villageId, null);
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.at !== 'number' || Date.now() - entry.at >= CACHE_TTL_MS) return null;
  if (typeof entry.data !== 'object' || entry.data === null) return null;

  const data = entry.data as Record<string, unknown>;
  const wall = stringOrNull(data.wall);
  const paladin = stringOrNull(data.paladin);
  const loyalty = stringOrNull(data.loyalty);
  const resources = stringOrNull(data.resources);
  if (wall === undefined || paladin === undefined || loyalty === undefined || resources === undefined) return null;
  if (!Array.isArray(data.rows)) return null;

  const rows: OverviewRow[] = [];
  for (const item of data.rows) {
    if (typeof item !== 'object' || item === null) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.label !== 'string' || typeof row.value !== 'string') return null;
    rows.push({ label: row.label, value: row.value });
  }
  return { rows, wall, paladin, loyalty, resources };
}

function writeCache(villageId: string, overview: VillageOverview): void {
  gm.set(CACHE_PREFIX + villageId, { at: Date.now(), data: overview });
}

// ── Dono: id do village.txt → nome em /map/player.txt (cache de sessão) ────

const PLAYER_TXT_TTL_MS = 10 * 60 * 1000;
let playerNames: Map<string, string> | null = null;
let playerNamesAt = 0;

/** Nome do jogador (best-effort): '' quando player.txt não traz o id. */
async function ownerName(playerId: string): Promise<string> {
  if (playerNames === null || Date.now() - playerNamesAt >= PLAYER_TXT_TTL_MS) {
    try {
      const text = await pacedGet('/map/player.txt');
      const names = new Map<string, string>();
      for (const line of text.trim().split('\n')) {
        const parts = line.split(',');
        const id = parts[0] ?? '';
        const rawName = parts[1] ?? '';
        if (id === '' || rawName === '') continue;
        let name = rawName;
        try {
          name = decodeURIComponent(rawName.replace(/\+/g, '%20'));
        } catch {
          /* nome cru se o decode falhar */
        }
        names.set(id, name);
      }
      // Não cacheia resultado vazio (formato inesperado tenta de novo depois).
      if (names.size > 0) {
        playerNames = names;
        playerNamesAt = Date.now();
      }
    } catch {
      /* sem nomes: o painel mostra o id */
    }
  }
  return playerNames?.get(playerId) ?? '';
}

// ── Widget (CSS local: os estilos da suíte não cobrem os ids novos) ────────

const STYLE_ID = 'vanta-inspecao-styles';
const TOGGLE_KEY = 'tsh-vanta:inspecao:on';
const WIDGET_STYLES = `
  #vanta-inspecao-widget {
    position: fixed; z-index: 99999; width: 250px;
    background: var(--shs-bg-card, #fffdf3); border: 1px solid var(--shs-border-strong, #cbb384); border-radius: 12px;
    box-shadow: 0 12px 40px rgba(60,37,10,0.18);
    font-family: var(--shs-font, Verdana, sans-serif); font-size: 12px; color: var(--shs-ink, #5a3a16);
  }
  #vanta-inspecao-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 12px 8px; background: var(--shs-bg-head, #efe2ba); border-bottom: 1px solid var(--shs-border, #e0cda0);
    border-radius: 12px 12px 0 0; cursor: grab;
  }
  #vanta-inspecao-header:active { cursor: grabbing; }
  #vanta-inspecao-title {
    font-size: 11px; font-weight: 700; letter-spacing: 2px;
    color: var(--shs-ink-strong, #3c250a); text-transform: uppercase;
  }
  #vanta-inspecao-close {
    background: none; border: none; color: var(--shs-muted, #6f5e40); font-size: 16px;
    line-height: 1; cursor: pointer; padding: 0 2px;
  }
  #vanta-inspecao-close:hover { color: var(--shs-danger, #c04038); }
  #vanta-inspecao-body {
    padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px;
  }
  #vanta-inspecao-toggle-row {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 600; color: var(--shs-accent-ink, #8a5a1e); cursor: pointer;
  }
  #vanta-inspecao-status { font-size: 11px; color: var(--shs-muted, #6f5e40); }
  #vanta-inspecao-village {
    display: flex; flex-direction: column; gap: 5px;
    border-top: 1px dashed var(--shs-border-head, #d9c48f); padding-top: 7px;
  }
  #vanta-inspecao-name {
    font-size: 12px; font-weight: 700; color: var(--shs-ink-strong, #3c250a); overflow-wrap: anywhere;
  }
  #vanta-inspecao-meta { font-size: 11px; color: var(--shs-accent-ink, #8a5a1e); overflow-wrap: anywhere; }
  #vanta-inspecao-details {
    display: flex; flex-direction: column; gap: 3px;
    max-height: 190px; overflow-y: auto;
  }
  #vanta-inspecao-details:empty { display: none; }
  .vanta-inspecao-section {
    font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
    color: var(--shs-accent-ink, #8a5a1e); margin-top: 3px;
  }
  .vanta-inspecao-row { display: flex; gap: 6px; font-size: 11px; }
  .vanta-inspecao-row-label { flex: 0 0 74px; color: var(--shs-accent-ink, #8a5a1e); }
  .vanta-inspecao-row-value { flex: 1; min-width: 0; color: var(--shs-ink-strong, #3c250a); overflow-wrap: anywhere; }
  .vanta-inspecao-row-missing .vanta-inspecao-row-value { color: var(--shs-ink-disabled, #b3a27d); font-style: italic; }
  .vanta-inspecao-msg { font-size: 11px; color: var(--shs-danger, #c04038); }
  #vanta-inspecao-actions { display: flex; gap: 4px; }
  .vanta-inspecao-btn {
    flex: 1 1 auto; padding: 5px 8px; background: var(--shs-bg-field, #fbf4de); border: 1px solid var(--shs-border-strong, #cbb384);
    border-radius: 8px; color: var(--shs-ink, #5a3a16); font-size: 11px; cursor: pointer; white-space: nowrap;
  }
  .vanta-inspecao-btn:hover { background: var(--shs-bg-head, #efe2ba); border-color: var(--shs-action-hover, #834a1a); color: var(--shs-action-hover, #834a1a); }
  .vanta-inspecao-btn:disabled { opacity: 0.5; cursor: not-allowed; }
`;

// ── Launcher ───────────────────────────────────────────────────────────────

registerVanta({
  id: 'vanta-inspecao-mapa',
  label: 'Inspeção de Aldeias',
  icon: 'search',
  desc: 'Passar o mouse na aldeia do mapa mostra dono, pontos e detalhes',
  group: 'utilidades',
  match: () => params().get('screen') === 'map',
  url: () => '/game.php?screen=map',
  mount(scope: ModuleScope): void {
    ensureVantaStyles();
    if (document.getElementById('vanta-inspecao-widget') !== null) return;
    if (document.body === null) return;

    // ── State ──
    let on = gm.get<boolean>(TOGGLE_KEY, true);
    let current: { id: string; x: number; y: number } | null = null;
    /** Aldeia cujos detalhes estão no painel (faz o botão virar "Atualizar"). */
    let detailsFor: string | null = null;
    let hoverToken = 0;
    let detailsToken = 0;
    let lastHoverKey = '';
    let mapWaitAttempts = 0;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = WIDGET_STYLES;
    document.head?.appendChild(scope.owns(style));

    const widget = document.createElement('div');
    widget.id = 'vanta-inspecao-widget';
    widget.innerHTML = `
        <div id="vanta-inspecao-header">
            <span id="vanta-inspecao-title">Inspeção de Aldeias</span>
            <button type="button" id="vanta-inspecao-close" title="Fechar">×</button>
        </div>
        <div id="vanta-inspecao-body">
            <label id="vanta-inspecao-toggle-row">
                <input type="checkbox" id="vanta-inspecao-toggle"> Inspecionar ao passar o mouse
            </label>
            <div id="vanta-inspecao-status"></div>
            <div id="vanta-inspecao-village" style="display:none">
                <div id="vanta-inspecao-name"></div>
                <div id="vanta-inspecao-meta"></div>
                <div id="vanta-inspecao-details"></div>
                <div id="vanta-inspecao-actions">
                    <button type="button" class="vanta-inspecao-btn" id="vanta-inspecao-detalhes" disabled>Detalhes</button>
                </div>
            </div>
        </div>
    `;
    widget.style.left = '16px';
    widget.style.top = '70px';
    document.body.appendChild(scope.owns(widget));

    const toggleEl = document.getElementById('vanta-inspecao-toggle');
    const statusEl = document.getElementById('vanta-inspecao-status');
    const villageEl = document.getElementById('vanta-inspecao-village');
    const nameEl = document.getElementById('vanta-inspecao-name');
    const metaEl = document.getElementById('vanta-inspecao-meta');
    const detailsEl = document.getElementById('vanta-inspecao-details');
    const detalhesEl = document.getElementById('vanta-inspecao-detalhes');
    const closeEl = document.getElementById('vanta-inspecao-close');
    if (
      !(toggleEl instanceof HTMLInputElement) ||
      !(villageEl instanceof HTMLElement) ||
      nameEl === null ||
      metaEl === null ||
      detailsEl === null ||
      !(detalhesEl instanceof HTMLButtonElement)
    ) {
      return;
    }
    // Consts estreitadas para as closures (o narrowing não sobrevive a elas).
    const toggle: HTMLInputElement = toggleEl;
    const village: HTMLElement = villageEl;
    const nameBox: HTMLElement = nameEl;
    const metaBox: HTMLElement = metaEl;
    const detailsBox: HTMLElement = detailsEl;
    const detalhesBtn: HTMLButtonElement = detalhesEl;

    function setStatus(text: string, color = '#6f5e40'): void {
      if (statusEl === null) return;
      statusEl.style.color = color;
      statusEl.textContent = text;
    }

    function rowElement(label: string, value: string, missing: boolean): HTMLElement {
      const row = document.createElement('div');
      row.className = missing ? 'vanta-inspecao-row vanta-inspecao-row-missing' : 'vanta-inspecao-row';
      const labelEl = document.createElement('span');
      labelEl.className = 'vanta-inspecao-row-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'vanta-inspecao-row-value';
      valueEl.textContent = value;
      row.appendChild(labelEl);
      row.appendChild(valueEl);
      return row;
    }

    function sectionElement(text: string): HTMLElement {
      const el = document.createElement('div');
      el.className = 'vanta-inspecao-section';
      el.textContent = text;
      return el;
    }

    function messageElement(text: string): HTMLElement {
      const el = document.createElement('div');
      el.className = 'vanta-inspecao-msg';
      el.textContent = text;
      return el;
    }

    function clearDetails(): void {
      detailsBox.replaceChildren();
      detailsFor = null;
      detalhesBtn.textContent = 'Detalhes';
    }

    function renderDetails(overview: VillageOverview, fromCache: boolean): void {
      detailsBox.replaceChildren();
      detailsBox.appendChild(sectionElement('Detalhes'));
      const fields: Array<[string, string | null]> = [
        ['Muralha', overview.wall],
        ['Paladino', overview.paladin],
        ['Lealdade', overview.loyalty],
        ['Recursos', overview.resources],
      ];
      for (const [label, value] of fields) {
        detailsBox.appendChild(rowElement(label, value ?? 'não disponível nesta tela', value === null));
      }

      // Demais linhas da visão geral (Coordenadas/Pontos/Jogador/Tribo...).
      const extras = overview.rows
        .filter((row) => !FIELD_CONSUMED_LABELS.has(normalizeLabel(row.label)))
        .slice(0, 8);
      if (extras.length > 0) {
        detailsBox.appendChild(sectionElement('Visão geral'));
        for (const row of extras) {
          detailsBox.appendChild(rowElement(row.label.replace(/:\s*$/, ''), row.value, false));
        }
      }

      detailsFor = current !== null ? current.id : null;
      detalhesBtn.textContent = 'Atualizar';
      if (fromCache) setStatus('Detalhes do cache (TTL 30min) — "Atualizar" relê agora.');
    }

    async function loadDetails(villageId: string, force: boolean): Promise<void> {
      const token = ++detailsToken;
      const cached = force ? null : readCache(villageId);
      if (cached !== null) {
        renderDetails(cached, true);
        return;
      }

      detailsBox.replaceChildren(sectionElement('Detalhes'), rowElement('Lendo...', 'info_village', true));
      detalhesBtn.disabled = true;
      try {
        const doc = await pacedDoc(infoVillagePath(villageId));
        if (token !== detailsToken || current === null || current.id !== villageId) return; // hover mudou
        const overview = parseVillageOverview(doc);
        if (overview === null) {
          detailsBox.replaceChildren(messageElement('Estrutura da página mudou — detalhes não lidos.'));
          setStatus('Não reconheci a visão geral de info_village (fail-closed).', '#c04038');
          return;
        }
        writeCache(villageId, overview);
        renderDetails(overview, false);
      } catch (error) {
        if (token !== detailsToken) return;
        detailsBox.replaceChildren(
          messageElement(`Erro ao ler detalhes: ${error instanceof Error ? error.message : String(error)}`),
        );
      } finally {
        if (token === detailsToken) detalhesBtn.disabled = false;
      }
    }

    /** Mostra a aldeia sob o cursor (nome/coord/dono/pontos via village.txt). */
    async function showVillage(villageId: string, x: number, y: number): Promise<void> {
      const token = ++hoverToken;
      current = { id: villageId, x, y };
      village.style.display = '';
      clearDetails();
      nameBox.textContent = `Aldeia ${villageId}`;
      metaBox.textContent = `${coordKey(x, y)} · lendo village.txt...`;
      detalhesBtn.disabled = true;
      setStatus('');

      let points = 0;
      let ownerId = '';
      try {
        const at = await villageAt(x, y);
        if (token !== hoverToken) return;
        if (at === null) {
          metaBox.textContent = `${coordKey(x, y)} · não está no village.txt`;
          detalhesBtn.disabled = false;
          return;
        }
        // O id do village.txt é o mesmo do TWMap — mantém o painel coerente.
        current = { id: at.id, x, y };
        nameBox.textContent = at.name !== '' ? at.name : `Aldeia ${at.id}`;
        points = at.points;
        metaBox.textContent = `${coordKey(x, y)} · ${points.toLocaleString('pt-BR')} pts · dono: lendo...`;
        detalhesBtn.disabled = false;

        const all = await allVillages(); // mesmo cache do villageAt — sem rede extra
        if (token !== hoverToken) return;
        ownerId = all.find((v) => v.id === at.id)?.playerId ?? '';
      } catch {
        if (token !== hoverToken) return;
        metaBox.textContent = `${coordKey(x, y)} · village.txt indisponível`;
        detalhesBtn.disabled = false;
        return;
      }

      const pts = `${points.toLocaleString('pt-BR')} pts`;
      if (ownerId === '' || ownerId === '0') {
        metaBox.textContent = `${coordKey(x, y)} · ${pts} · ${ownerId === '0' ? 'bárbaros' : 'dono desconhecido'}`;
        return;
      }
      const name = await ownerName(ownerId);
      if (token !== hoverToken) return;
      metaBox.textContent = `${coordKey(x, y)} · ${pts} · dono: ${name !== '' ? name : `#${ownerId}`}`;
    }

    function hideVillage(): void {
      hoverToken++;
      detailsToken++;
      current = null;
      lastHoverKey = '';
      village.style.display = 'none';
      clearDetails();
      detalhesBtn.disabled = true;
    }

    // ── Hover: coordenadas do TWMap sobre mousemove (fase de captura) ──

    function isMapTarget(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false;
      if (target.closest('[id^="vanta-"]') !== null) return false; // nunca sobre a UI Vanta
      if (target instanceof HTMLCanvasElement) return true;
      return target.closest('#map') !== null;
    }

    scope.on(
      document,
      'mousemove',
      (event) => {
        if (!on) return;
        if (!isMapTarget(event.target)) return;
        const tw = twMap();
        const map = tw?.map;
        if (tw === null || map === undefined) return;
        const pos = map.coordByEvent(event);
        const x = pos[0];
        const y = pos[1];
        if (typeof x !== 'number' || typeof y !== 'number') return;
        const mapVillage = tw.villages?.[x * 1000 + y];
        if (mapVillage === undefined || !mapVillage.id) return;
        const key = `${mapVillage.id}@${x}|${y}`;
        if (key === lastHoverKey) return; // mesma aldeia: nada a re-renderizar
        lastHoverKey = key;
        void showVillage(String(mapVillage.id), x, y);
      },
      { capture: true, passive: true },
    );

    scope.on(document, 'keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape' && current !== null) hideVillage();
    });

    // ── Toggle ──

    function waitForMap(): void {
      if (!on) return;
      if (twMap() !== null) {
        setStatus('Passe o mouse sobre uma aldeia do mapa.');
        return;
      }
      mapWaitAttempts++;
      if (mapWaitAttempts >= 50) {
        setStatus('O TWMap não carregou nesta tela — inspeção indisponível.', '#c04038');
        return;
      }
      setStatus('Aguardando o mapa carregar...');
      scope.after(waitForMap, 100);
    }

    function syncToggle(): void {
      toggle.checked = on;
      if (!on) {
        hideVillage();
        setStatus('Inspeção desligada.');
        return;
      }
      mapWaitAttempts = 0;
      waitForMap();
    }

    scope.on(toggle, 'change', () => {
      on = toggle.checked;
      gm.set(TOGGLE_KEY, on);
      syncToggle();
    });

    scope.on(detalhesBtn, 'click', () => {
      if (current === null) return;
      const villageId = current.id;
      void loadDetails(villageId, detailsFor === villageId);
    });

    // ── Drag (listeners de document rastreados pelo scope — padrão do coletor) ──

    const header = widget.querySelector<HTMLElement>('#vanta-inspecao-header');
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
        scope.dispose(); // remove widget, estilo, timers e listeners de uma vez
      });
    }

    syncToggle();
  },
});
