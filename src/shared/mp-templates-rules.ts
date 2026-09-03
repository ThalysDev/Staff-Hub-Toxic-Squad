// Regras PURAS da biblioteca de TEMPLATES DE MP (roadmap item 11): mensagens
// padrão reutilizadas no envio de MPs do Planejador (SG_6 usa assunto+corpo) e
// no pacote de comunicação da distribuição (SG_4 usa só o corpo). Sanitização
// fail-closed da entrada, teto de 50 templates, regra do default único e
// remoção idempotente. Nada de electron nem persistência aqui — ipc-templates
// (src/main/ipc-templates.ts) aplica estas funções sobre o JsonStore
// 'mp-templates' e journala cada evento.

/** Teto da biblioteca: criar além de 50 templates lança erro PT-BR. */
export const MAX_MP_TEMPLATES = 50;

export interface MpTemplateEntry {
  id: string;
  /** 1–50 caracteres. */
  name: string;
  /** Assunto opcional (SG_4 usa só o corpo; SG_6 usa assunto+corpo). */
  subject?: string;
  /** 1–20000 caracteres; placeholders #alvos#/#horarios# substituídos no envio. */
  body: string;
  /** No máximo UM default no store; remover o default deixa a lista sem default. */
  isDefault: boolean;
  /** ISO da última alteração (a criação conta como alteração). */
  updatedAt: string;
}

/** Entrada do IPC: com id = edição; sem id = criação. */
export interface MpTemplateSaveInput {
  id?: string;
  name: string;
  subject?: string;
  body: string;
  isDefault?: boolean;
}

/** Placeholders substituíveis no corpo (documentação viva para a UI). */
export const MP_PLACEHOLDERS: readonly { token: string; description: string }[] = [
  { token: '#jogador#', description: 'Nick do destinatário da MP (v0.33).' },
  { token: '#alvos#', description: 'Coordenadas atribuídas ao jogador, separadas por espaço.' },
  { token: '#horarios#', description: 'Bloco "alvo → HH:MM:SS" gerado pela calculadora de envio do SG_4.' },
];

/**
 * Seeds da v0.33 (modelos aprovados pelo dono): instalados UMA vez quando a
 * biblioteca está VAZIA — depois o usuário edita/exclui livremente. O de
 * cobrança usa #faltam# (substituído pelo painel "Cobrar faltas" da Sala de
 * Guerra antes do envio) além de #jogador#/#alvos#.
 */
export const SEED_MP_TEMPLATES: readonly MpTemplateSaveInput[] = [
  {
    name: '⚔ Diretrizes de OP',
    subject: '⚔ OP — seus alvos e horários',
    body:
      '[b]⚔ OP — Diretrizes da operação[/b]\n\n' +
      '[b]📍 SEUS ALVOS[/b]\n[spoiler=Clique para ver seus alvos]\n#alvos#\n[/spoiler]\n\n' +
      '[b]⏰ SEUS HORÁRIOS DE ENVIO[/b]\n[spoiler=Clique para ver quando enviar]\n#horarios#\n[/spoiler]\n\n' +
      '[b]📌 Diretrizes:[/b]\n' +
      '1. [b]Confirme[/b] respondendo esta MP com "OK";\n' +
      '2. Ataque com [b]toda a tropa indicada[/b] — nada de poupar;\n' +
      '3. [b]Não mire nada além do informado[/b];\n' +
      '4. Alvo caiu antes? [b]Envie mesmo assim[/b] no horário combinado;\n' +
      '5. Não pode participar? Avise [b]agora[/b] para realocarmos seus alvos;\n' +
      '6. [b]Não compartilhe[/b] esta MP fora da operação.\n\n' +
      'Boa sorte! 🍀\n— Comando',
    isDefault: true,
  },
  {
    name: '🔔 Cobrança de faltas',
    subject: '🔔 OP — faltam seus ataques',
    body:
      '[b]🔔 #jogador#, a OP ainda está esperando você[/b]\n\n' +
      'Faltam [b]#faltam# ataque(s)[/b] seus na operação em andamento.\n\n' +
      'Seus alvos:\n[spoiler=Clique para ver]\n#alvos#\n[/spoiler]\n\n' +
      'Manda o que puder [b]agora[/b] — qualquer ajuda conta. Se não conseguir, responda avisando para realocarmos.\n\n' +
      '— Comando',
    isDefault: false,
  },
];

/** Limite do assunto opcional (mesma folga do critério em groups-rules). */
const SUBJECT_MAX = 200;

/**
 * Validação fail-closed compartilhada por criação e edição: nome 1–50 e corpo
 * 1–20000 após trim lançam erro PT-BR claro e o template não é gravado (nunca
 * dado errado silencioso). Assunto é opcional — em branco vira ausente.
 * Placeholders NÃO são validados aqui (texto livre); o envio do SG_6 decide se
 * #horarios# sem horários é erro. id vazio/ausente segue ausente (criação).
 * Devolve a entrada sanitizada SEM o id quando ele não veio.
 */
export function sanitizeTemplateInput(input: MpTemplateSaveInput): MpTemplateSaveInput {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 50) {
    throw new Error('Nome do template vazio ou longo demais — informe entre 1 e 50 caracteres.');
  }
  const body = input.body.trim();
  if (body.length < 1 || body.length > 20000) {
    throw new Error('Corpo da mensagem vazio ou longo demais — informe entre 1 e 20000 caracteres.');
  }
  const subject = input.subject?.trim() ?? '';
  if (subject.length > SUBJECT_MAX) {
    throw new Error(`Assunto longo demais — limite de ${SUBJECT_MAX} caracteres.`);
  }
  const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : undefined;

  return {
    ...(id !== undefined ? { id } : {}),
    name,
    ...(subject !== '' ? { subject } : {}),
    body,
    ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
  };
}

/** Erro padronizado para id que não existe mais no arquivo. */
export function templateNotFoundError(id: string): Error {
  return new Error(`Template não encontrado na biblioteca (id=${id}) — recarregue a lista e tente de novo.`);
}

/**
 * Upsert (criação sem id / edição com id): sanitiza a entrada, grava
 * updatedAt=agora (injetável para teste) e aplica a regra do default único —
 * salvar com isDefault desmarca os demais. Edição de id inexistente lança erro
 * PT-BR fail-closed (mesma regra do groups-rules). Criação além do teto de
 * MAX_MP_TEMPLATES lança erro PT-BR citando o limite; editar um existente com
 * a biblioteca cheia NÃO lança (substitui no lugar). Não muta o array original.
 */
export function upsertTemplate(list: MpTemplateEntry[], input: MpTemplateSaveInput, now: Date): MpTemplateEntry[] {
  const sanitized = sanitizeTemplateInput(input);
  const updatedAt = now.toISOString();
  const isDefault = sanitized.isDefault === true;

  const makeEntry = (id: string): MpTemplateEntry => ({
    id,
    name: sanitized.name,
    ...(sanitized.subject !== undefined ? { subject: sanitized.subject } : {}),
    body: sanitized.body,
    isDefault,
    updatedAt,
  });

  if (sanitized.id !== undefined) {
    const index = list.findIndex((template) => template.id === sanitized.id);
    if (index < 0) throw templateNotFoundError(sanitized.id);
    const replaced = list.map((template, position) => (position === index ? makeEntry(template.id) : template));
    return enforceUniqueDefault(replaced, sanitized.id);
  }

  if (list.length >= MAX_MP_TEMPLATES) {
    throw new Error(
      `Biblioteca de templates cheia — limite de ${MAX_MP_TEMPLATES} alcançado; remova um template antes de criar outro.`,
    );
  }
  const created = crypto.randomUUID();
  return enforceUniqueDefault([...list, makeEntry(created)], created);
}

/**
 * Remove por id. IDEMPOTENTE de propósito: id que não existe mais (lista
 * recarregada, clique duplo na UI) é no-op e devolve a lista igual — remoção
 * nunca explode por corrida de UI. Se o removido era o default, NENHUM outro
 * vira default (a biblioteca pode ficar sem default até o próximo save).
 */
export function removeTemplate(list: MpTemplateEntry[], id: string): MpTemplateEntry[] {
  return list.filter((template) => template.id !== id);
}

/**
 * Marca O default e desmarca todos os demais (updatedAt não muda: a marcação
 * não altera o conteúdo do template). id inexistente lança erro PT-BR.
 */
export function markDefault(list: MpTemplateEntry[], id: string): MpTemplateEntry[] {
  if (!list.some((template) => template.id === id)) throw templateNotFoundError(id);
  return list.map((template) => (template.isDefault === (template.id === id) ? template : { ...template, isDefault: template.id === id }));
}

/**
 * Garante a regra do default único: o template salvo default vira O default e
 * todos os demais são desmarcados. Se o salvo não é default, sobrevive o
 * primeiro default já existente — arquivo sujo com 2+ defaults também é
 * normalizado no próximo upsert, nunca fica mais de um.
 */
function enforceUniqueDefault(list: MpTemplateEntry[], savedId: string): MpTemplateEntry[] {
  const saved = list.find((template) => template.id === savedId);
  const keeper = saved !== undefined && saved.isDefault ? savedId : list.find((template) => template.isDefault)?.id;
  if (keeper === undefined) return list;
  return list.map((template) => (template.isDefault === (template.id === keeper) ? template : { ...template, isDefault: template.id === keeper }));
}

/** Ordem de exibição: mais recente primeiro (updatedAt desc, estável). */
export function sortTemplatesNewestFirst(list: MpTemplateEntry[]): MpTemplateEntry[] {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
