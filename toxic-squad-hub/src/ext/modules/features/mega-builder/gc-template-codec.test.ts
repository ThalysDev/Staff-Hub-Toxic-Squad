import { describe, expect, it } from 'vitest';
import { decodeGcTemplate, toGcTemplateModel } from './gc-template-codec';

/** Codificador base64 canônico puro para montar vetores binários (sem Buffer, sem atob/btoa). */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64 = (bytes: readonly number[]): string => {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += ALPHABET[first >> 2]!;
    encoded += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)]!;
    encoded += second === undefined ? '=' : ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]!;
    encoded += third === undefined ? '=' : ALPHABET[third & 0x3f]!;
  }
  return encoded;
};

describe('GcTemplateCodec decodificador de template GC', () => {
  it('decodifica o literal recuperado independente pela superfície pública', () => {
    expect(decodeGcTemplate('AAAAAQUA9ICAgE0xAAAAAAA=')).toEqual({
      name: 'M1',
      orderedSteps: [{ buildingId: 'main', targetLevel: 1 }],
      farmPriority: { enabled: true, thresholdPercent: 5 },
    });
  });

  it('falha fechado com erros estáveis para entrada malformada e oversized', () => {
    const atLimit = [0, 0, 0, 1, 5, 0, 244, 128, 128, 128, 77, ...new Array(2_037).fill(0)];
    expect(atLimit).toHaveLength(2_048);
    expect(() => decodeGcTemplate(base64(atLimit))).not.toThrow();
    expect(() => decodeGcTemplate('not base64!')).toThrow(/GC_BASE64_INVALID/);
    expect(() => decodeGcTemplate('A'.repeat(2_733))).toThrow(/GC_INPUT_TOO_LARGE/);
    expect(() => decodeGcTemplate(base64(new Array(2_049).fill(0)))).toThrow(/GC_INPUT_TOO_LARGE/);
    expect(() => decodeGcTemplate(base64([0, 0, 0, 1, 5, 0]))).toThrow(/GC_MARKER_MISSING/);
    expect(() => decodeGcTemplate(base64([0, 0, 99, 1, 5, 0, 244, 128, 128, 128, 77, 0, 0, 0, 0, 0]))).toThrow(
      /GC_NO_VALID_STEPS/,
    );
  });

  it('preserva semânticas recuperadas de último marcador, truncamento, par inválido, trailer e acumulação', () => {
    const decoded = decodeGcTemplate(
      base64([
        0, 0, 0, 20, 99, 1, 1, 30, 7, 0, 244, 128, 128, 128, 88, 0, 0, 7, 0, 244, 128, 128, 128, 77, 50, 0, 0, 0, 0, 0,
      ]),
    );
    expect(decoded).toEqual({
      name: 'M2',
      orderedSteps: [{ buildingId: 'main', targetLevel: 20 }],
      farmPriority: { enabled: true, thresholdPercent: 5 },
    });

    const cumulative = decodeGcTemplate(base64([0, 0, 0, 20, 0, 20, 5, 0, 244, 128, 128, 128, 77, 0, 0, 0, 0, 0]));
    expect(cumulative.orderedSteps).toEqual([
      { buildingId: 'main', targetLevel: 20 },
      { buildingId: 'main', targetLevel: 40 },
    ]);
    expect(() => toGcTemplateModel(cumulative, 'model_cumulative-0001')).toThrow(/MODEL_OUT_OF_BOUNDS/);
    expect(
      decodeGcTemplate(base64([0, 0, 0, 1, 18, 5, 0, 244, 128, 128, 128, 84, 0, 0, 0, 0, 0])).orderedSteps,
    ).toEqual([{ buildingId: 'main', targetLevel: 1 }]);
  });

  it('converte o modelo decodificado válido pelo contrato Zod', () => {
    const model = toGcTemplateModel(decodeGcTemplate('AAAAAQUA9ICAgE0xAAAAAAA='), 'model_primary-0001');
    expect(model).toEqual({
      modelId: 'model_primary-0001',
      name: 'M1',
      orderedSteps: [{ buildingId: 'main', targetLevel: 1 }],
      farmPriority: { enabled: true, thresholdPercent: 5 },
    });
  });

  it('normaliza limiar de fazenda fora do conjunto permitido para 5 e preserva os aceitos', () => {
    // limiar cru = 7 (byte anterior ao marcador) → padrão 5
    expect(decodeGcTemplate(base64([0, 0, 0, 5, 7, 0, 244, 128, 128, 128, 65, 0, 0, 0, 0, 0])).farmPriority).toEqual({
      enabled: true,
      thresholdPercent: 5,
    });
    // limiar cru = 20 (aceito) → preservado
    expect(decodeGcTemplate(base64([0, 0, 0, 5, 20, 0, 244, 128, 128, 128, 65, 0, 0, 0, 0, 0])).farmPriority).toEqual({
      enabled: true,
      thresholdPercent: 20,
    });
  });

  it('sanitiza o nome para a faixa imprimível ASCII', () => {
    // bytes do nome: 0x01 (controle), 0x7f (DEL), 'A', 'B' → sobram 'AB'
    expect(
      decodeGcTemplate(base64([0, 0, 0, 5, 5, 0, 244, 128, 128, 128, 0x01, 0x7f, 0x41, 0x42, 0, 0, 0, 0, 0])).name,
    ).toBe('AB');
  });
});
