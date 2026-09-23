import { describe, expect, it } from 'vitest';
import {
  NOBLE_TRAIN_ALGORITHM_VERSION,
  NOBLE_TRAIN_DEFAULT_GAP_MS,
  NOBLE_TRAIN_MIN_GAP_MS,
  nobleTrainInputSchema,
  planNobleTrain,
  validateNobleTrain,
  type NobleTrainInput,
  type NobleTrainSize,
} from './noble-train-planner';

function train(overrides: Partial<NobleTrainInput> = {}): NobleTrainInput {
  return {
    trainSize: 3,
    gapMs: 300,
    noblesAvailable: 2,
    allowLoneSnob: false,
    autoSplitExtraNobles: true,
    ...overrides,
  };
}

const offsets = (input: NobleTrainInput): number[] =>
  planNobleTrain(input).slots.map((slot) => slot.arrivalOffsetMs);
const nobles = (input: NobleTrainInput): number[] => planNobleTrain(input).slots.map((slot) => slot.nobles);

describe('planNobleTrain', () => {
  it('trem de 2: limpa no slot 0 e 1 nobre no slot 1, separados pelo gap', () => {
    const plan = planNobleTrain(train({ trainSize: 2, gapMs: 300, noblesAvailable: 1 }));

    expect(plan.version).toBe(NOBLE_TRAIN_ALGORITHM_VERSION);
    expect(plan.slots).toEqual([
      { slotIndex: 0, arrivalOffsetMs: 0, nobles: 0 },
      { slotIndex: 1, arrivalOffsetMs: 300, nobles: 1 },
    ]);
    expect(plan.totalNobles).toBe(1);
    expect(plan.spanMs).toBe(300);
  });

  it('trem de 3: offsets 0, gap e 2*gap', () => {
    const plan = planNobleTrain(train({ trainSize: 3, gapMs: 300, noblesAvailable: 2 }));

    expect(offsets(train({ trainSize: 3, gapMs: 300, noblesAvailable: 2 }))).toEqual([0, 300, 600]);
    expect(nobles(train({ trainSize: 3, gapMs: 300, noblesAvailable: 2 }))).toEqual([0, 1, 1]);
    expect(plan.totalNobles).toBe(2);
    expect(plan.spanMs).toBe(600);
  });

  it('trem de 5: offsets 0..4*gap com gap calibrado de 250 ms', () => {
    const input = train({ trainSize: 5, gapMs: 250, noblesAvailable: 4 });
    const plan = planNobleTrain(input);

    expect(plan.slots.map((slot) => slot.slotIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(offsets(input)).toEqual([0, 250, 500, 750, 1000]);
    expect(nobles(input)).toEqual([0, 1, 1, 1, 1]);
    expect(plan.totalNobles).toBe(4);
    expect(plan.spanMs).toBe(1000);
  });

  it('slot 0 é sempre a limpa: nenhum nobre, offset zero, em todos os tamanhos', () => {
    for (const trainSize of [2, 3, 4, 5] as const) {
      const plan = planNobleTrain(train({ trainSize, noblesAvailable: trainSize + 3 }));
      expect(plan.slots[0], `tamanho ${trainSize}`).toEqual({ slotIndex: 0, arrivalOffsetMs: 0, nobles: 0 });
      expect(plan.slots.length).toBe(trainSize);
    }
  });

  it('split exato: um nobre por slot de nobre quando não há excedente', () => {
    const plan = planNobleTrain(train({ trainSize: 5, noblesAvailable: 4, autoSplitExtraNobles: true }));

    expect(plan.slots.map((slot) => slot.nobles)).toEqual([0, 1, 1, 1, 1]);
    expect(plan.totalNobles).toBe(4);
  });

  it('excedente com auto-split vai para os ÚLTIMOS slots, nunca para a limpa', () => {
    const plan = planNobleTrain(train({ trainSize: 5, noblesAvailable: 6, autoSplitExtraNobles: true }));

    expect(plan.slots.map((slot) => slot.nobles)).toEqual([0, 1, 1, 2, 2]);
    expect(plan.totalNobles).toBe(6);
  });

  it('excedente maior que o trem com auto-split cicla do último slot para trás', () => {
    const plan = planNobleTrain(train({ trainSize: 3, noblesAvailable: 6, autoSplitExtraNobles: true }));

    expect(plan.slots.map((slot) => slot.nobles)).toEqual([0, 3, 3]);
    expect(plan.totalNobles).toBe(6);
  });

  it('sem auto-split o excedente fica de fora e o trem segue válido', () => {
    const plan = planNobleTrain(train({ trainSize: 3, noblesAvailable: 5, autoSplitExtraNobles: false }));

    expect(plan.slots.map((slot) => slot.nobles)).toEqual([0, 1, 1]);
    expect(plan.totalNobles).toBe(2);
  });

  it('sem auto-split e sem nobres suficientes é erro de validação (fail-closed)', () => {
    const input = train({ trainSize: 4, noblesAvailable: 2, autoSplitExtraNobles: false, allowLoneSnob: false });

    expect(validateNobleTrain(input)).toMatch(/Nobres insuficientes na origem/);
    expect(() => planNobleTrain(input)).toThrow(/Nobres insuficientes na origem/);
  });

  it('allowLoneSnob aceita trem incompleto preenchendo os primeiros slots de nobre', () => {
    const input = train({ trainSize: 5, noblesAvailable: 2, allowLoneSnob: true });

    expect(validateNobleTrain(input)).toBeNull();
    expect(planNobleTrain(input).slots.map((slot) => slot.nobles)).toEqual([0, 1, 1, 0, 0]);
    expect(planNobleTrain(input).totalNobles).toBe(2);
  });

  it('allowLoneSnob sem nenhum nobre na origem continua erro', () => {
    const input = train({ trainSize: 3, noblesAvailable: 0, allowLoneSnob: true });

    expect(validateNobleTrain(input)).toMatch(/Nobres insuficientes na origem/);
    expect(() => planNobleTrain(input)).toThrow(/Nobres insuficientes na origem/);
  });

  it('spanMs é (trainSize-1)*gapMs e totalNobles soma os slots', () => {
    expect(planNobleTrain(train({ trainSize: 2, gapMs: 100, noblesAvailable: 1 })).spanMs).toBe(100);
    expect(planNobleTrain(train({ trainSize: 4, gapMs: 450, noblesAvailable: 3 })).spanMs).toBe(1350);
    expect(planNobleTrain(train({ trainSize: 5, gapMs: 1000, noblesAvailable: 9 })).spanMs).toBe(4000);
    expect(planNobleTrain(train({ trainSize: 4, gapMs: 300, noblesAvailable: 3 })).totalNobles).toBe(3);
    expect(planNobleTrain(train({ trainSize: 4, gapMs: 300, noblesAvailable: 8 })).totalNobles).toBe(8);
  });

  it('valida gap mínimo de 100 ms e recusa valores abaixo', () => {
    expect(validateNobleTrain(train({ gapMs: 99 }))).toMatch(/Gap entre chegadas inválido/);
    expect(validateNobleTrain(train({ gapMs: 0 }))).toMatch(/Gap entre chegadas inválido/);
    expect(validateNobleTrain(train({ gapMs: NOBLE_TRAIN_MIN_GAP_MS }))).toBeNull();
    expect(() => nobleTrainInputSchema.parse(train({ gapMs: 99 }))).toThrow();
    expect(planNobleTrain(train({ gapMs: NOBLE_TRAIN_MIN_GAP_MS })).slots[1]?.arrivalOffsetMs).toBe(100);
  });

  it('valida trainSize fora de 2..5 (6 é rejeitado no schema e na validação)', () => {
    const invalid = { ...train({ trainSize: 2, noblesAvailable: 5 }), trainSize: 6 as NobleTrainSize };

    expect(validateNobleTrain(invalid)).toMatch(/Tamanho de trem inválido/);
    expect(() => nobleTrainInputSchema.parse({ ...train(), trainSize: 6 })).toThrow();
    expect(() => nobleTrainInputSchema.parse({ ...train(), trainSize: 1 })).toThrow();
    expect(() => planNobleTrain(invalid)).toThrow();
  });

  it('schema zod rejeita nobres negativos, gap negativo e campos desconhecidos', () => {
    expect(() => nobleTrainInputSchema.parse(train({ noblesAvailable: -1 }))).toThrow();
    expect(() => nobleTrainInputSchema.parse(train({ gapMs: -300 }))).toThrow();
    expect(() => nobleTrainInputSchema.parse({ ...train(), extra: true })).toThrow();
  });

  it('schema zod aplica o gap padrão de 300 ms quando o chamador omite', () => {
    const parsed = nobleTrainInputSchema.parse({
      trainSize: 2,
      noblesAvailable: 1,
      allowLoneSnob: false,
      autoSplitExtraNobles: false,
    });

    expect(parsed.gapMs).toBe(NOBLE_TRAIN_DEFAULT_GAP_MS);
    expect(planNobleTrain(parsed).spanMs).toBe(NOBLE_TRAIN_DEFAULT_GAP_MS);
  });

  it('não muta a entrada e devolve plano congelado em profundidade', () => {
    const input: NobleTrainInput = Object.freeze({
      trainSize: 5,
      gapMs: 300,
      noblesAvailable: 7,
      allowLoneSnob: false,
      autoSplitExtraNobles: true,
    });

    const plan = planNobleTrain(input);

    expect(input).toEqual({
      trainSize: 5,
      gapMs: 300,
      noblesAvailable: 7,
      allowLoneSnob: false,
      autoSplitExtraNobles: true,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.slots)).toBe(true);
    expect(plan.slots.every((slot) => Object.isFrozen(slot))).toBe(true);
    expect(planNobleTrain(train({ trainSize: 5, noblesAvailable: 7 }))).toEqual(plan);
  });
});
