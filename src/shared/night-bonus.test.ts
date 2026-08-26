import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isNightBonusHour, solveDepartureForArrival, travelTimeMs } from './night-bonus';
import { parseWorldConfigXml, type WorldConfig } from './world-config';

// Config derivada do get_config REAL do BR142 (fixture obrigatória):
// <night><active>1</active><start_hour>23</start_hour><end_hour>7</end_hour>...
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/br142/${name}`, import.meta.url)), 'utf8');
}

const BR142: WorldConfig = parseWorldConfigXml('br142', fixture('world-config-xml.html'));
/** Janela NORMAL (não cruza meia-noite) só para exercitar os dois ramos. */
const JANELA_13_AS_18: Pick<WorldConfig, 'nightBonusActive' | 'nightStartHour' | 'nightEndHour'> = {
  nightBonusActive: true,
  nightStartHour: 13,
  nightEndHour: 18,
};
const SEM_BONUS: Pick<WorldConfig, 'nightBonusActive' | 'nightStartHour' | 'nightEndHour'> = {
  nightBonusActive: false,
  nightStartHour: 0,
  nightEndHour: 0,
};

describe('isNightBonusHour', () => {
  it('bônus desligado → nunca é hora noturna', () => {
    expect(isNightBonusHour(3, SEM_BONUS)).toBe(false);
    expect(isNightBonusHour(23.5, SEM_BONUS)).toBe(false);
  });

  it('janela que cruza a meia-noite (BR142 real 23→7): [23,24[ ∪ [0,7[', () => {
    expect(isNightBonusHour(23, BR142)).toBe(true);
    expect(isNightBonusHour(0, BR142)).toBe(true);
    expect(isNightBonusHour(6.99, BR142)).toBe(true);
    expect(isNightBonusHour(7, BR142)).toBe(false);
    expect(isNightBonusHour(12, BR142)).toBe(false);
    expect(isNightBonusHour(22.5, BR142)).toBe(false);
  });

  it('janela normal (13→18): [13,18[', () => {
    expect(isNightBonusHour(12.999, JANELA_13_AS_18)).toBe(false);
    expect(isNightBonusHour(13, JANELA_13_AS_18)).toBe(true);
    expect(isNightBonusHour(17.5, JANELA_13_AS_18)).toBe(true);
    expect(isNightBonusHour(18, JANELA_13_AS_18)).toBe(false);
  });

  it('janela nula (start === end) nunca dispara', () => {
    expect(isNightBonusHour(3, { nightBonusActive: true, nightStartHour: 7, nightEndHour: 7 })).toBe(false);
  });
});

describe('travelTimeMs', () => {
  it('(a) sem bônus → tempo clássico idêntico (distância × minutos/campo)', () => {
    const classic = 10 * 35 * 60_000;
    expect(travelTimeMs({ distanceFields: 10, minutesPerField: 35, departureAt: new Date('2026-08-26T02:00:00'), cfg: SEM_BONUS })).toBe(
      classic,
    );
    // Mesmo com horas configuradas, basta o bônus estar desligado.
    expect(travelTimeMs({ distanceFields: 10, minutesPerField: 35, departureAt: new Date('2026-08-26T02:00:00'), cfg: { ...BR142, nightBonusActive: false } })).toBe(
      classic,
    );
    // Timestamp numérico é aceito como partida.
    expect(travelTimeMs({ distanceFields: 10, minutesPerField: 35, departureAt: new Date('2026-08-26T02:00:00').getTime(), cfg: SEM_BONUS })).toBe(
      classic,
    );
  });

  it('(b) partida e chegada 100% dentro da janela (02:00, BR142 23→7) → exatamente 2x', () => {
    // Viagem clássica de 2h saindo às 02:00: dobrada vira 4h e chega às 06:00,
    // ainda dentro da janela noturna (termina antes das 07:00).
    const classic = 4 * 30 * 60_000; // 2h
    const travel = travelTimeMs({
      distanceFields: 4,
      minutesPerField: 30,
      departureAt: new Date('2026-08-26T02:00:00'),
      cfg: BR142,
    });
    expect(travel).toBe(classic * 2);
  });

  it('(c) saída da janela no meio da viagem: entre 1x e 2x e bate com cálculo manual', () => {
    // Cálculo manual (janela real BR142 23→7, partida às 05:00):
    //   05:00→07:00 noturno = 2h de relógio = apenas 1h de progresso diurno;
    //   restam 2h de progresso diurno, feitas em regime normal = 2h de relógio.
    //   Total: 4h de relógio para uma viagem clássica de 3h (razão 4/3).
    const classic = 6 * 30 * 60_000; // 3h
    const travel = travelTimeMs({
      distanceFields: 6,
      minutesPerField: 30,
      departureAt: new Date('2026-08-26T05:00:00'),
      cfg: BR142,
    });
    expect(travel).toBeGreaterThan(classic);
    expect(travel).toBeLessThan(classic * 2);
    expect(travel).toBe(4 * 60 * 60_000);
  });

  it('(d) janela cruzando a meia-noite: partida 22:00 atravessa a virada do dia', () => {
    // Cálculo manual (BR142 23→7, partida às 22:00):
    //   22:00→23:00 diurno = 1h de progresso (restam 4,5h diurnas);
    //   23:00→07:00 noturno = 8h de relógio = 4h de progresso (restam 0,5h);
    //   07:00→07:30 diurno = 0,5h. Total 9,5h para 5,5h clássicas.
    const classic = 11 * 30 * 60_000; // 5,5h
    const travel = travelTimeMs({
      distanceFields: 11,
      minutesPerField: 30,
      departureAt: new Date('2026-08-26T22:00:00'),
      cfg: BR142,
    });
    expect(travel).toBeGreaterThan(classic);
    expect(travel).toBeLessThan(classic * 2);
    expect(travel).toBe(9.5 * 60 * 60_000);
  });

  it('(e) entradas inválidas lançam erro claro em PT-BR', () => {
    const base = { distanceFields: 10, minutesPerField: 30, departureAt: new Date('2026-08-26T02:00:00'), cfg: BR142 };
    expect(() => travelTimeMs({ ...base, distanceFields: -1 })).toThrow(/Distância em campos deve ser um número maior ou igual a zero/);
    expect(() => travelTimeMs({ ...base, distanceFields: Number.NaN })).toThrow(/Distância em campos/);
    expect(() => travelTimeMs({ ...base, minutesPerField: 0 })).toThrow(/Minutos por campo deve ser um número maior que zero/);
    expect(() => travelTimeMs({ ...base, minutesPerField: -5 })).toThrow(/Minutos por campo/);
    expect(() => travelTimeMs({ ...base, departureAt: Number.NaN })).toThrow(/Momento de partida inválido/);
    expect(() => isNightBonusHour(Number.NaN, BR142)).toThrow(/Hora inválida/);
  });

  it('viagem inteiramente fora da janela não sofre penalidade', () => {
    // Partida 10:00, 2h clássicas → termina 12:00, longe da janela 23→7.
    expect(
      travelTimeMs({ distanceFields: 4, minutesPerField: 30, departureAt: new Date('2026-08-26T10:00:00'), cfg: BR142 }),
    ).toBe(2 * 60 * 60_000);
  });
});

describe('solveDepartureForArrival', () => {
  it('sem bônus: exato — partida = chegada − viagem clássica', () => {
    const arrival = new Date(2026, 7, 26, 22, 0);
    const solve = solveDepartureForArrival({ distanceFields: 4, minutesPerField: 30, arrivalAt: arrival, cfg: SEM_BONUS });
    expect(solve.travelMs).toBe(2 * 60 * 60_000);
    expect(new Date(solve.departureAt).getHours()).toBe(20);
  });

  it('contraexemplo da revisão (BR142 23→7): chegada 07:30, clássico 5,5h → partida 22:00, viagem 9,5h', () => {
    // 2 iterações fixas davam 22:15/9,25h (atraso de ~15 min na chegada real).
    const solve = solveDepartureForArrival({
      distanceFields: 6,
      minutesPerField: 55,
      arrivalAt: new Date(2026, 7, 26, 7, 30),
      cfg: BR142,
    });
    expect(solve.travelMs).toBe(9.5 * 60 * 60_000);
    const departure = new Date(solve.departureAt);
    expect(departure.getHours()).toBe(22);
    expect(departure.getMinutes()).toBe(0);
  });

  it('propriedade: |partida + viagem(partida) − chegada| ≤ 100ms em vários pontos do dia', () => {
    for (const [hour, minute] of [[0, 30], [2, 0], [7, 0], [12, 0], [23, 0], [23, 59]] as const) {
      const arrival = new Date(2026, 7, 26, hour, minute);
      const solve = solveDepartureForArrival({ distanceFields: 9, minutesPerField: 30, arrivalAt: arrival, cfg: BR142 });
      const realized = travelTimeMs({ distanceFields: 9, minutesPerField: 30, departureAt: solve.departureAt, cfg: BR142 });
      expect(Math.abs(solve.departureAt + realized - arrival.getTime())).toBeLessThanOrEqual(100);
    }
  });

  it('chegada inválida → erro claro (fail-closed)', () => {
    expect(() =>
      solveDepartureForArrival({ distanceFields: 4, minutesPerField: 30, arrivalAt: Number.NaN, cfg: BR142 }),
    ).toThrow(/Chegada desejada inválida/);
  });
});
