// Tags do Renomeador — port fiel do TW Vanta (linhas 47-93 do original).
// Definição das 17 tags de renomeação de comandos + helpers de texto puro.
// Usado pelo Painel de Incomings (dashboard.ts) e pelo Renomeador da
// screen=overview (renomeador.ts).

/** Uma tag de renomeação de comando (rótulo "outro comentário"). */
export interface RenomeadorTag {
  id: string;
  /** Sufixo/prefixo gravado no rótulo ('' = tag que só limpa). */
  label: string;
  /** Texto do botão. */
  abbrev: string;
  /** Cor do gradiente de topo (fundo do botão / da célula do comando). */
  topGrad: string;
  /** Cor do gradiente de base. */
  botGrad: string;
  /** Cor do texto do botão. */
  textColor: string;
  /** Exclusiva: substitui as outras exclusivas (additive = apenas anexa). */
  exclusive: boolean;
  /** Tag "remover" (✕): limpa TODAS as tags do rótulo. */
  isRemove?: boolean;
}

export const RENOMEADOR_TAGS: readonly RenomeadorTag[] = [
  // Tags exclusivas (substituem umas às outras)
  { id: 'rezar',         label: '[Rezar]',         abbrev: '人',  topGrad: '#0d83dd', botGrad: '#0860a3', textColor: '#fff', exclusive: true },
  { id: 'morto',         label: '[Morto]',         abbrev: 'M',   topGrad: '#31c908', botGrad: '#228c05', textColor: '#fff', exclusive: true },
  { id: 'desviado',      label: '[Desviado]',      abbrev: 'D!',  topGrad: '#ef8b10', botGrad: '#d3790a', textColor: '#fff', exclusive: true },
  { id: 'desviar',       label: '[Desviar]',       abbrev: 'D',   topGrad: '#9232a8', botGrad: '#9232a8', textColor: '#fff', exclusive: true },
  { id: 'reconquistar',  label: '[Reconquistar]',  abbrev: 'R',   topGrad: '#adb6c6', botGrad: '#828891', textColor: '#fff', exclusive: true },
  { id: 'reconquistado', label: '[Reconquistado]', abbrev: 'RR',  topGrad: '#ffffff', botGrad: '#dbdbdb', textColor: '#000', exclusive: true },
  { id: 'snipado',       label: '[Snipado]',       abbrev: 'S!',  topGrad: '#22e5db', botGrad: '#0cd3c9', textColor: '#fff', exclusive: true },
  { id: 'snipar',        label: '[Snipar]',        abbrev: 'S',   topGrad: '#0d83dd', botGrad: '#0860a3', textColor: '#fff', exclusive: true },
  { id: 'fubar',         label: '[Fubar]',         abbrev: 'FU',  topGrad: '#004c00', botGrad: '#004c00', textColor: '#fff', exclusive: true },
  { id: 'snipecancel',   label: '[Snipe Cancel]',  abbrev: 'SC',  topGrad: '#e20606', botGrad: '#ff0000', textColor: '#fff', exclusive: true },
  { id: 'fake',          label: '[Fake]',          abbrev: 'FA',  topGrad: '#FFC0CB', botGrad: '#FFC0CB', textColor: '#000', exclusive: true },
  { id: 'possivelfull',  label: '[Possível Full]', abbrev: 'PV',  topGrad: '#00007f', botGrad: '#00007f', textColor: '#fff', exclusive: true },
  { id: 'reforcar',      label: '[Reforçar]',      abbrev: 'RF',  topGrad: '#40434E', botGrad: '#40434E', textColor: '#fff', exclusive: true },
  // Tags aditivas (anexadas, não exclusivas)
  { id: 'retirar',       label: ' | Retirar',      abbrev: 'R!',  topGrad: '#004c00', botGrad: '#004c00', textColor: '#fff', exclusive: false },
  { id: 'vigiar',        label: ' | Vigiar',       abbrev: 'V!',  topGrad: '#ffd91c', botGrad: '#e8c30d', textColor: '#000', exclusive: false },
  { id: 'check',         label: ' | ✓',            abbrev: '✓',   topGrad: '#93cf82', botGrad: '#93cf82', textColor: '#000', exclusive: false },
  { id: 'remover',       label: '',                 abbrev: '✕',   topGrad: '#888',    botGrad: '#666',    textColor: '#fff', exclusive: true, isRemove: true },
];

/** Remove as tags exclusivas do rótulo (deixa as aditivas). */
export function stripExclusiveTags(text: string): string {
  let result = text;
  for (const tag of RENOMEADOR_TAGS) {
    if (tag.exclusive && tag.label !== '') result = result.split(tag.label).join('');
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

/** Remove TODAS as tags do rótulo (exclusivas e aditivas). */
export function stripAllTags(text: string): string {
  let result = text;
  for (const tag of RENOMEADOR_TAGS) {
    if (tag.label !== '') result = result.split(tag.label).join('');
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

/** Novo rótulo após clicar na tag (remove/adiciona conforme o tipo). */
export function buildTaggedText(currentText: string, tag: RenomeadorTag): string {
  if (tag.isRemove === true) {
    return stripAllTags(currentText);
  }
  if (tag.exclusive) {
    return `${stripExclusiveTags(currentText)} ${tag.label}`;
  }
  return currentText + tag.label;
}
