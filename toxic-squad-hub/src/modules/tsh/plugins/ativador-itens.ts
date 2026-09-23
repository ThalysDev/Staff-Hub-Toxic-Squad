// Agendador de Itens (Onda 5, Parte A) — agenda a ativação de UM item do
// inventário para um dia/hora e posta a ação de uso quando o horário chega.
//
// Como funciona:
//   - o usuário salva `itemId` + `quando` (data e hora, fuso do jogador) nas
//     configurações; o ciclo cria um REGISTRO na agenda (storage do módulo);
//   - a cada ciclo o módulo procura o registro vencido DA ALDEIA ATUAL e
//     posta a ação canônica de uso que a própria linha do inventário expõe
//     (parser puro em ext/.../inventory/inventory-items);
//   - F2: no máximo 1 POST por ciclo; o item é lido FRESCO antes do disparo
//     (item que sumiu do inventário = registro marcado como falha, sem POST).
//
// Regras de honestidade:
//   - horário no passado NÃO vira disparo imediato (isso surpreenderia o
//     jogador): o ciclo avisa e não cria o registro;
//   - a agenda é por ALDEIA — item guardado na aldeia A não é usado com a
//     aldeia B aberta (a tela de inventário é da aldeia);
//   - LACUNA REGISTRADA: a ação de uso não foi confirmada contra fixture real
//     do br142; sem URL canônica na linha do item, nada é postado. Itens que
//     abrem tela de confirmação ficam "enviados" (a confirmação é do jogador).

import { registerTsh, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { pacedGet } from '../../../core/net';
import {
  findInventoryItem,
  parseInventoryItems,
  summarizeInventory,
  type InventoryItem,
} from '../../../ext/modules/features/inventory/inventory-items';
import { postGameForm } from './onda5-form-post';

/** Teto de registros guardados (mais novos primeiro). */
export const MAX_ITEM_AGENDA = 20;

export type ItemScheduleStatus = 'agendado' | 'executado' | 'falha';

export interface ScheduledItemActivation {
  readonly id: string;
  readonly itemId: string;
  readonly itemName: string;
  /** Aldeia cujo inventário guarda o item (o disparo exige ela aberta). */
  readonly villageId: string;
  /** Instante do disparo em epoch ms (relógio local do jogador). */
  readonly at: number;
  status: ItemScheduleStatus;
  firedAt?: number;
  note?: string;
}

// Type alias (não interface) para continuar atribuível a Record<string, unknown>.
export type AtivadorItensSettings = {
  /** Id do item no inventário (o id que a tela expõe em data-item-id). */
  itemId: string;
  /** Rótulo livre para o jogador reconhecer o item no status. */
  itemNome: string;
  /** Data e hora do disparo no formato do input datetime-local. */
  quando: string;
};

export const DEFAULT_SETTINGS: AtivadorItensSettings = {
  itemId: '',
  itemNome: '',
  quando: '',
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'itemId',
    label: 'Id do item',
    type: 'text',
    placeholder: 'ex.: 4711',
    help: 'Id do item no inventário (a tela lista os itens com data-item-id). Salvar aqui agenda a ativação para o horário abaixo.',
  },
  {
    key: 'itemNome',
    label: 'Nome/rótulo do item',
    type: 'text',
    placeholder: 'ex.: Pacote de recursos',
    help: 'Opcional — só para você reconhecer o item no status do painel.',
  },
  {
    key: 'quando',
    label: 'Disparar em (data e hora)',
    type: 'text',
    placeholder: '2026-09-23T20:30',
    help: 'Fuso do seu relógio, formato AAAA-MM-DDTHH:MM. Horário no passado é recusado (nada dispara de surpresa).',
  },
];

/** Formato do input datetime-local ("YYYY-MM-DDTHH:MM"). */
const QUANDO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Epoch ms do horário digitado (fuso LOCAL do jogador) ou null quando o texto
 * não é uma data/hora válida — fail-closed: data ruim nunca vira "agora".
 */
export function parseScheduleDate(quando: string): number | null {
  const trimmed = quando.trim();
  if (!QUANDO_PATTERN.test(trimmed)) return null;
  const ts = Date.parse(trimmed);
  return Number.isFinite(ts) ? ts : null;
}

function agendaId(at: number, itemId: string, villageId: string): string {
  return `${villageId}-${itemId}-${at}`;
}

export interface SyncScheduleResult {
  readonly agenda: ScheduledItemActivation[];
  /** Registro criado neste ciclo (o usuário acabou de agendar). */
  readonly criado: ScheduledItemActivation | null;
  /** Erro de configuração (pt-BR); a agenda existente continua valendo. */
  readonly erro: string | null;
}

/**
 * Sincroniza o storage 'agenda' com as configurações: cria UM registro quando
 * o jogador informou item + horário futuro, sem duplicar o mesmo par
 * (item, horário) já registrado. Agenda antiga é preservada (só o teto corta).
 */
export function syncScheduledActivation(
  agenda: readonly ScheduledItemActivation[],
  settings: AtivadorItensSettings,
  villageId: string,
  now: number,
): SyncScheduleResult {
  const itemId = settings.itemId.trim();
  const quando = settings.quando.trim();
  if (itemId === '' || quando === '') return { agenda: [...agenda], criado: null, erro: null };
  const at = parseScheduleDate(quando);
  if (at === null) {
    return {
      agenda: [...agenda],
      criado: null,
      erro: 'Horário inválido — use data e hora no formato AAAA-MM-DDTHH:MM (ex.: 2026-09-23T20:30).',
    };
  }
  if (at <= now) {
    return {
      agenda: [...agenda],
      criado: null,
      erro: `O horário ${quando.replace('T', ' ')} já passou — escolha um horário no futuro (nada foi agendado).`,
    };
  }
  if (agenda.some((registro) => registro.itemId === itemId && registro.at === at)) {
    return { agenda: [...agenda], criado: null, erro: null };
  }
  const criado: ScheduledItemActivation = {
    id: agendaId(at, itemId, villageId),
    itemId,
    itemName: settings.itemNome.trim(),
    villageId,
    at,
    status: 'agendado',
  };
  return { agenda: [criado, ...agenda].slice(0, MAX_ITEM_AGENDA), criado, erro: null };
}

/** Registro vencido DA ALDEIA ATUAL (mais antigo primeiro) — 1 por ciclo. */
export function dueActivation(
  agenda: readonly ScheduledItemActivation[],
  villageId: string,
  now: number,
): ScheduledItemActivation | undefined {
  return agenda
    .filter(
      (registro) =>
        registro.status === 'agendado' && registro.villageId === villageId && registro.at <= now,
    )
    .sort((a, b) => a.at - b.at)[0];
}

/** Registro vencido preso em OUTRA aldeia (o jogador precisa abrir a aldeia). */
export function blockedActivation(
  agenda: readonly ScheduledItemActivation[],
  villageId: string,
  now: number,
): ScheduledItemActivation | undefined {
  return agenda.find(
    (registro) => registro.status === 'agendado' && registro.villageId !== villageId && registro.at <= now,
  );
}

/** Marca o registro na agenda (imutável — devolve uma agenda nova). */
export function markActivation(
  agenda: readonly ScheduledItemActivation[],
  id: string,
  status: ItemScheduleStatus,
  update: { firedAt?: number; note?: string } = {},
): ScheduledItemActivation[] {
  return agenda.map((registro) =>
    registro.id !== id
      ? registro
      : {
          ...registro,
          status,
          ...(update.firedAt !== undefined ? { firedAt: update.firedAt } : {}),
          ...(update.note !== undefined ? { note: update.note } : {}),
        },
  );
}

/** Página do inventário de uma aldeia (mesma rota do módulo Abertura de Pacotes). */
function inventoryPath(villageId: string): string {
  return `/game.php?village=${encodeURIComponent(villageId)}&screen=inventory`;
}

/** Rótulo do registro: nome escolhido ou "item #id". */
function activationLabel(registro: ScheduledItemActivation): string {
  return registro.itemName !== '' ? `${registro.itemName} (#${registro.itemId})` : `item #${registro.itemId}`;
}

/** Prévia publicada no painel (agenda + pendências). */
function publishPreview(ctx: TshCycleContext, agenda: readonly ScheduledItemActivation[]): void {
  ctx.storage.set('last-preview', {
    status: `${agenda.filter((registro) => registro.status === 'agendado').length} item(ns) agendado(s)`,
    registros: agenda.length,
    agenda: agenda.map((registro) => ({
      id: registro.id,
      item: activationLabel(registro),
      aldeia: registro.villageId,
      quando: new Date(registro.at).toISOString(),
      status: registro.status,
      observacao: registro.note ?? '',
    })),
    geradoEm: new Date().toISOString(),
  });
}

registerTsh({
  id: 'ativador-itens',
  label: 'Agendador de Itens',
  desc: 'Ativa um item do inventário no dia/hora agendado (a aldeia do item precisa estar aberta) — 1 uso por ciclo.',
  category: 'economia',
  screen: 'inventory',
  mutating: true,
  cooldownMs: 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  async runCycle(ctx) {
    const settings = ctx.storage.get('settings', DEFAULT_SETTINGS);
    const agora = Date.now();
    const sincronizado = syncScheduledActivation(
      ctx.storage.get<ScheduledItemActivation[]>('agenda', []),
      settings,
      ctx.villageId,
      agora,
    );
    let agenda = sincronizado.agenda;
    if (sincronizado.criado !== null) {
      ctx.storage.set('agenda', agenda);
      ctx.status(
        `Agendado: ${activationLabel(sincronizado.criado)} na aldeia ${sincronizado.criado.villageId} para ${new Date(sincronizado.criado.at).toLocaleString('pt-BR')}. Abra o inventário dessa aldeia no horário.`,
        'ok',
      );
      publishPreview(ctx, agenda);
      return;
    }

    const vencido = dueActivation(agenda, ctx.villageId, agora);
    if (vencido === undefined) {
      const preso = blockedActivation(agenda, ctx.villageId, agora);
      const futuros = agenda.filter((registro) => registro.status === 'agendado').length;
      const mensagem =
        sincronizado.erro !== null
          ? sincronizado.erro
          : preso !== undefined
            ? `Agendamento de ${activationLabel(preso)} venceu, mas ele está na aldeia ${preso.villageId} — abra o inventário dessa aldeia.`
            : futuros === 0
              ? 'Nenhum item agendado. Informe o id do item e o horário nas configurações.'
              : `${futuros} agendamento(s) no futuro — nenhum vencido nesta aldeia.`;
      ctx.status(mensagem, sincronizado.erro !== null || preso !== undefined ? 'warn' : 'info');
      publishPreview(ctx, agenda);
      return;
    }

    let itens: InventoryItem[];
    try {
      itens = parseInventoryItems(await pacedGet(inventoryPath(vencido.villageId), { fresh: true }));
    } catch (error) {
      ctx.status(
        `Não consegui ler o inventário da aldeia ${vencido.villageId}: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return;
    }
    const item = findInventoryItem(itens, vencido.itemId);
    if (item === undefined) {
      agenda = markActivation(agenda, vencido.id, 'falha', {
        note: `${activationLabel(vencido)} não está no inventário desta aldeia (${summarizeInventory(itens)}).`,
      });
      ctx.storage.set('agenda', agenda);
      publishPreview(ctx, agenda);
      ctx.status(`O ${activationLabel(vencido)} não está no inventário da aldeia ${vencido.villageId} — nada foi usado.`, 'warn');
      return;
    }
    if (item.actionUrl === undefined) {
      agenda = markActivation(agenda, vencido.id, 'falha', {
        note: `A linha do item ${item.id} não expôs a ação canônica de uso.`,
      });
      ctx.storage.set('agenda', agenda);
      publishPreview(ctx, agenda);
      ctx.status(`A linha do ${activationLabel(vencido)} não expôs ação de uso — nada foi postado (nada de POST adivinhado).`, 'warn');
      return;
    }
    const resultado = await postGameForm(item.actionUrl, {});
    if (!resultado.ok) {
      agenda = markActivation(agenda, vencido.id, 'falha', { note: resultado.message });
      ctx.storage.set('agenda', agenda);
      publishPreview(ctx, agenda);
      ctx.status(`Ativação do ${activationLabel(vencido)} falhou: ${resultado.message}`, 'warn');
      return;
    }
    agenda = markActivation(agenda, vencido.id, 'executado', { firedAt: Date.now() });
    ctx.storage.set('agenda', agenda);
    publishPreview(ctx, agenda);
    ctx.status(
      `Ativação enviada: ${activationLabel(vencido)} na aldeia ${vencido.villageId} (x${item.count} no inventário).`,
      'ok',
    );
  },
});
