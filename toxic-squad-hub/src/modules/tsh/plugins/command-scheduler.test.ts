// Motor do Agendador (P2-5 da revisão de marco): as DECISÕES PURAS do plugin
// em ambiente node, sem DOM — janela de envio (lead/late + `forced`),
// elegibilidade do ciclo (pausa/terminal/aldeia), revalidação pós-mira
// (`stillFirable`) e a decisão do Envio automático desligado (P1-1:
// fire/hold/expired + o vencimento dos comandos segurados).
//
// LACUNA DOCUMENTADA: `fireCommand`/`fireCancelCommand`/`runCycleGuarded` são
// acoplados ao DOM (leitura da Praça/relógio do servidor via `document`) e ao
// transporte (fetch/submit) — não há teste de ciclo fim-a-fim aqui. O que o
// ciclo decide está coberto por estas funções puras; a fiação DOM/transporte
// segue verificada pelos testes de tsh-transport/tsh-commands-ui e pela revisão.

import { describe, expect, it } from 'vitest';
import type { HubSchedulerState, ScheduledCommandRecord, ScheduledCommandStatus } from '../../../ext/core/scheduler-state';
import {
  AUTO_SEND_HOLD_DETAIL,
  createScheduledCommand,
  autoSendExpiredHeldRecords,
  recordInSendWindow,
  schedulableSchedulerRecords,
  shouldHoldForAutoSend,
  stillFirable,
  type NewScheduledCommandInput,
} from './command-scheduler';

const SEND_AT = '2026-09-23T12:00:00.000Z';
const SEND_AT_MS = Date.parse(SEND_AT);
/** Janela dos defaults do schema (focusLeadMs 15s / allowLateMs 250ms). */
const WINDOW = { focusLeadMs: 15_000, allowLateMs: 250 };
const VILLAGE = '238755';

/** Montagem mínima de um registro (tudo sobrescrevível pelo caso). */
function record(overrides: Partial<ScheduledCommandRecord> = {}): ScheduledCommandRecord {
  return {
    id: 'cid_teste',
    kind: 'attack',
    sourceVillageId: VILLAGE,
    target: { x: 503, y: 504 },
    units: { axe: 100 },
    timingMode: 'send',
    sendAt: SEND_AT,
    paused: false,
    createdAt: SEND_AT,
    events: [{ status: 'agendado', at: SEND_AT }],
    ...overrides,
  };
}

function state(commands: ScheduledCommandRecord[]): HubSchedulerState {
  return { commands, transit: [] };
}

function withEvent(
  base: ScheduledCommandRecord,
  status: ScheduledCommandStatus,
  detail?: string,
): ScheduledCommandRecord {
  return {
    ...base,
    events: [...base.events, { status, at: SEND_AT, ...(detail !== undefined ? { detail } : {}) }],
  };
}

/** Registro segurado pelo Envio automático desligado (evento de hold do P1-1). */
function held(base: ScheduledCommandRecord = record()): ScheduledCommandRecord {
  return withEvent(base, 'janela', `${AUTO_SEND_HOLD_DETAIL} no horário 12:00:00; ligue o Envio automático para enviar.`);
}

describe('recordInSendWindow (janela de envio do motor)', () => {
  it('comando no futuro DENTRO da antecipação está na janela', () => {
    expect(recordInSendWindow(record(), SEND_AT_MS - 10_000, WINDOW)).toBe(true);
  });

  it('comando além da antecipação ainda não está na janela', () => {
    expect(recordInSendWindow(record(), SEND_AT_MS - 20_000, WINDOW)).toBe(false);
  });

  it('atraso dentro do allowLateMs continua na janela', () => {
    expect(recordInSendWindow(record(), SEND_AT_MS + 200, WINDOW)).toBe(true);
  });

  it('atraso além do allowLateMs falha (não dispara)', () => {
    expect(recordInSendWindow(record(), SEND_AT_MS + 300, WINDOW)).toBe(false);
  });

  it('forced aceita atraso longo (risco assumido no agendamento)', () => {
    expect(recordInSendWindow(record({ forced: true }), SEND_AT_MS + 120_000, WINDOW)).toBe(true);
  });

  it('forced NÃO antecipa além da antecipação normal', () => {
    expect(recordInSendWindow(record({ forced: true }), SEND_AT_MS - 120_000, WINDOW)).toBe(false);
  });

  it('sendAt ilegível nunca entra na janela (fail-closed)', () => {
    expect(recordInSendWindow(record({ sendAt: 'ontem' }), SEND_AT_MS, WINDOW)).toBe(false);
  });
});

describe('schedulableSchedulerRecords (quem este ciclo pode disparar)', () => {
  const now = new Date(SEND_AT_MS);

  it('pausado fica fora, mesmo na janela', () => {
    const paused = record({ id: 'pausado', paused: true });
    expect(schedulableSchedulerRecords(state([paused]), VILLAGE, now, WINDOW)).toEqual([]);
  });

  it('status terminal persistido (enviado) fica fora — nunca reenvia', () => {
    const sent = withEvent(record({ id: 'enviado' }), 'enviado', 'já foi');
    expect(schedulableSchedulerRecords(state([sent]), VILLAGE, now, WINDOW)).toEqual([]);
  });

  it('comando de OUTRA aldeia fica fora (normaliza o prefixo n)', () => {
    const other = record({ id: 'outra', sourceVillageId: 'n238999' });
    const own = record({ id: 'minha', sourceVillageId: 'n238755' });
    const result = schedulableSchedulerRecords(state([other, own]), VILLAGE, now, WINDOW);
    expect(result.map((entry) => entry.id)).toEqual(['minha']);
  });

  it('forced atrasado entra mesmo com o relógio o marcando "falhou" (sem fato terminal)', () => {
    const late = record({ id: 'forcado', forced: true });
    const result = schedulableSchedulerRecords(state([late]), VILLAGE, new Date(SEND_AT_MS + 300_000), WINDOW);
    expect(result.map((entry) => entry.id)).toEqual(['forcado']);
  });

  it('forced com evento terminal falhou fica fora', () => {
    const failed = withEvent(record({ id: 'forcado', forced: true }), 'falhou', 'falhou de verdade');
    const result = schedulableSchedulerRecords(state([failed]), VILLAGE, new Date(SEND_AT_MS + 300_000), WINDOW);
    expect(result).toEqual([]);
  });
});

describe('stillFirable (revalidação depois da mira)', () => {
  it('registro ausente (removido no intervalo) não dispara', () => {
    expect(stillFirable(undefined, WINDOW, new Date(SEND_AT_MS))).toBe(false);
  });

  it('pausado durante a mira não dispara', () => {
    expect(stillFirable(record({ paused: true }), WINDOW, new Date(SEND_AT_MS))).toBe(false);
  });

  it('ativo na janela segue disparável', () => {
    expect(stillFirable(record(), WINDOW, new Date(SEND_AT_MS))).toBe(true);
  });

  it('passou do allowLateMs sem evento: o relógio fecha a janela (não dispara)', () => {
    expect(stillFirable(record(), WINDOW, new Date(SEND_AT_MS + 10_000))).toBe(false);
  });

  it('forced atrasado sem fato terminal segue disparável', () => {
    expect(stillFirable(record({ forced: true }), WINDOW, new Date(SEND_AT_MS + 10_000))).toBe(true);
  });

  it('forced com evento terminal (incerto) aborta', () => {
    const uncertain = withEvent(record({ forced: true }), 'incerto', 'resposta perdida');
    expect(stillFirable(uncertain, WINDOW, new Date(SEND_AT_MS + 10_000))).toBe(false);
  });
});

describe('shouldHoldForAutoSend (P1-1: Envio automático desligado segura o disparo)', () => {
  it('autoSend LIGADO segue o fluxo normal (fire)', () => {
    expect(shouldHoldForAutoSend({ autoSend: true }, record(), SEND_AT_MS, WINDOW)).toBe('fire');
  });

  it('autoSend DESLIGADO segura o comando devido (hold)', () => {
    expect(shouldHoldForAutoSend({ autoSend: false }, record(), SEND_AT_MS, WINDOW)).toBe('hold');
  });

  it('autoSend DESLIGADO dentro do allowLateMs ainda segura (religar dispara)', () => {
    expect(shouldHoldForAutoSend({ autoSend: false }, record(), SEND_AT_MS + 200, WINDOW)).toBe('hold');
  });

  it('janela vencida com o comando segurado vira expired (motivo autoSend)', () => {
    expect(shouldHoldForAutoSend({ autoSend: false }, record(), SEND_AT_MS + 300, WINDOW)).toBe('expired');
  });

  it('forced nunca vence o hold (aceita atraso por definição)', () => {
    expect(shouldHoldForAutoSend({ autoSend: false }, record({ forced: true }), SEND_AT_MS + 600_000, WINDOW)).toBe(
      'hold',
    );
  });

  it('sendAt ilegível não é caso de hold (o gate de janela já falha fechado)', () => {
    expect(shouldHoldForAutoSend({ autoSend: false }, record({ sendAt: 'ontem' }), SEND_AT_MS, WINDOW)).toBe('fire');
  });
});

describe('autoSendExpiredHeldRecords (desfecho do hold)', () => {
  const expiredNow = SEND_AT_MS + 10_000;

  it('segurado com janela vencida entra (vira fato terminal falhou)', () => {
    const result = autoSendExpiredHeldRecords(state([held()]), VILLAGE, expiredNow, WINDOW);
    expect(result.map((entry) => entry.id)).toEqual(['cid_teste']);
  });

  it('segurado ainda na janela NÃO vence (continua vivo para religar)', () => {
    expect(autoSendExpiredHeldRecords(state([held()]), VILLAGE, SEND_AT_MS + 200, WINDOW)).toEqual([]);
  });

  it('segurado forçado nunca vence', () => {
    const forced = held(record({ forced: true }));
    expect(autoSendExpiredHeldRecords(state([forced]), VILLAGE, expiredNow, WINDOW)).toEqual([]);
  });

  it('comando sem evento de hold não ganha o motivo autoSend', () => {
    expect(autoSendExpiredHeldRecords(state([record()]), VILLAGE, expiredNow, WINDOW)).toEqual([]);
  });

  it('segurado de outra aldeia, pausado ou já terminal fica fora', () => {
    const other = held(record({ id: 'outra', sourceVillageId: 'n238999' }));
    const paused = held(record({ id: 'pausado', paused: true }));
    const sent = withEvent(held(record({ id: 'enviado' })), 'enviado', 'saiu por outro caminho');
    expect(autoSendExpiredHeldRecords(state([other, paused, sent]), VILLAGE, expiredNow, WINDOW)).toEqual([]);
  });
});

describe('createScheduledCommand (montagem mínima do registro)', () => {
  it('nasce agendado, não pausado, com id canônico cid_<fnv1a64>', () => {
    const input: NewScheduledCommandInput = {
      kind: 'attack',
      sourceVillageId: VILLAGE,
      target: { x: 503, y: 504 },
      units: { axe: 100 },
      timingMode: 'send',
      sendAt: SEND_AT,
    };
    const created = createScheduledCommand(input);
    expect(created.id.startsWith('cid_')).toBe(true);
    expect(created.paused).toBe(false);
    expect(created.events.map((event) => event.status)).toEqual(['agendado']);
    // Mesmo comando = mesmo id canônico (dedupe do agendador).
    expect(createScheduledCommand(input).id).toBe(created.id);
  });
});
