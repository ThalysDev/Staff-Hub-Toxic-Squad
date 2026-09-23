import type { ToxicModuleId } from '../../core/catalog/module-catalog';
import type { HubWorldState } from '../../core/state/hub-state';

export type ResourceType = 'wood' | 'stone' | 'iron';
export type UnitType =
  'spear' | 'sword' | 'axe' | 'archer' | 'spy' | 'light' | 'marcher' | 'heavy' | 'ram' | 'catapult' | 'knight' | 'snob';

export interface VillageTarget {
  id: string;
  x: number;
  y: number;
  points: number;
  wallLevel: number;
  barbarian: boolean;
  buildings?: Record<string, number>;
}

export interface VillageSnapshot {
  id: string;
  name: string;
  groups: string[];
  resources: Record<ResourceType, number>;
  troops: Partial<Record<UnitType, number>>;
  targets: VillageTarget[];
  /**
   * Tropas PRÓPRIAS do jogador (Visualização "Próprias" —
   * `overview_villages&mode=units&type=own_home`: na aldeia + fora em
   * ataques/farm/apoios). Ausente quando a sub-aba ainda não foi lida; as
   * metas de recrutamento usam esta contagem com fallback em `troops`.
   */
  troopsOwnHome?: Partial<Record<UnitType, number>>;
  merchants?: { available: number; capacity: number };
  queue?: { building?: string; unit?: UnitType; endsAt?: string };
  collection?: { unlocked: boolean; activeSlots: number; maxSlots: number };
  paladin?: { recruited: boolean; training: boolean };
  buildings?: Record<string, number>;
  exchange?: Partial<Record<ResourceType, { rate: number; stock: number }>>;
  premiumPoints?: number;
  researchedUnits?: UnitType[];
  storage?: number;
  points?: number;
  x?: number;
  y?: number;
}

export interface ScheduledCommand {
  id: string;
  kind: 'attack' | 'support' | 'noble' | 'fake';
  sourceVillageId: string;
  target: { x: number; y: number };
  sendAt: string;
  units: Partial<Record<UnitType, number>>;
  /**
   * Pontos da aldeia alvo, quando conhecidos. Presentes, habilitam a checagem
   * do limite de fakes do mundo no planejador (ver game-data).
   */
  targetPoints?: number;
}

export interface WorldSnapshot {
  worldId: string;
  serverTime: string;
  villages: VillageSnapshot[];
  scheduledCommands: ScheduledCommand[];
  pendingCommandConfirmation?: {
    /**
     * Tipo da confirmação lida do hidden `support` da tela (presente → apoio;
     * ausente → ataque, doc vivo 20/08/2026). O matcher exige igualdade com o
     * tipo do comando esperado — confirmar a tela ERRADA é irreversível.
     */
    kind: 'attack' | 'support';
    targetLabel?: string;
    durationText?: string;
    arrivalText?: string;
    /**
     * Coordenada do alvo lida do form de confirmação (mesmo
     * `#command-data-form` do passo 1). Ausente quando a tela não expõe os
     * inputs — o matcher de comando falha-fechado (nunca confirma às cegas).
     */
    target?: { x: number; y: number };
    /** Quantidades por unidade lidas do form de confirmação (leitura defensiva). */
    units?: Partial<Record<UnitType, number>>;
  };
}

export interface PlannedAction {
  kind: string;
  payload: Record<string, unknown>;
}

export interface MutationReceipt {
  accepted: boolean;
  externalId?: string;
  uncertain?: boolean;
}

export interface ModuleTransport {
  submit(action: PlannedAction): Promise<MutationReceipt>;
  verify(
    action: PlannedAction,
    receipt: MutationReceipt,
  ): Promise<{ status: 'ACTION_VERIFIED' | 'RESULT_UNCERTAIN' | 'BLOCKED'; reason?: string }>;
}

export interface ModuleContext {
  worldId: string;
  playerName: string;
  now: Date;
  snapshot: WorldSnapshot;
  currentRuntime?: string;
  transport?: ModuleTransport;
  /** Estado do Hub (registro de aldeias e snapshots das Visualizações) para módulos multi-aldeia. */
  hubWorldState?: HubWorldState;
  /**
   * Armado no ciclo de página (regra efetiva da cascata). A prévia e os
   * ciclos em modo de planejamento NUNCA carregam este campo: o plano de
   * execução (1 mutação) só nasce num ciclo armado.
   */
  armed?: boolean;
  /** Documento vivo da aba, disponível para gates de página no plan() quando um módulo precisar inspecionar o DOM. */
  document?: Document;
  /**
   * Fatos específicos de módulos, sempre validados pelo schema da feature
   * antes do planejamento. Readers de página alimentam este mapa sem acoplar
   * os contratos compartilhados aos detalhes de cada automação.
   */
  featureFacts?: Partial<Record<ToxicModuleId, unknown>>;
  /**
   * Passo 1 do Apoio em Massa rastreado pelo runner (submit do form da
   * Praça): presente na segunda chamada de plan() quando a página releída
   * mostra a tela de confirmação (ou quando o passo 1 de um ciclo anterior
   * ainda aguarda o passo 2). A confirmação pendente SÓ é confirmada quando
   * corresponde a este comando — telas alheias nunca são confirmadas.
   */
  stepOneCommand?: {
    commandId: string;
    /** Tipo do comando submetido no passo 1 (o passo 2 exige o mesmo tipo na tela). */
    kind: 'attack' | 'support';
    target: { x: number; y: number };
    units: Partial<Record<UnitType, number>>;
  };
}

export function createDefaultWorldSnapshot(worldId: string): WorldSnapshot {
  return {
    worldId,
    serverTime: new Date(0).toISOString(),
    villages: [],
    scheduledCommands: [],
  };
}

export interface ModulePlan {
  operationId: string;
  moduleId: ToxicModuleId;
  worldId: string;
  villageId?: string;
  locks: string[];
  payload: Record<string, unknown>;
  action: PlannedAction;
}

export type ModulePlanResult =
  { kind: 'NO_WORK'; reason: string; warnings?: readonly unknown[] } | { kind: 'PLAN'; plan: ModulePlan };

export interface ModuleDetection {
  compatible: boolean;
  state: 'READY' | 'WAITING_PAGE' | 'SESSION_REQUIRED' | 'INCOMPATIBLE';
  reason?: string;
}

export interface ModulePlugin<Settings = Record<string, unknown>> {
  manifest: { id: ToxicModuleId; execution: 'PAGE' | 'BACKGROUND'; runtimeId?: string };
  settingsSchema: { parse(input: unknown): Settings };
  detect(context: ModuleContext): ModuleDetection;
  plan(context: ModuleContext, settings: Settings): Promise<ModulePlanResult>;
  execute(context: ModuleContext, plan: ModulePlan): Promise<MutationReceipt>;
  verify(
    context: ModuleContext,
    plan: ModulePlan,
    receipt: MutationReceipt,
  ): Promise<{ status: 'ACTION_VERIFIED' | 'RESULT_UNCERTAIN' | 'BLOCKED'; reason?: string }>;
  recover(context: ModuleContext, plan: ModulePlan): Promise<{ status: 'RECOVERED' | 'BLOCKED'; reason?: string }>;
}
