// Canais de Alerta (Onda 6) — parte pura: decisão de canais por evento.

import { describe, expect, it } from 'vitest';
import { channelsForEvent, getAlertsConfigDefaults, type AlertsConfig } from './tsh-alerts';

const BASE: AlertsConfig = {
  alarm: { trigger: 'nobre_ariete', sound: 'sirene', volume: 0.7 },
  webhook: { url: '', enabled: false },
  soundTriggers: {
    ataque_nobre: true,
    ataque_ariete: true,
    ataque_qualquer: false,
    comando_enviado: false,
    comando_falhou: true,
    automacao_erro: true,
    estoque_cheio: false,
  },
};

describe('channelsForEvent', () => {
  it('nobre com gatilho nobre_ariete toca som', () => {
    expect(channelsForEvent(BASE, 'ataque_nobre').sound).toBe(true);
  });
  it('ariete com gatilho apenas_nobre NÃO toca', () => {
    const config: AlertsConfig = { ...BASE, alarm: { ...BASE.alarm, trigger: 'apenas_nobre' } };
    expect(channelsForEvent(config, 'ataque_ariete').sound).toBe(false);
  });
  it('qualquer ataque com gatilho qualquer toca (mesmo com soundTriggers ligado)', () => {
    const config: AlertsConfig = {
      ...BASE,
      alarm: { ...BASE.alarm, trigger: 'qualquer' },
      soundTriggers: { ...BASE.soundTriggers, ataque_qualquer: true },
    };
    expect(channelsForEvent(config, 'ataque_qualquer').sound).toBe(true);
  });
  it('evento desligado em soundTriggers nunca toca (mesmo ataque nobre)', () => {
    const config: AlertsConfig = { ...BASE, soundTriggers: { ...BASE.soundTriggers, ataque_nobre: false } };
    expect(channelsForEvent(config, 'ataque_nobre').sound).toBe(false);
  });
  it('evento não-ataque ignora o gatilho do alarme (erro de automação toca direto)', () => {
    expect(channelsForEvent(BASE, 'automacao_erro').sound).toBe(true);
    const desligado: AlertsConfig = { ...BASE, alarm: { ...BASE.alarm, trigger: 'desligado' } };
    expect(channelsForEvent(desligado, 'comando_falhou').sound).toBe(true);
  });
  it('gatilho desligado silencia ataques mas não eventos operacionais', () => {
    const config: AlertsConfig = { ...BASE, alarm: { ...BASE.alarm, trigger: 'desligado' } };
    expect(channelsForEvent(config, 'ataque_nobre').sound).toBe(false);
    expect(channelsForEvent(config, 'comando_falhou').sound).toBe(true);
  });
  it('webhook stub desligado nunca é canal (url vazia)', () => {
    expect(channelsForEvent(BASE, 'ataque_nobre').webhook).toBe(false);
  });
  it('webhook ligado com url vira canal (stub documentado — sem tráfego real)', () => {
    const config: AlertsConfig = { ...BASE, webhook: { url: 'https://exemplo.test/hook', enabled: true } };
    expect(channelsForEvent(config, 'ataque_nobre').webhook).toBe(true);
  });
});

describe('defaults', () => {
  it('atalhos sonoros operacionais ligados, spam desligado', () => {
    const d = getAlertsConfigDefaults();
    expect(d.soundTriggers.comando_falhou).toBe(true);
    expect(d.soundTriggers.comando_enviado).toBe(false);
    expect(d.soundTriggers.estoque_cheio).toBe(false);
    expect(d.webhook).toEqual({ url: '', enabled: false });
  });
});
