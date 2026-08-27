// Export/Import de OP em JSON portável (P1): serializa distribuição + agenda
// de envio + grupos num arquivo compartilhável entre a staff. Puro; sem rede,
// DOM ou console. Como no payload de grupos: a exportação espelha os dados e o
// IMPORT revalida campo a campo — qualquer lixo lança erro PT-BR fail-closed,
// nunca dado errado silencioso.

import { parseCoord } from './coords';
import { parseSendSchedule } from './comms-package';

export interface OpExportDistributionRow {
  playerName: string;
  origin: string;
  target: string;
}

export interface OpExportGroup {
  nome: string;
  papel: string;
  coords: string[];
}

/** Payload completo do arquivo .json exportado pela Staff Hub. */
export interface OpExportData {
  app: 'staff-hub';
  kind: 'op-export';
  /** Versão do app que exportou (ex.: "0.18.1"). */
  version: string;
  /** Momento da exportação (ISO 8601). */
  exportedAt: string;
  world: string;
  opTitle: string;
  targets: string[];
  distribution: OpExportDistributionRow[];
  /** Texto colável do formatSendSchedule (linhas "nick;alvo;HH:MM:SS"; comentários "#…" tolerados). */
  sendSchedule?: string;
  groups?: OpExportGroup[];
}

/** Campos de identificação reconhecidos no import (mesmo padrão dos grupos). */
const APP_ID = 'staff-hub';
const KIND_ID = 'op-export';

/**
 * Serializa a OP inteira num JSON bonito, preenchendo os cabeçalhos fixos:
 * app="staff-hub", kind="op-export" e exportedAt=agora (ISO). O exportedAt é
 * metadado do ARQUIVO (não é hora de jogo) — mesmo critério do criadoEm de
 * fallback nos payloads de grupo. A saída é determinística exceto por ele.
 */
export function serializeOpExport(data: Omit<OpExportData, 'app' | 'kind' | 'exportedAt'>): string {
  const payload: OpExportData = {
    app: APP_ID,
    kind: KIND_ID,
    version: data.version,
    exportedAt: new Date().toISOString(),
    world: data.world,
    opTitle: data.opTitle,
    targets: [...data.targets],
    distribution: data.distribution.map((row) => ({ ...row })),
  };
  if (data.sendSchedule !== undefined) payload.sendSchedule = data.sendSchedule;
  if (data.groups !== undefined) {
    payload.groups = data.groups.map((group) => ({
      nome: group.nome,
      papel: group.papel,
      coords: [...group.coords],
    }));
  }
  return JSON.stringify(payload, null, 2);
}

/** String obrigatória no arquivo importado (fail-closed PT-BR, sem crash cru). */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Arquivo de OP inválido — o campo "${field}" é obrigatório e precisa ser texto.`);
  }
  return value;
}

function asNonEmptyString(value: unknown, field: string): string {
  const text = requiredString(value, field).trim();
  if (text === '') {
    throw new Error(`Arquivo de OP inválido — o campo "${field}" não pode ficar vazio.`);
  }
  return text;
}

/** Coordenada obrigatória no formato x|y (0..999 por eixo). */
function asCoord(value: unknown, field: string): string {
  const text = requiredString(value, field).trim();
  if (parseCoord(text) === null) {
    throw new Error(`Arquivo de OP inválido — ${field} fora do formato x|y: "${text.slice(0, 30)}".`);
  }
  return text;
}

function asCoordArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Arquivo de OP inválido — o campo "${field}" precisa ser uma lista de coordenadas.`);
  }
  return value.map((coord) => asCoord(coord, field));
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Arquivo de OP inválido — ${what} não é um objeto.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Faz o parse de UM arquivo exportado (ou do texto lido). Fail-closed:
 * app/kind devem ser exatamente "staff-hub"/"op-export" e todos os campos são
 * revalidados (coords x|y, agenda "nick;alvo;HH:MM:SS" via parseSendSchedule).
 * sendSchedule/groups ausentes ficam ausentes na saída (nunca inventados).
 */
export function parseOpExport(json: unknown): OpExportData {
  const record = asRecord(json, 'esperado um objeto JSON com a exportação da OP');

  const app = requiredString(record.app, 'app');
  if (app !== APP_ID) {
    throw new Error(`Arquivo de OP não reconhecido — este arquivo não foi exportado pela Staff Hub (app "${app.slice(0, 40)}").`);
  }
  const kind = requiredString(record.kind, 'kind');
  if (kind !== KIND_ID) {
    throw new Error(`Arquivo de OP não reconhecido — conteúdo inesperado (kind "${kind.slice(0, 40)}", esperado "${KIND_ID}").`);
  }

  const version = asNonEmptyString(record.version, 'version');
  const exportedAtRaw = requiredString(record.exportedAt, 'exportedAt');
  if (Number.isNaN(Date.parse(exportedAtRaw))) {
    throw new Error('Arquivo de OP inválido — "exportedAt" não é uma data ISO válida.');
  }
  const world = asNonEmptyString(record.world, 'world');
  const opTitle = asNonEmptyString(record.opTitle, 'opTitle');
  const targets = asCoordArray(record.targets, 'targets');
  if (targets.length === 0) {
    throw new Error('Arquivo de OP inválido — a OP precisa de ao menos um alvo.');
  }
  if (!Array.isArray(record.distribution)) {
    throw new Error('Arquivo de OP inválido — o campo "distribution" precisa ser uma lista.');
  }
  const distribution = record.distribution.map((rawRow) => {
    const row = asRecord(rawRow, 'linha da distribution');
    const playerName = asNonEmptyString(row.playerName, 'nick da distribuição');
    // Origem OPCIONAL: o arquivo da OP guarda só alvos por jogador (sem
    // origem), então o export do app grava origin="" — aceitar vazio/ausente.
    const originRaw = typeof row.origin === 'string' ? row.origin.trim() : '';
    return {
      playerName,
      origin: originRaw === '' ? '' : asCoord(originRaw, `origem de ${playerName}`),
      target: asCoord(row.target, `alvo de ${playerName}`),
    };
  });
  if (distribution.length === 0) {
    throw new Error('Arquivo de OP inválido — a distribuição está vazia.');
  }

  const parsed: OpExportData = { app: APP_ID, kind: KIND_ID, version, exportedAt: exportedAtRaw.trim(), world, opTitle, targets, distribution };

  if (record.sendSchedule !== undefined && record.sendSchedule !== null) {
    const schedule = requiredString(record.sendSchedule, 'sendSchedule');
    // Revalida com o MESMO parser do pacote de comunicação (fonte única);
    // linhas vazias/comentário "#" ignoradas, lixo lança.
    parseSendSchedule(schedule);
    parsed.sendSchedule = schedule;
  }

  if (record.groups !== undefined && record.groups !== null) {
    if (!Array.isArray(record.groups)) {
      throw new Error('Arquivo de OP inválido — o campo "groups" precisa ser uma lista de grupos.');
    }
    parsed.groups = record.groups.map((rawGroup) => {
      const group = asRecord(rawGroup, 'grupo');
      const nome = asNonEmptyString(group.nome, 'nome do grupo');
      const papel = asNonEmptyString(group.papel, `papel do grupo "${nome}"`);
      return { nome, papel, coords: asCoordArray(group.coords, `coords do grupo "${nome}"`) };
    });
  }

  return parsed;
}
