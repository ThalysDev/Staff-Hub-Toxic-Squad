// Renomeador de Aldeias (Onda 5, Parte A) — renomeia em MASSA as aldeias de um
// grupo a partir de um template com tokens ({numero}, {coord}, {k}, {pontos},
// {texto}), uma aldeia por ciclo (F2).
//
// Divisão de trabalho: a engine pura (src/ext/modules/features/village-renamer)
// monta o plano — numeração por continente/geral, ordem determinística,
// idempotência (aldeia cujo nome já é o alvo não é repostada) e truncamento —
// e este plugin só LÊ o jogo (grupo + /map/village.txt) e APLICA o primeiro
// item pendente.
//
// LACUNA REGISTRADA: o endpoint/form de renomeação NÃO foi confirmado contra
// fixture real do br142. O contrato aqui é "posta somente o form que a própria
// tela da aldeia expôs" (parseVillageRenameRequest); sem form canônico, nada é
// postado e o status explica. A confirmação é por RELEITURA: no ciclo seguinte
// o plano recalcula e a aldeia some do plano quando o nome ficou igual.

import { registerTsh } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { pacedGet } from '../../../core/net';
import { getGroupVillages } from '../tsh-groups';
import { ownVillages } from '../tsh-game-data';
import {
  planVillageRenames,
  validateRenameTemplate,
  type RenamePlanEntry,
  type RenameVillage,
} from '../../../ext/modules/features/village-renamer/renamer';
import { postGameForm } from './onda5-form-post';

/** Janela em que uma aldeia já postada não é repostada (cache do village.txt). */
const RENAME_LEDGER_TTL_MS = 15 * 60_000;
/** Teto de entradas publicadas na prévia (o JSON vive no storage do mundo). */
const MAX_PREVIEW_ENTRIES = 20;

// Type alias (não interface) para continuar atribuível a Record<string, unknown>.
export type RenomeadorSettings = {
  template: string;
  texto: string;
  padding: number;
  inicio: number;
  /** Id do grupo (texto por enquanto); vazio = módulo não age (fail-closed). */
  grupo: string;
  numbering: 'continente' | 'geral';
};

export const DEFAULT_SETTINGS: RenomeadorSettings = {
  template: '{numero} {coord}',
  texto: '',
  padding: 2,
  inicio: 1,
  grupo: '',
  numbering: 'continente',
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'template',
    label: 'Template do nome',
    type: 'text',
    placeholder: '{numero} {coord}',
    help: 'Tokens: {numero} (contador), {coord} (x|y), {k} (continente K45), {pontos}, {texto}. Precisa de pelo menos um token que diferencie as aldeias.',
  },
  {
    key: 'texto',
    label: 'Texto do token {texto}',
    type: 'text',
    placeholder: 'ex.: Toxic Squad',
    help: 'Entra no lugar de {texto} — opcional.',
  },
  {
    key: 'padding',
    label: 'Dígitos do {numero}',
    type: 'number',
    min: 1,
    max: 6,
    step: 1,
    help: 'Zero à esquerda no contador (2 = 01, 02, …).',
  },
  {
    key: 'inicio',
    label: 'Início da numeração',
    type: 'number',
    min: 1,
    max: 9999,
    step: 1,
    help: 'Primeiro número; no modo por continente, cada K reinicia neste valor.',
  },
  {
    key: 'numbering',
    label: 'Numeração',
    type: 'select',
    options: [
      { value: 'continente', label: 'Por continente (1..N dentro de cada K)' },
      { value: 'geral', label: 'Geral (1..N em todas as aldeias)' },
    ],
    help: 'Como o {numero} conta as aldeias do grupo.',
  },
  {
    key: 'grupo',
    label: 'Grupo de aldeias (id)',
    type: 'text',
    placeholder: 'ex.: 1234',
    help: 'Id do grupo do jogo cujas aldeias são renomeadas. Obrigatório: sem grupo o módulo não renomeia nada (evita renomear a conta inteira por engano).',
  },
];

export interface VillageRenameRequest {
  /** Ação do form canônico de renomeação (é o que é postado). */
  readonly action: string;
  /** Nome do campo de texto que recebe o nome novo. */
  readonly nameField: string;
  /** Campos hidden do mesmo form (sem h — o POST usa o csrf fresco). */
  readonly hidden: Record<string, string>;
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  const value = match?.[1]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * Form canônico de renomeação da aldeia (parser puro, fail-closed): exige um
 * `<form>` cuja action mencione renomeação (`rename`) E um input de texto com
 * nome de campo de nome (`name`/`nome`/`village_name`). Qualquer outra coisa →
 * null (nada é postado): um POST adivinhado poderia renomear no lugar errado.
 */
export function parseVillageRenameRequest(html: string): VillageRenameRequest | null {
  for (const formMatch of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const tag = formMatch[0] ?? '';
    const inner = formMatch[1] ?? '';
    const action = attribute(tag, 'action');
    if (action === undefined || !/rename/i.test(action)) continue;
    const nameField = [...inner.matchAll(/<input\b[^>]*>/gi)]
      .map((input) => input[0] ?? '')
      .filter((inputTag) => {
        const type = (attribute(inputTag, 'type') ?? 'text').toLowerCase();
        return type === 'text' || type === 'search';
      })
      .map((inputTag) => attribute(inputTag, 'name'))
      .find((name) => name !== undefined && /name|nome/i.test(name));
    if (nameField === undefined) continue;
    const hidden: Record<string, string> = {};
    for (const input of inner.matchAll(/<input\b[^>]*>/gi)) {
      const inputTag = input[0] ?? '';
      if ((attribute(inputTag, 'type') ?? '').toLowerCase() !== 'hidden') continue;
      const name = attribute(inputTag, 'name');
      if (name === undefined || name === 'h') continue;
      hidden[name] = decodeEntities(attribute(inputTag, 'value') ?? '');
    }
    return { action: decodeEntities(action), nameField, hidden };
  }
  return null;
}

/** Página da aldeia (onde o form de renomeação vive). */
export function villageMainPath(villageId: string): string {
  return `/game.php?village=${encodeURIComponent(villageId)}&screen=main`;
}

/**
 * Aldeias-alvo: intersecção do grupo (ids) com as aldeias PRÓPRIAS lidas do
 * /map/village.txt (que trazem pontos para o token {pontos}). Aldeia do grupo
 * que não for do jogador fica de fora com motivo — renomear aldeia alheia está
 * fora de questão.
 */
export async function resolveRenameTargets(grupo: string): Promise<{
  villages: RenameVillage[];
  ignored: { id: string; reason: string }[];
}> {
  const groupId = Number.parseInt(grupo.trim(), 10);
  if (!Number.isInteger(groupId) || groupId <= 0) return { villages: [], ignored: [] };
  const [rows, proprias] = await Promise.all([getGroupVillages(groupId), ownVillages()]);
  const porId = new Map(proprias.map((village) => [village.id, village]));
  const villages: RenameVillage[] = [];
  const ignored: { id: string; reason: string }[] = [];
  for (const row of rows) {
    const id = String(row.villageId);
    const propria = porId.get(id);
    if (propria === undefined) {
      ignored.push({ id, reason: 'não é aldeia própria (ou ainda não está no /map/village.txt).' });
      continue;
    }
    villages.push({ id, name: propria.name, x: propria.x, y: propria.y, points: propria.points });
  }
  return { villages, ignored };
}

registerTsh({
  id: 'renomeador-aldeias',
  label: 'Renomeador de Aldeias',
  desc: 'Renomeia as aldeias do grupo pelo template com tokens ({numero}, {coord}, {k}, {pontos}, {texto}) — 1 aldeia por ciclo.',
  category: 'planejamento',
  screen: 'overview_villages',
  mutating: true,
  cooldownMs: 30 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  async runCycle(ctx) {
    const settings = ctx.storage.get('settings', DEFAULT_SETTINGS);
    const erroTemplate = validateRenameTemplate(settings.template);
    if (erroTemplate !== null) {
      ctx.status(`${erroTemplate} Nenhuma aldeia foi renomeada.`, 'warn');
      return;
    }
    if (Number.parseInt(settings.grupo.trim(), 10) <= 0) {
      ctx.status('Configure o id do grupo (Grupo de aldeias) — sem grupo o módulo não renomeia nada.', 'warn');
      return;
    }

    let alvos: Awaited<ReturnType<typeof resolveRenameTargets>>;
    try {
      alvos = await resolveRenameTargets(settings.grupo);
    } catch (error) {
      ctx.status(
        `Não consegui ler as aldeias do grupo: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return;
    }
    const plano = planVillageRenames(alvos.villages, {
      template: settings.template,
      texto: settings.texto,
      padding: settings.padding,
      inicio: settings.inicio,
      numbering: settings.numbering,
    });
    if (!plano.ok) {
      ctx.status(`${plano.error ?? 'Template inválido.'} Nenhuma aldeia foi renomeada.`, 'warn');
      return;
    }
    const ignoradas = [...alvos.ignored, ...plano.ignored.map((entry) => ({ id: entry.id, reason: entry.reason }))];
    ctx.storage.set('last-preview', {
      status: `${plano.pendingCount} de ${plano.entries.length} aldeia(s) fora do template`,
      aldeias: plano.entries.length,
      pendentes: plano.pendingCount,
      porContinente: plano.counters,
      template: settings.template,
      texto: settings.texto,
      numbering: settings.numbering,
      geradoEm: new Date().toISOString(),
      ignoradas,
      amostra: plano.entries.slice(0, MAX_PREVIEW_ENTRIES).map((entry) => ({
        aldeia: entry.villageId,
        de: entry.from,
        para: entry.target,
        k: entry.continent,
        seq: entry.seq,
        truncado: entry.truncated,
        pendente: entry.changed,
      })),
    });

    // Ledger anti-repostagem: o /map/village.txt fica em cache, então a aldeia
    // recém-renomeada pode voltar ao plano por alguns minutos.
    const ledger = ctx.storage.get<Record<string, number>>('ledger', {});
    const agora = Date.now();
    const pendente = plano.entries.find(
      (entry: RenamePlanEntry) =>
        entry.changed && (ledger[entry.villageId] === undefined || agora - (ledger[entry.villageId] ?? 0) > RENAME_LEDGER_TTL_MS),
    );
    if (pendente === undefined) {
      ctx.status(
        plano.pendingCount === 0
          ? `Todas as ${plano.entries.length} aldeia(s) do grupo já seguem o template.`
          : `${plano.pendingCount} aldeia(s) fora do template, mas todas foram postadas há pouco — aguardando a releitura do jogo.`,
        'info',
      );
      return;
    }

    let pedido: VillageRenameRequest | null;
    try {
      pedido = parseVillageRenameRequest(await pacedGet(villageMainPath(pendente.villageId), { fresh: true }));
    } catch (error) {
      ctx.status(
        `Não consegui abrir a aldeia ${pendente.villageId} para renomear: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return;
    }
    if (pedido === null) {
      ctx.status(
        `A tela da aldeia ${pendente.villageId} não expôs o form canônico de renomeação — nada foi postado (nada de POST adivinhado).`,
        'warn',
      );
      return;
    }
    const resultado = await postGameForm(pedido.action, { ...pedido.hidden, [pedido.nameField]: pendente.target });
    if (!resultado.ok) {
      ctx.status(`Renomeação da aldeia ${pendente.villageId} falhou: ${resultado.message}`, 'warn');
      return;
    }
    ledger[pendente.villageId] = agora;
    ctx.storage.set('ledger', ledger);
    ctx.status(
      `Renomeação enviada: ${pendente.villageId} "${pendente.from}" → "${pendente.target}" (${pendente.continent}, nº ${pendente.seq}). Restam ${Math.max(0, plano.pendingCount - 1)}.`,
      'ok',
    );
  },
});
