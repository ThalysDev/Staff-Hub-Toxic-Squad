import { describe, expect, it } from 'vitest';
import { erroFilaOcupada, erroSentinela, erroSessao } from './error-catalog';

describe('error-catalog (strings canônicas PT-BR)', () => {
  it('erroSessao: mensagem canônica completa, com e sem contexto', () => {
    expect(erroSessao()).toBe('Nenhuma sessão ativa no jogo — faça login no jogo ou importe a sessão na tela Sessão.');
    expect(erroSessao('usar o fórum')).toBe(
      'Nenhuma sessão ativa no jogo — faça login no jogo ou importe a sessão na tela Sessão. (usar o fórum)',
    );
  });

  it('erroFilaOcupada: base canônica do single-flight (C4), com e sem contexto', () => {
    expect(erroFilaOcupada()).toBe('Uma operação está em andamento — aguarde terminar (ou cancele na barra de progresso) antes de iniciar outra.');
    expect(erroFilaOcupada('usar o fórum')).toBe(
      'Uma operação está em andamento — aguarde terminar (ou cancele na barra de progresso) antes de usar o fórum.',
    );
  });

  it('erroSentinela: sessão e captcha com redações canônicas distintas', () => {
    expect(erroSentinela('session-expired')).toBe('Sessão expirada — operação interrompida. Faça login novamente.');
    expect(erroSentinela('captcha-suspected')).toBe('Captcha detectado — operação pausada. Resolva manualmente na janela de login.');
  });
});
