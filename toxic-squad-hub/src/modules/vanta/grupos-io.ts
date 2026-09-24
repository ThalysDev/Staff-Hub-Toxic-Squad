// Import/Export de Grupos do jogo (Onda 3 da Suite Vanta) — backup e
// restauração de QUAIS aldeias estão em QUAIS grupos do jogo (as duas fontes:
// `overview_villages` e a tela de grupos `screen=groups`).
//
// Exportar: lê TODOS os grupos com getGroupOptions() + getGroupVillages(id) do
// leitor da Onda 0 (ext/core/game-groups via tsh-groups), monta o JSON
// `{version:1, world, exportedAt, groups:[{id,nome,villages:[{id,x,y,nome}]}]}`
// e baixa como `tsh-grupos-<mundo>-<data>.json` (Blob + URL.createObjectURL).
// Leitura vazia de grupos é tratada como FALHA (nada de exportar backup vazio).
//
// Importar: input file → JSON.parse → validação manual rigorosa (fail-closed,
// mensagens pt-BR) → prévia "grupo X: +N aldeias" → confirmação no modal do
// padrão vanta → aplicação aldeia a aldeia com progresso.
//
// REGRA DO IMPORT: só ADICIONA. Nenhum grupo é criado ou apagado e nenhuma
// associação existente é removida — a associação de cada aldeia é lida na hora
// e o POST manda a UNIÃO (grupos atuais + grupo-alvo), exatamente o caminho
// verificado no Coletor (Onda 2): GET
// `screen=groups&ajax=load_groups&village_id=<id>` e POST
// `screen=groups&ajaxaction=village` com `groups[]`, `village_id` e
// `mode=village`. Arquivo de outro mundo é recusado (os ids de aldeia só valem
// no mundo de origem; resolver por coordenada seria adivinhação).

import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import type { ModuleScope } from './vanta-lifecycle';
import { currentCsrf, currentVillageId, pacedGet, vantaPostJson } from './vanta-net';
import { getGroupOptions, getGroupVillages, invalidateGroupsCache } from '../tsh/tsh-groups';
import type { GameGroupOption } from '../../ext/core/game-groups/groups-parser';
import { vantaConfirm } from './cancelamento-bloco';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** Mundo = subdomínio (br142.tribalwars.com.br → br142), padrão do runtime. */
function worldId(): string {
  return window.location.hostname.split('.')[0] ?? 'mundo';
}

/** Pausa entre mutações do lote (a fila global já garante ≥200ms; aqui ≥300ms). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PAUSA_MS = 300;

function mensagemDeErro(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Data local "AAAA-MM-DD" para o nome do arquivo. */
function localDateStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ── Formato do arquivo ──

interface FileVillage {
  id: number;
  x: number;
  y: number;
  nome: string;
}

interface FileGroup {
  id: number;
  nome: string;
  villages: FileVillage[];
}

interface GroupsFile {
  version: number;
  world: string;
  exportedAt: string;
  groups: FileGroup[];
}

/** Tetos de sanidade do arquivo (backup acima disso é recusado, não truncado). */
const MAX_GROUPS = 500;
const MAX_VILLAGES_PER_GROUP = 5000;

export type ImportParseResult = { ok: true; file: GroupsFile } | { ok: false; erro: string };

/**
 * Validação manual rigorosa do arquivo de backup (fail-closed): qualquer campo
 * fora do contrato recusa o arquivo INTEIRO com mensagem pt-BR — importar pela
 * metade seria pior que não importar.
 */
export function parseGroupsImportFile(text: string, currentWorld: string): ImportParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, erro: 'o arquivo não é um JSON válido.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, erro: 'o arquivo não tem o formato de backup do Hub (objeto JSON esperado).' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    return {
      ok: false,
      erro: `versão de arquivo não suportada (esperado version 1, veio ${JSON.stringify(obj.version)}).`,
    };
  }
  if (typeof obj.world !== 'string' || obj.world.trim() === '') {
    return { ok: false, erro: 'o arquivo não informa o mundo de origem (campo "world").' };
  }
  const world = obj.world.trim();
  if (world !== currentWorld) {
    return {
      ok: false,
      erro: `o arquivo é do mundo "${world}" — importe no mundo de origem (este é o "${currentWorld}").`,
    };
  }
  if (!Array.isArray(obj.groups)) {
    return { ok: false, erro: 'o arquivo não tem a lista de grupos (campo "groups").' };
  }
  if (obj.groups.length > MAX_GROUPS) {
    return { ok: false, erro: `o arquivo traz grupos demais (${obj.groups.length} > ${MAX_GROUPS}).` };
  }

  const seenGroups = new Set<number>();
  const groups: FileGroup[] = [];
  for (let index = 0; index < obj.groups.length; index++) {
    const entry: unknown = obj.groups[index];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, erro: `grupo ${index + 1} do arquivo é uma entrada inválida.` };
    }
    const group = entry as Record<string, unknown>;
    const id = group.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      return { ok: false, erro: `grupo ${index + 1} do arquivo tem id inválido.` };
    }
    if (seenGroups.has(id)) return { ok: false, erro: `o grupo ${id} aparece mais de uma vez no arquivo.` };
    seenGroups.add(id);
    if (!Array.isArray(group.villages)) {
      return { ok: false, erro: `o grupo ${id} do arquivo não tem a lista de aldeias.` };
    }
    if (group.villages.length > MAX_VILLAGES_PER_GROUP) {
      return {
        ok: false,
        erro: `o grupo ${id} traz aldeias demais (${group.villages.length} > ${MAX_VILLAGES_PER_GROUP}).`,
      };
    }
    const seenVillages = new Set<number>();
    const villages: FileVillage[] = [];
    for (let vIndex = 0; vIndex < group.villages.length; vIndex++) {
      const rawVillage: unknown = group.villages[vIndex];
      if (typeof rawVillage !== 'object' || rawVillage === null || Array.isArray(rawVillage)) {
        return { ok: false, erro: `grupo ${id}: aldeia ${vIndex + 1} do arquivo é inválida.` };
      }
      const village = rawVillage as Record<string, unknown>;
      const villageId = village.id;
      if (typeof villageId !== 'number' || !Number.isInteger(villageId) || villageId <= 0) {
        return { ok: false, erro: `grupo ${id}: aldeia ${vIndex + 1} do arquivo tem id inválido.` };
      }
      const x = village.x;
      const y = village.y;
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        x > 999 ||
        y < 0 ||
        y > 999
      ) {
        return { ok: false, erro: `grupo ${id}: aldeia ${vIndex + 1} do arquivo está sem coordenada válida.` };
      }
      if (seenVillages.has(villageId)) continue; // duplicata no arquivo: a primeira vale
      seenVillages.add(villageId);
      villages.push({
        id: villageId,
        x,
        y,
        nome: typeof village.nome === 'string' ? village.nome : '',
      });
    }
    groups.push({
      id,
      nome: typeof group.nome === 'string' ? group.nome : '',
      villages,
    });
  }

  return {
    ok: true,
    file: {
      version: 1,
      world,
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
      groups,
    },
  };
}

// ── Plano de importação (prévia) ──

interface PlanLine {
  kind: 'ok' | 'aviso';
  text: string;
}

interface PlanTarget {
  localGroupId: number;
  localName: string;
  villageIds: number[];
}

interface ImportPlan {
  lines: PlanLine[];
  targets: PlanTarget[];
  total: number;
}

/**
 * Lê os grupos locais e a associação ATUAL de cada grupo do arquivo (leitura
 * cacheada da Onda 0 — a aplicação confere aldeia por aldeia na hora do POST).
 * Grupo do arquivo sem correspondente local (por id ou por nome) é ignorado com
 * aviso: o import nunca cria grupo (ação não verificada) nem apaga nada.
 */
async function buildPlan(file: GroupsFile): Promise<ImportPlan> {
  const locals = await getGroupOptions();
  if (locals.length === 0) {
    throw new Error('nenhum grupo do jogo foi encontrado — abra a tela de Grupos no jogo e tente de novo');
  }
  const byId = new Map<number, GameGroupOption>();
  const byName = new Map<string, GameGroupOption[]>();
  locals.forEach((group) => {
    byId.set(group.groupId, group);
    const key = group.name.trim();
    const bucket = byName.get(key);
    if (bucket === undefined) byName.set(key, [group]);
    else bucket.push(group);
  });

  const lines: PlanLine[] = [];
  const targets: PlanTarget[] = [];
  let total = 0;

  for (const group of file.groups) {
    const label = group.nome.trim() !== '' ? group.nome.trim() : `grupo ${group.id}`;
    const byIdHit = byId.get(group.id);
    const byNameHits = byName.get(group.nome.trim());
    const byNameHit = byNameHits !== undefined && byNameHits.length === 1 ? byNameHits[0] : undefined;
    const local = byIdHit ?? byNameHit;

    if (local === undefined) {
      lines.push({
        kind: 'aviso',
        text: `${label} (id ${group.id}): não existe neste mundo — será IGNORADO. O import não cria grupos: crie-o no jogo e importe de novo.`,
      });
      continue;
    }
    if (byIdHit === undefined) {
      lines.push({
        kind: 'aviso',
        text: `${label}: o id do arquivo (${group.id}) não existe aqui; usando o grupo homônimo deste mundo (id ${local.groupId}).`,
      });
    }

    const current = await getGroupVillages(local.groupId);
    const inGroup = new Set(current.map((row) => row.villageId));
    const toAdd = group.villages.filter((village) => !inGroup.has(village.id));
    const already = group.villages.length - toAdd.length;

    if (toAdd.length === 0) {
      lines.push({
        kind: 'ok',
        text: `${label}: nada a fazer — ${group.villages.length} aldeia(s) do arquivo já estão no grupo.`,
      });
      continue;
    }
    lines.push({
      kind: 'ok',
      text: `${label}: +${toAdd.length} aldeia(s)${already > 0 ? ` (${already} já no grupo)` : ''}.`,
    });
    total += toAdd.length;
    targets.push({ localGroupId: local.groupId, localName: local.name, villageIds: toAdd.map((v) => v.id) });
  }

  return { lines, targets, total };
}

// ── Acesso aos grupos (mesmo caminho verificado do Coletor) ──

interface VillageGroupsJson {
  csrf?: unknown;
  result?: unknown;
}

function groupsPath(suffix: string): string {
  const villageId = currentVillageId();
  const prefix = villageId === '' ? '' : `village=${encodeURIComponent(villageId)}&`;
  return `/game.php?${prefix}screen=groups${suffix}`;
}

/** Grupos ATUAIS de uma aldeia (`ajax=load_groups`), com o csrf da resposta. */
async function groupsOfVillage(villageId: string, csrfIn: string): Promise<{ ids: number[]; csrf: string }> {
  const json = JSON.parse(
    await pacedGet(groupsPath(`&ajax=load_groups&village_id=${encodeURIComponent(villageId)}`), { fresh: true }),
  ) as VillageGroupsJson;
  const csrf = typeof json.csrf === 'string' && json.csrf !== '' ? json.csrf : csrfIn;
  if (!Array.isArray(json.result)) {
    throw new Error('o jogo não devolveu os grupos da aldeia (resposta inesperada).');
  }
  const ids = json.result
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    .filter((entry) => entry.in_group === true)
    .map((entry) => Number(entry.group_id))
    .filter((groupId) => Number.isInteger(groupId) && groupId > 0);
  return { ids, csrf };
}

/** Grava a associação COMPLETA da aldeia (união calculada pelo chamador). */
async function setVillageGroups(villageId: string, groupIds: number[], csrf: string): Promise<string> {
  const body = new URLSearchParams();
  groupIds.forEach((groupId) => body.append('groups[]', String(groupId)));
  body.append('village_id', villageId);
  body.append('mode', 'village');
  // URLSearchParams passado "como Record": o construtor clona outra instância
  // preservando as chaves `groups[]` repetidas (mesma escolha do Coletor).
  const result = await vantaPostJson(
    groupsPath(`&ajaxaction=village&h=${encodeURIComponent(csrf)}`),
    body as unknown as Record<string, string>,
  );
  return result.csrf;
}

// ── Estilos locais (idempotente pelo id; escopo no id do módulo) ──

const STYLE_ID = 'vanta-gio-styles';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
        #vanta-gio-ui {
            margin: 10px 0; background: var(--shs-bg-card, #fffdf3); border: 1px solid var(--shs-border, #e0cda0);
            border-radius: 10px; overflow: hidden;
            font-family: var(--shs-font, Verdana, sans-serif); font-size: 12px; color: var(--shs-ink, #5a3a16);
        }
        #vanta-gio-ui * { box-sizing: border-box; }
        #vanta-gio-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 9px 14px; background: var(--shs-bg-head, #efe2ba); border-bottom: 1px solid var(--shs-border, #e0cda0);
        }
        #vanta-gio-header-title {
            font-size: 12px; font-weight: 700; letter-spacing: 0;
            text-transform: uppercase; color: var(--shs-accent-ink, #8a5a1e);
        }
        #vanta-gio-body { padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 8px; }
        #vanta-gio-help { font-size: 11px; color: var(--shs-muted, #6f5e40); line-height: 1.4; }
        #vanta-gio-actions { display: flex; flex-wrap: wrap; gap: 8px; }
        #vanta-gio-ui button {
            background: var(--shs-bg-field, #fbf4de); border: 1px solid var(--shs-border-strong, #cbb384); border-radius: 8px;
            color: var(--shs-ink, #5a3a16); padding: 5px 12px; font-size: 11px;
            font-family: inherit; cursor: pointer;
        }
        #vanta-gio-ui button:hover:not(:disabled) { background: var(--shs-bg-head, #efe2ba); border-color: var(--shs-action-hover, #834a1a); color: var(--shs-action-hover, #834a1a); }
        #vanta-gio-ui button:disabled { opacity: 0.4; cursor: default; }
        #vanta-gio-ui #vanta-gio-exportar { background: var(--shs-action, #6d3c14); border-color: var(--shs-action-deep, #5a3110); color: #fff; font-weight: 600; }
        #vanta-gio-ui #vanta-gio-exportar:hover:not(:disabled) { background: var(--shs-action-hover, #834a1a); color: #fff; }
        #vanta-gio-ui #vanta-gio-confirmar { background: var(--shs-info, #2f66c0); border-color: #27549f; color: #fff; font-weight: 600; }
        #vanta-gio-ui #vanta-gio-confirmar:hover:not(:disabled) { background: #4473cd; color: #fff; }
        #vanta-gio-status { font-size: 11px; color: var(--shs-muted, #6f5e40); line-height: 1.4; min-height: 14px; }
        #vanta-gio-status.vanta-gio-status--erro { color: var(--shs-danger, #c04038); }
        #vanta-gio-status.vanta-gio-status--ok { color: var(--shs-ok, #3f8f43); font-weight: 600; }
        #vanta-gio-preview ul { margin: 6px 0 0; padding: 0; list-style: none; }
        #vanta-gio-preview li { font-size: 11.5px; padding: 3px 0; border-top: 1px dashed var(--shs-border, #e0cda0); }
        #vanta-gio-preview li:first-child { border-top: none; }
        #vanta-gio-preview li.vanta-gio-aviso { color: var(--shs-accent-ink, #8a5a1e); }
        #vanta-gio-preview .vanta-gio-note {
            margin-top: 6px; font-size: 11px; color: var(--shs-muted, #6f5e40); font-style: italic;
        }
    `;
  document.head.appendChild(style);
}

// ── Launcher ──

registerVanta({
  id: 'vanta-grupos-io',
  label: 'Grupos: Backup e Restauração',
  icon: 'layers',
  desc: 'Exporta/importa os grupos do jogo em JSON',
  group: 'utilidades',
  match: () => {
    const screen = params().get('screen');
    return screen === 'overview_villages' || screen === 'groups';
  },
  url: () => {
    const villageId = currentVillageId();
    const prefix = villageId === '' ? '' : `village=${encodeURIComponent(villageId)}&`;
    return `/game.php?${prefix}screen=overview_villages`;
  },
  mount(scope: ModuleScope) {
    ensureVantaStyles();
    ensureStyles();
    if (document.getElementById('vanta-gio-ui') !== null) return;

    const screen = params().get('screen');
    // O painel pode montar o módulo por flag de navegação em qualquer página:
    // fora das telas de grupos/visão geral a injeção nem tenta (fail-closed).
    if (screen !== 'overview_villages' && screen !== 'groups') return;

    const currentWorld = worldId();
    const card = document.createElement('div');
    card.id = 'vanta-gio-ui';
    card.innerHTML = `
        <div id="vanta-gio-header"><span id="vanta-gio-header-title">Grupos do Jogo — Backup</span></div>
        <div id="vanta-gio-body">
            <div id="vanta-gio-help">Exporta os grupos do jogo (JSON com as aldeias de cada grupo) e restaura um backup. O import SÓ ADICIONA aldeias aos grupos existentes — nenhum grupo é criado, apagado ou esvaziado.</div>
            <div id="vanta-gio-actions">
                <button type="button" id="vanta-gio-exportar">Exportar grupos</button>
                <button type="button" id="vanta-gio-importar">Escolher arquivo…</button>
                <button type="button" id="vanta-gio-confirmar" disabled hidden>Confirmar importação</button>
                <input type="file" id="vanta-gio-file" accept="application/json,.json" hidden />
            </div>
            <div id="vanta-gio-status"></div>
            <div id="vanta-gio-preview"></div>
        </div>`;

    const anchor =
      document.querySelector('div.vis_item') ??
      document.getElementById('overview_form') ??
      document.querySelector('#content_value table.vis') ??
      document.getElementById('content_value');
    if (anchor === null || anchor.parentNode === null) return;
    anchor.parentNode.insertBefore(scope.owns(card), anchor);

    const exportBtnEl = card.querySelector<HTMLButtonElement>('#vanta-gio-ui #vanta-gio-exportar');
    const importBtnEl = card.querySelector<HTMLButtonElement>('#vanta-gio-importar');
    const confirmBtnEl = card.querySelector<HTMLButtonElement>('#vanta-gio-ui #vanta-gio-confirmar');
    const fileInputEl = card.querySelector<HTMLInputElement>('#vanta-gio-file');
    const statusElEl = card.querySelector<HTMLElement>('#vanta-gio-status');
    const previewElEl = card.querySelector<HTMLElement>('#vanta-gio-preview');
    if (
      exportBtnEl === null ||
      importBtnEl === null ||
      confirmBtnEl === null ||
      fileInputEl === null ||
      statusElEl === null ||
      previewElEl === null
    ) {
      return;
    }
    // Aliases não-nulos: funções içadas (setStatus, applyImport...) não herdam
    // o narrowing do guard acima.
    const exportBtn: HTMLButtonElement = exportBtnEl;
    const importBtn: HTMLButtonElement = importBtnEl;
    const confirmBtn: HTMLButtonElement = confirmBtnEl;
    const fileInput: HTMLInputElement = fileInputEl;
    const statusEl: HTMLElement = statusElEl;
    const previewEl: HTMLElement = previewElEl;

    let busy = false;
    let plan: ImportPlan | null = null;

    function setStatus(text: string, kind: 'info' | 'ok' | 'erro'): void {
      statusEl.textContent = text;
      statusEl.className = kind === 'info' ? '' : `vanta-gio-status--${kind}`;
    }

    function setButtons(enabled: boolean): void {
      exportBtn.disabled = !enabled;
      importBtn.disabled = !enabled;
      confirmBtn.disabled = !enabled || plan === null || plan.total === 0;
    }

    function clearPreview(): void {
      previewEl.replaceChildren();
      plan = null;
      confirmBtn.hidden = true;
      confirmBtn.disabled = true;
    }

    function renderPlan(importPlan: ImportPlan): void {
      previewEl.replaceChildren();
      if (importPlan.lines.length > 0) {
        const list = document.createElement('ul');
        importPlan.lines.forEach((line) => {
          const item = document.createElement('li');
          item.textContent = line.text; // sempre textContent — nunca HTML do arquivo
          if (line.kind === 'aviso') item.className = 'vanta-gio-aviso';
          list.appendChild(item);
        });
        previewEl.appendChild(list);
      }
      const note = document.createElement('div');
      note.className = 'vanta-gio-note';
      note.textContent =
        'Só ADIÇÕES: nenhum grupo e nenhuma associação existente é apagada. A prévia usa a última leitura dos grupos (até 5 min); a aplicação confere cada aldeia na hora.';
      previewEl.appendChild(note);
      confirmBtn.hidden = false;
      confirmBtn.disabled = importPlan.total === 0;
    }

    function downloadJson(conteudo: GroupsFile, fileName: string): void {
      const blob = new Blob([JSON.stringify(conteudo, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.style.display = 'none';
      document.body.appendChild(scope.owns(link));
      link.click();
      link.remove();
      scope.after(() => {
        URL.revokeObjectURL(url);
      }, 4000);
    }

    async function exportGroups(): Promise<void> {
      if (busy) return;
      busy = true;
      setButtons(false);
      setStatus('Lendo os grupos do jogo...', 'info');
      try {
        const groups = await getGroupOptions();
        if (groups.length === 0) {
          setStatus('Nenhum grupo do jogo foi encontrado — abra a tela de Grupos no jogo e tente de novo.', 'erro');
          return;
        }
        const fileGroups: FileGroup[] = [];
        let totalVillages = 0;
        for (let i = 0; i < groups.length; i++) {
          const group = groups[i];
          if (group === undefined) continue;
          setStatus(`Lendo o grupo ${i + 1}/${groups.length} (${group.name})...`, 'info');
          const villages = await getGroupVillages(group.groupId);
          totalVillages += villages.length;
          fileGroups.push({
            id: group.groupId,
            nome: group.name,
            villages: villages.map((village) => ({
              id: village.villageId,
              x: village.x,
              y: village.y,
              nome: village.name,
            })),
          });
        }
        const fileName = `tsh-grupos-${currentWorld}-${localDateStamp(new Date())}.json`;
        downloadJson(
          { version: 1, world: currentWorld, exportedAt: new Date().toISOString(), groups: fileGroups },
          fileName,
        );
        setStatus(
          `Backup baixado como ${fileName}: ${fileGroups.length} grupo(s), ${totalVillages} aldeia(s). A leitura pode vir do cache do Hub (grupos até 10 min, aldeias até 5 min).`,
          'ok',
        );
      } catch (error) {
        setStatus(`Falha ao exportar: ${mensagemDeErro(error)}`, 'erro');
      } finally {
        busy = false;
        setButtons(true);
      }
    }

    async function loadImportFile(): Promise<void> {
      const file = fileInput.files?.[0];
      fileInput.value = ''; // permite reescolher o MESMO arquivo depois
      if (file === undefined || busy) return;
      busy = true;
      clearPreview();
      setButtons(false);
      setStatus(`Lendo ${file.name}...`, 'info');
      try {
        let text: string;
        try {
          text = await file.text();
        } catch {
          setStatus('Não foi possível ler o arquivo escolhido.', 'erro');
          return;
        }
        const parsed = parseGroupsImportFile(text, currentWorld);
        if (!parsed.ok) {
          setStatus(`Arquivo recusado: ${parsed.erro}`, 'erro');
          return;
        }
        setStatus(
          `Arquivo aceito (${parsed.file.groups.length} grupo(s)${parsed.file.exportedAt !== '' ? `, exportado em ${parsed.file.exportedAt}` : ''}). Lendo os grupos atuais do jogo...`,
          'info',
        );
        const importPlan = await buildPlan(parsed.file);
        plan = importPlan;
        renderPlan(importPlan);
        if (importPlan.total === 0) {
          setStatus(
            'Nada a importar: as aldeias do arquivo já estão nos grupos correspondentes (ou os grupos não existem neste mundo).',
            'erro',
          );
        } else {
          setStatus(
            `Prévia pronta: ${importPlan.total} aldeia(s) seriam ADICIONADAS em ${importPlan.targets.length} grupo(s). Nada foi alterado ainda — confirme abaixo.`,
            'ok',
          );
        }
      } catch (error) {
        setStatus(`Falha ao montar a prévia: ${mensagemDeErro(error)}`, 'erro');
      } finally {
        busy = false;
        setButtons(true);
      }
    }

    async function applyImport(): Promise<void> {
      const currentPlan = plan;
      if (busy || currentPlan === null || currentPlan.total === 0) return;

      const details = currentPlan.lines.slice(0, 12).map((line) => line.text);
      if (currentPlan.lines.length > details.length) {
        details.push(`… e mais ${currentPlan.lines.length - details.length} linha(s) da prévia.`);
      }
      const ok = await vantaConfirm(scope, {
        title: 'Importar grupos',
        message: `Adicionar ${currentPlan.total} aldeia(s) em ${currentPlan.targets.length} grupo(s)? O import SÓ ADICIONA: nenhum grupo e nenhuma associação existente é apagada.`,
        details,
        confirmLabel: 'Importar',
      });
      if (!ok) return;

      busy = true;
      setButtons(false);

      let csrf: string;
      try {
        csrf = currentCsrf();
      } catch (error) {
        setStatus(`Não foi possível obter o token do jogo: ${mensagemDeErro(error)}`, 'erro');
        busy = false;
        setButtons(true);
        return;
      }

      let added = 0;
      let skipped = 0;
      let done = 0;
      let stoppedAt: string | null = null;

      for (const target of currentPlan.targets) {
        for (const villageId of target.villageIds) {
          done += 1;
          setStatus(
            `Adicionando a aldeia ${villageId} ao grupo "${target.localName}" (${done}/${currentPlan.total})...`,
            'info',
          );
          try {
            const current = await groupsOfVillage(String(villageId), csrf);
            csrf = current.csrf;
            if (current.ids.includes(target.localGroupId)) {
              skipped += 1;
              continue;
            }
            // União (atuais + alvo): nunca remove a aldeia de outro grupo.
            csrf = await setVillageGroups(String(villageId), [...current.ids, target.localGroupId], csrf);
            added += 1;
          } catch (error) {
            stoppedAt = `falhou na aldeia ${villageId} (grupo "${target.localName}"): ${mensagemDeErro(error)}`;
            break;
          }
          await sleep(PAUSA_MS);
        }
        if (stoppedAt !== null) break;
      }

      invalidateGroupsCache();
      clearPreview();
      busy = false;
      setButtons(true);

      if (stoppedAt === null) {
        setStatus(
          `Import concluído: ${added} aldeia(s) adicionada(s)${skipped > 0 ? `, ${skipped} já estava(m) no grupo` : ''}.`,
          'ok',
        );
        return;
      }
      setStatus(
        `Import interrompido: ${added} de ${currentPlan.total} aldeia(s) adicionada(s) — ${stoppedAt} O import é idempotente: escolha o arquivo de novo para continuar de onde parou.`,
        'erro',
      );
    }

    scope.on(exportBtn, 'click', () => {
      void exportGroups();
    });
    scope.on(importBtn, 'click', () => {
      fileInput.click();
    });
    scope.on(fileInput, 'change', () => {
      void loadImportFile();
    });
    scope.on(confirmBtn, 'click', () => {
      void applyImport();
    });

    setStatus(
      `Mundo ${currentWorld}. Destino do backup: tsh-grupos-${currentWorld}-${localDateStamp(new Date())}.json`,
      'info',
    );
  },
});
