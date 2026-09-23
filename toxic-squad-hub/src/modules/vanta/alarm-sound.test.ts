// Testes da parte PURA do alarme sonoro (normalize do storage/UI). A síntese em
// si (Web Audio) não roda em node — é verificada no navegador pelo testAlarm().
import { describe, expect, it } from 'vitest';

import {
  ALARM_SOUNDS,
  ALARM_TRIGGERS,
  DEFAULT_ALARM_CONFIG,
  DEFAULT_ALARM_VOLUME,
  alarmConfigSchema,
  normalizeAlarmConfig,
} from './alarm-sound';

describe('normalizeAlarmConfig — lixo vira default (nunca lança)', () => {
  it('undefined/null/objeto vazio caem no default', () => {
    expect(normalizeAlarmConfig(undefined)).toEqual(DEFAULT_ALARM_CONFIG);
    expect(normalizeAlarmConfig(null)).toEqual(DEFAULT_ALARM_CONFIG);
    expect(normalizeAlarmConfig({})).toEqual(DEFAULT_ALARM_CONFIG);
  });

  it('tipo errado (string, número, booleano, array) cai no default', () => {
    for (const lixo of ['barulho', 42, true, [], ['sirene']]) {
      expect(normalizeAlarmConfig(lixo)).toEqual(DEFAULT_ALARM_CONFIG);
    }
  });

  it('campos com valor inválido caem no default DO CAMPO (sem perder os válidos)', () => {
    const cfg = normalizeAlarmConfig({ trigger: 'x', sound: 'sirene', volume: 'alto' });
    expect(cfg).toEqual({
      trigger: DEFAULT_ALARM_CONFIG.trigger,
      sound: 'sirene',
      volume: DEFAULT_ALARM_VOLUME,
    });
  });

  it('objeto parcial completa os campos ausentes com default', () => {
    expect(normalizeAlarmConfig({ sound: 'bip' })).toEqual({
      trigger: 'desligado',
      sound: 'bip',
      volume: DEFAULT_ALARM_VOLUME,
    });
  });
});

describe('normalizeAlarmConfig — volume clampado em 0..1', () => {
  it('acima de 1 vira 1 e abaixo de 0 vira 0', () => {
    expect(normalizeAlarmConfig({ volume: 5 }).volume).toBe(1);
    expect(normalizeAlarmConfig({ volume: 1e9 }).volume).toBe(1);
    expect(normalizeAlarmConfig({ volume: -3 }).volume).toBe(0);
    expect(normalizeAlarmConfig({ volume: -0.001 }).volume).toBe(0);
  });

  it('valores dentro da faixa passam intactos (0 é válido, não é "ausente")', () => {
    expect(normalizeAlarmConfig({ volume: 0 }).volume).toBe(0);
    expect(normalizeAlarmConfig({ volume: 0.35 }).volume).toBe(0.35);
    expect(normalizeAlarmConfig({ volume: 1 }).volume).toBe(1);
  });

  it('NaN cai no default (número não finito não é volume)', () => {
    expect(normalizeAlarmConfig({ volume: Number.NaN }).volume).toBe(DEFAULT_ALARM_VOLUME);
  });
});

describe('normalizeAlarmConfig — trigger e som válidos sobrevivem', () => {
  it('todos os sons e gatilhos conhecidos passam', () => {
    for (const sound of ALARM_SOUNDS) {
      for (const trigger of ALARM_TRIGGERS) {
        const cfg = normalizeAlarmConfig({ trigger, sound, volume: 0.5 });
        expect(cfg).toEqual({ trigger, sound, volume: 0.5 });
      }
    }
  });

  it("trigger 'desligado' (falsy de intenção) é preservado", () => {
    expect(normalizeAlarmConfig({ trigger: 'desligado', sound: 'sirene', volume: 0.2 })).toEqual({
      trigger: 'desligado',
      sound: 'sirene',
      volume: 0.2,
    });
  });
});

describe('alarmConfigSchema (cru) — rejeita lixo; o normalize é a camada tolerante', () => {
  it('entrada que não é objeto falha no schema cru', () => {
    expect(alarmConfigSchema.safeParse('nada').success).toBe(false);
    expect(alarmConfigSchema.safeParse(null).success).toBe(false);
  });

  it('campo inválido é absorvido por campo (catch), sem derrubar os válidos', () => {
    const cru = { trigger: 'nobre_ariete', sound: 'trovão', volume: 88 };
    expect(alarmConfigSchema.parse(cru)).toEqual({
      trigger: 'nobre_ariete',
      sound: DEFAULT_ALARM_CONFIG.sound,
      volume: 88, // o schema só valida; o clamp 0..1 é do normalize
    });
    expect(normalizeAlarmConfig(cru)).toEqual({
      trigger: 'nobre_ariete',
      sound: DEFAULT_ALARM_CONFIG.sound,
      volume: 1,
    });
  });
});
