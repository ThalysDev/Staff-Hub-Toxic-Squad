// Cunhagem — contra as telas REAIS da Academia do BR142.
import { describe, expect, it } from 'vitest';
import coinHtml from '../__fixtures__/br142-snob-coin.html?raw';
import snobHtml from '../__fixtures__/br142-snob-train.html?raw';
import ativaHtml from '../__fixtures__/br142-snob-train-ativa.html?raw';
import { parseCoinOverview, parseSnobScreen, planMassMint, readMintedCoins, sessionHours, uniqueCoords } from './coin-mass';

describe('Academia (screen=snob)', () => {
  it('custo, máximo e sessão nativa inativa com o form do jogo', () => {
    const s = parseSnobScreen(snobHtml);
    expect(s).toMatchObject({ cost: { wood: 28000, stone: 30000, iron: 25000 }, max: 2 });
    expect(s?.autoMint).toEqual({ kind: 'inativa', startAction: '/game.php?village=35454&screen=snob&action=start_auto_minting_session&h=f5506e54' });
    expect(sessionHours(snobHtml)).toBe(8);
  });
  it('sessão ATIVA real: fim e moedas da sessão; sem prova positiva = desconhecida', () => {
    expect(parseSnobScreen(ativaHtml)?.autoMint).toEqual({ kind: 'ativa', endsText: 'hoje às 23:42:01', coins: 2 });
    const semProva = snobHtml.replace(/<form[^>]*start_auto_minting_session[\s\S]*?<\/form>/, '<span>?</span>');
    expect(parseSnobScreen(semProva)?.autoMint).toEqual({ kind: 'desconhecida' });
  });
  it('Academia não construída = ausente; tela estranha = null', () => {
    expect(parseSnobScreen('<h2>Academia (não construído)</h2>')?.autoMint).toEqual({ kind: 'ausente' });
    expect(parseSnobScreen('<html>login</html>')).toBeNull();
  });
});

describe('Cunhagem em massa (mode=coin)', () => {
  const o = parseCoinOverview(coinHtml)!;
  it('aldeias com recursos, armazém e o máximo do jogo; sem Academia = null', () => {
    expect(o.villages).toHaveLength(6);
    expect(o.villages[0]).toEqual({ id: '238755', name: '001 - Nobre, Toxic Squad!', x: 534, y: 551, res: { wood: 146219, stone: 71619, iron: 359713 }, storage: 400000, max: 2 });
    expect(o.villages.find((v) => v.id === '166685')?.max).toBeNull();
    expect(o.multiLink).toBe('/game.php?village=35454&screen=snob&ajaxaction=coin_multi&h=f5506e54');
    expect(o.more).toBe(true);
    expect(o.cost).toEqual({ wood: 28000, stone: 30000, iron: 25000 });
    expect(parseCoinOverview(coinHtml, 1000)?.more).toBe(false);
  });
  it('plano: máximo do jogo, reserva fixa, % do armazém e teto por aldeia', () => {
    const cost = { wood: 28000, stone: 30000, iron: 25000 };
    expect(planMassMint(o.villages, cost, { keep: { wood: 0, stone: 0, iron: 0 }, keepPct: 0, perVillage: 0 })).toEqual({ 238755: 2, 2095: 1, 20180: 2, 1184: 2, 177127: 1 });
    // Argila é o gargalo: 71.619 − 20.000 = 51.619 → 1 moeda na 001.
    expect(planMassMint(o.villages, cost, { keep: { wood: 0, stone: 20000, iron: 0 }, keepPct: 0, perVillage: 0 })['238755']).toBe(1);
    // 30% do que tem fica: argila 71.619 → 50.133 livres → 1 moeda.
    expect(planMassMint(o.villages, cost, { keep: { wood: 0, stone: 0, iron: 0 }, keepPct: 30, perVillage: 0 })['238755']).toBe(1);
    expect(planMassMint(o.villages, cost, { keep: { wood: 0, stone: 0, iron: 0 }, keepPct: 0, perVillage: 1 })['1184']).toBe(1);
    expect(planMassMint(o.villages, cost, { keep: { wood: 0, stone: 0, iron: 0 }, keepPct: 0, perVillage: 0 }, new Set(['2095']))).toEqual({ 2095: 1 });
  });
  it('resposta do jogo e coordenadas coladas', () => {
    expect(readMintedCoins({ minted_coins: { 238755: 2, 2095: '1' }, message: 'ok' })).toEqual({ 238755: 2, 2095: 1 });
    expect(readMintedCoins({ message: 'x' })).toBeNull();
    // Resposta REAL do jogo (BR142, 24/09/2026, 1 moeda na 001 pela própria tela):
    expect(readMintedCoins(JSON.parse('{"minted_coins":{"238755":1},"gold_cost":{"238755":{"wood":28000,"stone":30000,"iron":25000}},"message":"Voc\u00ea j\u00e1 cunhou 1 moeda de ouro."}'))).toEqual({ 238755: 1 });
    expect(uniqueCoords('501|569 501|566, 501|569\n502|570 lixo')).toEqual(['501|569', '501|566', '502|570']);
  });
});
