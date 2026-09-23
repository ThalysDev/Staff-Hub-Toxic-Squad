// Gerenciador do Paladino (Onda 5, Parte A) — na Estátua, recruta o Paladino
// ausente (transporte existente launchPaladinTraining) e EDUCA as habilidades
// na ordem de prioridade configurada, uma por ciclo (F2).
//
// Divisão do trabalho: o parser de habilidades é PURO (html → habilidades) e o
// seletor `pickSkillToEducate` só devolve uma habilidade quando a PRÓPRIA
// página expôs a ação de educar; o plugin posta essa ação (onda5-form-post).
//
// LACUNA REGISTRADA: a tela da Estátua não tem fixture no repo — o contrato do
// parser é explícito: só linhas marcadas com `data-skill` entram, e a ação de
// educar precisa de `data-skill-educate` ou de um href com "educate/educar".
// Sem isso, o ciclo NÃO posta nada (fail-closed: educar a habilidade errada
// queimaria o custo da educação).

import { registerTsh } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { launchPaladinTraining } from '../tsh-transport';
import { postGameForm } from './onda5-form-post';

/** Catálogo das habilidades do Paladino (chave canônica + rótulos aceitos). */
export const PALADIN_SKILL_CATALOG: readonly {
  readonly key: string;
  readonly label: string;
  readonly aliases: readonly string[];
}[] = [
  { key: 'cavalry', label: 'Cavalaria', aliases: ['cavalaria', 'cavalary', 'cavalry'] },
  { key: 'medicine', label: 'Medicina', aliases: ['medicina', 'medicine', 'curandeiro'] },
  { key: 'infantry', label: 'Infantaria', aliases: ['infantaria', 'infantry'] },
  { key: 'siege', label: 'Cerco', aliases: ['cerco', 'assedio', 'siege'] },
  { key: 'fortification', label: 'Fortificação', aliases: ['fortificacao', 'muralha', 'fortaleza', 'fortification'] },
];

/** Minúsculas sem acento (rótulo do jogo vem em pt-BR). */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Chave canônica da habilidade ('cavalaria' → 'cavalry'); null = desconhecida. */
export function normalizeSkillKey(token: string): string | null {
  const alvo = fold(token).replace(/[\s_-]+/g, ' ');
  if (alvo === '') return null;
  for (const skill of PALADIN_SKILL_CATALOG) {
    if (skill.key === alvo) return skill.key;
    if (skill.aliases.some((alias) => fold(alias) === alvo)) return skill.key;
  }
  return null;
}

export interface SkillPriority {
  /** Chaves canônicas na ordem informada (sem repetição). */
  readonly keys: string[];
  /** Tokens que não casaram com nenhuma habilidade do catálogo. */
  readonly invalid: string[];
}

/**
 * Lista de prioridades do texto ("cavalaria,medicina,…"): separa por vírgula,
 * ponto e vírgula ou linha; normaliza para as chaves canônicas, preserva a
 * ordem, remove repetições e devolve os tokens desconhecidos à parte (o ciclo
 * avisa — nunca "educa a habilidade mais parecida").
 */
export function parseSkillPriorityList(text: string): SkillPriority {
  const keys: string[] = [];
  const invalid: string[] = [];
  for (const bruto of text.split(/[,;\n]+/)) {
    const token = bruto.trim();
    if (token === '') continue;
    const key = normalizeSkillKey(token);
    if (key === null) {
      invalid.push(token);
      continue;
    }
    if (!keys.includes(key)) keys.push(key);
  }
  return { keys, invalid };
}

export interface PaladinSkill {
  /** Chave canônica do catálogo ou o rótulo normalizado quando desconhecida. */
  readonly key: string;
  readonly label: string;
  readonly level: number;
  /** 0 = a página não informou o teto (a ação exposta é o gate). */
  readonly maxLevel: number;
  readonly known: boolean;
  /** Caminho canônico de educar exposto pela página (undefined = indisponível). */
  readonly educatePath?: string;
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
 * Habilidades do Paladino na Estátua (parser puro, fail-closed): cada linha
 * marcada com `data-skill="<rótulo|chave>"` vira uma habilidade; nível vem de
 * `data-skill-level` (fallback "Nível N" no texto), teto de `data-skill-max` e
 * a ação de educar de `data-skill-educate` ou de um href com "educate/educar".
 * Linha sem marcador é ignorada — nunca entra habilidade "adivinhada".
 */
export function parsePaladinSkills(html: string): PaladinSkill[] {
  const anchors = [...html.matchAll(/<[a-z]+[^>]*data-skill="([^"]+)"[^>]*>/gi)];
  const skills: PaladinSkill[] = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const raw = anchor?.[1];
    if (anchor === undefined || raw === undefined) continue;
    const label = decodeEntities(raw).trim();
    const key = normalizeSkillKey(label);
    const block = html.slice(anchor.index, anchors[index + 1]?.index ?? html.length);
    const level = Number(
      attribute(block, 'data-skill-level') ?? block.match(/(?:n[íi]vel|level)\s*(\d+)/i)?.[1] ?? '0',
    );
    const maxLevel = Number(attribute(block, 'data-skill-max') ?? '0');
    const declaredPath = attribute(block, 'data-skill-educate');
    const href = block.match(/href="([^"]*(?:educate|educar)[^"]*)"/i)?.[1];
    const educatePath = declaredPath !== undefined ? decodeEntities(declaredPath) : href !== undefined ? decodeEntities(href) : undefined;
    skills.push({
      key: key ?? fold(label).replace(/[\s_-]+/g, '-'),
      label,
      level: Number.isFinite(level) && level > 0 ? Math.floor(level) : 0,
      maxLevel: Number.isFinite(maxLevel) && maxLevel > 0 ? Math.floor(maxLevel) : 0,
      known: key !== null,
      ...(educatePath !== undefined ? { educatePath } : {}),
    });
  }
  return skills;
}

export type SkillEducationDecision =
  | { readonly kind: 'educar'; readonly skill: PaladinSkill }
  | { readonly kind: 'nada'; readonly reason: string };

/**
 * Próxima habilidade a educar: percorre a lista de prioridades NA ORDEM e
 * devolve a primeira que a página deixou educável (ação exposta e nível abaixo
 * do teto conhecido). Sem prioridade válida ou sem habilidade educável, o
 * motivo volta em pt-BR (o ciclo só reporta — nada é postado).
 */
export function pickSkillToEducate(
  skills: readonly PaladinSkill[],
  priorityKeys: readonly string[],
): SkillEducationDecision {
  if (skills.length === 0) {
    return {
      kind: 'nada',
      reason: 'Nenhuma habilidade reconhecida na Estátua (linhas com data-skill) — nada foi educado.',
    };
  }
  if (priorityKeys.length === 0) {
    return { kind: 'nada', reason: 'Nenhuma habilidade na lista de prioridades — nada foi educado.' };
  }
  const educaveis = skills.filter(
    (skill) => skill.educatePath !== undefined && (skill.maxLevel === 0 || skill.level < skill.maxLevel),
  );
  for (const key of priorityKeys) {
    const escolhida = educaveis.find((skill) => skill.key === key);
    if (escolhida !== undefined) return { kind: 'educar', skill: escolhida };
  }
  return {
    kind: 'nada',
    reason: `Nenhuma habilidade prioritária está educável agora (lidas: ${skills.map((skill) => `${skill.label} nível ${skill.level}`).join(', ')}).`,
  };
}

// Type alias (não interface) para continuar atribuível a Record<string, unknown>.
export type PaladinoSettings = {
  /** Recruta o Paladino quando o slot da Estátua está livre. */
  recrutarAuto: boolean;
  /** Educa habilidades automaticamente (desligado = só prévia/status). */
  eduAuto: boolean;
  /** Lista de prioridades "cavalaria,medicina,…". */
  skillsPrioritarias: string;
};

export const DEFAULT_SETTINGS: PaladinoSettings = {
  recrutarAuto: true,
  eduAuto: true,
  skillsPrioritarias: 'cavalaria,medicina',
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'recrutarAuto',
    label: 'Recrutar o Paladino quando o slot estiver livre',
    type: 'boolean',
    help: 'Usa o lançador oficial da Estátua (mesmo transporte do Treinamento do Paladino).',
  },
  {
    key: 'eduAuto',
    label: 'Educar habilidades automaticamente',
    type: 'boolean',
    help: 'Desligado: o ciclo só reporta a prévia das habilidades — nenhuma educação é enviada.',
  },
  {
    key: 'skillsPrioritarias',
    label: 'Prioridade das habilidades',
    type: 'text',
    placeholder: 'cavalaria,medicina',
    help: 'Ordem de educação, separada por vírgula. Conhecidas: cavalaria, medicina, infantaria, cerco, fortificação.',
  },
];

registerTsh({
  id: 'paladino-skills',
  label: 'Gerenciador do Paladino',
  desc: 'Na Estátua: recruta o Paladino e educa as habilidades na ordem de prioridade — 1 ação por ciclo.',
  category: 'producao',
  screen: 'statue',
  mutating: true,
  cooldownMs: 10 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  async runCycle(ctx) {
    const settings = ctx.storage.get('settings', DEFAULT_SETTINGS);
    const prioridade = parseSkillPriorityList(settings.skillsPrioritarias);
    const avisoPrioridade =
      prioridade.invalid.length > 0
        ? ` Habilidades não reconhecidas na prioridade (ignoradas): ${prioridade.invalid.join(', ')}.`
        : '';

    // Slot livre na Estátua = paladino ausente: usa o transporte existente.
    if (document.querySelector('a.knight_recruit_launch') !== null) {
      ctx.storage.set('last-preview', {
        status: 'Slot livre — paladino ausente',
        prioridade: prioridade.keys,
        invalid: prioridade.invalid,
        geradoEm: new Date().toISOString(),
      });
      if (!settings.recrutarAuto) {
        ctx.status(`Slot livre, mas o recrutamento automático está desligado nas configurações.${avisoPrioridade}`, 'info');
        return;
      }
      ctx.status('Slot livre: lançando o recrutamento do Paladino da Estátua…', 'info');
      await launchPaladinTraining();
      ctx.status('Recrutamento do Paladino lançado.', 'ok');
      return;
    }

    const skills = parsePaladinSkills(document.documentElement.outerHTML);
    const decisao = pickSkillToEducate(skills, prioridade.keys);
    ctx.storage.set('last-preview', {
      status: decisao.kind === 'educar' ? `Educar ${decisao.skill.label} (nível ${decisao.skill.level})` : 'Sem educação neste ciclo',
      motivo: decisao.kind === 'nada' ? decisao.reason : '',
      prioridade: prioridade.keys,
      invalid: prioridade.invalid,
      habilidades: skills.map((skill) => ({
        habilidade: skill.label,
        chave: skill.key,
        nivel: skill.level,
        teto: skill.maxLevel,
        educavel: skill.educatePath !== undefined,
      })),
      geradoEm: new Date().toISOString(),
    });
    if (decisao.kind === 'nada') {
      ctx.status(`${decisao.reason}${avisoPrioridade}`, 'info');
      return;
    }
    if (!settings.eduAuto) {
      ctx.status(
        `Prévia: educaria ${decisao.skill.label} (nível ${decisao.skill.level}) — a educação automática está desligada.${avisoPrioridade}`,
        'info',
      );
      return;
    }
    const caminho = decisao.skill.educatePath;
    if (caminho === undefined) {
      // Inalcançável hoje (o seletor exige a ação), mantido explícito.
      ctx.status(`Não há ação de educar exposta para ${decisao.skill.label} — nada foi postado.`, 'warn');
      return;
    }
    const resultado = await postGameForm(caminho, {});
    if (!resultado.ok) {
      ctx.status(`Educação de ${decisao.skill.label} falhou: ${resultado.message}`, 'warn');
      return;
    }
    ctx.status(
      `Educação enviada: ${decisao.skill.label} (nível ${decisao.skill.level}).${avisoPrioridade}`,
      'ok',
    );
  },
});
