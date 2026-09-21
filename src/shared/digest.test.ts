import { describe, expect, it } from 'vitest';
import {
  buildDigestMessage,
  DIGEST_MAX_CHARS,
  filterJournalToday,
  formatBrDate,
  localDateKey,
  summarizeAuditSignals,
  type DigestInput,
} from './digest';
import type { AuditSignal, StagnationSignal } from './member-audit';

const BASE_INPUT: DigestInput = {
  date: '2026-09-04',
  playerName: 'Comandante',
  signals: [
    { label: 'em declínio', count: 1 },
    { label: 'estagnados', count: 2 },
    { label: 'recrutamento massivo', count: 1 },
  ],
  collectionsToday: 2,
  mutationsToday: 5,
  nextAutoCollect: '21:00',
};

describe('buildDigestMessage', () => {
  it('formata o digesto completo no formato do exemplo (PT-BR, markdown simples)', () => {
    expect(buildDigestMessage(BASE_INPUT)).toBe(
      [
        '🔔 **Digesto do Quartel — 04/09/2026**',
        '**Staff Hub — Comandante**',
        '🕵️ Auditoria: 1 em declínio, 2 estagnados, 1 recrutamento massivo',
        '📦 Coletas hoje: 2',
        '✉️ MPs/cobranças hoje: 5',
        '⏰ Próxima coleta automática: 21:00',
        '— Staff Hub Toxic Squad',
      ].join('\n'),
    );
  });

  it('sem sessão de jogo o cabeçalho vira "sem sessão"; dia vazio tem estados explícitos', () => {
    const message = buildDigestMessage({ ...BASE_INPUT, playerName: null, signals: [], nextAutoCollect: null });
    expect(message).toContain('**Staff Hub — sem sessão**');
    expect(message).toContain('🕵️ Auditoria: sem sinais no período');
    expect(message).toContain('⏰ Próxima coleta automática: não configurada');
  });

  it('mensagem maior que o teto é cortada com reticência (webhook nunca rejeita por tamanho)', () => {
    const message = buildDigestMessage({
      ...BASE_INPUT,
      signals: [{ label: 'inativo no período '.repeat(200).trim(), count: 999 }],
    });
    expect(message.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(message.endsWith('…')).toBe(true);
  });

  it('formatBrDate converte YYYY-MM-DD → DD/MM/AAAA e devolve cru o inesperado', () => {
    expect(formatBrDate('2026-09-04')).toBe('04/09/2026');
    expect(formatBrDate('hoje')).toBe('hoje');
  });

  it('localDateKey usa o dia LOCAL (componentes do Date, não o ISO UTC)', () => {
    // 2026-09-04T23:30 no fuso -03:00 é 05/09 em UTC — a chave tem de ser a local.
    expect(localDateKey(new Date(2026, 8, 4, 23, 30))).toBe('2026-09-04');
  });
});

describe('filterJournalToday', () => {
  // Entradas construídas em hora LOCAL (o ts sai ISO UTC) — o resultado não
  // depende do fuso da máquina que roda o teste.
  const isoOf = (date: Date): string => date.toISOString();
  const entries = [
    { ts: isoOf(new Date(2026, 8, 4, 10, 0)), action: 'collect-members' },
    { ts: isoOf(new Date(2026, 8, 4, 11, 0)), action: 'collect-summary' },
    { ts: isoOf(new Date(2026, 8, 4, 12, 0)), action: 'mp-send' },
    { ts: isoOf(new Date(2026, 8, 3, 12, 0)), action: 'collect-members' }, // dia anterior
    { ts: isoOf(new Date(2026, 8, 4, 13, 0)), action: 'reserve' }, // prefixo fora da lista
    { ts: 'não-é-data', action: 'collect-members' }, // ts ilegível é pulado
  ];
  const date = localDateKey(new Date(2026, 8, 4, 12, 0));

  it('conta só as ações com prefixo casado no dia LOCAL dado', () => {
    expect(date).toBe('2026-09-04');
    expect(filterJournalToday(entries, date, ['collect-'])).toBe(2);
    expect(filterJournalToday(entries, date, ['mp-', 'charge-'])).toBe(1);
    expect(filterJournalToday(entries, date, ['reserve'])).toBe(1);
  });

  it('dia sem nenhuma entrada casada → 0', () => {
    expect(filterJournalToday(entries, '2026-01-01', ['collect-'])).toBe(0);
    expect(filterJournalToday([], '2026-09-04', ['collect-'])).toBe(0);
  });

  it('data malformada → 0 (nunca contar errado)', () => {
    expect(filterJournalToday(entries, '04/09/2026', ['collect-'])).toBe(0);
  });
});

describe('summarizeAuditSignals', () => {
  const signal = (kind: AuditSignal['kind'], playerName: string): AuditSignal => ({
    playerName,
    kind,
    offPopDelta: 0,
    defPopDelta: 0,
    villageCountDelta: 0,
  });
  const stagnation = (kind: StagnationSignal['kind'], playerName: string): StagnationSignal => ({
    playerName,
    kind,
    versionsPresent: 4,
    offPopFirst: 0,
    offPopLast: 0,
    offPopDelta: 0,
    villagesFirst: 0,
    villagesLast: 0,
    villagesDelta: 0,
  });

  it('soma estagnação + sinais A→B na ordem canônica, no plural quando count > 1, e omite zero', () => {
    const audit = [
      signal('massive-recruit', 'A'),
      signal('inactive', 'B'),
      signal('left', 'C'),
    ];
    const stag = [stagnation('em-declinio', 'D'), stagnation('estagnado', 'E'), stagnation('estagnado', 'F')];
    expect(summarizeAuditSignals(audit, stag)).toEqual([
      { label: 'em declínio', count: 1 },
      { label: 'estagnados', count: 2 },
      { label: 'recrutamento massivo', count: 1 },
      { label: 'saiu da tribo', count: 1 },
      { label: 'inativo no período', count: 1 },
    ]);
  });

  it('rótulos voltam no PLURAL quando a contagem é > 1', () => {
    const audit = [signal('massive-recruit', 'A'), signal('massive-recruit', 'B')];
    expect(summarizeAuditSignals(audit, [])).toEqual([{ label: 'recrutamentos massivos', count: 2 }]);
  });

  it('dia sem nenhum sinal → lista vazia (o digesto mostra "sem sinais no período")', () => {
    expect(summarizeAuditSignals([], [])).toEqual([]);
  });
});
