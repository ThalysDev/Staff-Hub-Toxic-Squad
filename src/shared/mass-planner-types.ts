// Sala de Guerra · Planner de OP em Massa — CONTRATO (tipos e constantes).
// v0.29.0 alinhado À FERRAMENTA REAL (twmassplanner.pro, provado por gerações
// reais capturadas): cotas "1;2" POR GRUPO de coordenadas (cota por vila do
// grupo), chegadas Fixa / Intervalo (início e fim) / Fixa com intervalo por
// aldeia (delay SEQUENCIAL entre ataques, na ordem de atribuição), modos
// Otimizado / Distribuído por players / Mais perto (+ Mais longe, extra nosso),
// e IDs das vilas no comando (o link da praça da exportação usa o ID da vila
// de ORIGEM). Tudo aqui é dado puro — lógica em mass-planner-engine.ts.

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
  /** Chegadas espalhadas ENTRE o datetime de início e o de fim (janela). */
  | 'intervalo'
  /** Base fixa com DELAY SEQUENCIAL entre ataques: o k-ésimo ataque atribuído
   *  (ordem de distância crescente) chega base + k×delay. Label original da
   *  ferramenta: "Fixa com intervalo por aldeia". */
  | 'sequencial';

/** Como as origens são atribuídas aos alvos por distância. */
export type MassAssignMode =
  /** Melhor atribuição geral: guloso global por menor distância do conjunto
   *  (aproximação determinística do matching de custo mínimo do tool real). */
  | 'otimizado'
  /** Distribui os alvos de forma JUSTA entre os JOGADORES de origem
   *  (ferramenta real "Distributed by players"); heurística determinística. */
  | 'por-jogador'
  /** Cada alvo recebe as origens mais PRÓXIMAS ainda disponíveis. */
  | 'mais-perto'
  /** Cada alvo recebe as origens mais DISTANTES ainda disponíveis (extra nosso —
   *  a ferramenta real não tem este modo). */
  | 'mais-longe';

/** Proteção de bônus noturno: chegada dentro da janela é empurrada para depois. */
export type MassNightBonusMode = 'desativado' | 'reagendar';

/** Edifícios-alvo de catapulta (19 da ferramenta original, pt-BR). */
export interface MassBuildingDef {
  /** Id técnico do jogo (ex.: "main") — é o que a exportação BBCode emite. */
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
  /** Cota de usos DE CADA ORIGEM (resolvida dos grupos "1;2"; mesma ordem de origins). */
  originQuotas: number[];
  targets: MassCoordEntry[];
  /** Cota de ataques DE CADA ALVO (resolvida dos grupos "1;1"; mesma ordem de targets). */
  targetQuotas: number[];
  /** Permite reusar a mesma origem contra o MESMO jogador-alvo (alvos DIFERENTES). */
  repeatOriginSamePlayer: boolean;
  /** Torres de Vigia INIMIGAS: pares cuja trajetória passa dentro do raio são descartados. */
  towers: MassCoordEntry[];
  towerRadius: number;
  /** Unidade que dita a velocidade do comando (do unit-info do mundo — nunca hardcode). */
  slowestUnit: UnitId;
  /** Modo de atribuição origem→alvo por distância. */
  assignMode: MassAssignMode;
  minDistance: number;
  maxDistance: number;
  arrivalKind: MassArrivalKind;
  /** Data/hora base de chegada (epoch ms local). Fixa = chegada exata; sequencial = base do 1º ataque; intervalo = referência legada (não usado). */
  arrivalBaseMs: number;
  /** Janela do modo "intervalo": chegadas espalhadas entre início e fim (epoch ms local). */
  windowStartMs: number;
  windowEndMs: number;
  /** Delay SEQUENCIAL entre ataques em segundos (modo "fixa com intervalo por aldeia"). */
  attackDelaySeconds: number;
  nightBonus: MassNightBonusMode;
  /** Evita dois comandos no MESMO ms para o MESMO jogador (resolvido na OP inteira). */
  avoidMsConflict: boolean;
  /** Moral mínima 0–100 (0 = ignorar). Mundo sem moral força 0 fora da engine. */
  minMorale: number;
  /** Edifícios-alvo de catapulta (ids de MASS_BUILDINGS; vazio = export usa "farm", como o tool real). */
  catapultTargets: string[];
}

/** Contexto do mundo INJETADO pelo caller (a engine pura nunca consulta rede/relógio). */
export interface MassPlanContext {
  /** Minutos-por-campo EFETIVOS por unidade (unit-info do mundo; valor servido já é final). */
  unitMinutesPerField: Partial<Record<UnitId, number>>;
  /** Janela do bônus noturno do get_config — MESMA forma do NightBonusCfg. O IPC
   *  world:night-bonus devolve {active,startHour,endHour}: o caller converte. */
  nightBonus: { nightBonusActive: boolean; nightStartHour: number; nightEndHour: number };
  /** Pontos da VILDEJA por "x|y" (dump do mundo; ausente = desconhecido). */
  villagePoints: ReadonlyMap<string, number>;
  /** Nick do dono por "x|y" (dump; ausente/bárbaro = desconhecido). */
  ownerByCoord: ReadonlyMap<string, string>;
  /** Pontos do JOGADOR por nick (dump; moral usa pontos do dono da origem). */
  playerPoints: ReadonlyMap<string, number>;
  /** ID interno da VILDEJA por "x|y" (dump village.txt) — o link da praça na
   *  exportação BBCode usa o ID da vila de ORIGEM (igual ao tool real). */
  villageIdByCoord: ReadonlyMap<string, number>;
  /** Mundo tem moral por pontos (get_config disable_morale). */
  moralActive: boolean;
}

/** Um comando gerado da operação (linha da tabela e das exportações). */
export interface MassPlanCommand {
  groupId: string;
  groupName: string;
  /** "x|y" de origem. */
  origin: string;
  /** ID interno da vila de origem no dump (null = desconhecido — link degradado). */
  originVillageId: number | null;
  /** "x|y" do alvo. */
  target: string;
  /** ID interno da vila de alvo no dump (null = desconhecido). */
  targetVillageId: number | null;
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
    | 'windowStartMs'
    | 'windowEndMs'
    | 'attackDelaySeconds'
    | 'minMorale'
    | 'catapultTargets',
    string
  >
>;
