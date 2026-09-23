import { describe, expect, it } from 'vitest';
import {
  CLOCK_CONFIDENCE_MIN_SAMPLES,
  DEFAULT_ADAPTIVE_CLOCK_CONFIG,
  DEFAULT_MAX_RTT_MS,
  clockConfidence,
  ingestSample,
  initialAdaptiveClockState,
  masterNow,
  needsCalibration,
  sampleOffsetMs,
  type AdaptiveClockConfig,
  type AdaptiveClockState,
  type ClockSample,
} from './adaptive-clock';

/** Amostra com offset bruto conhecido: o carimbo do servidor fica no meio do RTT + offset. */
function sample(sentAtMs: number, rttMs: number, rawOffsetMs: number): ClockSample {
  const receivedAtMs = sentAtMs + rttMs;
  return { sentAtMs, receivedAtMs, serverMs: (sentAtMs + receivedAtMs) / 2 + rawOffsetMs };
}

function config(overrides: Partial<AdaptiveClockConfig> = {}): AdaptiveClockConfig {
  return { ...DEFAULT_ADAPTIVE_CLOCK_CONFIG, ...overrides };
}

/** Ingere `count` amostras (t0 = 1s apart) com o mesmo offset bruto e RTT curto. */
function feed(
  state: AdaptiveClockState,
  count: number,
  rawOffsetMs: number,
  cfg: AdaptiveClockConfig,
  startSentAtMs = 1_000,
): AdaptiveClockState {
  let next = state;
  for (let index = 0; index < count; index += 1) {
    next = ingestSample(next, sample(startSentAtMs + index * 1_000, 200, rawOffsetMs), cfg);
  }
  return next;
}

describe('relógio adaptativo — offset por amostra', () => {
  it('offset exato com RTT simétrico: carimbo no meio do round-trip', () => {
    // Servidor 250ms à frente; RTT 200ms com ida e volta iguais.
    expect(sampleOffsetMs(sample(1_000, 200, 250))).toBe(250);
    expect(sampleOffsetMs(sample(0, 200, 0))).toBe(0);
  });

  it('assimetria de RTT dá o offset do meio (não das pontas)', () => {
    // Carimbo do servidor tirado no t0: o motor assume o meio e erra -500ms.
    expect(sampleOffsetMs({ sentAtMs: 0, receivedAtMs: 1_000, serverMs: 700 })).toBe(200);
    // Carimbo tirado no t1: erra +500ms no outro sentido.
    expect(sampleOffsetMs({ sentAtMs: 0, receivedAtMs: 1_000, serverMs: 1_200 })).toBe(700);
  });

  it('config default do módulo: responsivo, janelas 8/30 e trim 0.2', () => {
    expect(DEFAULT_ADAPTIVE_CLOCK_CONFIG.strategy).toBe('responsivo');
    expect(DEFAULT_ADAPTIVE_CLOCK_CONFIG.windowResponsivo).toBe(8);
    expect(DEFAULT_ADAPTIVE_CLOCK_CONFIG.windowEstavel).toBe(30);
    expect(DEFAULT_ADAPTIVE_CLOCK_CONFIG.trimRatio).toBe(0.2);
    expect(DEFAULT_ADAPTIVE_CLOCK_CONFIG.maxRttMs).toBe(DEFAULT_MAX_RTT_MS);
    expect(DEFAULT_MAX_RTT_MS).toBe(10_000);
  });

  it('estado inicial parte do offset base com janela vazia e sem correção', () => {
    const state = initialAdaptiveClockState(1_234);
    expect(state.offsetMs).toBe(1_234);
    expect(state.samples).toEqual([]);
    expect(state.lastCorrectionMs).toBe(0);
    expect(initialAdaptiveClockState(Number.NaN).offsetMs).toBe(0);
  });
});

describe('relógio adaptativo — ingestão de amostras', () => {
  it('converge para o offset real na primeira amostra quando cabe no clamp', () => {
    const next = ingestSample(initialAdaptiveClockState(0), sample(1_000, 200, 250), config());
    expect(next.offsetMs).toBe(250);
    expect(next.lastCorrectionMs).toBe(250);
    expect(next.samples).toHaveLength(1);
  });

  it('descarta amostra com RTT acima do teto e devolve o MESMO estado', () => {
    const state = feed(initialAdaptiveClockState(0), 3, 250, config());
    expect(ingestSample(state, sample(9_000, 10_001, 250), config())).toBe(state);
    // No teto exato ainda entra.
    expect(ingestSample(state, sample(9_000, 10_000, 250), config()).samples).toHaveLength(4);
  });

  it('descarta amostra com RTT negativo, não finito ou serverMs inválido', () => {
    const state = feed(initialAdaptiveClockState(0), 3, 250, config());
    expect(ingestSample(state, { sentAtMs: 2_000, receivedAtMs: 1_000, serverMs: 2_250 }, config())).toBe(state);
    expect(
      ingestSample(state, { sentAtMs: 2_000, receivedAtMs: Number.POSITIVE_INFINITY, serverMs: 2_250 }, config()),
    ).toBe(state);
    expect(ingestSample(state, { sentAtMs: 2_000, receivedAtMs: 2_200, serverMs: Number.NaN }, config())).toBe(state);
  });

  it('respeita o teto de RTT configurado', () => {
    const cfg = config({ maxRttMs: 500 });
    const state = initialAdaptiveClockState(0);
    expect(ingestSample(state, sample(1_000, 700, 250), cfg)).toBe(state);
    expect(ingestSample(state, sample(1_000, 400, 250), cfg).samples).toHaveLength(1);
  });

  it('clamp de maxCorrection limita o salto e converge em passos', () => {
    const cfg = config({ maxCorrectionMs: 300 });
    let state = initialAdaptiveClockState(0);
    state = ingestSample(state, sample(1_000, 200, 5_000), cfg);
    expect(state.offsetMs).toBe(300);
    expect(state.lastCorrectionMs).toBe(300);

    state = feed(state, 15, 5_000, cfg, 2_000);
    // 15 passos de 300ms sobre o passo inicial: 300 * 16 = 4800 (ainda no teto).
    expect(state.offsetMs).toBe(4_800);
    expect(state.lastCorrectionMs).toBe(300);

    state = feed(state, 1, 5_000, cfg, 30_000);
    expect(state.offsetMs).toBe(5_000);
    expect(state.lastCorrectionMs).toBe(200);
  });

  it('clampa o próprio maxCorrectionMs na faixa 300..5000', () => {
    const baixo = config({ maxCorrectionMs: 50 });
    expect(ingestSample(initialAdaptiveClockState(0), sample(1_000, 200, 5_000), baixo).offsetMs).toBe(300);

    const alto = config({ maxCorrectionMs: 99_999 });
    expect(ingestSample(initialAdaptiveClockState(0), sample(1_000, 200, 1_000_000), alto).offsetMs).toBe(5_000);

    const naoFinito = config({ maxCorrectionMs: Number.NaN });
    expect(ingestSample(initialAdaptiveClockState(0), sample(1_000, 200, 100_000), naoFinito).offsetMs).toBe(1_000);
  });

  it('com a janela cheia o offset é a mediana aparada dos offsets brutos', () => {
    const cfg = config({ maxCorrectionMs: 5_000 });
    let state = initialAdaptiveClockState(0);
    const offsets = [100, 200, 300, 400, 500, 600, 700, 900];
    offsets.forEach((rawOffset, index) => {
      state = ingestSample(state, sample(1_000 + index * 1_000, 200, rawOffset), cfg);
    });
    // 8 amostras, corte de 1 por ponta: miolo [200..700] → mediana (400+500)/2.
    expect(state.offsetMs).toBe(450);
    expect(state.samples).toHaveLength(8);
  });

  it('outlier absurdo em janela cheia não move o offset', () => {
    const cfg = config({ maxCorrectionMs: 1_000 });
    let state = feed(initialAdaptiveClockState(0), 7, 1_000, cfg);
    expect(state.offsetMs).toBe(1_000);
    state = ingestSample(state, sample(20_000, 200, 10_000_000), cfg);
    expect(state.offsetMs).toBe(1_000);
    expect(state.lastCorrectionMs).toBe(0);
  });

  it('outlier em janela curta não muda além do clamp', () => {
    const cfg = config({ maxCorrectionMs: 1_000 });
    let state = ingestSample(initialAdaptiveClockState(1_000), sample(1_000, 200, 1_000), cfg);
    expect(state.offsetMs).toBe(1_000);
    state = ingestSample(state, sample(2_000, 200, 10_000_000), cfg);
    expect(Math.abs(state.lastCorrectionMs)).toBeLessThanOrEqual(1_000);
    expect(state.offsetMs).toBe(2_000);
  });

  it('ring buffer respeita a janela de cada estratégia', () => {
    const responsivo = feed(initialAdaptiveClockState(0), 12, 0, config({ strategy: 'responsivo' }));
    expect(responsivo.samples).toHaveLength(8);
    expect(responsivo.samples[0]?.sentAtMs).toBe(5_000);
    expect(responsivo.samples.at(-1)?.sentAtMs).toBe(12_000);

    const estavel = feed(initialAdaptiveClockState(0), 35, 0, config({ strategy: 'estavel' }));
    expect(estavel.samples).toHaveLength(30);
    expect(estavel.samples[0]?.sentAtMs).toBe(6_000);
    expect(estavel.samples.at(-1)?.sentAtMs).toBe(35_000);
  });

  it('estratégia responsiva adere mais rápido que a estável após mudança de offset', () => {
    const responsivoCfg = config({ strategy: 'responsivo', maxCorrectionMs: 5_000 });
    const estavelCfg = config({ strategy: 'estavel', maxCorrectionMs: 5_000 });
    const responsivo = feed(feed(initialAdaptiveClockState(0), 30, 0, responsivoCfg), 8, 1_500, responsivoCfg, 40_000);
    const estavel = feed(feed(initialAdaptiveClockState(0), 30, 0, estavelCfg), 8, 1_500, estavelCfg, 40_000);

    const erroResponsivo = Math.abs(responsivo.offsetMs - 1_500);
    const erroEstavel = Math.abs(estavel.offsetMs - 1_500);
    expect(erroResponsivo).toBeLessThanOrEqual(100);
    expect(erroEstavel).toBeGreaterThan(500);
    expect(erroResponsivo).toBeLessThan(erroEstavel);
  });

  it('é puro: não muta o estado de entrada e é determinístico', () => {
    const cfg = config({ maxCorrectionMs: 5_000 });
    const base = feed(initialAdaptiveClockState(0), 3, 1_500, cfg);
    const snapshot = structuredClone(base);
    const next = ingestSample(base, sample(9_000, 200, 1_500), cfg);
    expect(base).toEqual(snapshot);
    expect(base.offsetMs).toBe(1_500);
    expect(next).not.toBe(base);

    const sequencia = (): AdaptiveClockState => {
      let state = initialAdaptiveClockState(0);
      for (const rawOffset of [900, 1_100, 1_000, 950, 1_050]) {
        state = ingestSample(state, sample(1_000 + rawOffset, 200, rawOffset), cfg);
      }
      return state;
    };
    expect(sequencia()).toEqual(sequencia());
  });
});

describe('relógio adaptativo — leitura e qualidade', () => {
  it('masterNow devolve o agora do servidor somando o offset', () => {
    const state: AdaptiveClockState = { samples: [], offsetMs: 1_500, lastCorrectionMs: 0 };
    expect(masterNow(state, 1_000_000)).toBe(1_001_500);
    expect(masterNow(initialAdaptiveClockState(-2_000), 1_000_000)).toBe(998_000);
  });

  it('confidence: baixa, media e alta conforme o preenchimento da janela', () => {
    const cfg = config({ strategy: 'responsivo' });
    expect(CLOCK_CONFIDENCE_MIN_SAMPLES).toBe(5);
    expect(clockConfidence(initialAdaptiveClockState(0), cfg)).toBe('baixa');
    expect(clockConfidence(feed(initialAdaptiveClockState(0), 4, 0, cfg), cfg)).toBe('baixa');
    expect(clockConfidence(feed(initialAdaptiveClockState(0), 5, 0, cfg), cfg)).toBe('media');
    expect(clockConfidence(feed(initialAdaptiveClockState(0), 7, 0, cfg), cfg)).toBe('media');
    expect(clockConfidence(feed(initialAdaptiveClockState(0), 8, 0, cfg), cfg)).toBe('alta');

    const estavelCfg = config({ strategy: 'estavel' });
    expect(clockConfidence(feed(initialAdaptiveClockState(0), 8, 0, estavelCfg), estavelCfg)).toBe('media');
    expect(clockConfidence(feed(initialAdaptiveClockState(0), 30, 0, estavelCfg), estavelCfg)).toBe('alta');
  });

  it('needsCalibration usa a última amostra aceita', () => {
    const cfg = config();
    expect(needsCalibration(initialAdaptiveClockState(0), 1_000, 60_000)).toBe(true);

    const state = feed(initialAdaptiveClockState(0), 2, 0, cfg);
    const lastReceived = state.samples.at(-1)?.receivedAtMs ?? 0;
    expect(needsCalibration(state, lastReceived, 60_000)).toBe(false);
    expect(needsCalibration(state, lastReceived + 59_999, 60_000)).toBe(false);
    expect(needsCalibration(state, lastReceived + 60_000, 60_000)).toBe(true);
    // Relógio local atrás da amostra não pede recalibração.
    expect(needsCalibration(state, lastReceived - 10_000, 60_000)).toBe(false);
  });

  it('amostra descartada não conta como calibração recente', () => {
    const cfg = config();
    const state = feed(initialAdaptiveClockState(0), 1, 0, cfg);
    const comDescarte = ingestSample(state, sample(50_000, 99_999, 0), cfg);
    expect(comDescarte).toBe(state);
    const lastReceived = state.samples.at(-1)?.receivedAtMs ?? 0;
    expect(needsCalibration(comDescarte, lastReceived + 60_000, 60_000)).toBe(true);
  });
});
