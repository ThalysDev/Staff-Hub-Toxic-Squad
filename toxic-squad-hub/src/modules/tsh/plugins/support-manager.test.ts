// Partes PURAS do plugin Gestão de Apoio (ambiente node, sem DOM — a porta do
// supports-reader depende de DOMParser e é coberta pela leitura defensiva):
// defaults do schema, mapa de percentuais e canonização de unidades.
import { describe, expect, it } from 'vitest';
import { SUPPORT_WITHDRAWAL_UNITS } from '../../../ext/modules/features/support-manager/support-manager-planner';
import { canonicalWithdrawalUnitIds, supportManagerSettingsSchema } from './support-manager';

describe('supportManagerSettingsSchema', () => {
  it('nascimento por padrão: escopo de apoios enviados a jogadores, 100%, todas as unidades', () => {
    const settings = supportManagerSettingsSchema.parse({});
    expect(settings.scope).toBe('player');
    expect(settings.groupId).toBeNull();
    expect(settings.selectionPercent).toBe('100');
    expect(settings.unitIds).toEqual([...SUPPORT_WITHDRAWAL_UNITS]);
  });
});

describe('canonicalWithdrawalUnitIds', () => {
  it('filtra unidades desconhecidas, deduplica e ordena no cânone do planner', () => {
    expect(canonicalWithdrawalUnitIds(['spear', 'spear', 'knight', 'zombie', 'archer'])).toEqual(['spear', 'archer', 'knight']);
    // ordem canônica independentemente da entrada
    expect(canonicalWithdrawalUnitIds(['snob', 'spear'])).toEqual(['spear', 'snob']);
  });

  it('lista vazia quando nenhuma unidade é reconhecida (fail-closed do ciclo)', () => {
    expect(canonicalWithdrawalUnitIds([])).toEqual([]);
    expect(canonicalWithdrawalUnitIds(['militia', 'zzz'])).toEqual([]);
  });
});
