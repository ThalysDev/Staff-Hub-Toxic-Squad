import { describe, expect, it } from 'vitest';
import { parseServerTimeText, serverClockOffset, serverNow } from './server-clock';

describe('relógio do servidor', () => {
  it('interpreta o texto de hora do servidor exibido pelo jogo', () => {
    const local = new Date(2026, 7, 14, 13, 28, 33);
    expect(parseServerTimeText('13:28:33 14/08/2026', local)).toEqual(new Date(2026, 7, 14, 13, 28, 33));
    expect(parseServerTimeText('Hora do servidor: 09:00:00 15/08/2026', local)).toEqual(new Date(2026, 7, 15, 9, 0, 0));
    expect(parseServerTimeText('sem hora aqui', local)).toBeUndefined();
    expect(parseServerTimeText('99:00:00 14/08/2026', local)).toBeUndefined();
  });

  it('mede o offset entre servidor e relógio local e o aplica', () => {
    const local = new Date(2026, 7, 14, 13, 28, 33);
    // Servidor 30s à frente do local.
    const offset = serverClockOffset('13:29:03 14/08/2026', local);
    expect(offset).toBe(30_000);
    expect(serverNow(offset ?? 0, local).toISOString()).toBe(new Date(2026, 7, 14, 13, 29, 3).toISOString());
    // Texto sem data usa o dia local; offsets absurdos são descartados.
    expect(serverClockOffset('13:28:33', local)).toBe(0);
    expect(serverClockOffset('13:28:33 14/08/1999', local)).toBeUndefined();
  });
});
