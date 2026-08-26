// Regras PURAS do domínio GRUPOS: coleções de coordenadas salvas da Análise de
// Tropas (SG_4), reutilizadas na montagem de OPs e persistentes entre
// sessões/contas (OP conjunta multi-tribo). Validação fail-closed da entrada,
// teto de 100 grupos, ordenação e o payload de import/export de arquivo.
// Nada de electron nem persistência aqui — GroupsService
// (src/main/services/groups-service.ts) aplica estas funções sobre o JsonStore
// e journala cada evento.

/** Teto do arquivo: ao superar o limite, os grupos mais antigos caem fora. */
export const GROUPS_LIMIT = 100;

/** Snapshot por jogador vindo da distribuição do SG_4 ("nick;fulls;coords"). */
export interface GroupPlayerSnapshot {
  playerName: string;
  fulls: number;
  semis: number;
  coords: string[];
}

/** Entrada validada e limpa (trim) pronta para gravar. */
export interface NormalizedGroupInput {
  nome: string;
  mundo: string;
  autor: string;
  papel: 'origem' | 'alvo';
  coords: string[];
  perPlayer: GroupPlayerSnapshot[];
  criterio: string;
}

/** Grupo persistido no arquivo (userData/stores/groups.json). */
export interface GroupEntry extends NormalizedGroupInput {
  id: string;
  criadoEm: string;
}

/** Entrada do IPC: com id = edição; sem id = criação. */
export interface GroupSaveInput {
  id?: string;
  nome: string;
  mundo: string;
  autor: string;
  papel: 'origem' | 'alvo';
  coords: string[];
  perPlayer: GroupPlayerSnapshot[];
  criterio: string;
}

const MUNDO_RE = /^br[a-z]?\d{1,4}$/i;
const COORD_RE = /^\d{1,3}\|\d{1,3}$/;
const PAPEIS = ['origem', 'alvo'] as const;

/**
 * Validação fail-closed compartilhada por criação, edição e import de arquivo:
 * nome/mundo/autor/papel/coords/perPlayer/criterio fora do formato lançam erro
 * PT-BR claro e o grupo não é gravado (nunca dado errado silencioso).
 * Devolve a entrada normalizada (trim; mundo minúsculo; coords deduplicadas
 * preservando a ordem da primeira ocorrência).
 */
export function normalizeGroupInput(input: GroupSaveInput): NormalizedGroupInput {
  const nome = input.nome.trim();
  if (nome.length < 1 || nome.length > 60) {
    throw new Error('Nome do grupo vazio ou longo demais — informe entre 1 e 60 caracteres.');
  }
  const mundoRaw = input.mundo.trim();
  if (!MUNDO_RE.test(mundoRaw)) {
    throw new Error(`Mundo inválido ("${mundoRaw.slice(0, 20)}") — use o formato br + número (ex.: br142).`);
  }
  const autor = input.autor.trim();
  if (autor.length < 1 || autor.length > 40) {
    throw new Error('Autor vazio ou longo demais — informe entre 1 e 40 caracteres.');
  }
  if (!PAPEIS.includes(input.papel)) {
    throw new Error(`Papel inválido ("${String(input.papel)}") — use "origem" ou "alvo".`);
  }

  // Dedupe preservando a ordem da primeira ocorrência; toda coord precisa bater
  // com o formato x|y (até 3 dígitos por eixo).
  const seenCoord = new Set<string>();
  const coords: string[] = [];
  for (const raw of input.coords) {
    const coord = typeof raw === 'string' ? raw.trim() : String(raw);
    if (!COORD_RE.test(coord)) {
      throw new Error(`Coordenada fora do formato (use x|y, ex.: 402|303): "${coord.slice(0, 30)}".`);
    }
    if (!seenCoord.has(coord)) {
      seenCoord.add(coord);
      coords.push(coord);
    }
  }
  if (coords.length < 1 || coords.length > 2000) {
    throw new Error(`O grupo precisa de 1 a 2000 coordenadas distintas (recebeu ${coords.length}).`);
  }

  const perPlayer = normalizePerPlayer(input.perPlayer, seenCoord);

  const criterio = input.criterio?.trim() ?? '';
  if (criterio.length > 200) {
    throw new Error('Critério longo demais — limite de 200 caracteres.');
  }

  return { nome, mundo: mundoRaw.toLowerCase(), autor, papel: input.papel, coords, perPlayer, criterio };
}

/**
 * Valida os snapshots por jogador: nick 2–40, todas as coords no formato x|y E
 * contidas nas coords do grupo, fulls/semis inteiros ≥ 0. Qualquer
 * inconsistência lança erro citando o jogador.
 */
function normalizePerPlayer(perPlayer: GroupPlayerSnapshot[], groupCoords: Set<string>): GroupPlayerSnapshot[] {
  if (!Array.isArray(perPlayer)) {
    throw new Error('Lista de jogadores (perPlayer) inválida — esperado um array.');
  }
  return perPlayer.map((entry) => {
    // Payload importado pode ter lixo no lugar do snapshot — nunca crashar cru.
    const player = (entry ?? {}) as Partial<GroupPlayerSnapshot>;
    const playerName = typeof player.playerName === 'string' ? player.playerName.trim() : '';
    if (playerName.length < 2 || playerName.length > 40) {
      throw new Error(`Nick do jogador fora do formato (2–40 caracteres): "${playerName.slice(0, 40)}".`);
    }
    const fulls = validateCounter(player.fulls, playerName, 'fulls');
    const semis = validateCounter(player.semis, playerName, 'semis');
    if (!Array.isArray(player.coords)) {
      throw new Error(`Coordenadas do jogador "${playerName}" inválidas — esperado um array.`);
    }
    const seenCoord = new Set<string>();
    const coords: string[] = [];
    for (const raw of player.coords) {
      const coord = typeof raw === 'string' ? raw.trim() : String(raw);
      if (!COORD_RE.test(coord)) {
        throw new Error(`Coordenada do jogador "${playerName}" fora do formato (use x|y): "${coord.slice(0, 30)}".`);
      }
      if (!groupCoords.has(coord)) {
        throw new Error(`Coordenada ${coord} do jogador "${playerName}" não pertence às coordenadas do grupo.`);
      }
      if (!seenCoord.has(coord)) {
        seenCoord.add(coord);
        coords.push(coord);
      }
    }
    return { playerName, fulls, semis, coords };
  });
}

/** Contador (fulls/semis) precisa ser número inteiro ≥ 0; senão falha citando o jogador. */
function validateCounter(value: unknown, playerName: string, field: 'fulls' | 'semis'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Contagem de ${field} do jogador "${playerName}" inválida — esperado número inteiro ≥ 0.`);
  }
  return value;
}

/** Erro padronizado para id que não existe mais no arquivo. */
export function groupNotFoundError(id: string): Error {
  return new Error(`Grupo não encontrado no arquivo (id=${id}) — recarregue a lista e tente de novo.`);
}

export function findGroupById(groups: GroupEntry[], id: string): GroupEntry | undefined {
  return groups.find((group) => group.id === id);
}

/** Novo grupo: id e criadoEm vêm prontos (o service gera). */
export function createGroupEntry(data: NormalizedGroupInput, id: string, criadoEm: string): GroupEntry {
  return { ...data, coords: [...data.coords], perPlayer: data.perPlayer.map((p) => ({ ...p, coords: [...p.coords] })), id, criadoEm };
}

/**
 * Edição de grupo existente: campos de conteúdo são substituídos; id e
 * criadoEm são PRESERVADOS — a antiguidade no arquivo nunca muda na edição.
 */
export function updateGroupEntry(existing: GroupEntry, data: NormalizedGroupInput): GroupEntry {
  return { ...data, coords: [...data.coords], perPlayer: data.perPlayer.map((p) => ({ ...p, coords: [...p.coords] })), id: existing.id, criadoEm: existing.criadoEm };
}

/** Insere o grupo novo ou substitui o de mesmo id, sem mutar o array original. */
export function upsertGroup(groups: GroupEntry[], entry: GroupEntry): GroupEntry[] {
  const index = groups.findIndex((group) => group.id === entry.id);
  if (index < 0) return [...groups, entry];
  return groups.map((group, position) => (position === index ? entry : group));
}

/**
 * Aplica o teto do arquivo removendo os grupos mais antigos (criadoEm asc)
 * até voltar ao limite — mas o grupo acabado de salvar/importar NUNCA é
 * removido, mesmo sendo o mais antigo. Mantém a ordem relativa das sobreviventes.
 */
export function capGroups(groups: GroupEntry[], keepId: string, limit: number = GROUPS_LIMIT): GroupEntry[] {
  if (groups.length <= limit) return groups;
  const survivors = [...groups];
  while (survivors.length > limit) {
    let oldestIndex = -1;
    let oldestCriadoEm = '';
    for (let i = 0; i < survivors.length; i++) {
      const candidate = survivors[i];
      if (candidate === undefined || candidate.id === keepId) continue;
      if (oldestIndex < 0 || candidate.criadoEm < oldestCriadoEm) {
        oldestIndex = i;
        oldestCriadoEm = candidate.criadoEm;
      }
    }
    if (oldestIndex < 0) break; // só restou o próprio grupo salvo — nada a remover
    survivors.splice(oldestIndex, 1);
  }
  return survivors;
}

/** Ordem de exibição: mais recente primeiro (criadoEm desc, estável). */
export function sortNewestFirst(groups: GroupEntry[]): GroupEntry[] {
  return [...groups].sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}

// ---------------------------------------------------------------------------
// Textos coláveis (formato do SG_4)
// ---------------------------------------------------------------------------

/**
 * Texto INFORMAÇÕES ORIGEM do SG_4: uma linha "nick;nroFulls;coordenadas" por
 * jogador, coords separadas por espaço (o parser do SG_4 aceita de volta).
 */
export function groupToOriginsText(group: GroupEntry): string {
  return group.perPlayer
    .map((player) => `${player.playerName};${player.fulls};${player.coords.join(' ')}`)
    .join('\n');
}

/** Todas as coords do grupo, uma por linha (colável na Reserva em Massa etc.). */
export function groupToTargetsText(group: GroupEntry): string {
  return group.coords.join('\n');
}

// ---------------------------------------------------------------------------
// Import/export de arquivo (.json)
// ---------------------------------------------------------------------------

/** Campos de identificação do payload exportado (reconhecidos no import). */
const PAYLOAD_APP = 'staff-hub';
const PAYLOAD_KIND = 'group';

/** Payload boninho para salvar em arquivo; app/kind permitem reconhecer o formato. */
export function groupPayloadForExport(group: GroupEntry): string {
  return JSON.stringify({ app: PAYLOAD_APP, kind: PAYLOAD_KIND, ...group }, null, 2);
}

/**
 * Import de arquivo: aceita UM objeto GroupEntry (payload do groupPayloadForExport)
 * ou um wrapper {groups:[...]} com EXATAMENTE 1 grupo. Tudo é revalidado pelo
 * normalizeGroupInput; id ausente/vazio gera um novo, criadoEm é preservado
 * quando ISO válido (senão recebe agora). Qualquer lixo → erro PT-BR fail-closed.
 */
export function parseGroupPayload(json: unknown): GroupEntry {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Arquivo de grupo inválido — esperado um objeto JSON com um grupo.');
  }
  const record = json as Record<string, unknown>;

  let raw: Record<string, unknown> = record;
  if ('groups' in record) {
    if (!Array.isArray(record.groups) || record.groups.length !== 1) {
      throw new Error('Arquivo de grupos inválido — o campo "groups" deve conter exatamente 1 grupo.');
    }
    const first = record.groups[0];
    if (typeof first !== 'object' || first === null || Array.isArray(first)) {
      throw new Error('Arquivo de grupos inválido — o item dentro de "groups" não é um objeto de grupo.');
    }
    raw = first as Record<string, unknown>;
  }

  return buildEntryFromRecord(raw);
}

/** Valida os campos brutos do JSON e monta a GroupEntry (id/criadoEm resolvidos). */
function buildEntryFromRecord(raw: Record<string, unknown>): GroupEntry {
  const normalized = normalizeGroupInput({
    nome: asString(raw.nome, 'nome do grupo'),
    mundo: asString(raw.mundo, 'mundo'),
    autor: asString(raw.autor, 'autor'),
    papel: raw.papel as GroupSaveInput['papel'],
    coords: asCoordArray(raw.coords),
    perPlayer: (Array.isArray(raw.perPlayer) ? raw.perPlayer : []) as GroupPlayerSnapshot[],
    criterio: typeof raw.criterio === 'string' ? raw.criterio : '',
  });

  const idRaw = typeof raw.id === 'string' ? raw.id.trim() : '';
  const criadoEm =
    typeof raw.criadoEm === 'string' && !Number.isNaN(Date.parse(raw.criadoEm))
      ? raw.criadoEm
      : new Date().toISOString();

  return { ...normalized, id: idRaw === '' ? crypto.randomUUID() : idRaw, criadoEm };
}

/** String obrigatória no payload importado (fail-closed PT-BR, sem crash cru). */
function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Arquivo de grupo inválido — o campo "${field}" é obrigatório e precisa ser texto.`);
  }
  return value;
}

function asCoordArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Arquivo de grupo inválido — o campo "coords" é obrigatório e precisa ser uma lista.');
  }
  return value.map((coord) => asString(coord, 'coordenada'));
}
