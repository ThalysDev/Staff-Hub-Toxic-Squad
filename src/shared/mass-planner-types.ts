// Sala de Guerra · Planner de OP em Massa — CONTRATO (tipos e constantes).
// Inspirado no TW Mass Planner / Russian Planner, adaptado ao app: cada GRUPO
// é um lote de comandos de um tipo (fake, nuke, nobre…) com configuração
// própria; "Gerar Operação" junta todos numa única OP. Tudo aqui é dado puro —
// a lógica vive em mass-planner-engine.ts (pura, determinística) e os textos
// exportáveis em mass-planner-formats.ts.

import type { UnitId } from './units';

/** Coordenada já validada ("x|y" + eixos numéricos), na ordem digitada. */
export interface MassCoordEntry {
  /** Forma canônica "x|y" (identidade deduplicada). */
  coord: string;
  x: number;
  y: number;
}

/** Como as chegadas do grupo são calculadas a partir da data/hora base. */
export type MassArrivalKind =
  /** Todos chegam no MESMO horário exato (o da base). */
  | 'fixa'
  /** Chegadas espalhadas dentro de uma janela (base → base + janela). */
  | 'intervalo'
  /** Base fixa com deslocamento por ALDEIA-alvo (ondas por alvo). */
  | 'fixa-por-aldeia';

/** Como as origens são atribuídas aos alvos por distância. */
export type MassAssignMode =
  /** Melhor atribuição geral: guloso global por menor distância do conjunto. */
  | 'otimizado'
  /** Cada alvo recebe as origens mais PRÓXIMAS ainda disponíveis. */
  | 'mais-perto'
  /** Cada alvo recebe as origens mais DISTANTES ainda disponíveis. */
  | 'mais-longe';

/** Proteção de bônus noturno: chegada dentro da janela é empurrada para depois. */
export type MassNightBonusMode = 'desativado' | 'reagendar';

/** Edifícios-alvo de catapulta (19 da ferramenta original, pt-BR). */
export interface MassBuildingDef {
  /** Id técnico do jogo (ex.: "main"). */
  id: string;
  /** Nome pt-BR exibido (rótulo original da ferramenta). */
  name: string;
}

export const MASS_BUILDINGS: readonly MassBuildingDef[] = [
  { id: 'main', name: 'Edifício Principal' },
  { id: 'barracks', name: 'Quartel' },
  { id: 'stable', name: 'Estábulo' },
  { id: 'garage', name: 'Oficina' },
  { id: 'church', name: 'Igreja' },
  { id: 'first_church', name: 'Primeira Igreja' },
  { id: 'watchtower', name: 'Torre de Vigia' },
  { id: 'academy', name: 'Academia' },
  { id: 'smithy', name: 'Ferreiro' },
  { id: 'place', name: 'Praça de Reunião' },
  { id: 'statue', name: 'Estátua' },
  { id: 'market', name: 'Mercado' },
  { id: 'wood', name: 'Bosque' },
  { id: 'clay', name: 'Poço de Argila' },
  { id: 'iron', name: 'Mina de Ferro' },
  { id: 'farm', name: 'Fazenda' },
  { id: 'storage', name: 'Armazém' },
  { id: 'hide', name: 'Esconderijo' },
  { id: 'wall', name: 'Muralha' },
];

/** Raio de detecção da Torre de Vigia (campos) — confirmado pelo usuário. */
export const MASS_TOWER_RADIUS_DEFAULT = 15;

/** Configuração de UM grupo do planner (tudo no nível do grupo por decisão da spec). */
export interface MassGroupConfig {
  /** Identidade estável do grupo (gerada no "Adicionar Grupo" / carregada do rascunho). */
  id: string;
  /** "Modelo de Tropa" — rótulo livre do tipo de ataque (ex.: "nuke", "fake"). */
  nome: string;
  origins: MassCoordEntry[];
  targets: MassCoordEntry[];
  /** Torres de Vigia INIMIGAS: pares cuja trajetória passa dentro do raio são descartados. */
  towers: MassCoordEntry[];
  towerRadius: number;
  /** Unidade que dita a velocidade do comando (do unit-info do mundo — nunca hardcode). */
  slowestUnit: UnitId;
  /** Modo de atribuição origem→alvo por distância. */
  assignMode: MassAssignMode;
  /** Quantas vezes CADA origem pode ser usada (≥1). */
  commandsPerOrigin: number;
  /** Quantas vezes CADA alvo pode ser atacado (≥1). */
  commandsPerTarget: number;
  /** Permite reusar a mesma origem contra o MESMO jogador-alvo. */
  repeatOriginSamePlayer: boolean;
  /** Descarta pares com distância MENOR que este valor (campos; 0 = sem piso). */
  minDistance: number;
  /** Descarta pares com distância MAIOR que este valor (campos). */
  maxDistance: number;
  arrivalKind: MassArrivalKind;
  /** Data/hora base de chegada (epoch ms local). Fixa = chegada exata; intervalo = início; por-aldeia = base da 1ª aldeia. */
  arrivalBaseMs: number;
  /** Janela de espalhamento em minutos (arrivalKind "intervalo", ≥1). */
  windowMinutes: number;
  /** Deslocamento entre aldeias-alvo em segundos (arrivalKind "fixa-por-aldeia", ≥0). */
  perVillageSeconds: number;
  nightBonus: MassNightBonusMode;
  /** Evita dois comandos no MESMO ms para o MESMO jogador (resolvido na OP inteira). */
  avoidMsConflict: boolean;
  /** Moral mínima 0–100 (0 = ignorar). Mundo sem moral força 0 fora da engine. */
  minMorale: number;
  /** Edifícios-alvo de catapulta (ids de MASS_BUILDINGS; vazio = sem mira). */
  catapultTargets: string[];
}

/** Contexto do mundo INJETADO pelo caller (a engine pura nunca consulta rede/relógio). */
export interface MassPlanContext {
  /** Minutos-por-campo EFETIVOS por unidade (unit-info do mundo; valor servido já é final). */
  unitMinutesPerField: Partial<Record<UnitId, number>>;
  /** Janela do bônus noturno do get_config — MESMA forma do NightBonusCfg
   *  (nightBonusActive/nightStartHour/nightEndHour, como no WorldConfig). O IPC
   *  world:night-bonus devolve {active,startHour,endHour}: o caller converte. */
  nightBonus: { nightBonusActive: boolean; nightStartHour: number; nightEndHour: number };
  /** Pontos da VILDEJA por "x|y" (dump do mundo; ausente = desconhecido). */
  villagePoints: ReadonlyMap<string, number>;
  /** Nick do dono por "x|y" (dump; ausente/bárbaro = desconhecido). */
  ownerByCoord: ReadonlyMap<string, string>;
  /** Pontos do JOGADOR por nick (dump; moral usa pontos do dono da origem). */
  playerPoints: ReadonlyMap<string, number>;
  /** Mundo tem moral por pontos (get_config disable_morale). */
  moralActive: boolean;
}

/** Um comando gerado da operação (linha da tabela e das exportações). */
export interface MassPlanCommand {
  groupId: string;
  groupName: string;
  /** "x|y" de origem. */
  origin: string;
  /** "x|y" do alvo. */
  target: string;
  /** Dono do alvo pelo dump (null = desconhecido/bárbaro). */
  targetOwner: string | null;
  /** Dono da origem pelo dump (null = desconhecido) — executor do comando. */
  originOwner: string | null;
  unit: UnitId;
  /** Distância origem→alvo em campos (2 casas, mesma convenção de fieldsBetween). */
  distanceFields: number;
  /** Minutos de viagem no ritmo da unidade (sem bônus noturno no relógio de partida). */
  travelMinutes: number;
  /** Chegada (epoch ms local) já com agendamento/BN/ms aplicados. */
  arrivalMs: number;
  /** Partida calculada (epoch ms) = chegada − viagem (solver considera trecho noturno 2×). */
  sendMs: number;
  /** Miras de catapulta deste comando (ids de MASS_BUILDINGS; vazio = nenhuma). */
  catapultTargets: string[];
}

/** Telemetria de descartes de pares — NUNCA descarte silencioso (AGENTS.md). */
export interface MassDiscardEntry {
  reason: string;
  count: number;
}

export interface MassPlanResult {
  commands: MassPlanCommand[];
  /** Descartes agregados por motivo (distância, torre, moral, repetição…). */
  discards: MassDiscardEntry[];
  /** Avisos não-fatais (alvos sem origem disponível, chegada no passado, BN desligado no mundo…). */
  warnings: string[];
}

/** Erro de validação por campo do formulário ("nomeDoCampo" → mensagem PT-BR). */
export type MassGroupErrors = Partial<
  Record<
    | 'nome'
    | 'origins'
    | 'targets'
    | 'towers'
    | 'slowestUnit'
    | 'commandsPerOrigin'
    | 'commandsPerTarget'
    | 'minDistance'
    | 'maxDistance'
    | 'arrivalBaseMs'
    | 'windowMinutes'
    | 'perVillageSeconds'
    | 'minMorale'
    | 'catapultTargets',
    string
  >
>;
