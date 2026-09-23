// Auditoria de TODOS os formulários de Automações: cada campo que o usuário
// edita precisa voltar ao reabrir (loadSettings só relê chaves presentes em
// settingsDefaults) e o padrão precisa caber nos limites/opções do próprio
// campo — senão o "Salvar" grava outra coisa ou a edição some.
import { describe, expect, it } from 'vitest';
import { tshAutomations } from './tsh-runtime';
import './plugins/abrir-pacotes';
import './plugins/ativador-itens';
import './plugins/auto-farm';
import './plugins/auto-mint-nativo';
import './plugins/barbarian-cultivator';
import './plugins/coin-center';
import './plugins/collection';
import './plugins/command-scheduler';
import './plugins/conquista-livres';
import './plugins/doador-prestigio';
import './plugins/map-farm';
import './plugins/mass-support';
import './plugins/mega-builder';
import './plugins/op-generator';
import './plugins/paladin-training';
import './plugins/paladino-skills';
import './plugins/premium-exchange';
import './plugins/producao-nobres';
import './plugins/recruitment';
import './plugins/renomeador-aldeias';
import './plugins/resource-balancer';
import './plugins/support-manager';
import './plugins/wall-demolition';

describe('formulários de Automações', () => {
  const problemas: string[] = [];
  for (const automation of tshAutomations()) {
    const defaults = automation.settingsDefaults ?? {};
    for (const field of automation.settingsForm ?? []) {
      const where = `${automation.id}.${field.key}`;
      if (!(field.key in defaults)) {
        problemas.push(`${where}: campo sem valor padrão — a edição não volta ao reabrir`);
        continue;
      }
      const def = defaults[field.key];
      if (field.type === 'number') {
        if (typeof def !== 'number') problemas.push(`${where}: padrão não é número (${JSON.stringify(def)})`);
        else if ((field.min !== undefined && def < field.min) || (field.max !== undefined && def > field.max)) {
          problemas.push(`${where}: padrão ${def} fora de ${field.min}..${field.max}`);
        }
      } else if (field.type === 'boolean' && typeof def !== 'boolean') {
        problemas.push(`${where}: padrão não é booleano`);
      } else if (field.type === 'select' && !(field.options ?? []).some((o) => o.value === def)) {
        problemas.push(`${where}: padrão ${JSON.stringify(def)} não está nas opções`);
      } else if ((field.type === 'text' || field.type === 'textarea') && typeof def !== 'string') {
        problemas.push(`${where}: padrão de texto não é string (${typeof def})`);
      } else if (field.type === 'record' && (typeof def !== 'object' || def === null)) {
        problemas.push(`${where}: padrão de grade não é objeto`);
      }
    }
  }

  it('todo campo relê o valor salvo e tem padrão válido', () => {
    expect(tshAutomations().length).toBeGreaterThan(15);
    expect(problemas).toEqual([]);
  });
});
