/**
 * Hash FNV-1a 64-bit (padrão rei-do-tribal) sobre a representação canônica
 * de um plano: re-planejar a mesma operação produz o MESMO ID, o que significa
 * que um RESULT_UNCERTAIN reconciliado não vira "plano novo" no ciclo
 * seguinte — dedupe natural entre ciclos.
 */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index) & 0xff);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Serialização canônica (chaves ordenadas, arrays em ordem) para hashing. */
const canonicalizeValue = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key])}`)
    .join(',')}}`;
};

/**
 * Fingerprint FNV-1a 64 das regras efetivas de um módulo (base do mundo):
 * o mesmo helper roda no background (geração) e na UI (obsolescência), então
 * "as regras mudaram desde a geração" é derivado de um único canônico.
 */
export function fingerprintSettings(settings: Record<string, unknown>): string {
  return fnv1a64(canonicalizeValue(settings));
}
