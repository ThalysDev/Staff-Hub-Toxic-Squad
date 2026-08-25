// Faixas de tempo de nobre com rótulos originais da ferramenta, em caixa alta.

export interface TimeBucket {
  /** Limite inferior inclusivo, em horas. */
  min: number;
  /** Limite superior exclusivo, em horas (Infinity no último). */
  max: number;
  /** Rótulo original da ferramenta. */
  label: string;
}

// Exatamente 11 buckets, intervalos [min, max); o último tem max = Infinity.
export const NOBLE_TIME_BUCKETS: readonly TimeBucket[] = [
  { min: 0, max: 1, label: 'A MENOS DE 1 HORA' },
  { min: 1, max: 2, label: 'DE 1 HORA A 2 HORAS' },
  { min: 2, max: 3, label: 'DE 2 HORAS A 3 HORAS' },
  { min: 3, max: 4, label: 'DE 3 HORAS A 4 HORAS' },
  { min: 4, max: 5, label: 'DE 4 HORAS A 5 HORAS' },
  { min: 5, max: 8, label: 'DE 5 HORAS A 8 HORAS' },
  { min: 8, max: 12, label: 'DE 8 HORAS A 12 HORAS' },
  { min: 12, max: 18, label: 'DE 12 HORAS A 18 HORAS' },
  { min: 18, max: 24, label: 'DE 18 HORAS A 24 HORAS' },
  { min: 24, max: 34, label: 'DE 24 HORAS A 34 HORAS' },
  { min: 34, max: Infinity, label: 'A MAIS DE 34 HORAS' },
];

export function bucketFor(hours: number): number {
  // Fail-closed: tempo inválido (NaN/negativo) não cai no bucket "<1h" —
  // um tempo de viagem quebrado jamais é reportado como front a blindar.
  if (!Number.isFinite(hours) || hours < 0) return -1;
  return NOBLE_TIME_BUCKETS.findIndex((b) => hours >= b.min && (hours < b.max || b.max === Infinity));
}

export function bucketLabelListLabel(index: number): string {
  const bucket = NOBLE_TIME_BUCKETS[index];
  if (bucket === undefined) {
    throw new RangeError(`Índice de bucket fora da faixa: ${index}`);
  }
  // Deriva o prefixo das listas de coords dos rótulos originais:
  // "A MENOS DE 1 HORA" → "MENOR QUE 1 HORA"; "A MAIS DE 34 HORAS" → "DE MAIS DE 34 HORAS".
  const segment = bucket.label.replace(/^A MENOS DE /, 'MENOR QUE ').replace(/^A MAIS DE /, 'DE MAIS DE ');
  return `ALDEIAS COM DISTANCIA DE NOBRE ${segment} DO INIMIGO`;
}