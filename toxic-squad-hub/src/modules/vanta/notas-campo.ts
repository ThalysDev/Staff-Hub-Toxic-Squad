// Bloco de Campo (Onda 6): notas locais por aldeia — rascunhos do jogador
// (alvos marcados, lembretes de OP, avisos de tribo) gravados no GM storage,
// sem nuvem por decisão do dono. Injeta um pequeno bloco "Notas" na tela da
// aldeia (info_village) e no mapa um marcador ● nas aldeias com nota.
// Visualização no mapa: overlay discreto via TWMap.spawnSector (padrão do
// coletor, com restore no dispose).

import { gm } from '../../core/storage';
import type { ModuleScope } from './vanta-lifecycle';
import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import { pageWindow } from '../../core/page';

const NOTES_KEY = 'tsh-vanta:notas:villages';

interface VillageNote {
  readonly text: string;
  readonly updatedAt: number;
}

type NotesStore = Record<string, VillageNote>;

function loadNotes(): NotesStore {
  return gm.get<NotesStore>(NOTES_KEY, {});
}

function saveNotes(store: NotesStore): void {
  gm.set(NOTES_KEY, store);
}

export function getVillageNote(villageId: string): VillageNote | null {
  return loadNotes()[villageId] ?? null;
}

export function setVillageNote(villageId: string, text: string): void {
  const store = loadNotes();
  if (text.trim() === '') {
    delete store[villageId];
  } else {
    store[villageId] = { text: text.trim().slice(0, 500), updatedAt: Date.now() };
  }
  saveNotes(store);
}

/** Aldeias com nota (para o marcador do mapa e buscas). */
export function villagesWithNotes(): { villageId: string; note: VillageNote }[] {
  const store = loadNotes();
  return Object.entries(store).map(([villageId, note]) => ({ villageId, note }));
}

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** Id da aldeia em exibição na tela info_village (parâmetro id). */
function infoVillageId(): string | null {
  const id = params().get('id');
  return id !== null && /^\d+$/.test(id) ? id : null;
}

// ── Launcher: bloco de notas na tela da aldeia ─────────────────────────────

registerVanta({
  id: 'vanta-notas-campo',
  label: 'Bloco de Campo',
  desc: 'Notas locais por aldeia (rascunhos de OP, lembretes) com marcador no mapa.',
  group: 'utilidades',
  match: () => params().get('screen') === 'info_village',
  url: () => `/game.php?village=${pageWindow().game_data?.village?.id ?? ''}&screen=info_village`,
  mount(scope: ModuleScope): void {
    ensureVantaStyles();
    if (document.getElementById('vanta-notas-ui') !== null) return;
    const villageId = infoVillageId();
    if (villageId === null) return;

    const anchor =
      document.querySelector('#content_value h2, #content_value h3')?.parentElement ??
      document.getElementById('content_value');
    if (anchor === null) return;

    const container = document.createElement('div');
    container.id = 'vanta-notas-ui';
    container.className = 'vanta-widget';

    const title = document.createElement('div');
    title.className = 'vanta-widget-title';
    title.textContent = 'Bloco de Campo';
    const body = document.createElement('div');
    body.className = 'vanta-widget-body';

    const textarea = document.createElement('textarea');
    textarea.rows = 4;
    textarea.maxLength = 500;
    textarea.placeholder = 'Notas desta aldeia (local, não sincroniza)…';
    const existing = getVillageNote(villageId);
    textarea.value = existing?.text ?? '';

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Salvar nota';
    const status = document.createElement('span');
    status.style.marginLeft = '8px';
    status.style.fontSize = '11px';

    scope.on(save, 'click', () => {
      setVillageNote(villageId, textarea.value);
      status.textContent = 'Salvo ✓';
      scope.after(() => {
        status.textContent = '';
      }, 2000);
    });

    body.append(textarea, save, status);
    container.append(title, body);
    anchor.insertBefore(container, anchor.firstChild);
    scope.owns(container);
  },
});

// ── Marcador no mapa (decoração idempotente, sem patch de handler) ─────────
// A cada 2s (scope.every) varre os elementos de aldeia renderizados pelo jogo
// e decora com ● âmbar os que têm nota. Os pontos são scope.owns → o dispose
// os remove sozinho; nenhum handler do TWMap é tocado. Falha silenciosa.

export function mountMapNotesMarker(scope: ModuleScope): void {
  const decorate = (): void => {
    try {
      const withNotes = new Set(villagesWithNotes().map((v) => v.villageId));
      if (withNotes.size === 0) return;
      const candidates = document.querySelectorAll<HTMLElement>('[data-id], [id^="village_"]');
      for (const el of candidates) {
        const raw = el.dataset.id ?? el.id.replace(/^village_/, '');
        if (raw === '' || !/^\d+$/.test(raw) || !withNotes.has(raw)) continue;
        if (el.dataset.tshNota !== undefined) continue;
        el.dataset.tshNota = '1';
        const dot = document.createElement('span');
        dot.textContent = '●';
        dot.title = 'Esta aldeia tem nota no Bloco de Campo';
        dot.style.color = '#b8860b';
        dot.style.position = 'absolute';
        dot.style.top = '0';
        dot.style.right = '0';
        dot.style.fontSize = '10px';
        dot.style.pointerEvents = 'none';
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        el.appendChild(dot);
        scope.owns(dot);
      }
    } catch {
      // decorativo: nunca quebra o mapa do jogo
    }
  };
  decorate();
  scope.every(decorate, 2000);
}

// Launcher próprio do marcador: sem ele o mount acima ficaria órfão (o painel
// só monta módulos registrados). O Bloco de Campo continua na tela da aldeia.
registerVanta({
  id: 'vanta-notas-mapa',
  label: 'Notas no Mapa',
  desc: 'Marca com ● as aldeias que têm nota no Bloco de Campo.',
  group: 'utilidades',
  match: () => params().get('screen') === 'map',
  url: () => '/game.php?screen=map',
  mount(scope: ModuleScope): void {
    mountMapNotesMarker(scope);
  },
});
