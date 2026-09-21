// LICENSE KEYS in-game — testes da lógica extraída em vps/staffhub-auth/keys.mjs
// (pura: só node:crypto — sem banco e sem auth.env, importa limpo no vitest)
// + round-trip do banco (db.mjs) com SQLite EFÊMERO em tmpdir: o AUTH_ENV e o
// AUTH_DB_PATH apontam p/ arquivos temporários ANTES do import dinâmico, então
// nada do repo é tocado. Cobre: formato, fronteira de expiração, vínculo
// (1ª ativação vs. player diferente), revogação e o contrato do list (sem hash).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decidirValidacao, gerarChave, hashChave, novaChave, prefixoChave, ticketDe } from '../../vps/staffhub-auth/keys.mjs';

const SEGredo = 'segredo-de-teste-0123456789abcdef0123456789abcdef';

// Registro de referência (válido, sem vínculo, prazo longo).
const valido = (parcial: Record<string, unknown> = {}) => ({
  revoked: 0,
  expires_at: Date.now() + 24 * 3600_000,
  bound_player: null,
  ...parcial,
});

describe('keys.mjs — formato da chave', () => {
  it('SHS-XXXX-XXXX-XXXX com alfabeto legível (sem I O l i o 0 1)', () => {
    for (let i = 0; i < 50; i += 1) {
      const chave = gerarChave();
      expect(chave).toMatch(/^SHS-[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]{4}$/);
      expect(chave).not.toMatch(/[IOilo01]/);
    }
  });

  it('duas gerações seguidas não colidem (sanidade do aleatório)', () => {
    const chaves = new Set<string>();
    for (let i = 0; i < 20; i += 1) chaves.add(gerarChave());
    expect(chaves.size).toBe(20);
  });

  it('novaChave devolve chave + hash sha256 hex + prefixo de 8 chars', () => {
    const chave = novaChave();
    expect(chave.chave).toMatch(/^SHS-/);
    expect(chave.hash).toBe(createHash('sha256').update(chave.chave).digest('hex'));
    expect(chave.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(chave.prefixo).toBe(chave.chave.slice(0, 8));
    expect(prefixoChave(`  ${chave.chave}  `)).toBe(chave.chave.slice(0, 8)); // trim
    expect(hashChave(`  ${chave.chave}  `)).toBe(chave.hash); // trim antes do hash
  });
});

describe('keys.mjs — decidirValidacao (fail-closed)', () => {
  it('inexistente', () => {
    expect(decidirValidacao(undefined, 'Jogador')).toEqual({ ok: false, motivo: 'inexistente' });
  });

  it('revogada mesmo com prazo e vínculo ok', () => {
    expect(decidirValidacao(valido({ revoked: 1 }), 'Jogador')).toEqual({ ok: false, motivo: 'revogada' });
  });

  it('fronteira de expiração: limite EXCLUSIVO (<= agora já expirou)', () => {
    const agora = 1_700_000_000_000;
    expect(decidirValidacao(valido({ expires_at: agora }), 'Jogador', agora)).toEqual({ ok: false, motivo: 'expirada' });
    expect(decidirValidacao(valido({ expires_at: agora - 1 }), 'Jogador', agora)).toEqual({ ok: false, motivo: 'expirada' });
    expect(decidirValidacao(valido({ expires_at: agora + 1 }), 'Jogador', agora)).toEqual({ ok: true, vinculou: true });
  });

  it('sem prazo (expires_at null) não expira nunca', () => {
    expect(decidirValidacao(valido({ expires_at: null }), 'Jogador')).toEqual({ ok: true, vinculou: true });
  });

  it('vínculo: 1ª ativação vincula; mesmo player revalida; outro player 403', () => {
    // 1ª ativação: bound_player null → ok e vinculou=true (o servidor grava).
    expect(decidirValidacao(valido({ bound_player: null }), 'JogadorA')).toEqual({ ok: true, vinculou: true });
    // Mesmo player depois da ativação → ok, sem re-vincular.
    expect(decidirValidacao(valido({ bound_player: 'JogadorA' }), 'JogadorA')).toEqual({ ok: true, vinculou: false });
    // Player diferente → negado (case-sensitive de propósito).
    expect(decidirValidacao(valido({ bound_player: 'JogadorA' }), 'JogadorB')).toEqual({ ok: false, motivo: 'vinculada' });
    expect(decidirValidacao(valido({ bound_player: 'JogadorA' }), 'jogadora')).toEqual({ ok: false, motivo: 'vinculada' });
    // Vínculo perde para revogação/expiração (ordem fail-closed).
    expect(decidirValidacao(valido({ bound_player: 'JogadorA', revoked: 1 }), 'JogadorA')).toEqual({ ok: false, motivo: 'revogada' });
  });
});

describe('keys.mjs — ticket HMAC', () => {
  it('ticket = HMAC-SHA256 hex de `player|expiresAt` com o segredo injetado', () => {
    const esperado = createHmac('sha256', SEGredo).update('JogadorA|1700000000000').digest('hex');
    expect(ticketDe('JogadorA', 1_700_000_000_000, SEGredo)).toBe(esperado);
    expect(ticketDe('JogadorA', 1_700_000_000_000, 'outro-segredo')).not.toBe(esperado);
    expect(ticketDe('JogadorB', 1_700_000_000_000, SEGredo)).not.toBe(esperado);
  });
});

// ---- round-trip no banco (SQLite efêmero em tmpdir) ----

describe('db.mjs — license_keys (SQLite em tmpdir)', () => {
  let pasta: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    pasta = mkdtempSync(join(tmpdir(), 'shub-keys-'));
    writeFileSync(join(pasta, 'auth.env'), `JWT_SECRET=${SEGredo}\n`);
    process.env.AUTH_ENV = join(pasta, 'auth.env');
    process.env.AUTH_DB_PATH = join(pasta, 'auth.db');
    db = await import('../../vps/staffhub-auth/db.mjs');
  });

  afterAll(() => {
    db?.db?.close?.();
    delete process.env.AUTH_ENV;
    delete process.env.AUTH_DB_PATH;
    rmSync(pasta, { recursive: true, force: true });
  });

  it('insert → findByHash → 1ª ativação → touch → list sem hash → revogar', () => {
    const chave = novaChave();
    const expiraEm = Date.now() + 7 * 24 * 3600_000;
    db.q.chaveInserir.run('id-chave-1', chave.hash, chave.prefixo, 'Player Um', 'lider', expiraEm, 'Chefe', new Date().toISOString());

    const linha = db.q.chavePorHash.get(chave.hash);
    expect(linha).toBeDefined();
    expect(linha.key_hash).toBe(chave.hash);
    expect(linha.tier).toBe('lider');
    expect(linha.revoked).toBe(0);
    expect(linha.bound_player).toBeNull();

    // 1ª ativação vincula; revalidação do dono segue; outro player não.
    expect(decidirValidacao(linha, 'JogadorA')).toEqual({ ok: true, vinculou: true });
    db.q.chaveVincular.run('JogadorA', linha.id);
    db.q.chaveTouch.run(new Date().toISOString(), '10.0.0.1', linha.id);
    const revalidada = db.q.chavePorHash.get(chave.hash);
    expect(revalidada.bound_player).toBe('JogadorA');
    expect(revalidada.last_ip).toBe('10.0.0.1');
    expect(revalidada.last_used_at).not.toBeNull();
    expect(decidirValidacao(revalidada, 'JogadorA')).toEqual({ ok: true, vinculou: false });
    expect(decidirValidacao(revalidada, 'JogadorB')).toEqual({ ok: false, motivo: 'vinculada' });

    // Listagem: camelCase do contrato e NUNCA key_hash.
    const naLista = db.q.chaveListar.all().find((k: Record<string, unknown>) => k.id === 'id-chave-1');
    expect(naLista).toBeDefined();
    expect(naLista.keyPrefix).toBe(chave.prefixo);
    expect(naLista.ownerNick).toBe('Player Um');
    expect(naLista.boundPlayer).toBe('JogadorA');
    expect(naLista.tier).toBe('lider');
    expect(naLista.key_hash).toBeUndefined();
    expect(naLista.keyHash).toBeUndefined();

    // Revogação vale mesmo para o dono vinculado (fail-closed).
    db.q.chaveRevogar.run(linha.id);
    expect(decidirValidacao(db.q.chavePorHash.get(chave.hash), 'JogadorA')).toEqual({ ok: false, motivo: 'revogada' });
  });

  it('chave por hash é EXATA: variação de 1 char não encontra nada', () => {
    const chave = novaChave();
    db.q.chaveInserir.run('id-chave-2', chave.hash, chave.prefixo, 'Player Dois', 'staff', null, 'Chefe', new Date().toISOString());
    expect(db.q.chavePorHash.get(chave.hash)).toBeDefined();
    expect(db.q.chavePorHash.get(hashChave(`${chave.chave}X`))).toBeUndefined();
    // sem prazo (expires_at null) segue válida
    expect(decidirValidacao(db.q.chavePorHash.get(chave.hash), 'Qualquer')).toEqual({ ok: true, vinculou: true });
  });
});
