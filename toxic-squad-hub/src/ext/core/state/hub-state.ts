// vendored: subconjunto MÍNIMO de core/state/hub-state da extensão Toxic Squad
// Hub (origem: toxic-squad-hub-ext). O original puxa infra da extensão
// (profile-config/cascata de configuração, ledgers de features, readers de
// página, atividades); o espelho userscript precisa apenas do que
// scheduler-state e seus testes usam: identidade do mundo, settings por módulo
// (`command-scheduler`), snapshots de coordenadas das aldeias e o slot
// `scheduler`. Fora do recorte e NÃO portados: setModuleEnabled/Status,
// resolveEffectiveModule, overrides de profile, appendActivity e os merges de
// leitura; normalizeWorldState perdeu apenas a higiene de campos que não
// existem neste subconjunto (renameExecutionLedger legado e overrides de
// escopo do módulo removido village-rename).
import { moduleCatalog, type ToxicModuleId } from '../catalog/module-catalog';
import { migrateLegacySchedulerCommands, type HubSchedulerState } from '../scheduler-state';

export type HubModuleStatus =
  | 'DISABLED'
  | 'IDLE'
  | 'WAITING_PAGE'
  | 'SCHEDULED'
  | 'RUNNING'
  | 'COOLDOWN'
  | 'BLOCKED'
  | 'CAPTCHA'
  | 'SESSION_REQUIRED'
  | 'INCOMPATIBLE'
  | 'ERROR';

export interface HubModuleState {
  enabled: boolean;
  status: HubModuleStatus;
  settings: Record<string, unknown>;
}

export interface HubWorldState {
  worldId: string;
  worldLabel: string;
  playerName: string;
  modules: Record<ToxicModuleId, HubModuleState>;
  updatedAt: string;
  /** Último snapshot conhecido por aldeia (a migração legado lê x/y daqui). */
  villageSnapshots?: Record<string, HubVillageSnapshot>;
  /**
   * Estado do Agendador de Comandos v2 (comandos de primeira classe com ciclo
   * de vida + espelho dos comandos em trânsito). Ausente apenas em estados
   * pré-redesign; `normalizeWorldState` garante o default e a migração única.
   */
  scheduler?: HubSchedulerState;
}

export interface HubVillageSnapshot {
  x?: number;
  y?: number;
  updatedAt: string;
}

export function createWorldState(input: Pick<HubWorldState, 'worldId' | 'worldLabel' | 'playerName'>): HubWorldState {
  const modules = Object.fromEntries(
    moduleCatalog.map((module) => [module.id, { enabled: false, status: 'DISABLED' as const, settings: {} }]),
  ) as Record<ToxicModuleId, HubModuleState>;
  return {
    ...input,
    modules,
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeWorldState(state: HubWorldState): HubWorldState {
  const modules = Object.fromEntries(
    moduleCatalog.map((module) => {
      const current = state.modules[module.id];
      return [
        module.id,
        current
          ? { ...current, settings: current.settings || {} }
          : { enabled: false, status: 'DISABLED' as const, settings: {} },
      ];
    }),
  ) as Record<ToxicModuleId, HubModuleState>;
  // Agendador v2: garante o slot do estado novo e roda a migração ÚNICA dos
  // settings.commands legados (flag `legacyMigratedAt`; os settings legados
  // NÃO são apagados — higiene de storage apenas. O motor lê a FONTE ÚNICA
  // state.scheduler, com dedupe por id contra o que já está lá).
  return migrateLegacySchedulerCommands({ ...state, modules });
}

export function setModuleSettings(
  state: HubWorldState,
  moduleId: ToxicModuleId,
  settings: Record<string, unknown>,
): HubWorldState {
  const current = state.modules[moduleId];
  if (!current) throw new Error(`Módulo ausente no estado: ${moduleId}`);
  return {
    ...state,
    modules: { ...state.modules, [moduleId]: { ...current, settings } },
    updatedAt: new Date().toISOString(),
  };
}
