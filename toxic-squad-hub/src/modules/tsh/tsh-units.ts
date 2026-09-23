// Ícones das unidades do Tribal Wars para as grades do painel (record do
// settings-ui e grade de unidades do commands-ui). O jogo serve os ícones em
// caminho relativo SAME-ORIGIN (`graphic/unit/unit_<key>.png`), que resolve
// contra a página game.php mesmo dentro do Shadow DOM do shell — os módulos
// Vanta já usam o mesmo caminho. Rótulos pt-BR únicos (mesmos textos da tela
// Comandos); chave desconhecida = fail-soft (mostra a própria key).

/** Chave de unidade do jogo → rótulo pt-BR. */
export const UNIT_LABELS: Record<string, string> = {
  spear: 'Lança',
  sword: 'Espada',
  axe: 'Machado',
  archer: 'Arqueiro',
  spy: 'Explorador',
  light: 'Cav. Leve',
  marcher: 'Arq. Cavalo',
  heavy: 'Cav. Pesada',
  ram: 'Aríete',
  catapult: 'Catapulta',
  knight: 'Paladino',
  snob: 'Nobre',
};

/** True quando a chave é uma unidade com ícone no jogo. */
export function isUnitKey(key: string): boolean {
  return UNIT_LABELS[key] !== undefined;
}

/** Rótulo pt-BR da unidade; fora da lista devolve a própria chave. */
export function unitLabelOrKey(key: string): string {
  return UNIT_LABELS[key] ?? key;
}

/** <img> do ícone da unidade (18px por padrão); alt/title com o rótulo pt-BR. */
export function unitIcon(key: string, size = 18): HTMLImageElement {
  const img = document.createElement('img');
  img.src = `graphic/unit/unit_${key}.png`;
  img.alt = unitLabelOrKey(key);
  img.title = unitLabelOrKey(key);
  img.draggable = false;
  img.width = size;
  img.height = size;
  img.style.verticalAlign = 'middle';
  return img;
}
