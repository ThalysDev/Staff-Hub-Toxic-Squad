// Abertura de Pacotes (Onda 5, Parte A) — abre UM pacote de recursos do
// inventário por ciclo (F2), só quando o armazém tem espaço para receber.
//
// Por que existe: pacotes de recursos (eventos, recompensas) ficam parados no
// inventário; abertos com o armazém quase cheio, os recursos são PERDIDOS no
// estouro. Aqui a abertura respeita espaço livre mínimo no armazém + o
// intervalo configurado; o Balanceador continua sendo quem distribui o que
// chegou.
//
// Ordenação com o Balanceador (setting `ordem`): APENAS DOCUMENTAÇÃO nesta
// onda — o runtime percorre as automações na ordem de REGISTRO do script e o
// escalonamento real é o `delaySegundos` (0 = abre no começo do ciclo; um
// atraso deixa o Balanceador/Coleta da rodada anterior terminarem antes).
//
// LACUNA REGISTRADA: a ação de abrir pacote NÃO foi confirmada contra fixture
// real do br142 — o POST usa SOMENTE a URL canônica que a própria linha do
// inventário expõe (data-action-url/href de uso); sem ela, nada é postado.

import { registerTsh, renewTshLock } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { pacedGet } from '../../../core/net';
import { parsePtBrInt } from '../../vanta/vanta-utils';
import {
  parseInventoryItems,
  pickResourcePackage,
  summarizeInventory,
  type InventoryItem,
} from '../../../ext/modules/features/inventory/inventory-items';
import { postGameForm } from './onda5-form-post';

/** Recursos lidos do header (as três chaves do jogo). */
export type WarehouseResources = { wood: number; stone: number; iron: number };

export interface WarehouseState {
  readonly used: number;
  readonly capacity: number;
}

// Type alias (não interface) para continuar atribuível a Record<string, unknown>.
export type AbrirPacotesSettings = {
  /** Espaço livre mínimo no armazém (%) para abrir um pacote. */
  espacoLivreMinimoPct: number;
  /** Intervalo mínimo entre aberturas (minutos). */
  intervaloMinutos: number;
  ordem: 'antes_balanceador' | 'antes_envio' | 'sozinho';
  /** Espera antes de abrir, dentro do ciclo (segundos) — escalonamento real. */
  delaySegundos: number;
};

export const DEFAULT_SETTINGS: AbrirPacotesSettings = {
  espacoLivreMinimoPct: 20,
  intervaloMinutos: 60,
  ordem: 'antes_balanceador',
  delaySegundos: 0,
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'espacoLivreMinimoPct',
    label: 'Espaço livre mínimo no armazém (%)',
    type: 'number',
    min: 0,
    max: 100,
    step: 5,
    help: 'Só abre pacote quando o armazém tem pelo menos este percentual livre — evita perder recursos no estouro. 0 = abre sempre.',
  },
  {
    key: 'intervaloMinutos',
    label: 'Intervalo mínimo entre aberturas (min)',
    type: 'number',
    min: 1,
    max: 1440,
    step: 5,
    help: 'Espaçamento entre uma abertura e a próxima, além do cooldown do ciclo.',
  },
  {
    key: 'ordem',
    label: 'Ordem em relação aos outros módulos',
    type: 'select',
    options: [
      { value: 'antes_balanceador', label: 'Antes do Balanceador (recomendado)' },
      { value: 'antes_envio', label: 'Antes do envio de recursos' },
      { value: 'sozinho', label: 'Sozinho (sem relação)' },
    ],
    help: 'Documentação da intenção nesta onda: o runtime roda as automações na ordem de registro e o escalonamento real é o atraso abaixo.',
  },
  {
    key: 'delaySegundos',
    label: 'Atraso antes de abrir (segundos)',
    type: 'number',
    min: 0,
    max: 600,
    step: 5,
    help: 'Espera dentro do ciclo antes de abrir o pacote (0 = abre de imediato).',
  },
];

/** Rótulo humano da ordem escolhida (usado no status/prévia). */
export function orderLabel(ordem: AbrirPacotesSettings['ordem']): string {
  if (ordem === 'antes_balanceador') return 'antes do Balanceador';
  if (ordem === 'antes_envio') return 'antes do envio de recursos';
  return 'sozinho';
}

/**
 * Percentual de espaço livre do armazém. `null` = capacidade ilegível na
 * página — o ciclo não abre nada (fail-closed: sem número confiável, o risco
 * de estourar o armazém é do jogador).
 */
export function freeSpacePercent(state: WarehouseState | null): number | null {
  if (state === null || !Number.isFinite(state.capacity) || state.capacity <= 0) return null;
  const livre = Math.max(0, state.capacity - Math.max(0, state.used));
  return (livre / state.capacity) * 100;
}

/** Leitura do armazém na página viva do inventário (header da aldeia). */
export function readWarehouse(doc: Document): WarehouseState | null {
  const read = (id: string): number => {
    const element = doc.querySelector<HTMLElement>(`#${id}`);
    return element === null ? 0 : parsePtBrInt(element.textContent);
  };
  const capacity = parsePtBrInt(doc.querySelector<HTMLElement>('#storage')?.textContent ?? null);
  if (capacity <= 0) return null;
  return { used: read('wood') + read('stone') + read('iron'), capacity };
}

/** Página do inventário de uma aldeia (fila global, sem cache velho). */
export function inventoryPath(villageId: string): string {
  return `/game.php?village=${encodeURIComponent(villageId)}&screen=inventory`;
}

/** Espera efêmera DENTRO da promise do ciclo (nunca timer solto no módulo). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

registerTsh({
  id: 'abrir-pacotes',
  label: 'Abertura de Pacotes',
  desc: 'Abre um pacote de recursos do inventário por ciclo, respeitando o espaço livre do armazém e o intervalo configurado.',
  category: 'economia',
  screen: 'inventory',
  mutating: true,
  cooldownMs: 30 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  async runCycle(ctx) {
    const settings = ctx.storage.get('settings', DEFAULT_SETTINGS);
    const agora = Date.now();

    // 1) Intervalo mínimo entre aberturas (além do cooldown do ciclo).
    const ultima = ctx.storage.get<number>('aberto-em', 0);
    const intervaloMs = Math.max(1, Math.floor(settings.intervaloMinutos)) * 60_000;
    if (ultima > 0 && agora - ultima < intervaloMs) {
      ctx.status(
        `Intervalo em curso: a última abertura foi há ${Math.round((agora - ultima) / 60_000)} min (mínimo ${settings.intervaloMinutos} min).`,
        'info',
      );
      return;
    }

    // 2) Gate do armazém (leitura da página viva — o ciclo roda no inventário).
    const armazem = readWarehouse(document);
    const livrePct = freeSpacePercent(armazem);
    if (livrePct === null) {
      ctx.status(
        'Não consegui ler a capacidade do armazém nesta página — nenhum pacote foi aberto (fail-closed).',
        'warn',
      );
      return;
    }
    if (livrePct < settings.espacoLivreMinimoPct) {
      ctx.status(
        `Armazém com ${livrePct.toFixed(1)}% livre — abaixo do mínimo de ${settings.espacoLivreMinimoPct}%; nenhum pacote aberto (os recursos estourariam).`,
        'info',
      );
      return;
    }

    // 3) Escalonamento (ordem documentada + atraso real). O atraso pode
    //    ultrapassar o TTL do lock de aba (2min): renova na saída do sleep —
    //    senão outra aba assume o módulo e o pacote abriria duas vezes.
    if (settings.delaySegundos > 0) {
      ctx.status(`Aguardando ${settings.delaySegundos}s (${orderLabel(settings.ordem)}) antes de abrir o pacote…`, 'info');
      await sleep(Math.min(600, Math.max(0, settings.delaySegundos)) * 1000);
      renewTshLock('abrir-pacotes', ctx.world);
    }

    // 4) Inventário fresco pelo parser puro; só abre o que a página marcou.
    let itens: InventoryItem[];
    try {
      itens = parseInventoryItems(await pacedGet(inventoryPath(ctx.villageId), { fresh: true }));
    } catch (error) {
      ctx.status(
        `Não consegui ler o inventário: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return;
    }
    ctx.storage.set('last-preview', {
      armazemLivrePct: Number(livrePct.toFixed(1)),
      itensReconhecidos: itens.length,
      resumoItens: summarizeInventory(itens),
      ordem: settings.ordem,
      delaySegundos: settings.delaySegundos,
      abertoEm: new Date(agora).toISOString(),
    });
    const pacote = pickResourcePackage(itens);
    if (pacote === undefined) {
      ctx.status(`${summarizeInventory(itens)} Nenhum pacote de recursos abrível (com ação canônica) no inventário.`, 'info');
      return;
    }
    if (pacote.actionUrl === undefined) {
      // Inalcançável hoje (pickResourcePackage exige a URL), mantido explícito
      // para o dia em que a seleção mudar.
      ctx.status(`O pacote "${pacote.name}" não expôs ação de abertura — nada foi postado.`, 'warn');
      return;
    }
    const resultado = await postGameForm(pacote.actionUrl, {});
    if (!resultado.ok) {
      ctx.status(`Abertura do pacote "${pacote.name}" falhou: ${resultado.message}`, 'warn');
      return;
    }
    ctx.storage.set('aberto-em', agora);
    ctx.status(
      `Pacote "${pacote.name}" (x${pacote.count}) enviado para abertura com ${livrePct.toFixed(1)}% de armazém livre.`,
      'ok',
    );
  },
});
