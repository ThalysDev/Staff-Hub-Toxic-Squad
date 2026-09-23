import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HUMANIZE_POLICY,
  humanizePolicySchema,
  humanizedActionDelayMs,
  isPauseActive,
  laneForCommand,
  laneForSchedulerCommandKind,
  laneForSchedulerRecord,
  nextCommandAt,
  nextHumanizedCommandAt,
  normalizeHumanizePolicy,
  routineWaitMs,
  type CommandKindForLane,
  type HumanizePolicy,
} from './humanize-policy';

const MINUTE = 60 * 1000;
const HOUR_MS = 60 * MINUTE;

/** Política LIGADA com os defaults de fábrica (o único desvio é o master switch). */
function policy(overrides: Partial<HumanizePolicy> = {}): HumanizePolicy {
  return { ...DEFAULT_HUMANIZE_POLICY, enabled: true, ...overrides };
}

/** Instante em hora LOCAL (a pausa diária é sempre em hora local, como o motor). */
function localMs(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute, 0, 0).getTime();
}

describe('faixa do comando (laneForCommand)', () => {
  it('nobre, snipe, dodge e cancelamento são SEMPRE precisao — não há versão humanizada deles', () => {
    const kinds: readonly CommandKindForLane[] = ['nobre', 'snipe', 'dodge', 'cancelamento'];
    for (const kind of kinds) {
      expect(laneForCommand(kind, true)).toBe('precisao');
      expect(laneForCommand(kind, false)).toBe('precisao');
    }
  });

  it('ataque e apoio cravados são precisao; imediatos são humanizado', () => {
    expect(laneForCommand('apoio', true)).toBe('precisao');
    expect(laneForCommand('apoio', false)).toBe('humanizado');
    expect(laneForCommand('ataque', true)).toBe('precisao');
    expect(laneForCommand('ataque', false)).toBe('humanizado');
  });

  it('fake é humanizado cravado ou não', () => {
    expect(laneForCommand('fake', true)).toBe('humanizado');
    expect(laneForCommand('fake', false)).toBe('humanizado');
  });

  it('rotinas de coleta/recrutamento/construção/mercado/cunhagem são humanizado', () => {
    const rotinas: readonly CommandKindForLane[] = ['coleta', 'recrutamento', 'construcao', 'mercado', 'cunhagem'];
    for (const kind of rotinas) {
      expect(laneForCommand(kind, true)).toBe('humanizado');
      expect(laneForCommand(kind, false)).toBe('humanizado');
    }
  });

  it('kind do estado do Agendador (attack/support/noble/fake) mapeia para a mesma faixa', () => {
    expect(laneForSchedulerCommandKind('noble', false)).toBe('precisao');
    expect(laneForSchedulerCommandKind('attack', true)).toBe('precisao');
    expect(laneForSchedulerCommandKind('attack', false)).toBe('humanizado');
    expect(laneForSchedulerCommandKind('support', true)).toBe('precisao');
    expect(laneForSchedulerCommandKind('support', false)).toBe('humanizado');
    expect(laneForSchedulerCommandKind('fake', true)).toBe('humanizado');
  });
});

describe('delay humanizado', () => {
  it('rand 0/0.5/1 abre o piso, o nominal e o teto da variação', () => {
    expect(humanizedActionDelayMs(policy(), 0)).toBe(600); // 750 − 20%
    expect(humanizedActionDelayMs(policy(), 0.5)).toBe(750);
    expect(humanizedActionDelayMs(policy(), 1)).toBe(900); // 750 + 20%
  });

  it('variation 0 = delay fixo em qualquer rand', () => {
    const fixed = policy({ variationPct: 0 });
    expect(humanizedActionDelayMs(fixed, 0)).toBe(750);
    expect(humanizedActionDelayMs(fixed, 0.5)).toBe(750);
    expect(humanizedActionDelayMs(fixed, 1)).toBe(750);
  });

  it('rand fora de [0,1] é clampado e variação de 100% nunca produz delay negativo', () => {
    expect(humanizedActionDelayMs(policy(), -3)).toBe(600);
    expect(humanizedActionDelayMs(policy(), 7)).toBe(900);
    const full = policy({ variationPct: 100 });
    expect(humanizedActionDelayMs(full, 0)).toBe(0);
    expect(humanizedActionDelayMs(full, 1)).toBe(1_500);
  });

  it('arredonda o delay para milissegundo inteiro', () => {
    expect(humanizedActionDelayMs(policy({ actionDelayMs: 333, variationPct: 33 }), 1)).toBe(443);
  });
});

describe('intervalo mínimo e pausa diária', () => {
  it('respeita o intervalo desde o último envio (e nunca devolve o passado)', () => {
    const now = 1_000_000;
    // 100ms desde o último envio: ainda faltam 200ms do intervalo de 300ms.
    expect(nextHumanizedCommandAt(policy(), now - 100, now)).toBe(now + 200);
    // Intervalo já vencido: envia agora.
    expect(nextHumanizedCommandAt(policy(), now - 10_000, now)).toBe(now);
    // Último envio "no futuro" (deriva de relógio): o gap conta a partir dele.
    expect(nextHumanizedCommandAt(policy(), now + 5_000, now)).toBe(now + 5_300);
  });

  it('pausa simples (1→7): ativa de 01:00 até 06:59, livre às 07:00', () => {
    const p = policy({ scheduledPause: { startHour: 1, endHour: 7 } });
    expect(isPauseActive(p, 1)).toBe(true);
    expect(isPauseActive(p, 6)).toBe(true);
    expect(isPauseActive(p, 7)).toBe(false);
    expect(isPauseActive(p, 0)).toBe(false);
    expect(isPauseActive(p, 12)).toBe(false);
  });

  it('pausa cruzando a meia-noite (23→7): ativa às 23h e de 00h às 06h', () => {
    const p = policy({ scheduledPause: { startHour: 23, endHour: 7 } });
    expect(isPauseActive(p, 23)).toBe(true);
    expect(isPauseActive(p, 0)).toBe(true);
    expect(isPauseActive(p, 6)).toBe(true);
    expect(isPauseActive(p, 7)).toBe(false);
    expect(isPauseActive(p, 22)).toBe(false);
  });

  it('sem pausa configurada (null) ou janela degenerada nunca pausa', () => {
    expect(isPauseActive(policy(), 3)).toBe(false);
    expect(isPauseActive(policy({ scheduledPause: { startHour: 0, endHour: 0 } }), 0)).toBe(false);
    expect(isPauseActive(policy({ scheduledPause: { startHour: 8, endHour: 8 } }), 8)).toBe(false);
  });

  it('envio humanizado que cai na pausa escorrega para o fim da janela', () => {
    const p = policy({ scheduledPause: { startHour: 23, endHour: 7 } });
    // 23:30 dentro de 23→7: o próximo envio é às 07:00 do dia seguinte.
    expect(nextHumanizedCommandAt(p, localMs(2026, 8, 23, 23, 30) - HOUR_MS, localMs(2026, 8, 23, 23, 30))).toBe(
      localMs(2026, 8, 24, 7, 0),
    );
    // 03:00 (madrugada da janela que cruzou a meia-noite): escorrega para as 07:00 do MESMO dia.
    expect(nextHumanizedCommandAt(p, localMs(2026, 8, 24, 3, 0) - HOUR_MS, localMs(2026, 8, 24, 3, 0))).toBe(
      localMs(2026, 8, 24, 7, 0),
    );
    // 06:50 com intervalo de 300ms continua dentro da janela: 07:00 em ponto.
    expect(nextHumanizedCommandAt(p, localMs(2026, 8, 24, 6, 50) - 1_000, localMs(2026, 8, 24, 6, 50))).toBe(
      localMs(2026, 8, 24, 7, 0),
    );
    // 22:00 fora da janela: só o intervalo manda.
    const livre = localMs(2026, 8, 23, 22, 0);
    expect(nextHumanizedCommandAt(p, livre - HOUR_MS, livre)).toBe(livre);
  });
});

describe('porta do envio (nextCommandAt)', () => {
  it('faixa precisao NUNCA é atrasada — nem por intervalo alto, nem por pausa ativa', () => {
    const now = localMs(2026, 8, 23, 12, 0);
    const p = policy({ commandIntervalMs: 10 * MINUTE, scheduledPause: { startHour: 0, endHour: 23 } });
    expect(isPauseActive(p, 12)).toBe(true);
    expect(nextCommandAt(p, 'precisao', now, now)).toBe(now);
    expect(nextCommandAt(p, 'precisao', now - 1, now)).toBe(now);
    // Contraste: a mesma política ATRASA a faixa humanizada até sair da pausa.
    expect(nextCommandAt(p, 'humanizado', now, now)).toBe(localMs(2026, 8, 23, 23, 0));
  });

  it('política desligada (default) = tudo passa direto nas duas faixas', () => {
    const now = localMs(2026, 8, 23, 12, 0);
    const off: HumanizePolicy = { ...DEFAULT_HUMANIZE_POLICY, commandIntervalMs: 10 * MINUTE };
    expect(off.enabled).toBe(false);
    expect(nextHumanizedCommandAt(off, now, now)).toBe(now);
    expect(nextCommandAt(off, 'humanizado', now, now)).toBe(now);
    expect(nextCommandAt(off, 'precisao', now, now)).toBe(now);
  });
});

describe('persistência da política (schema e normalização)', () => {
  it('schema aplica os defaults sobre objeto vazio e respeita o que vem preenchido', () => {
    const parsed = humanizePolicySchema.parse({});
    expect(parsed).toEqual(DEFAULT_HUMANIZE_POLICY);
    expect(humanizePolicySchema.parse({ enabled: true }).enabled).toBe(true);
  });

  it('lixo (não-objeto ou campo de tipo errado) cai nos defaults, campo a campo', () => {
    expect(normalizeHumanizePolicy(null)).toEqual(DEFAULT_HUMANIZE_POLICY);
    expect(normalizeHumanizePolicy('humaniza')).toEqual(DEFAULT_HUMANIZE_POLICY);
    expect(normalizeHumanizePolicy([1, 2, 3])).toEqual(DEFAULT_HUMANIZE_POLICY);
    expect(normalizeHumanizePolicy(42)).toEqual(DEFAULT_HUMANIZE_POLICY);
    const garbageFieldTypes = normalizeHumanizePolicy({
      enabled: 'sim',
      commandIntervalMs: '300',
      actionDelayMs: {},
      variationPct: [],
      scheduledPause: 'noite',
      enforceFakeLimit: 1,
    });
    expect(garbageFieldTypes).toEqual(DEFAULT_HUMANIZE_POLICY);
  });

  it('merge parcial sobre os defaults (campo ausente nunca zera o resto)', () => {
    const normalized = normalizeHumanizePolicy({ enabled: true, actionDelayMs: 100 });
    expect(normalized).toEqual({
      enabled: true,
      actionDelayMs: 100,
      commandIntervalMs: 300,
      variationPct: 20,
      scheduledPause: null,
      enforceFakeLimit: true,
    });
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('clamp: variation >100 vira 100, ms fora da faixa é limitado e pausa inválida vira null', () => {
    const clamped = normalizeHumanizePolicy({
      variationPct: 500,
      commandIntervalMs: 10_000_000,
      actionDelayMs: -50,
      scheduledPause: { startHour: 25, endHour: 7 },
    });
    expect(clamped.variationPct).toBe(100);
    expect(clamped.commandIntervalMs).toBe(600_000);
    expect(clamped.actionDelayMs).toBe(0);
    expect(clamped.scheduledPause).toBeNull();

    // A variação clampada é a que o motor usa: 100% no piso zera o delay e
    // uma variação negativa (que viraria "anti-variação") vira delay fixo.
    expect(humanizedActionDelayMs(clamped, 0)).toBe(0);
    expect(humanizedActionDelayMs(normalizeHumanizePolicy({ variationPct: -80 }), 0)).toBe(750);
  });

  it('pausa válida (inclusive cruzando a meia-noite) sobrevive à normalização', () => {
    const normalized = normalizeHumanizePolicy({ enabled: true, scheduledPause: { startHour: 23, endHour: 7 } });
    expect(normalized.scheduledPause).toEqual({ startHour: 23, endHour: 7 });
    expect(isPauseActive(normalized, 3)).toBe(true);
    expect(isPauseActive(normalized, 12)).toBe(false);
  });
});

describe('routineWaitMs (porta de rotina — regra de ouro na integração)', () => {
  const ON: HumanizePolicy = { ...DEFAULT_HUMANIZE_POLICY, enabled: true };
  const NOW = 1_000_000;

  it('faixa precisao é SEMPRE 0 — nem pausa ativa a segura', () => {
    const comPausa: HumanizePolicy = { ...ON, scheduledPause: { startHour: 0, endHour: 23 } };
    expect(routineWaitMs(comPausa, 'precisao', 0, NOW, 12, 0.5)).toBe(0);
  });
  it('política desligada → 0 nas duas faixas', () => {
    expect(routineWaitMs(DEFAULT_HUMANIZE_POLICY, 'humanizado', 0, NOW, 12, 0.5)).toBe(0);
  });
  it('pausa ativa em rotina → -1 (pule o ciclo)', () => {
    const comPausa: HumanizePolicy = { ...ON, scheduledPause: { startHour: 8, endHour: 18 } };
    expect(routineWaitMs(comPausa, 'humanizado', 0, NOW, 12, 0.5)).toBe(-1);
  });
  it('sem pendências → espera = atraso humanizado do rand', () => {
    expect(routineWaitMs(ON, 'humanizado', 0, NOW, 12, 0.5)).toBe(750); // nominal
    expect(routineWaitMs(ON, 'humanizado', 0, NOW, 12, 0)).toBe(600); // piso -20%
    expect(routineWaitMs(ON, 'humanizado', 0, NOW, 12, 1)).toBe(900); // teto +20%
  });
  it('gap de intervalo vence quando maior que o atraso', () => {
    const apertado: HumanizePolicy = { ...ON, commandIntervalMs: 5_000, actionDelayMs: 100 };
    // último envio há 1s → gap 4s > jitter
    expect(routineWaitMs(apertado, 'humanizado', NOW - 1_000, NOW, 12, 0)).toBe(4_000);
  });
  it('cooldown vencido → só o atraso humanizado', () => {
    expect(routineWaitMs(ON, 'humanizado', NOW - 60_000, NOW, 12, 0.5)).toBe(750);
  });

  it('laneForSchedulerRecord deriva scheduledExact=true sempre (ataque de OP nunca humaniza)', () => {
    expect(laneForSchedulerRecord({ kind: 'attack' })).toBe('precisao');
    expect(laneForSchedulerRecord({ kind: 'support' })).toBe('precisao');
    expect(laneForSchedulerRecord({ kind: 'noble' })).toBe('precisao');
    expect(laneForSchedulerRecord({ kind: 'cancel' })).toBe('precisao');
    expect(laneForSchedulerRecord({ kind: 'fake' })).toBe('humanizado'); // exceção deliberada
  });
});
