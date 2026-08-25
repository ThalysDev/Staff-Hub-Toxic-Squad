/**
 * Dados estáticos dos módulos SG (fonte: docs/MODULOS-SG.md).
 * `title` = rótulo curto de navegação; `description` = 1 linha usada no dashboard;
 * `originalLabel` = rótulo ORIGINAL da ferramenta replicada (usado nos placeholders).
 */

export type ModuleId = 'sg1' | 'sg2' | 'sg3' | 'sg4' | 'sg5' | 'sg6' | 'sg7';

export type SystemPageId = 'dashboard' | 'sessao' | 'config' | 'journal' | 'captures';

export type PageId = ModuleId | SystemPageId;

export interface ModuleInfo {
  id: ModuleId;
  title: string;
  description: string;
  originalLabel: string;
  phase: number;
}

export const MODULES: readonly ModuleInfo[] = [
  { id: 'sg1', title: 'Análise de Aldeias', description: 'Distâncias por tempo de nobre e mapa do mundo', originalLabel: 'Análise de Aldeias e Distâncias', phase: 1 },
  { id: 'sg2', title: 'Análise de Tropas', description: 'Tropas recrutadas por aldeia com filtros', originalLabel: 'Análise de Tropas das Aldeias', phase: 2 },
  { id: 'sg3', title: 'Análise de Defesa', description: 'Tropas nas aldeias, blind e apoiadores', originalLabel: 'Análise de Defesa das Aldeias', phase: 3 },
  { id: 'sg4', title: 'Criação de Operações', description: 'OP por coordenada central e distribuição de alvos', originalLabel: 'Criação de Operações', phase: 4 },
  { id: 'sg5', title: 'Conferência de Comandos', description: 'Verificação e totalizador de comandos', originalLabel: 'Conferência de Comandos', phase: 5 },
  { id: 'sg6', title: 'Reservas e MPs', description: 'Reserva em massa e MPs personalizadas', originalLabel: 'Reservas e MPs', phase: 6 },
  { id: 'sg7', title: 'Blindagem no Fórum', description: 'Conferência e ajuste de pedidos no fórum', originalLabel: 'Atualização de Blindagem no Fórum', phase: 7 },
];