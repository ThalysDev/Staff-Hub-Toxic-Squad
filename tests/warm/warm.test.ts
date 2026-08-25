/**
 * Aquecimento do app com dados REAIS (execução manual, nunca no CI):
 *   WARM_SID=<sid> WARM_USERDATA=<pasta do app> pnpm vitest run tests/warm
 * Baixa os dumps do mundo, coleta tropas+defesa de todos os membros (pacing
 * 400ms) e grava os JSON stores exatamente nos schemas que os services leem —
 * assim o dono abre o app com tudo populado. O sid NUNCA fica no repo (env).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseMemberSelector, parseMemberVillageDefense, parseMemberVillageTroops } from '../../src/shared/parsers/ally-parsers';
import { parseMapAllyTxt, parseMapPlayerTxt, parseMapVillageTxt, parseUnitInfoXml } from '../../src/shared/parsers/world-parsers';
import { parseWorldConfigXml } from '../../src/shared/world-config';
import type { DefenseSnapshot, TroopSnapshot } from '../../src/shared/sg2-engine';

const SID = process.env.WARM_SID ?? '';
const USER_DATA = process.env.WARM_USERDATA ?? '';
const WORLD = 'br142';
const BASE = `https://${WORLD}.tribalwars.com.br`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function get(path: string): Promise<string> {
  const response = await fetch(`${BASE}/${path}`, { headers: { Cookie: `sid=${SID}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status} em ${path}`);
  return await response.text();
}

async function getBinary(path: string): Promise<Buffer> {
  const response = await fetch(`${BASE}/${path}`, { headers: { Cookie: `sid=${SID}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status} em ${path}`);
  return Buffer.from(await response.arrayBuffer());
}

describe('aquecimento com dados reais (manual)', () => {
  it('popula world-data, unit-info, world-config e troops-snapshots', { timeout: 600_000 }, async () => {
    if (SID === '' || USER_DATA === '') return; // só roda com env explícito
    expect(existsSync(USER_DATA)).toBe(true);
    const stores = `${USER_DATA}/stores`;
    mkdirSync(stores, { recursive: true });

    // --- Dumps do mundo (públicos) ---
    const villages = parseMapVillageTxt(gunzipSync(await getBinary('map/village.txt.gz')).toString('utf8'));
    const players = parseMapPlayerTxt(await get('map/player.txt'));
    const allies = parseMapAllyTxt(await get('map/ally.txt'));
    const playerAlly = new Map(players.map((p) => [p.id, p.allyId]));
    for (const village of villages) village.allyId = playerAlly.get(village.playerId) ?? 0;
    const now = new Date().toISOString();
    writeFileSync(`${stores}/world-data.json`, JSON.stringify({ fetchedAt: now, villages, players, allies }));
    console.log(`world-data: ${villages.length} aldeias, ${players.length} jogadores, ${allies.length} tribos`);

    // --- Configs (cache 1 dia do SG_1) ---
    await sleep(400);
    const units = parseUnitInfoXml(await get('interface.php?func=get_unit_info'));
    writeFileSync(`${stores}/unit-info.json`, JSON.stringify({ fetchedAt: now, world: WORLD, units }));
    await sleep(400);
    const config = parseWorldConfigXml(WORLD, await get('interface.php?func=get_config'));
    writeFileSync(`${stores}/world-config.json`, JSON.stringify({ fetchedAt: now, world: WORLD, config }));

    // --- Dropdown de membros ---
    await sleep(400);
    const members = parseMemberSelector(await get('game.php?screen=ally&mode=members_troops')).options;
    console.log(`membros: ${members.length}`);

    // --- Coleta por membro: tropas + defesa (pacing 400ms) ---
    const troopsEntries: TroopSnapshot['entries'] = [];
    const defenseEntries: TroopSnapshot['entries'] = [];
    const defenseVillages: DefenseSnapshot['entries'] = [];
    for (const [index, member] of members.entries()) {
      await sleep(400);
      const troopsHtml = await get(`game.php?screen=ally&mode=members_troops&player_id=${member.playerId}`);
      try {
        for (const village of parseMemberVillageTroops(troopsHtml).villages) {
          troopsEntries.push({
            playerId: member.playerId, playerName: member.name, coord: village.coord,
            villageId: village.villageId, villageName: village.name, units: village.units,
          });
        }
      } catch (error) {
        console.log(`tropas ${member.name}: SEM TABELA (${error instanceof Error ? error.message.slice(0, 60) : '?'})`);
      }
      await sleep(400);
      const defenseHtml = await get(`game.php?screen=ally&mode=members_defense&player_id=${member.playerId}`);
      try {
        for (const village of parseMemberVillageDefense(defenseHtml).villages) {
          defenseEntries.push({
            playerId: member.playerId, playerName: member.name, coord: village.coord,
            villageId: village.villageId, villageName: village.name, units: village.unitsInVillage,
          });
          defenseVillages.push({
            playerId: member.playerId, playerName: member.name, villageId: village.villageId,
            name: village.name, coord: village.coord, points: village.points,
            unitsInVillage: village.unitsInVillage, unitsInTransit: village.unitsInTransit,
          });
        }
      } catch (error) {
        console.log(`defesa ${member.name}: SEM TABELA (${error instanceof Error ? error.message.slice(0, 60) : '?'})`);
      }
      if ((index + 1) % 10 === 0) console.log(`  ${index + 1}/${members.length} membros…`);
    }

    writeFileSync(`${stores}/troops-snapshots.json`, JSON.stringify({
      troops: { kind: 'troops', source: 'per-member', collectedAt: now, entries: troopsEntries },
      defense: { kind: 'defense', source: 'per-member', collectedAt: now, entries: defenseEntries },
      defenseVillages: { kind: 'defense', collectedAt: now, entries: defenseVillages },
    }));
    console.log(`tropas: ${troopsEntries.length} aldeias | defesa: ${defenseEntries.length} aldeias — AQUECIMENTO COMPLETO`);
  });
});
