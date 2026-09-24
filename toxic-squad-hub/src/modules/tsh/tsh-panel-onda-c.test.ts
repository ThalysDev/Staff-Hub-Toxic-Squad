import { describe, expect, it } from 'vitest';
import { passesTshFilter } from './tsh-panel';

describe('passesTshFilter (Onda C)', () => {
  it('Todas mostra tudo', () => {
    expect(passesTshFilter('todas', false, null)).toBe(true);
  });
  it('Ativas só ligadas', () => {
    expect(passesTshFilter('ativas', true, 'ok')).toBe(true);
    expect(passesTshFilter('ativas', false, 'warn')).toBe(false);
  });
  it('Com atenção só ligadas com aviso', () => {
    expect(passesTshFilter('atencao', true, 'warn')).toBe(true);
    expect(passesTshFilter('atencao', true, 'ok')).toBe(false);
    expect(passesTshFilter('atencao', false, 'warn')).toBe(false);
  });
});
