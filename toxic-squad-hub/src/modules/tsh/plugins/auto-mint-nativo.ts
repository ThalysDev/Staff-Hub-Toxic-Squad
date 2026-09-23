// Cunhagem Nativa (Onda 5, Parte A) — liga a cunhagem AUTOMÁTICA DO PRÓPRIO
// JOGO (o checkbox de "cunhagem automática" da Academia, screen=snob) nas
// aldeias do grupo configurado, reativando de tempos em tempos porque o jogo
// expira a configuração.
//
// Por que existe: o plugin Cunhagem de moedas cunha SOZINHO, ciclo a ciclo, com
// o usuário armando; a cunhagem nativa do jogo cunha sozinha no servidor e
// sobrevive com a aba fechada. Não são o mesmo mecanismo: este módulo só LIGA
// a opção nativa — nenhuma moeda é cunhada por ele.
//
// Fluxo do ciclo (F2: no máximo 1 POST por ciclo):
//   1. alvos = aldeias do grupo (settings.grupo, id em texto por enquanto) ou a
//      aldeia atual quando o grupo está vazio;
//   2. pula aldeia cujo último "ligado" ainda está dentro de `reativarDias`;
//   3. lê a Academia da aldeia pela fila global (pacedGet fresh) e o parser
//      puro exige o controle canônico (`name` contendo auto_mint);
//   4. já ligada → anota e segue; desligada → POST do form exposto pela própria
//      página (campos hidden + campo do controle) e anota a data.
//
// LACUNA REGISTRADA: a ação exata do jogo (nome do campo/rota) NÃO foi
// confirmada contra fixture real do br142. O contrato aqui é "posta somente o
// que a Academia expôs": página sem o controle canônico = nada é postado e o
// status diz o que faltou (fail-closed, nunca chute de seletor).

import { registerTsh } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { pacedGet } from '../../../core/net';
import { getGroupVillages } from '../tsh-groups';
import { postGameForm } from './onda5-form-post';

/** Teto de leituras de Academia por ciclo (cada leitura ≥200ms na fila). */
const MAX_LEITURAS_POR_CICLO = 3;

export interface AutoMintControl {
  /** Ação do form canônico da Academia (é o que é postado). */
  readonly action: string;
  /** Nome do campo da cunhagem automática. */
  readonly field: string;
  /** Valor a enviar quando o jogador liga a opção (default "1"). */
  readonly value: string;
  /** true = a página lida já está com a opção ligada. */
  readonly enabled: boolean;
  /** Outros campos hidden do MESMO form (sem h — o POST usa o csrf fresco). */
  readonly hidden: Record<string, string>;
}

const FIELD_PATTERN = /auto[_-]?mint/i;

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  const value = match?.[1]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * Controle de cunhagem automática da Academia (parser puro, fail-closed):
 * procura um `<input name="...auto_mint...">` dentro de um `<form>`, pega a
 * action do próprio form e os hidden dele. Sem form canônico → null (o ciclo
 * NÃO posta nada). Links de toggle NÃO são aceitos: um `href` com auto_mint
 * pode ser o DESLIGAR — chutar ali desligaria a cunhagem do jogador.
 */
export function parseAutoMintControl(html: string): AutoMintControl | null {
  for (const formMatch of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const tag = formMatch[0] ?? '';
    const inner = formMatch[1] ?? '';
    const action = attribute(tag, 'action');
    if (action === undefined) continue;
    const control = [...inner.matchAll(/<input\b[^>]*>/gi)].find((input) =>
      FIELD_PATTERN.test(attribute(input[0] ?? '', 'name') ?? ''),
    );
    if (control === undefined) continue;
    const controlTag = control[0] ?? '';
    const field = attribute(controlTag, 'name');
    if (field === undefined) continue;
    const type = (attribute(controlTag, 'type') ?? 'text').toLowerCase();
    if (type !== 'checkbox' && type !== 'radio' && type !== 'hidden') continue;
    const hidden: Record<string, string> = {};
    for (const input of inner.matchAll(/<input\b[^>]*>/gi)) {
      const inputTag = input[0] ?? '';
      if ((attribute(inputTag, 'type') ?? '').toLowerCase() !== 'hidden') continue;
      const name = attribute(inputTag, 'name');
      const value = attribute(inputTag, 'value');
      if (name === undefined || name === 'h' || FIELD_PATTERN.test(name)) continue;
      hidden[name] = decodeEntities(value ?? '');
    }
    return {
      action: decodeEntities(action),
      field,
      value: decodeEntities(attribute(controlTag, 'value') ?? '1'),
      // Checkbox/radio: `checked` no HTML. Hidden: já é o valor corrente.
      enabled: type === 'hidden' ? (attribute(controlTag, 'value') ?? '') !== '' && attribute(controlTag, 'value') !== '0' : /\bchecked\b/i.test(controlTag),
      hidden,
    };
  }
  return null;
}

// Type alias (não interface) para continuar atribuível a Record<string, unknown>.
export type AutoMintSettings = {
  /** Id do grupo de aldeias (texto por enquanto — sem dropdown nesta onda). */
  grupo: string;
  /** Dias até reativar a cunhagem automática (o jogo expira a configuração). */
  reativarDias: number;
};

export const DEFAULT_SETTINGS: AutoMintSettings = {
  grupo: '',
  reativarDias: 7,
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'grupo',
    label: 'Grupo de aldeias (id)',
    type: 'text',
    placeholder: 'ex.: 1234',
    help: 'Id do grupo do jogo cujas Academias recebem a cunhagem automática. Vazio = só a aldeia aberta. (Seletor de grupo entra numa próxima onda.)',
  },
  {
    key: 'reativarDias',
    label: 'Reativar a cada (dias)',
    type: 'number',
    min: 1,
    max: 60,
    step: 1,
    help: 'A configuração do jogo expira: passado este prazo, o módulo confere a Academia da aldeia de novo e religa se tiver caído.',
  },
];

/** Caminho da Academia de uma aldeia (fonte das leituras do ciclo). */
export function academiaPath(villageId: string): string {
  return `/game.php?village=${encodeURIComponent(villageId)}&screen=snob`;
}

/** Ids das aldeias-alvo: grupo configurado ou a aldeia atual. */
export async function resolveAutoMintTargets(grupo: string, currentVillageId: string): Promise<string[]> {
  const groupId = Number.parseInt(grupo.trim(), 10);
  if (Number.isInteger(groupId) && groupId > 0) {
    const rows = await getGroupVillages(groupId);
    const ids = rows.map((row) => String(row.villageId));
    if (ids.length > 0) return ids;
  }
  return currentVillageId === '' ? [] : [currentVillageId];
}

registerTsh({
  id: 'auto-mint-nativo',
  label: 'Cunhagem Nativa',
  desc: 'Liga a cunhagem automática DO JOGO nas Academias do grupo (máx. 1 ligação por ciclo); nenhuma moeda é cunhada por este módulo.',
  category: 'economia',
  screen: 'snob',
  mutating: true,
  cooldownMs: 60 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  async runCycle(ctx) {
    const settings = ctx.storage.get('settings', DEFAULT_SETTINGS);
    const alvos = await resolveAutoMintTargets(settings.grupo, ctx.villageId);
    if (alvos.length === 0) {
      ctx.status('Sem aldeias-alvo: informe o id do grupo ou abra uma aldeia com Academia.', 'warn');
      return;
    }
    const reativarMs = Math.max(1, Math.floor(settings.reativarDias)) * 24 * 60 * 60 * 1000;
    const agora = Date.now();
    const aplicado = ctx.storage.get<Record<string, number>>('aplicado', {});
    const rotacao = ctx.storage.get<number>('rotacao', 0);
    const total = alvos.length;
    let lidas = 0;
    let ilegiveis = 0;
    let jaAtivas = 0;
    for (let passo = 0; passo < total && lidas < MAX_LEITURAS_POR_CICLO; passo += 1) {
      const villageId = alvos[(rotacao + passo) % total];
      if (villageId === undefined) continue;
      const ultima = aplicado[villageId];
      if (ultima !== undefined && agora - ultima < reativarMs) {
        jaAtivas += 1;
        continue;
      }
      lidas += 1;
      let controle: AutoMintControl | null = null;
      try {
        controle = parseAutoMintControl(await pacedGet(academiaPath(villageId), { fresh: true }));
      } catch (error) {
        ctx.status(
          `Não consegui ler a Academia da aldeia ${villageId}: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
        return;
      }
      if (controle === null) {
        ilegiveis += 1;
        continue;
      }
      if (controle.enabled) {
        aplicado[villageId] = agora;
        ctx.storage.set('aplicado', aplicado);
        jaAtivas += 1;
        continue;
      }
      const campos = { ...controle.hidden, [controle.field]: controle.value };
      const resultado = await postGameForm(controle.action, campos);
      ctx.storage.set('rotacao', (rotacao + passo + 1) % total);
      if (!resultado.ok) {
        ctx.status(`Cunhagem automática da aldeia ${villageId}: ${resultado.message}`, 'warn');
        return;
      }
      aplicado[villageId] = agora;
      ctx.storage.set('aplicado', aplicado);
      ctx.status(
        `Cunhagem automática LIGADA na Academia da aldeia ${villageId} (o jogo vai cunhar sozinho; reativo em ${settings.reativarDias} dia(s)).`,
        'ok',
      );
      return;
    }
    ctx.storage.set('rotacao', (rotacao + lidas) % Math.max(1, total));
    ctx.status(
      `Nada a ligar neste ciclo: ${jaAtivas} dentro do prazo de reativação, ${ilegiveis} Academia(s) sem o controle canônico de cunhagem automática (lida(s): ${lidas}).`,
      ilegiveis > 0 && ilegiveis === lidas ? 'warn' : 'ok',
    );
  },
});
