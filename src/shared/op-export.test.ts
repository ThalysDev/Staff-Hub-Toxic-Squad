import { describe, expect, it } from 'vitest';
import { parseOpExport, serializeOpExport } from './op-export';

/** Campos OBRIGATÓRIOS do export (sem os opcionais sendSchedule/groups). */
const core = {
  version: '0.18.1',
  world: 'br142',
  opTitle: 'OP Ferrovias do Norte',
  targets: ['450|450', '451|449'],
  distribution: [
    { playerName: 'alfa', origin: '480|410', target: '450|450' },
    { playerName: 'bravo', origin: '479|412', target: '451|449' },
  ],
};

const input = {
  ...core,
  sendSchedule: '# Chegada desejada\nalfa;450|450;21:00:00\nbravo;451|449;21:05:30',
  groups: [
    { nome: 'Origens Norte', papel: 'origem', coords: ['480|410'] },
    { nome: 'Suporte Sul', papel: 'alvo', coords: [] },
  ],
};

describe('serializeOpExport → parseOpExport (ida e volta)', () => {
  it('round-trip preserva todos os campos da OP', () => {
    const parsed = parseOpExport(JSON.parse(serializeOpExport(input)));
    expect(parsed.app).toBe('staff-hub');
    expect(parsed.kind).toBe('op-export');
    expect(parsed.version).toBe('0.18.1');
    expect(parsed.world).toBe('br142');
    expect(parsed.opTitle).toBe('OP Ferrovias do Norte');
    expect(parsed.targets).toEqual(['450|450', '451|449']);
    expect(parsed.distribution).toEqual([
      { playerName: 'alfa', origin: '480|410', target: '450|450' },
      { playerName: 'bravo', origin: '479|412', target: '451|449' },
    ]);
    // Agenda preservada COM o comentário de cabeçalho.
    expect(parsed.sendSchedule).toBe(input.sendSchedule);
    expect(parsed.groups).toEqual(input.groups);
  });

  it('exportedAt preenchido com ISO válido e arquivo reconhecível como staff-hub/op-export', () => {
    const json = serializeOpExport(core);
    const data = JSON.parse(json) as { app: string; kind: string; exportedAt: string };
    expect(data.app).toBe('staff-hub');
    expect(data.kind).toBe('op-export');
    expect(Number.isNaN(Date.parse(data.exportedAt))).toBe(false);
  });

  it('sendSchedule/groups ausentes permanecem ausentes (nunca inventados)', () => {
    const parsed = parseOpExport(JSON.parse(serializeOpExport(core)));
    expect('sendSchedule' in parsed).toBe(false);
    expect('groups' in parsed).toBe(false);
  });
});

describe('parseOpExport fail-closed', () => {
  it('payload lixo lança PT-BR', () => {
    expect(() => parseOpExport('não sou json')).toThrow(/inválido/i);
    expect(() => parseOpExport([1, 2])).toThrow(/inválido/i);
    expect(() => parseOpExport(null)).toThrow(/inválido/i);
  });

  it('app/kind errados são rejeitados', () => {
    const base = JSON.parse(serializeOpExport(input)) as Record<string, unknown>;
    expect(() => parseOpExport({ ...base, app: 'toxic-squad-extension' })).toThrow(/não foi exportado pela Staff Hub/i);
    expect(() => parseOpExport({ ...base, kind: 'group' })).toThrow(/kind "group"/i);
    expect(() => parseOpExport({ ...base, app: 42 })).toThrow(/app.*obrigatório/i);
  });

  it('campos obrigatórios ausentes ou vazios lançam citando o campo', () => {
    const base = JSON.parse(serializeOpExport(input)) as Record<string, unknown>;
    for (const field of ['version', 'exportedAt', 'world', 'opTitle', 'targets', 'distribution']) {
      const broken = { ...base };
      delete broken[field];
      expect(() => parseOpExport(broken), `campo ${field}`).toThrow(new RegExp(`"${field}"`, 'i'));
    }
    expect(() => parseOpExport({ ...base, world: '' })).toThrow(/"world" não pode ficar vazio/i);
    expect(() => parseOpExport({ ...base, targets: [] })).toThrow(/ao menos um alvo/i);
    expect(() => parseOpExport({ ...base, distribution: [] })).toThrow(/distribuição está vazia/i);
  });

  it('coords fora do formato x|y e linhas de agenda quebradas lançam', () => {
    const base = JSON.parse(serializeOpExport(input)) as Record<string, unknown>;
    expect(() => parseOpExport({ ...base, targets: ['abc'] })).toThrow(/x\|y/i);
    expect(() =>
      parseOpExport({ ...base, distribution: [{ playerName: 'alfa', origin: '12', target: '450|450' }] }),
    ).toThrow(/origem de alfa/i);
    expect(() => parseOpExport({ ...base, sendSchedule: 'sem formato aqui;123' })).toThrow(/agenda de envio inválida/i);
    expect(() => parseOpExport({ ...base, groups: [{ nome: 'G', papel: 'origem', coords: ['1|2|3'] }] })).toThrow(
      /coords do grupo "G"/i,
    );
  });

  it('origem VAZIA é aceita (formato que o próprio export do app produz — arquivo da OP não guarda origem)', () => {
    const base = JSON.parse(serializeOpExport(input)) as Record<string, unknown>;
    const semOrigem = parseOpExport({
      ...base,
      distribution: [
        { playerName: 'alfa', origin: '', target: '450|450' },
        { playerName: 'bravo', target: '451|449' },
      ],
    });
    expect(semOrigem.distribution[0]!.origin).toBe('');
    expect(semOrigem.distribution[1]!.origin).toBe('');
    expect(semOrigem.distribution[0]!.target).toBe('450|450');
  });
});
