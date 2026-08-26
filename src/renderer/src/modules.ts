/**
 * Dados estáticos dos módulos SG (fonte: docs/MODULOS-SG.md).
 * `title` = rótulo curto (páginas e cards); `navLabel` = rótulo ainda mais curto
 * para a sidebar (evita truncamento); `description` = 1 linha usada no dashboard;
 * `originalLabel` = rótulo ORIGINAL da ferramenta replicada (usado nos placeholders);
 * `flows` = 2-3 bullets do que o módulo faz (resumo da especificação).
 */
import type { LucideIcon } from 'lucide-react';
import {
  Crosshair,
  ListChecks,
  MessageSquareText,
  Radar,
  ScrollText,
  ShieldCheck,
  Swords,
} from 'lucide-react';

export type ModuleId = 'sg1' | 'sg2' | 'sg3' | 'sg4' | 'sg5' | 'sg6' | 'sg7';

/** Sala de Guerra (P0-4): monitoramento ao vivo de uma OP arquivada. */
export type WarPageId = 'guerra';

export type SystemPageId = 'dashboard' | 'sessao' | 'config' | 'journal' | 'captures';

export type PageId = ModuleId | WarPageId | SystemPageId;

export interface ModuleInfo {
  id: ModuleId;
  title: string;
  /** Rótulo compacto exibido na sidebar. */
  navLabel: string;
  description: string;
  originalLabel: string;
  phase: number;
  icon: LucideIcon;
  flows: readonly string[];
}

export const MODULES: readonly ModuleInfo[] = [
  {
    id: 'sg1',
    title: 'Análise de Aldeias',
    navLabel: 'Análise de Aldeias',
    description: 'Distâncias por tempo de nobre e mapa do mundo',
    originalLabel: 'Análise de Aldeias e Distâncias',
    phase: 1,
    icon: Radar,
    flows: [
      'Tempo de nobre de cada aldeia da tribo até o inimigo mais próximo, com filtros de TAGs, continentes K e coordenadas consideradas/desconsideradas.',
      'Contagem por faixa de distância (<1h até >34h) para achar o front que precisa de blindagem.',
      'Mapa do mundo com aldeias pintadas por tribo e destaques em branco.',
    ],
  },
  {
    id: 'sg2',
    title: 'Análise de Tropas',
    navLabel: 'Análise de Tropas',
    description: 'Tropas recrutadas por aldeia com filtros',
    originalLabel: 'Análise de Tropas das Aldeias',
    phase: 2,
    icon: Swords,
    flows: [
      'Coleta as tropas recrutadas de cada aldeia, membro a membro, com progresso e dados guardados em memória.',
      'Filtros combináveis por unidade, escopo aldeia/jogador e lista de coordenadas colada do SG1.',
      'Sem filtro, classifica todas as aldeias em ofensivas e defensivas.',
    ],
  },
  {
    id: 'sg3',
    title: 'Análise de Defesa',
    navLabel: 'Análise de Defesa',
    description: 'Tropas nas aldeias, blind e apoiadores',
    originalLabel: 'Análise de Defesa das Aldeias',
    phase: 3,
    icon: ShieldCheck,
    flows: [
      'Tropas fisicamente presentes em cada aldeia — paradas e a caminho.',
      'Verificação de blind: quanto falta de cada unidade por aldeia do front, com BBCode pronto para o fórum.',
      'Apoiadores por aldeia, totais por apoiador e detecção de auto-apoio.',
    ],
  },
  {
    id: 'sg4',
    title: 'Criação de Operações',
    navLabel: 'Criação de OPs',
    description: 'OP por coordenada central e distribuição de alvos',
    originalLabel: 'Criação de Operações',
    phase: 4,
    icon: Crosshair,
    flows: [
      'OP por coordenada central: alvos e fakes por jogador, em faixas de 1 a 8 horas.',
      'Distribuição origem × alvo com tempo e moral, heatmap verde a vermelho.',
      'Parâmetros de prioridade, moral aceita e distância máxima antes de rodar.',
    ],
  },
  {
    id: 'sg5',
    title: 'Conferência de Comandos',
    navLabel: 'Conferência',
    description: 'Verificação e totalizador de comandos',
    originalLabel: 'Conferência de Comandos',
    phase: 5,
    icon: ListChecks,
    flows: [
      'Conferência alvo a alvo dos comandos compartilhados com a liderança.',
      'Totalizador por jogador: ataques grandes, fakes e comandos com nobre.',
      'Documento imprimível para arquivar a OP como prova.',
    ],
  },
  {
    id: 'sg6',
    title: 'Reservas e MPs',
    navLabel: 'Reservas e MPs',
    description: 'Reserva em massa e MPs personalizadas',
    originalLabel: 'Reservas e MPs',
    phase: 6,
    icon: MessageSquareText,
    flows: [
      'Reserva em massa por coordenada direto no planejador da tribo.',
      'MPs personalizadas com #alvos# trocado por jogador, em fila com pacing humano.',
      'Relatório final do que foi reservado e do que foi enviado.',
    ],
  },
  {
    id: 'sg7',
    title: 'Blindagem no Fórum',
    navLabel: 'Blindagem no Fórum',
    description: 'Conferência e ajuste de pedidos no fórum',
    originalLabel: 'Atualização de Blindagem no Fórum',
    phase: 7,
    icon: ScrollText,
    flows: [
      'Varre os posts do tópico e reconhece pedidos no formato pedido/lanceiros/espadachins/arqueiros.',
      'Soma o enviado por pedido e aponta o que ainda falta.',
      'Ajusta a tabela do primeiro post e apaga os comentários processados, sempre com confirmação.',
    ],
  },
];
