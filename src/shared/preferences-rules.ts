// Regras PURAS de preferências por módulo: o que pode entrar no store que faz
// formulários sobreviverem a F5/reinício. O store no processo main guarda
// `{ [modulo]: { chave: valor } }` e este módulo é a fronteira de validação —
// sem fs, sem rede, sem DOM, sem electron (o service no main só aplica aqui).
//
// Dois níveis de tolerância de propósito:
// - sanitizePrefPatch/mergePrefs/prefKeyCount: tolerantes, NUNCA lançam — lixo
//   de runtime (função, undefined, símbolo, profundidade além do raso) cai fora
//   em silêncio, porque um salvamento de formulário não pode quebrar a UI.
// - validatePrefMerge: fail-closed — exceder teto de chaves por módulo ou de
//   tamanho de string é abuso real (não lixo acidental) e lança erro PT-BR.
//
// BAN PERMANENTE: preferências JAMAIS guardam credenciais — chave contendo
// sid/senha/password/token (case-insensitive) é descartada em qualquer nível;
// a sessão do jogo vive no cookie jar da partição persist:tw, nunca neste arquivo.

/** Módulos que podem ter preferências persistidas. */
export const PREFERENCE_MODULES = ['sg1','sg2','sg3','sg4','sg5','sg6','sg7','guerra','journal','dashboard','captures','geral'] as const;

/** Um dos módulos da lista acima (isPreferenceModule estreita string para cá). */
export type PreferenceModule = (typeof PREFERENCE_MODULES)[number];

/**
 * Valor de preferência: JSON puro — string | number | boolean | null, array de
 * JSON puros ou objeto raso de JSON puros. O tipo é o formato do disco; o que
 * cada função ACEITA é definido pela sanitização, que é mais estrita (raso,
 * sem nada não-JSON).
 */
export type PrefValue = string | number | boolean | null | PrefValue[] | { [key: string]: PrefValue };

/** Cap de chaves por módulo: protege o disco de formulário descontrolado. */
export const MAX_PREFS_PER_MODULE = 200;

/** Tamanho máximo de UMA string de preferência (textareas grandes ficam). */
export const MAX_PREF_STRING_LENGTH = 20_000;

/**
 * Teto de itens por array: além disso é dump de dados, não preferência de UI.
 * 500 itens JÁ descarta o array inteiro (fronteira combinada com os testes).
 */
const MAX_PREF_ARRAY_ITEMS = 500;

/**
 * Chave candidata a credencial: substring e case-insensitive de propósito —
 * conservador demais vale mais que uma credencial vazando para o disco (um
 * falso positivo raro só derruba uma preferência, nunca dado de jogo).
 * EXCEÇÃO APRENDIDA: "sid" como substring baniria campos legítimos como
 * "enemyCoordsConSIDerText" — por isso sid só é banido como chave EXATA.
 */
const CREDENCIAL_RE = /^sid$|senha|password|passwd|token|secret|credential|session|auth|cookie/i;

/**
 * Type guard de módulo: case-sensitive de propósito — a UI sempre envia
 * minúsculo e "SG1" vs "sg1" no disco seria duas preferências diferentes.
 */
export function isPreferenceModule(value: string): value is PreferenceModule {
  return (PREFERENCE_MODULES as readonly string[]).includes(value);
}

/**
 * Escalar JSON puro. Número não finito (NaN/Infinity) NÃO é JSON —
 * JSON.stringify o viraria null e o roundtrip mentiria; então descarta.
 */
function isJsonScalar(value: unknown): value is string | number | boolean | null {
  if (value === null) return true;
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Objeto "plain" (literal ou Object.create(null)) — instância de classe, Date,
 * Map, Set etc. carregam protótipo/estado que não sobrevive a JSON puro.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Chave candidata a credencial (ver CREDENCIAL_RE) — ban vale em qualquer nível. */
function isChaveBanida(key: string): boolean {
  return CREDENCIAL_RE.test(key);
}

/**
 * Sanitiza um ITEM de array: escalares e objetos RASOS (valores escalares)
 * sobrevivem; array aninhado, objeto fundo, função etc. derrubam só o item —
 * um item ruim não apaga a lista inteira do usuário. Sem recursão de propósito:
 * só estes dois níveis são visitados, então estrutura cíclica não trava.
 */
function sanitizeArrayItem(raw: unknown): PrefValue | undefined {
  if (isJsonScalar(raw)) return raw;
  if (!isPlainObject(raw)) return undefined;
  const item: Record<string, PrefValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isChaveBanida(key)) continue;
    if (!isJsonScalar(value)) return undefined; // fundo demais → o item inteiro não é preferência
    item[key] = value;
  }
  return item;
}

/**
 * Sanitiza o VALOR de uma chave do patch (nível do módulo): escalar, array
 * (≤ MAX_PREF_ARRAY_ITEMS itens, itens por sanitizeArrayItem) ou objeto raso
 * de escalares. Devolve undefined quando a chave deve ser descartada.
 */
function sanitizeValorDeChave(raw: unknown): PrefValue | undefined {
  if (isJsonScalar(raw)) return raw;
  if (Array.isArray(raw)) {
    if (raw.length >= MAX_PREF_ARRAY_ITEMS) return undefined;
    const itens: PrefValue[] = [];
    for (const item of raw) {
      const limpo = sanitizeArrayItem(item);
      if (limpo !== undefined) itens.push(limpo);
    }
    return itens;
  }
  if (isPlainObject(raw)) {
    const objeto: Record<string, PrefValue> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (isChaveBanida(key)) continue;
      // Profundidade além do raso descarta a CHAVE INTEIRA (não só o ramo):
      // objeto parcialmente sanitizado esconderia o erro de modelagem da UI.
      if (!isJsonScalar(value)) return undefined;
      objeto[key] = value;
    }
    return objeto;
  }
  return undefined; // função, undefined, símbolo, bigint, Date, Map, classe…
}

/**
 * Sanitiza um patch de preferências na fronteira: mantém só chaves com JSON
 * puro (escalar; array com menos de 500 itens de JSON puro raso; objeto raso
 * de escalares) e descarta silenciosamente o resto — função, undefined,
 * símbolo, bigint, NaN/Infinity, Date/Map/classe, array de 500+ itens e
 * profundidade além do raso (ex.: {a:{b:{c:1}}} descarta 'a' inteiro).
 * Chave com sid/senha/password/token (case-insensitive) NUNCA passa:
 * preferências jamais guardam credenciais. NUNCA lança.
 */
export function sanitizePrefPatch(patch: Record<string, unknown>): Record<string, PrefValue> {
  const limpo: Record<string, PrefValue> = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (isChaveBanida(key)) continue;
    const valor = sanitizeValorDeChave(raw);
    if (valor !== undefined) limpo[key] = valor;
  }
  return limpo;
}

/**
 * Mescla patch sobre o atual com merge RASO por chave: cada chave do patch
 * substitui a chave INTEIRA do atual (sem merge profundo — o unitInputs do
 * patch É o novo unitInputs). Devolve objeto novo; inputs nunca são mutados
 * (o spread copia o topo; os valores ficam compartilhados, mas o disco só os
 * lê via JSON, então ninguém muta por ali).
 */
export function mergePrefs(current: Record<string, PrefValue>, patch: Record<string, PrefValue>): Record<string, PrefValue> {
  return { ...current, ...patch };
}

/** Total de chaves do módulo (contagem do topo; aninhamento não conta). */
export function prefKeyCount(prefs: Record<string, PrefValue>): number {
  return Object.keys(prefs).length;
}

/**
 * sanitizePrefPatch + caps fail-closed: sanitiza o patch, mescla sobre o atual
 * e valida o ESTADO FINAL — mais de MAX_PREFS_PER_MODULE chaves ou qualquer
 * string acima de MAX_PREF_STRING_LENGTH (inclusive dentro de array/objeto)
 * lança erro PT-BR claro. Valida o mesclado (não só o patch) porque o disco
 * jamais deve receber estado inválido — e substituir chave existente não
 * aumenta a contagem, então o módulo cheio continua editável.
 */
export function validatePrefMerge(current: Record<string, PrefValue>, patch: Record<string, PrefValue>): Record<string, PrefValue> {
  const mesclado = mergePrefs(current, sanitizePrefPatch(patch));
  const total = prefKeyCount(mesclado);
  if (total > MAX_PREFS_PER_MODULE) {
    throw new Error(
      `Limite de ${MAX_PREFS_PER_MODULE} preferências por módulo excedido — o salvamento ficaria com ${total} chaves. Remova preferências obsoletas antes de salvar.`,
    );
  }
  for (const [key, value] of Object.entries(mesclado)) {
    assertStringDentroDoTeto(value, key);
  }
  return mesclado;
}

/** Desce por array/objeto (formas que a sanitização já garante rasas) procurando string acima do teto. */
function assertStringDentroDoTeto(value: PrefValue, chave: string): void {
  if (typeof value === 'string') {
    if (value.length > MAX_PREF_STRING_LENGTH) {
      throw new Error(
        `Preferência "${chave}" tem um texto de ${value.length} caracteres — o limite é ${MAX_PREF_STRING_LENGTH}. Encurte o conteúdo antes de salvar.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertStringDentroDoTeto(item, chave);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const interno of Object.values(value)) assertStringDentroDoTeto(interno, chave);
  }
}
