import { describe, expect, it } from 'vitest';
import { parseSidInput } from '../../src/main/tw/session';

const RAW_SID = '0:737cdf1f3be981c443ae6b25d6608fac29107ab3f0691aeafd24f6056aadddcfc7882fa24527caa9824d96b5cf2d7797804595ccd2dc2568df37efc7da1347b4';
const ENCODED_SID = `0%3A${RAW_SID.slice(2)}`;

const EDIT_THIS_COOKIE_EXPORT = JSON.stringify([
  { domain: '.tribalwars.com.br', name: 'br_auth', value: '16db1f87ec88:3741ec9cec8007c583ca1ff66372fdf21372fecce620f8ceec6c9bc209ca858b' },
  { domain: '.tribalwars.com.br', name: 'cid', value: '597525880' },
  { domain: 'br142.tribalwars.com.br', name: 'global_village_id', value: '255131' },
  { domain: 'br142.tribalwars.com.br', name: 'sid', value: ENCODED_SID },
  { domain: 'br142.tribalwars.com.br', name: 'websocket_available', value: 'true' },
]);

describe('parseSidInput', () => {
  it('aceita valor puro decodificado (0:hex) e grava como veio', () => {
    expect(parseSidInput(RAW_SID, 'br142')).toEqual({ sid: RAW_SID, extraCookies: [] });
  });

  it('aceita valor puro URL-encoded (0%3Ahex) e preserva como veio (cookie é enviado cru)', () => {
    expect(parseSidInput(ENCODED_SID, 'br142')?.sid).toBe(ENCODED_SID);
  });

  it('aceita o export completo do EditThisCookie e extrai o sid do mundo (forma como colada)', () => {
    const result = parseSidInput(EDIT_THIS_COOKIE_EXPORT, 'br142');
    expect(result?.sid).toBe(ENCODED_SID);
    const names = result?.extraCookies.map((c) => c.name).sort();
    expect(names).toEqual(['br_auth', 'cid', 'global_village_id', 'websocket_available']);
  });

  it('aceita cookie único em JSON', () => {
    const single = JSON.stringify({ domain: 'br142.tribalwars.com.br', name: 'sid', value: ENCODED_SID });
    expect(parseSidInput(single, 'br142')?.sid).toBe(ENCODED_SID);
  });

  it('prefere o sid do domínio do mundo quando há vários', () => {
    const multi = JSON.stringify([
      { domain: 'br140.tribalwars.com.br', name: 'sid', value: '1%3A1111111111111111111111111111111111111111111111111111111111111111' },
      { domain: 'br142.tribalwars.com.br', name: 'sid', value: ENCODED_SID },
    ]);
    expect(parseSidInput(multi, 'br142')?.sid).toBe(ENCODED_SID);
  });

  it('rejeita export sem cookie sid', () => {
    const noSid = JSON.stringify([{ domain: 'br142.tribalwars.com.br', name: 'cid', value: '123' }]);
    expect(parseSidInput(noSid, 'br142')).toBeNull();
  });

  it('rejeita lixo e JSON quebrado', () => {
    expect(parseSidInput('qualquer coisa', 'br142')).toBeNull();
    expect(parseSidInput('[{ "domain": ".tribalwars', 'br142')).toBeNull();
    expect(parseSidInput('0:curto', 'br142')).toBeNull();
  });
});
