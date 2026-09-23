// Testes dos contratos PUROS do Modo Sentinela (Onda 5, Parte A): URL da aba de
// fundo e badge do título. A marcação da aba (isSentinelaTab) e o botão
// flutuante dependem do documento e ficam na verificação manual no jogo.
import { describe, expect, it } from 'vitest';

import { SENTINELA_PARAM, sentinelaBadgeTitle, sentinelaUrl, SENTINELA_TITULO } from './tsh-sentinela';

describe('sentinelaUrl', () => {
  it('monta a Visão das Aldeias marcada com o parâmetro da Sentinela', () => {
    expect(sentinelaUrl('12345')).toBe('/game.php?village=12345&screen=overview_villages&tsh-sentinela=1');
    expect(sentinelaUrl('12345')).toContain(`${SENTINELA_PARAM}=1`);
  });

  it('aceita o id canônico com prefixo n e sem aldeia abre o overview puro', () => {
    expect(sentinelaUrl('n777')).toBe('/game.php?village=777&screen=overview_villages&tsh-sentinela=1');
    expect(sentinelaUrl('')).toBe('/game.php?screen=overview_villages&tsh-sentinela=1');
  });

  it('escapa o id na URL em vez de colar texto cru', () => {
    expect(sentinelaUrl('12 34')).toBe('/game.php?village=12%2034&screen=overview_villages&tsh-sentinela=1');
  });
});

describe('sentinelaBadgeTitle', () => {
  it('anuncia o título base com a contagem de automações ativas', () => {
    expect(SENTINELA_TITULO).toContain('Sentinela TSH');
    expect(sentinelaBadgeTitle(0)).toBe(`${SENTINELA_TITULO} — nenhuma ativa`);
    expect(sentinelaBadgeTitle(1)).toBe(`${SENTINELA_TITULO} — 1 ativa`);
    expect(sentinelaBadgeTitle(4)).toBe(`${SENTINELA_TITULO} — 4 ativas`);
  });

  it('grampeia contagem inválida em zero (nunca título com NaN)', () => {
    expect(sentinelaBadgeTitle(-3)).toBe(`${SENTINELA_TITULO} — nenhuma ativa`);
    expect(sentinelaBadgeTitle(Number.NaN)).toBe(`${SENTINELA_TITULO} — nenhuma ativa`);
  });
});
