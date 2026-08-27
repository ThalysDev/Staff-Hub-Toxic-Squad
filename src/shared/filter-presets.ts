// Presets NOMEADOS de filtro para SG_1/SG_2: o usuário salva o estado atual do
// formulário com um nome e reaplica depois. Tudo cabe em UMA única chave do
// store de preferências — uma string JSON de até MAX_PRESETS_JSON_LENGTH
// (mesmo teto de UMA string do store, ver MAX_PREF_STRING_LENGTH em
// preferences-rules.ts) — por isso os caps existem: respeitar o limite do
// disco SEM truncar silenciosamente nada.
//
// Motor PURo de serialização/validação — sem fs, sem rede, sem DOM, sem electron.
//
// Camadas e suas fronteiras:
// - serializePresets: valida TUDO (nome, caps, chave = nome trimado, tamanho
//   final) — o que sai daqui sempre volta inteiro por parsePresets.
// - parsePresets: fail-closed PT-BR — lixo no disco lança em vez de entregar
//   meia verdade. ÚNICA tolerância (decisão documentada): campo de fields com
//   valor não-string (número que vazou do form, null…) derruba SÓ essa chave —
//   o resto do preset sobrevive. Um campo perdido o usuário reenche; um preset
//   inteiro corrompido seria pior. O cap de 30 campos conta as chaves BRUTAS
//   do disco, antes do descarte.
// - upsertPreset/removePreset: coleção imutável (devolvem objeto novo). A chave
//   do record é sempre preset.name após trim — nomes que colidem pelo trim SÃO
//   o mesmo preset DE PROPÓSITO (o trim é a identidade, " Foo " sobrescreve
//   "Foo").
// - listPresets: ordem da UI — savedAt mais recente primeiro.

/** Um filtro salvo com nome: snapshot dos campos do formulário. */
export interface FilterPreset {
  /** 1–40 caracteres APÓS trim — é a identidade do preset (vira a chave do record). */
  name: string;
  /** Valores string dos campos do formulário (raso, apenas strings). */
  fields: Record<string, string>;
  /** Momento do salvamento, ISO 8601 — ordena a lista da UI. */
  savedAt: string;
}

/** Máximo de presets persistidos: o store é UMA chave, não pode crescer à vontade. */
export const MAX_PRESETS = 20;

/** Máximo de campos de formulário por preset: além disso é dump de dados, não filtro. */
export const MAX_PRESET_FIELDS = 30;

/** Comprimento máximo do JSON persistido (o teto de UMA string no store de preferências). */
export const MAX_PRESETS_JSON_LENGTH = 20_000;

/** Comprimento máximo do nome do preset APÓS trim. */
export const MAX_PRESET_NAME_LENGTH = 40;

/**
 * Valida o nome (1–40 após trim) e devolve ele trimado. `chave` só enriquece a
 * mensagem quando o validador roda no contexto do parse (disco suspeito).
 */
function validarNome(nome: string, chave?: string): string {
  const trimado = nome.trim();
  if (trimado.length < 1 || trimado.length > MAX_PRESET_NAME_LENGTH) {
    const origem = chave === undefined ? '' : ` na chave "${chave}"`;
    throw new Error(
      `Nome de preset${origem} deve ter entre 1 e ${MAX_PRESET_NAME_LENGTH} caracteres após remover os espaços das pontas — recebeu ${trimado.length}.`,
    );
  }
  return trimado;
}

/** Objeto plano (não array, não null) — no parse só chega saída de JSON.parse, então protótipo é sempre Object.prototype. */
function ehObjetoPlano(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** Valida os campos de um preset tipado (upsert/serialize): cap de chaves e valores string. */
function validarCampos(fields: Record<string, string>, nome: string): void {
  const chaves = Object.keys(fields);
  if (chaves.length > MAX_PRESET_FIELDS) {
    throw new Error(`Preset "${nome}" tem ${chaves.length} campos — o máximo é ${MAX_PRESET_FIELDS}.`);
  }
  for (const chave of chaves) {
    if (typeof fields[chave] !== 'string') {
      throw new Error(`Preset "${nome}" tem o campo "${chave}" com valor não-string — campos de filtro são sempre texto.`);
    }
  }
}

/**
 * Validador compartilhado por upsert/serialize: nome (trim, 1–40), savedAt
 * string e fields dentro do cap com valores string. Devolve o preset canônico
 * (nome trimado, fields copiados — inputs nunca são devolvidos por referência).
 */
function assertPresetValido(preset: FilterPreset): FilterPreset {
  const nome = validarNome(preset.name);
  if (typeof preset.savedAt !== 'string') {
    throw new Error(`Preset "${nome}" está sem savedAt (string ISO) — sem data a lista da UI não ordena.`);
  }
  validarCampos(preset.fields, nome);
  return { name: nome, fields: { ...preset.fields }, savedAt: preset.savedAt };
}

/**
 * Serializa {presetName: {name, fields, savedAt}} de forma DETERMINÍSTICA:
 * chaves dos presets e dos fields em ordem lexicográfica, props sempre na
 * ordem name/fields/savedAt, sem BOM. Fail-closed: mais de MAX_PRESETS, preset
 * inválido, chave diferente do nome trimado ou JSON final acima de
 * MAX_PRESETS_JSON_LENGTH lança erro PT-BR — o disco jamais recebe estado que
 * o parse rejeitaria.
 */
export function serializePresets(presets: Record<string, FilterPreset>): string {
  const chaves = Object.keys(presets);
  if (chaves.length > MAX_PRESETS) {
    throw new Error(`Coleção tem ${chaves.length} presets — o máximo é ${MAX_PRESETS}.`);
  }
  const canonico: Record<string, FilterPreset> = {};
  for (const chave of [...chaves].sort()) {
    const preset = presets[chave];
    if (preset === undefined) continue; // inalcançável: chave veio de Object.keys
    const valido = assertPresetValido(preset);
    if (chave !== valido.name) {
      throw new Error(
        `Chave "${chave}" não bate com o nome trimado "${valido.name}" — a chave do record é sempre o nome após trim.`,
      );
    }
    const fields: Record<string, string> = {};
    for (const [campo, valor] of Object.entries(valido.fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      fields[campo] = valor;
    }
    canonico[chave] = { name: valido.name, fields, savedAt: valido.savedAt };
  }
  const json = JSON.stringify(canonico);
  if (json.length > MAX_PRESETS_JSON_LENGTH) {
    throw new Error(
      `Presets de filtro serializados ficam com ${json.length} caracteres — o máximo persistível é ${MAX_PRESETS_JSON_LENGTH}. Encurte nomes ou valores de campos.`,
    );
  }
  return json;
}

/** Lê UM preset do JSON já parseado — tudo aqui é fail-closed PT-BR. */
function lerPreset(chave: string, bruto: unknown): FilterPreset {
  if (!ehObjetoPlano(bruto)) {
    throw new Error(`Preset "${chave}" não é um objeto com name, fields e savedAt.`);
  }
  const nomeBruto = bruto['name'];
  if (typeof nomeBruto !== 'string') {
    throw new Error(`Preset "${chave}" está sem name (string) — preset sem nome não tem identidade.`);
  }
  const nome = validarNome(nomeBruto, chave);
  if (chave !== nome) {
    throw new Error(
      `Chave "${chave}" não bate com o nome trimado "${nome}" — a chave do record é sempre o nome após trim.`,
    );
  }
  const camposBrutos = bruto['fields'];
  if (!ehObjetoPlano(camposBrutos)) {
    throw new Error(`Preset "${nome}" tem fields inválidos — esperado objeto de strings.`);
  }
  const entradas = Object.entries(camposBrutos);
  if (entradas.length > MAX_PRESET_FIELDS) {
    throw new Error(`Preset "${nome}" tem ${entradas.length} campos — o máximo é ${MAX_PRESET_FIELDS}.`);
  }
  const fields: Record<string, string> = {};
  for (const [campo, valor] of entradas) {
    // DECISÃO documentada no cabeçalho: valor não-string derruba SÓ a chave,
    // o resto do preset sobrevive.
    if (typeof valor === 'string') fields[campo] = valor;
  }
  const savedAt = bruto['savedAt'];
  if (typeof savedAt !== 'string') {
    throw new Error(`Preset "${nome}" está sem savedAt (string ISO) — sem data a lista da UI não ordena.`);
  }
  // Props extras do preset (fora name/fields/savedAt) são descartadas de propósito:
  // o formato canônico é fechado, texto antigo do disco não vira estado fantasma.
  return { name: nome, fields, savedAt };
}

/**
 * Parse fail-closed PT-BR: JSON inválido, raiz não-objeto, entrada acima de
 * MAX_PRESETS_JSON_LENGTH, mais de MAX_PRESETS presets, preset sem nome/savedAt
 * ou fields não-objeto lançam erro claro; campos com valor não-string são
 * descartados (só a chave cai) e props extras do preset idem. Um BOM solitário
 * no início é tolerado (artefato de editor), mas conta para o limite de tamanho.
 */
export function parsePresets(json: string): Record<string, FilterPreset> {
  if (typeof json !== 'string') {
    throw new Error(`Presets de filtro esperam uma string JSON — recebeu ${typeof json}.`);
  }
  if (json.length > MAX_PRESETS_JSON_LENGTH) {
    throw new Error(
      `Presets de filtro têm ${json.length} caracteres — o máximo persistível é ${MAX_PRESETS_JSON_LENGTH}.`,
    );
  }
  const semBom = json.charCodeAt(0) === 0xfeff ? json.slice(1) : json;
  let bruto: unknown;
  try {
    bruto = JSON.parse(semBom);
  } catch (motivo) {
    const detalhe = motivo instanceof Error ? motivo.message : String(motivo);
    throw new Error(`JSON dos presets de filtro é inválido — ${detalhe}`);
  }
  if (!ehObjetoPlano(bruto)) {
    throw new Error('JSON dos presets de filtro não é um objeto — a raiz deveria ser { "nome do preset": { name, fields, savedAt } }.');
  }
  const chaves = Object.keys(bruto);
  if (chaves.length > MAX_PRESETS) {
    throw new Error(`JSON dos presets de filtro tem ${chaves.length} presets — o máximo é ${MAX_PRESETS}.`);
  }
  const presets: Record<string, FilterPreset> = {};
  for (const chave of chaves) {
    presets[chave] = lerPreset(chave, bruto[chave]);
  }
  return presets;
}

/**
 * Upsert por chave (name trimado): substitui o preset existente de mesmo nome
 * ou adiciona um novo. Inserir um NOVO preset quando a coleção já tem
 * MAX_PRESETS lança PT-BR (substituir existente no limite continua permitido —
 * não cresce a coleção). Devolve objeto novo; nunca muta `presets`.
 */
export function upsertPreset(presets: Record<string, FilterPreset>, preset: FilterPreset): Record<string, FilterPreset> {
  const valido = assertPresetValido(preset);
  const jaExistia = Object.prototype.hasOwnProperty.call(presets, valido.name);
  if (!jaExistia && Object.keys(presets).length >= MAX_PRESETS) {
    throw new Error(`Já existem ${MAX_PRESETS} presets salvos — remova um antes de salvar "${valido.name}".`);
  }
  return { ...presets, [valido.name]: valido };
}

/**
 * Remove pelo nome (trimado). Remover nome inexistente é idempotente: devolve
 * coleção igual (objeto novo), nunca lança.
 */
export function removePreset(presets: Record<string, FilterPreset>, name: string): Record<string, FilterPreset> {
  const chave = name.trim();
  const restantes: Record<string, FilterPreset> = {};
  for (const [k, preset] of Object.entries(presets)) {
    if (k !== chave) restantes[k] = preset;
  }
  return restantes;
}

/**
 * Lista para a UI: savedAt mais recente primeiro. Compara por timestamp quando
 * ambos os savedAt parseiam (cobre ISOs com offsets diferentes); senão cai na
 * comparação lexicográfica (ISO no formato do toISOString compara igual ao
 * tempo). Empate de savedAt desempata pelo nome (asc, código de caractere) —
 * a lista é determinística para o mesmo input.
 */
export function listPresets(presets: Record<string, FilterPreset>): FilterPreset[] {
  return Object.values(presets).sort((a, b) => {
    const tempoA = Date.parse(a.savedAt);
    const tempoB = Date.parse(b.savedAt);
    if (Number.isFinite(tempoA) && Number.isFinite(tempoB) && tempoA !== tempoB) return tempoB - tempoA;
    if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
