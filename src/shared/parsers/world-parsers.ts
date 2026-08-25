// Parsers dos dados PÚBLICOS do mundo BR142:
// - map dumps oficiais /map/village.txt(.gz), /map/player.txt, /map/ally.txt
//   (texto descomprimido, 1 registro por linha, campos separados por vírgula;
//   nomes URL-encoded — decodificados com decodeURIComponent após converter "+" em espaço);
// - /interface.php?func=get_unit_info (XML com speed/pop/attack/defense/carry por unidade).
// Fail-closed: qualquer linha/campo inválido lança ParseError apontando a linha.

import { UNITS, type UnitId } from '../units';
import type { UnitInfo, WorldAlly, WorldPlayer, WorldVillage } from '../types';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const UNIT_IDS = Object.keys(UNITS) as UnitId[];

const UNIT_INFO_FIELDS = ['speed', 'pop', 'attack', 'defense', 'carry'] as const;

function decodeName(raw: string, lineNo: number): string {
  try {
    // Map dumps usam codificação de formulário: "+" é espaço.
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    throw new ParseError(
      `Linha ${lineNo}: nome com percent-encoding inválido, impossível decodificar ("${raw}")`
    );
  }
}

function parseFieldNumber(raw: string, lineNo: number, field: string): number {
  const value = Number.parseFloat(raw.replace(',', '.'));
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ParseError(`Linha ${lineNo}: campo "${field}" não é um inteiro válido ("${raw}")`);
  }
  return value;
}

function parseRecords<T>(
  text: string,
  expectedFields: number,
  parse: (fields: readonly string[], lineNo: number) => T
): T[] {
  const result: T[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue; // linhas em branco (ex.: quebra final) são ignoradas
    const fields = line.split(',');
    if (fields.length < expectedFields) {
      const preview = line.length > 80 ? `${line.slice(0, 80)}…` : line;
      throw new ParseError(
        `Linha ${i + 1}: esperados ao menos ${expectedFields} campos separados por vírgula, ` +
          `encontrados ${fields.length} ("${preview}")`
      );
    }
    result.push(parse(fields, i + 1));
  }
  return result;
}

/** /map/village.txt: id,nome,x,y,playerId,pontos,bonus (allyId vem do player.txt) */
export function parseMapVillageTxt(text: string): WorldVillage[] {
  return parseRecords(text, 7, (fields, line) => ({
    id: parseFieldNumber(fields[0] ?? '', line, 'id'),
    name: decodeName(fields[1] ?? '', line),
    x: parseFieldNumber(fields[2] ?? '', line, 'x'),
    y: parseFieldNumber(fields[3] ?? '', line, 'y'),
    playerId: parseFieldNumber(fields[4] ?? '', line, 'playerId'),
    allyId: 0,
    points: parseFieldNumber(fields[5] ?? '', line, 'pontos'),
    bonus: parseFieldNumber(fields[6] ?? '', line, 'bonus'),
  }));
}

/** /map/player.txt: id,nome,allyId,aldeias,pontos,rank */
export function parseMapPlayerTxt(text: string): WorldPlayer[] {
  return parseRecords(text, 6, (fields, line) => ({
    id: parseFieldNumber(fields[0] ?? '', line, 'id'),
    name: decodeName(fields[1] ?? '', line),
    allyId: parseFieldNumber(fields[2] ?? '', line, 'allyId'),
    villages: parseFieldNumber(fields[3] ?? '', line, 'aldeias'),
    points: parseFieldNumber(fields[4] ?? '', line, 'pontos'),
    rank: parseFieldNumber(fields[5] ?? '', line, 'rank'),
  }));
}

/** /map/ally.txt: id,nome,tag,membros,aldeias,pontos,[total,]rank — o dump
 * real do BR traz 8 campos (com pontos totais antes do rank); rank = último. */
export function parseMapAllyTxt(text: string): WorldAlly[] {
  return parseRecords(text, 7, (fields, line) => ({
    id: parseFieldNumber(fields[0] ?? '', line, 'id'),
    name: decodeName(fields[1] ?? '', line),
    tag: decodeName(fields[2] ?? '', line),
    members: parseFieldNumber(fields[3] ?? '', line, 'membros'),
    villages: parseFieldNumber(fields[4] ?? '', line, 'aldeias'),
    points: parseFieldNumber(fields[5] ?? '', line, 'pontos'),
    rank: parseFieldNumber(fields[fields.length - 1] ?? '', line, 'rank'),
  }));
}

/**
 * interface.php?func=get_unit_info — espera o bloco <unitId> de TODAS as 13 unidades
 * do catálogo (o jogo retorna o XML completo mesmo em mundos sem arqueiros).
 * Unidade ou campo ausente/inválido = ParseError (fail-closed).
 */
export function parseUnitInfoXml(xml: string): Record<UnitId, UnitInfo> {
  const result = {} as Record<UnitId, UnitInfo>;
  for (const unitId of UNIT_IDS) {
    const blockMatch = new RegExp(`<${unitId}>([\\s\\S]*?)</${unitId}>`, 'i').exec(xml);
    if (blockMatch === null) {
      throw new ParseError(`Unidade "${unitId}": bloco <${unitId}> ausente no XML de unidades`);
    }
    const block = blockMatch[1] ?? '';
    const info = {} as UnitInfo;
    for (const field of UNIT_INFO_FIELDS) {
      const fieldMatch = new RegExp(`<${field}>\\s*([^<]*?)\\s*</${field}>`, 'i').exec(block);
      if (fieldMatch === null) {
        throw new ParseError(`Unidade "${unitId}": campo <${field}> ausente`);
      }
      const value = Number.parseFloat((fieldMatch[1] ?? '').replace(',', '.'));
      if (!Number.isFinite(value)) {
        throw new ParseError(
          `Unidade "${unitId}": campo <${field}> não é um número válido ("${fieldMatch[1]}")`
        );
      }
      info[field] = value;
    }
    result[unitId] = info;
  }
  return result;
}