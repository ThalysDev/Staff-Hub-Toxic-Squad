// Paladino — porta do plugin paladin-training da extensão Toxic Squad Hub
// (toxic-squad-hub-ext/.../modules/features/paladin-training/plugin.ts):
// - o plan() da origem decidia pelo snapshot do paladino (readPaladin do
//   page-adapter): lançador .knight_recruit_launch presente → {recruited:
//   false, training: false} → ação recruit; paladino presente (link mode=
//   resident) → recrutado; .timer/.trainqueue no box → em treinamento;
// - desvio documentado: sem snapshot, a leitura é direta do documento vivo
//   da Estátua (mesmos seletores/semântica do readPaladin);
// - TRÊS estados confirmados e reportados com clareza (mesma ordem da
//   origem): 1) lançador .knight_recruit_launch presente → slot LIVRE →
//   recruta; 2) box com marcador de treino ([data-paladin-training],
//   .trainqueue, .timer) → EM TREINO; 3) link mode=resident → RECRUTADO
//   (slot ocupado pelo paladino presente); resto = ilegível;
// - F2: no máximo 1 mutação por ciclo — launchPaladinTraining() (o botão
//   "Recrutar" JS da Estátua, único mecanismo certificado do transporte;
//   NENHUM link genérico action= é clicado).

import { registerTsh } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { launchPaladinTraining } from '../tsh-transport';

// Type alias (não interface) para continuar atribuível a Record<string, unknown>
// em settingsDefaults.
export type PaladinSettings = {
  enabled: boolean;
  maxConcurrent: number;
};

export const DEFAULT_SETTINGS: PaladinSettings = {
  enabled: true,
  maxConcurrent: 1,
};

// Único setting consultado pelo ciclo é "enabled"; o restante não tem efeito
// neste porte, então não entra no formulário.
const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'enabled',
    label: 'Ativar o recrutamento do Paladino',
    type: 'boolean',
    help: 'Desmarcado: o ciclo apenas reporta status e não age na Estátua.',
  },
];

registerTsh({
  id: 'paladin-training',
  label: 'Treinamento do Paladino',
  desc: 'Recruta o Paladino na Estátua quando o slot de recrutamento está livre (máx. 1 lançamento por ciclo).',
  category: 'economia',
  screen: 'statue',
  mutating: true,
  cooldownMs: 5 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  async runCycle(ctx) {
    const settings = ctx.storage.get('settings', DEFAULT_SETTINGS);
    if (!settings.enabled) {
      ctx.status('Treinamento de Paladino desativado nas configurações.', 'info');
      return;
    }
    if (document.querySelector('a.knight_recruit_launch') === null) {
      // Porta do readPaladin: sem lançador, o paladino existe ou treina.
      if (document.querySelector('a[href*="screen=statue"][href*="mode=resident"]') !== null) {
        ctx.status(
          'Slot ocupado: o Paladino já está recrutado; ações de treinamento ainda não têm transporte certificado.',
          'info',
        );
        return;
      }
      const box = document.querySelector('#knight_box, [data-paladin], .paladin-status');
      if (box !== null && box.querySelector('[data-paladin-training], .trainqueue, .timer') !== null) {
        ctx.status('Em treino: o Paladino desta aldeia já está em treinamento.', 'info');
        return;
      }
      ctx.status(
        'Estado ilegível: nem lançador, nem paladino presente, nem treino visível na Estátua — nada foi feito.',
        'info',
      );
      return;
    }
    ctx.status('Slot livre: lançando o recrutamento do Paladino da Estátua…', 'info');
    await launchPaladinTraining();
    ctx.status('Recrutamento do Paladino lançado.', 'ok');
  },
});
