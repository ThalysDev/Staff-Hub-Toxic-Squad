export type ModuleExecution = 'PAGE' | 'BACKGROUND';

export type ToxicModuleId =
  | 'auto-farm'
  | 'wall-demolition'
  | 'barbarian-cultivator'
  | 'coin-center'
  | 'premium-exchange'
  | 'command-scheduler'
  | 'recruitment'
  | 'collection'
  | 'resource-balancer'
  | 'paladin-training'
  | 'map-farm'
  | 'mega-builder'
  | 'op-generator'
  | 'mass-support'
  | 'support-manager';

export type PageRuntimeId =
  | 'farming-suite'
  | 'coin-center'
  | 'premium-exchange'
  | 'command-scheduler'
  | 'recruitment'
  | 'village-headquarters'
  | 'market-send'
  | 'statue'
  | 'scavenging'
  | 'scavenging-mass'
  | 'villages-overview'
  | 'units-overview'
  | 'commands-overview';

export interface PageRuntime {
  id: PageRuntimeId;
  screen: 'am_farm' | 'snob' | 'market' | 'place' | 'train' | 'main' | 'statue' | 'scavenge' | 'overview_villages';
  mode?: 'combined' | 'exchange' | 'send' | 'scavenge' | 'scavenge_mass' | 'units' | 'commands';
  label: string;
  maxTabsPerWorld: 4;
}

export interface ModuleManifest {
  id: ToxicModuleId;
  name: string;
  description: string;
  execution: ModuleExecution;
  cardId: string;
  routeLabel: string;
  runtimeId?: PageRuntimeId;
  /** Módulo com superfície de prévia de planejamento (somente leitura). */
  preview?: true;
}

/**
 * Módulos com prévia de planejamento: o cartão ganha "Gerar prévia" e o
 * editor de regras ganha a ponte "Ver prévia" após salvar.
 */
export const PLAN_PREVIEW_MODULES: readonly ToxicModuleId[] = [
  'auto-farm',
  'op-generator',
  'mass-support',
  'support-manager',
  'resource-balancer',
];

export const pageRuntimes: readonly PageRuntime[] = [
  {
    id: 'farming-suite',
    screen: 'am_farm',
    mode: 'combined',
    label: 'Assistente de Saque',
    maxTabsPerWorld: 4,
  },
  {
    id: 'coin-center',
    screen: 'snob',
    label: 'Academia',
    maxTabsPerWorld: 4,
  },
  {
    id: 'premium-exchange',
    screen: 'market',
    mode: 'exchange',
    label: 'Mercado Premium',
    maxTabsPerWorld: 4,
  },
  {
    id: 'command-scheduler',
    screen: 'place',
    label: 'Praça de Reunião',
    maxTabsPerWorld: 4,
  },
  {
    id: 'recruitment',
    screen: 'train',
    label: 'Praça de Recrutamento',
    maxTabsPerWorld: 4,
  },
  {
    id: 'village-headquarters',
    screen: 'main',
    label: 'Edifício Principal',
    maxTabsPerWorld: 4,
  },
  {
    id: 'market-send',
    screen: 'market',
    mode: 'send',
    label: 'Mercado — Enviar Recursos',
    maxTabsPerWorld: 4,
  },
  {
    id: 'statue',
    screen: 'statue',
    label: 'Estátua do Paladino',
    maxTabsPerWorld: 4,
  },
  {
    id: 'scavenging',
    screen: 'place',
    mode: 'scavenge',
    label: 'Coleta (Praça de Reunião)',
    maxTabsPerWorld: 4,
  },
  {
    id: 'scavenging-mass',
    screen: 'place',
    mode: 'scavenge_mass',
    label: 'Coleta em Massa',
    maxTabsPerWorld: 4,
  },
  {
    id: 'villages-overview',
    screen: 'overview_villages',
    mode: 'combined',
    label: 'Visualizações (todas as aldeias)',
    maxTabsPerWorld: 4,
  },
  {
    id: 'units-overview',
    screen: 'overview_villages',
    mode: 'units',
    label: 'Tropas Próprias (Visualizações)',
    maxTabsPerWorld: 4,
  },
  {
    id: 'commands-overview',
    screen: 'overview_villages',
    mode: 'commands',
    label: 'Visão de Comandos (Visualizações)',
    maxTabsPerWorld: 4,
  },
];

export const moduleCatalog: readonly ModuleManifest[] = [
  {
    id: 'auto-farm',
    name: 'Auto Farm',
    description: 'Organiza saques recorrentes por templates, distância, pontos e perdas máximas.',
    execution: 'PAGE',
    cardId: 'farming-suite',
    routeLabel: 'Assistente de Saque',
    runtimeId: 'farming-suite',
    preview: true,
  },
  {
    id: 'wall-demolition',
    name: 'Demolidor de Muralhas',
    description: 'Calcula e acompanha ondas com aríetes contra alvos elegíveis.',
    execution: 'PAGE',
    cardId: 'farming-suite',
    routeLabel: 'Assistente de Saque',
    runtimeId: 'farming-suite',
  },
  {
    id: 'barbarian-cultivator',
    name: 'Cultivador de Bárbaras',
    description: 'Planeja catapultas para remover edifícios configurados e favorecer minas.',
    execution: 'PAGE',
    cardId: 'farming-suite',
    routeLabel: 'Assistente de Saque',
    runtimeId: 'farming-suite',
  },
  {
    id: 'coin-center',
    name: 'Central de Moedas',
    description: 'Controla cunhagem e distribuição de recursos para a Academia.',
    execution: 'PAGE',
    cardId: 'coin-center',
    routeLabel: 'Academia',
    runtimeId: 'coin-center',
  },
  {
    id: 'premium-exchange',
    name: 'Mercado Premium',
    description: 'Aplica regras de compra e venda por estoque, preço e cooldown.',
    execution: 'PAGE',
    cardId: 'premium-exchange',
    routeLabel: 'Troca Premium',
    runtimeId: 'premium-exchange',
  },
  {
    id: 'command-scheduler',
    name: 'Agendador',
    description: 'Coordena ataques, apoios, nobres, fakes e ondas por horário.',
    execution: 'PAGE',
    cardId: 'command-scheduler',
    routeLabel: 'Praça de Reunião',
    runtimeId: 'command-scheduler',
  },
  {
    id: 'recruitment',
    name: 'Recrutamento',
    description: 'Preenche metas de tropas com prioridades e reservas por grupo.',
    execution: 'PAGE',
    cardId: 'recruitment',
    routeLabel: 'Praça de Recrutamento',
    runtimeId: 'recruitment',
  },
  {
    id: 'collection',
    name: 'Coleta e Desbloqueio',
    description: 'Desbloqueia e envia grupos de coleta com critérios por aldeia.',
    execution: 'PAGE',
    cardId: 'collection',
    routeLabel: 'Coleta',
    runtimeId: 'scavenging-mass',
  },
  {
    id: 'resource-balancer',
    name: 'Balanceador',
    description: 'Distribui recursos entre doadoras e receptoras respeitando reservas.',
    execution: 'PAGE',
    cardId: 'resource-balancer',
    routeLabel: 'Mercado — Enviar Recursos',
    runtimeId: 'market-send',
    preview: true,
  },
  {
    id: 'paladin-training',
    name: 'Paladinos em Massa',
    description: 'Acompanha recrutamento, recuperação e treinamento do Paladino.',
    execution: 'PAGE',
    cardId: 'paladin-training',
    routeLabel: 'Estátua do Paladino',
    runtimeId: 'statue',
  },
  {
    id: 'map-farm',
    name: 'Auto Farm pelo Mapa',
    description: 'Descobre bárbaras novas em regiões configuradas e alimenta a lista de alvos.',
    execution: 'BACKGROUND',
    cardId: 'map-farm',
    routeLabel: 'Execução em background',
  },
  {
    id: 'mega-builder',
    name: 'Mega Construtor',
    description: 'Planeja filas de construção, dependências e conclusão permitida pelo jogo.',
    execution: 'PAGE',
    cardId: 'mega-builder',
    routeLabel: 'Edifício Principal',
    runtimeId: 'village-headquarters',
  },
  {
    id: 'op-generator',
    name: 'Gerador de OPs',
    description:
      'Planeja operações: pareia aldeias de origem com alvos por seis critérios, com refinamento de distâncias e avisos de segurança.',
    execution: 'BACKGROUND',
    cardId: 'op-generator',
    routeLabel: 'Execução em background',
    preview: true,
  },
  {
    id: 'mass-support',
    name: 'Apoio em Massa',
    description:
      'Planeja envios de apoio por modo imediato ou metas de defesa, com alocação por estratégia e distância.',
    execution: 'PAGE',
    cardId: 'mass-support',
    routeLabel: 'Praça de Reunião',
    runtimeId: 'command-scheduler',
    preview: true,
  },
  {
    id: 'support-manager',
    name: 'Gestão de Apoio',
    description: 'Planeja retiradas de apoio de guarnições e envios por percentual selecionado.',
    execution: 'BACKGROUND',
    cardId: 'support-manager',
    routeLabel: 'Execução em background',
    preview: true,
  },
];

export function getModuleManifest(id: ToxicModuleId): ModuleManifest {
  const module = moduleCatalog.find((candidate) => candidate.id === id);
  if (!module) throw new Error(`Módulo desconhecido: ${id}`);
  return module;
}
