import { describe, expect, it } from 'vitest';
import {
  MAX_MP_TEMPLATES,
  type MpTemplateEntry,
  MP_PLACEHOLDERS,
  type MpTemplateSaveInput,
  markDefault,
  removeTemplate,
  sanitizeTemplateInput,
  SEED_MP_TEMPLATES,
  sortTemplatesNewestFirst,
  templateNotFoundError,
  upsertTemplate,
} from './mp-templates-rules';

const NOW = new Date('2026-08-26T12:00:00.000Z');

const VALID_INPUT: MpTemplateSaveInput = {
  name: ' Ataque Madrugada ',
  subject: '  OP Norte — confirme ',
  body: '  Seus alvos: #alvos#\nHorários: #horarios#  ',
};

function entry(id: string, overrides: Partial<MpTemplateEntry> = {}): MpTemplateEntry {
  return {
    id,
    name: 'Ataque Madrugada',
    body: 'Seus alvos: #alvos#',
    isDefault: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sanitizeTemplateInput (fail-closed)', () => {
  it('entrada válida é sanitizada (trim de nome/assunto/corpo) e preserva id/isDefault', () => {
    expect(sanitizeTemplateInput({ ...VALID_INPUT, id: ' t-1 ', isDefault: true })).toEqual({
      id: 't-1',
      name: 'Ataque Madrugada',
      subject: 'OP Norte — confirme',
      body: 'Seus alvos: #alvos#\nHorários: #horarios#',
      isDefault: true,
    });
  });

  it('assunto é opcional: em branco vira ausente e o corpo mantém as quebras de linha', () => {
    const sanitized = sanitizeTemplateInput({ ...VALID_INPUT, subject: '   ' });
    expect('subject' in sanitized).toBe(false);
    expect(sanitized.body).toBe('Seus alvos: #alvos#\nHorários: #horarios#');
  });

  it('nome vazio ou acima de 50 caracteres lança erro PT-BR', () => {
    expect(() => sanitizeTemplateInput({ ...VALID_INPUT, name: '   ' })).toThrow(/Nome do template vazio ou longo demais — informe entre 1 e 50 caracteres/);
    expect(() => sanitizeTemplateInput({ ...VALID_INPUT, name: 'n'.repeat(51) })).toThrow(/entre 1 e 50 caracteres/);
    // limites exatos passam
    expect(sanitizeTemplateInput({ ...VALID_INPUT, name: 'n'.repeat(50) }).name).toHaveLength(50);
  });

  it('corpo vazio lança erro PT-BR', () => {
    expect(() => sanitizeTemplateInput({ ...VALID_INPUT, body: '' })).toThrow(/Corpo da mensagem vazio/);
    expect(() => sanitizeTemplateInput({ ...VALID_INPUT, body: '   ' })).toThrow(/Corpo da mensagem vazio/);
  });

  it('corpo acima de 20000 caracteres lança erro PT-BR citando o limite (20000 exato passa)', () => {
    expect(() => sanitizeTemplateInput({ ...VALID_INPUT, body: 'c'.repeat(20001) })).toThrow(/entre 1 e 20000 caracteres/);
    expect(sanitizeTemplateInput({ ...VALID_INPUT, body: 'c'.repeat(20000) }).body).toHaveLength(20000);
  });

  it('assunto acima de 200 caracteres lança erro PT-BR', () => {
    expect(() => sanitizeTemplateInput({ ...VALID_INPUT, subject: 's'.repeat(201) })).toThrow(/Assunto longo demais — limite de 200/);
  });
});

describe('upsertTemplate', () => {
  it('criação sem id gera id novo, updatedAt=agora injetado e isDefault false por omissão', () => {
    const next = upsertTemplate([], { name: ' Ataque Madrugada ', body: 'Seus alvos: #alvos#' }, NOW);
    expect(next).toHaveLength(1);
    const created = next[0]!;
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.updatedAt).toBe('2026-08-26T12:00:00.000Z');
    expect(created.isDefault).toBe(false);
    expect(created.name).toBe('Ataque Madrugada');
    expect('subject' in created).toBe(false);
  });

  it('criação com isDefault desmarca o default anterior (regra do default único)', () => {
    const list = [entry('a', { isDefault: true }), entry('b')];
    const next = upsertTemplate(list, { name: 'Novo', body: 'x', isDefault: true }, NOW);
    expect(next.filter((template) => template.isDefault)).toHaveLength(1);
    expect(next.find((template) => template.id === 'a')?.isDefault).toBe(false);
    expect(next.at(-1)?.isDefault).toBe(true);
  });

  it('edição com id substitui no lugar, preserva o id e atualiza o updatedAt', () => {
    const list = [entry('a'), entry('b', { isDefault: true })];
    const next = upsertTemplate(list, { id: 'a', name: 'Retomada', body: 'Novo corpo #alvos#' }, NOW);
    expect(next.map((template) => template.id)).toEqual(['a', 'b']);
    const edited = next[0]!;
    expect(edited.name).toBe('Retomada');
    expect(edited.body).toBe('Novo corpo #alvos#');
    expect(edited.updatedAt).toBe('2026-08-26T12:00:00.000Z');
    expect(edited.isDefault).toBe(false);
    expect(list[0]!.name).toBe('Ataque Madrugada'); // original não mutado
  });

  it('edição promovendo a default desmarca o default anterior', () => {
    const list = [entry('a', { isDefault: true }), entry('b')];
    const next = upsertTemplate(list, { id: 'b', name: 'B', body: 'x', isDefault: true }, NOW);
    expect(next.find((template) => template.id === 'a')?.isDefault).toBe(false);
    expect(next.find((template) => template.id === 'b')?.isDefault).toBe(true);
  });

  it('edição que desmarca o default deixa a biblioteca SEM default (válido)', () => {
    const list = [entry('a', { isDefault: true }), entry('b')];
    const next = upsertTemplate(list, { id: 'a', name: 'A', body: 'x', isDefault: false }, NOW);
    expect(next.some((template) => template.isDefault)).toBe(false);
  });

  it('edição com id inexistente lança erro PT-BR (fail-closed, igual groups)', () => {
    expect(() => upsertTemplate([entry('a')], { id: 'fantasma', name: 'X', body: 'x' }, NOW)).toThrow(
      /Template não encontrado na biblioteca \(id=fantasma\)/,
    );
  });

  it('cap 50: criar o 51º lança erro PT-BR citando o limite', () => {
    const full: MpTemplateEntry[] = [];
    for (let i = 0; i < MAX_MP_TEMPLATES; i++) full.push(entry(`t-${i}`));
    expect(() => upsertTemplate(full, { name: 'Estourou', body: 'x' }, NOW)).toThrow(
      new RegExp(`Biblioteca de templates cheia — limite de ${MAX_MP_TEMPLATES} alcançado`),
    );
  });

  it('cap 50: EDITAR um existente com a biblioteca cheia não lança (substitui no lugar)', () => {
    const full: MpTemplateEntry[] = [];
    for (let i = 0; i < MAX_MP_TEMPLATES; i++) full.push(entry(`t-${i}`));
    const next = upsertTemplate(full, { id: 't-25', name: 'Editado na cheia', body: 'x' }, NOW);
    expect(next).toHaveLength(MAX_MP_TEMPLATES);
    expect(next.find((template) => template.id === 't-25')?.name).toBe('Editado na cheia');
  });

  it('biblioteca suja com 2 defaults é normalizada para 1 no próximo upsert', () => {
    const dirty = [entry('a', { isDefault: true }), entry('b', { isDefault: true }), entry('c')];
    const next = upsertTemplate(dirty, { id: 'c', name: 'C', body: 'x' }, NOW);
    expect(next.filter((template) => template.isDefault)).toHaveLength(1);
    expect(next.find((template) => template.id === 'a')?.isDefault).toBe(true); // primeiro default sobrevive
  });
});

describe('removeTemplate', () => {
  it('remove por id e, se o removido era o default, NENHUM outro vira default', () => {
    const list = [entry('a', { isDefault: true }), entry('b')];
    const next = removeTemplate(list, 'a');
    expect(next.map((template) => template.id)).toEqual(['b']);
    expect(next.some((template) => template.isDefault)).toBe(false);
    expect(list).toHaveLength(2); // original não mutado
  });

  it('remove de id inexistente é IDEMPOTENTE: devolve lista igual, sem erro', () => {
    const list = [entry('a'), entry('b', { isDefault: true })];
    expect(removeTemplate(list, 'fantasma')).toEqual(list);
    expect(removeTemplate([], 'fantasma')).toEqual([]);
  });
});

describe('markDefault', () => {
  it('marca O default e desmarca todos os demais (updatedAt intocado)', () => {
    const list = [entry('a', { isDefault: true }), entry('b'), entry('c')];
    const next = markDefault(list, 'c');
    expect(next.find((template) => template.id === 'a')?.isDefault).toBe(false);
    expect(next.find((template) => template.id === 'b')?.isDefault).toBe(false);
    expect(next.find((template) => template.id === 'c')?.isDefault).toBe(true);
    expect(next.find((template) => template.id === 'c')?.updatedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(list[0]!.isDefault).toBe(true); // original não mutado
  });

  it('id inexistente lança erro PT-BR', () => {
    expect(() => markDefault([entry('a')], 'fantasma')).toThrow(/Template não encontrado na biblioteca \(id=fantasma\) — recarregue/);
    expect(templateNotFoundError('z').message).toContain('(id=z)');
  });
});

describe('MP_PLACEHOLDERS e ordenação', () => {
  it('constante documenta os placeholders #alvos# e #horarios#', () => {
    const tokens = MP_PLACEHOLDERS.map((placeholder) => placeholder.token);
    expect(tokens).toContain('#alvos#');
    expect(tokens).toContain('#horarios#');
    for (const placeholder of MP_PLACEHOLDERS) {
      expect(placeholder.description.length).toBeGreaterThan(10);
    }
  });

  it('sortTemplatesNewestFirst ordena updatedAt desc sem mutar o original', () => {
    const list = [
      entry('a', { updatedAt: '2026-03-01T00:00:00.000Z' }),
      entry('b', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      entry('c', { updatedAt: '2026-06-01T00:00:00.000Z' }),
    ];
    expect(sortTemplatesNewestFirst(list).map((template) => template.id)).toEqual(['c', 'a', 'b']);
    expect(list.map((template) => template.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('SEED_MP_TEMPLATES (v0.33)', () => {
  it('todos os seeds passam na sanitização fail-closed e têm placeholder obrigatório', () => {
    for (const seed of SEED_MP_TEMPLATES) {
      expect(() => sanitizeTemplateInput(seed)).not.toThrow();
      const sanitized = sanitizeTemplateInput(seed);
      expect(sanitized.body.includes('#alvos#') || sanitized.body.includes('#horarios#')).toBe(true);
    }
  });
});
