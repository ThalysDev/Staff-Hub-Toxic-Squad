// Pré-visualização de MPs do SG_6 (roadmap U5): funções PURAS que espelham a
// montagem real da mensagem em Sg6Service.sendMps (src/main/mutations/sg6-service.ts)
// e validam os nicks contra o dump de jogadores (player.txt).
// Atenção: MP no Tribal Wars é case-sensitive — errar a CAIXA do nick = não entrega.

import { horariosBlock } from './comms-package';

export interface MpPreviewEntry {
  playerName: string;
  subject: string;
  body: string;
}

/**
 * Prévia EXATA do que sendMps enviaria: mesma ordem de parâmetros e mesma
 * substituição (#alvos# por coords separadas por espaço; #horarios# pelo bloco
 * "alvo → HH:MM:SS" da fonte única horariosBlock — prévia e envio nunca
 * divergem). `limit` corta para as N primeiras entradas (a UI mostra a 1ª);
 * sem limit, gera a prévia de TODAS as entradas.
 * Fail-closed igual ao service: #horarios# no corpo sem horários coerentes
 * na entrada → ERRO antes de qualquer confirmação.
 */
export function previewMps(
  subject: string,
  bodyTemplate: string,
  entries: { playerName: string; coords: string[]; horarios?: string[] }[],
  limit?: number,
): MpPreviewEntry[] {
  const selecionadas = limit === undefined ? entries : entries.slice(0, limit);
  return selecionadas.map((entry) => {
    let body = bodyTemplate.replaceAll('#alvos#', entry.coords.join(' '));
    if (body.includes('#horarios#')) {
      if (entry.horarios === undefined || entry.horarios.length === 0) {
        throw new Error(`O corpo usa #horarios#, mas a entrada de "${entry.playerName}" não trouxe horários — gere o pacote de comunicação no SG_4.`);
      }
      body = body.replaceAll('#horarios#', horariosBlock(entry.coords, entry.horarios));
    }
    return { playerName: entry.playerName, subject, body };
  });
}

export interface NickValidation {
  /** Existe no dump com exatamente esses caracteres — entrega garantida. */
  valid: string[];
  /** Não existe como digitado, mas existe variando só a CAIXA (match único). */
  caseMismatch: { given: string; known: string }[];
  /** Não existe de forma nenhuma (ou match de caixa ambíguo). */
  unknown: string[];
}

/**
 * Valida os nicks das entradas contra os nomes reais do dump (player.txt).
 * - iguais caractere a caractere → valid;
 * - diferentes só na caixa, com UM único candidato → caseMismatch;
 * - inexistentes OU ambíguos (mais de um jogador no dump diferindo só pela
 *   caixa, ex.: "Joao" e "JOAO") → unknown — melhor apontar como problema
 *   do que sugerir o nick errado. Sem fuzzy de acentos (não adivinhar).
 */
export function validateNicks(entries: { playerName: string }[], knownPlayers: string[]): NickValidation {
  const exatos = new Set(knownPlayers);
  // Caixa normalizada -> nomes reais do dump (para detectar match único de caixa).
  const porCaixa = new Map<string, string[]>();
  for (const nome of knownPlayers) {
    const chave = nome.toLowerCase();
    const existentes = porCaixa.get(chave);
    if (existentes === undefined) porCaixa.set(chave, [nome]);
    else existentes.push(nome);
  }

  const resultado: NickValidation = { valid: [], caseMismatch: [], unknown: [] };
  for (const { playerName } of entries) {
    if (exatos.has(playerName)) {
      resultado.valid.push(playerName);
      continue;
    }
    const candidatos = porCaixa.get(playerName.toLowerCase());
    if (candidatos !== undefined && candidatos.length === 1) {
      const known = candidatos[0];
      if (known !== undefined) resultado.caseMismatch.push({ given: playerName, known });
    } else {
      resultado.unknown.push(playerName);
    }
  }
  return resultado;
}
