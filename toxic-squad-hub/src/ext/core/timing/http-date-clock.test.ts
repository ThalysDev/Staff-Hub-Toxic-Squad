import { describe, expect, it } from 'vitest';
import {
  calibrationSchedule,
  dateSampleInterval,
  estimateDateClock,
  frameShiftMs,
  marzullo,
  nextBisectionSendAt,
  type DateHeaderSample,
} from './http-date-clock';

/** Simula uma amostra: servidor adiantado `offset`, RTT simétrico. */
function simulate(offset: number, sentAtMs: number, rtt: number): DateHeaderSample {
  const serverAtMid = sentAtMs + rtt / 2 + offset;
  return { sentAtMs, receivedAtMs: sentAtMs + rtt, dateHeaderMs: Math.floor(serverAtMid / 1000) * 1000 };
}

describe('dateSampleInterval', () => {
  it('limita o offset por [D − t1, D + 1000 − t0]', () => {
    expect(dateSampleInterval({ sentAtMs: 1_000, receivedAtMs: 1_100, dateHeaderMs: 5_000 })).toEqual({
      lo: 3_900,
      hi: 5_000,
    });
  });
  it('recusa RTT negativo, gigante ou números inválidos', () => {
    expect(dateSampleInterval({ sentAtMs: 10, receivedAtMs: 5, dateHeaderMs: 0 })).toBeNull();
    expect(dateSampleInterval({ sentAtMs: 0, receivedAtMs: 10_000, dateHeaderMs: 0 })).toBeNull();
    expect(dateSampleInterval({ sentAtMs: Number.NaN, receivedAtMs: 5, dateHeaderMs: 0 })).toBeNull();
  });
});

describe('marzullo', () => {
  it('acha a região de maior consenso ignorando o intervalo discordante', () => {
    const region = marzullo([
      { lo: 0, hi: 10 },
      { lo: 5, hi: 15 },
      { lo: 8, hi: 20 },
      { lo: 100, hi: 110 },
    ]);
    expect(region).toEqual({ lo: 8, hi: 10, count: 3 });
  });
  it('lista vazia → null', () => {
    expect(marzullo([])).toBeNull();
  });
});

describe('estimateDateClock', () => {
  it('converge para o offset real com amostras em fases variadas (erro < RTT)', () => {
    const offset = 1_337;
    const rtt = 60;
    const samples = calibrationSchedule(8).map((delay) => simulate(offset, 1_000_000 + delay, rtt));
    const estimate = estimateDateClock(samples);
    expect(estimate).not.toBeNull();
    // O offset real SEMPRE cai dentro da região de consenso (erro ≤ ±meia-largura).
    expect(Math.abs((estimate?.offsetMs ?? 0) - offset)).toBeLessThanOrEqual(estimate?.halfWidthMs ?? 0);
    expect(estimate?.halfWidthMs ?? 9_999).toBeLessThanOrEqual(200);
    expect(estimate?.rttMedianMs).toBe(rtt);
  });
  it('uma amostra absurda não derruba o consenso', () => {
    const offset = -420;
    const samples = calibrationSchedule(7).map((delay) => simulate(offset, 2_000_000 + delay, 40));
    samples.push({ sentAtMs: 2_010_000, receivedAtMs: 2_010_040, dateHeaderMs: 9_999_000 });
    const estimate = estimateDateClock(samples);
    expect(Math.abs((estimate?.offsetMs ?? 0) - offset)).toBeLessThanOrEqual(estimate?.halfWidthMs ?? 0);
    expect(estimate?.agreeing).toBe(7);
    expect(estimate?.total).toBe(8);
  });
  it('sem amostras válidas → null', () => {
    expect(estimateDateClock([])).toBeNull();
  });
});

describe('frameShiftMs', () => {
  it('arredonda o fuso a 15 min', () => {
    expect(frameShiftMs(10_000_000 - 3 * 3_600_000 + 400, 10_000_000)).toBe(-3 * 3_600_000);
    expect(frameShiftMs(10_000_000 + 1_200, 10_000_000)).toBe(0);
  });
  it('recusa divergência fora da tolerância', () => {
    expect(frameShiftMs(10_000_000 + 7 * 60_000, 10_000_000)).toBeNull();
  });
});

describe('calibrationSchedule', () => {
  it('respeita o gap mínimo e espalha as fases', () => {
    const delays = calibrationSchedule(5, 250);
    expect(delays[0]).toBe(0);
    for (let i = 1; i < delays.length; i += 1) {
      expect((delays[i] ?? 0) - (delays[i - 1] ?? 0)).toBeGreaterThanOrEqual(250);
    }
    expect(new Set(delays.map((d) => d % 1000)).size).toBe(delays.length);
  });
});

describe('nextBisectionSendAt (bissecção da virada de segundo)', () => {
  it('mira a próxima virada de segundo do servidor respeitando o atraso mínimo', () => {
    const t = nextBisectionSendAt({ nowLocalMs: 10_000, offsetMs: 1_337, rttMs: 60, minDelayMs: 250 });
    expect(t).toBeGreaterThanOrEqual(10_250);
    // no meio do round-trip o servidor (estimado) marca um múltiplo de 1000
    expect((t + 30 + 1_337) % 1000).toBe(0);
  });
  it('bissecção converge muito abaixo do RTT com poucas amostras', () => {
    const trueOffset = 1_337.4;
    const rtt = 40;
    const simulate = (sentAtMs: number): DateHeaderSample => ({
      sentAtMs,
      receivedAtMs: sentAtMs + rtt,
      dateHeaderMs: Math.floor((sentAtMs + rtt / 2 + trueOffset) / 1000) * 1000,
    });
    const samples = calibrationSchedule(4).map((d) => simulate(1_000_000 + d));
    let now = 1_000_000 + 2_000;
    for (let i = 0; i < 8; i += 1) {
      const est = estimateDateClock(samples);
      const at = nextBisectionSendAt({ nowLocalMs: now, offsetMs: est?.offsetMs ?? 0, rttMs: rtt });
      samples.push(simulate(at));
      now = at + rtt;
    }
    const final = estimateDateClock(samples);
    expect(Math.abs((final?.offsetMs ?? 0) - trueOffset)).toBeLessThanOrEqual((final?.halfWidthMs ?? 0) + 1);
    expect(final?.halfWidthMs ?? 999).toBeLessThanOrEqual(rtt);
  });
});
