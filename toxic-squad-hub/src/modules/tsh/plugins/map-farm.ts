// Auto Farm pelo Mapa (userscript) — porta da frente da extensão
// toxic-squad-hub-ext (src/modules/features/map-farm/plugin.ts) rebaixada a
// PRÉVIA LOCAL. Na origem o módulo roda em BACKGROUND sobre abas gerenciadas
// e descobre bárbaras novas dentro da região configurada a partir do snapshot
// compartilhado (que o page-adapter nunca popula). Sem service worker/abas
// gerenciadas no userscript, o ciclo apenas lê o dump público
// /map/village.txt (mesma fila/pacing do resto do script) e gera a lista de
// alvos bárbaros da região em status/'last-preview'. Nenhum alvo é
// registrado no jogo e nenhum ataque é enviado: mutating=false.

import { z } from 'zod';
import { registerTsh } from '../tsh-runtime';
import { pacedGet } from '../../../core/net';

export const mapFarmSettingsSchema = z.object({
  xMin: z.number().int().min(0).max(1000).default(0),
  xMax: z.number().int().min(0).max(1000).default(1000),
  yMin: z.number().int().min(0).max(1000).default(0),
  yMax: z.number().int().min(0).max(1000).default(1000),
  maxTargetsPerCycle: z.number().int().positive().default(20),
});
export type MapFarmSettings = z.infer<typeof mapFarmSettingsSchema>;

/** Defaults efetivos do schema (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: MapFarmSettings = {
  xMin: 0,
  xMax: 1000,
  yMin: 0,
  yMax: 1000,
  maxTargetsPerCycle: 20,
};

export interface MapFarmBarbarian {
  id: string;
  x: number;
  y: number;
  points: number;
}

/**
 * Parser puro do /map/village.txt (formato id,nome,x,y,playerId,pontos,bonus;
 * bárbaras têm playerId 0). Fail-closed: linha malformada lança erro apontando
 * o número da linha — nunca retorna dado errado silenciosamente.
 */
export function parseBarbarianVillages(villageTxt: string): MapFarmBarbarian[] {
  const barbarians: MapFarmBarbarian[] = [];
  const numeric = (value: string | undefined): number | undefined =>
    value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
  const lines = villageTxt.trim() === '' ? [] : villageTxt.trim().split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fields = line.split(',');
    const id = fields[0] ?? '';
    const x = numeric(fields[2]);
    const y = numeric(fields[3]);
    const playerId = numeric(fields[4]);
    const points = numeric(fields[5]);
    if (id === '' || !/^\d+$/.test(id) || x === undefined || y === undefined || playerId === undefined || points === undefined) {
      throw new Error(`Linha ${index + 1} do /map/village.txt não foi reconhecida: ${line}`);
    }
    if (playerId !== 0) continue; // aldeia de jogador — não é bárbara
    barbarians.push({ id, x, y, points });
  }
  return barbarians;
}

export interface MapFarmSelection {
  selected: MapFarmBarbarian[];
  totalInRegion: number;
}

/** Seleção pura: bárbaras dentro do retângulo configurado, no teto do ciclo. */
export function selectMapFarmTargets(
  barbarians: readonly MapFarmBarbarian[],
  settings: MapFarmSettings,
): MapFarmSelection {
  const inRegion = barbarians.filter(
    (candidate) =>
      candidate.x >= settings.xMin && candidate.x <= settings.xMax && candidate.y >= settings.yMin && candidate.y <= settings.yMax,
  );
  return { selected: inRegion.slice(0, settings.maxTargetsPerCycle), totalInRegion: inRegion.length };
}

registerTsh({
  id: 'map-farm',
  label: 'Auto Farm pelo Mapa',
  desc: 'Prévia local (sem execução): lista as bárbaras de /map/village.txt dentro da região configurada — na origem alimenta abas gerenciadas, aqui é somente relatório.',
  category: 'planejamento',
  screen: null,
  mutating: false,
  settingsDefaults: DEFAULT_SETTINGS,
  // A região é lida como 4 escalares (xMin/xMax/yMin/yMax), não como texto
  // "x1|y1 x2|y2" — da forma que o plugin consome.
  settingsForm: [
    { key: 'xMin', label: 'Região — X mínimo', type: 'number', min: 0, max: 1000 },
    { key: 'xMax', label: 'Região — X máximo', type: 'number', min: 0, max: 1000 },
    { key: 'yMin', label: 'Região — Y mínimo', type: 'number', min: 0, max: 1000 },
    { key: 'yMax', label: 'Região — Y máximo', type: 'number', min: 0, max: 1000 },
    {
      key: 'maxTargetsPerCycle',
      label: 'Teto de alvos por ciclo',
      type: 'number',
      min: 1,
      help: 'Quantas bárbaras da região entram no relatório a cada ciclo.',
    },
  ],
  async runCycle(ctx): Promise<void> {
    const settings = mapFarmSettingsSchema.parse(ctx.storage.get('settings', DEFAULT_SETTINGS));
    const villageTxt = await pacedGet('/map/village.txt');
    const selection = selectMapFarmTargets(parseBarbarianVillages(villageTxt), settings);
    ctx.storage.set('last-preview', {
      generatedAt: new Date().toISOString(),
      region: { xMin: settings.xMin, xMax: settings.xMax, yMin: settings.yMin, yMax: settings.yMax },
      totalInRegion: selection.totalInRegion,
      selected: selection.selected,
    });
    if (selection.selected.length === 0) {
      ctx.status('Nenhuma bárbara nova está dentro da região configurada. Prévia local, sem execução.', 'info');
      return;
    }
    const first = selection.selected[0];
    const firstLabel = first !== undefined ? ` (ex.: ${first.x}|${first.y})` : '';
    ctx.status(
      `Prévia Map Farm: ${selection.selected.length} de ${selection.totalInRegion} bárbaras na região${firstLabel} — prévia local, sem execução.`,
      'ok',
    );
  },
});
