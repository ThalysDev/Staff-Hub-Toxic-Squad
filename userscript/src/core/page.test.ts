// Regressão do bug de origem do userscript: a identificação da conta depende
// do parser puro de game_data (a leitura real de unsafeWindow é do browser —
// o que aqui é testável é a conversão do dado bruto em contexto do jogo).
import { describe, expect, it } from 'vitest';
import { gameContextFrom } from './page';

describe('gameContextFrom', () => {
  it('extrai player/world/villageId do game_data da página', () => {
    expect(
      gameContextFrom({ player: { name: 'Thalys', id: 7 }, world: 'br142', village: { id: 12345 } }),
    ).toEqual({ player: 'Thalys', world: 'br142', villageId: '12345' });
  });

  it('devolve "—" em tudo quando game_data não existe', () => {
    expect(gameContextFrom(undefined)).toEqual({ player: '—', world: '—', villageId: '—' });
  });

  it('nome vazio da conta conta como ausente (||, não ??)', () => {
    const ctx = gameContextFrom({ player: { name: '' }, world: 'br142', village: { id: 1 } });
    expect(ctx.player).toBe('—');
    expect(ctx.world).toBe('br142');
  });

  it('village.id numérico vira string (usado em URL e chave de storage)', () => {
    expect(gameContextFrom({ village: { id: 42 } }).villageId).toBe('42');
  });
});
