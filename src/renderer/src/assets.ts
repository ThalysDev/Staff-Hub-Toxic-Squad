/**
 * Ícones do Tribal Wars (PNG 18x18 embutidos) para uso nas telas de tropas e
 * recursos. As URLs vêm do bundler (vite/client tipa *.png como string).
 */
import type { UnitId } from '@shared/units';

import spearIcon from '@renderer/assets/tw/units/unit_spear.png';
import swordIcon from '@renderer/assets/tw/units/unit_sword.png';
import axeIcon from '@renderer/assets/tw/units/unit_axe.png';
import archerIcon from '@renderer/assets/tw/units/unit_archer.png';
import spyIcon from '@renderer/assets/tw/units/unit_spy.png';
import lightIcon from '@renderer/assets/tw/units/unit_light.png';
import marcherIcon from '@renderer/assets/tw/units/unit_marcher.png';
import heavyIcon from '@renderer/assets/tw/units/unit_heavy.png';
import ramIcon from '@renderer/assets/tw/units/unit_ram.png';
import catapultIcon from '@renderer/assets/tw/units/unit_catapult.png';
import knightIcon from '@renderer/assets/tw/units/unit_knight.png';
import snobIcon from '@renderer/assets/tw/units/unit_snob.png';
import militiaIcon from '@renderer/assets/tw/units/unit_militia.png';

import holzIcon from '@renderer/assets/tw/res/holz.png';
import lehmIcon from '@renderer/assets/tw/res/lehm.png';
import eisenIcon from '@renderer/assets/tw/res/eisen.png';

/** Ícone de cada unidade, indexado pelo UnitId do catálogo compartilhado. */
export const TW_UNIT_ICONS: Record<UnitId, string> = {
  spear: spearIcon,
  sword: swordIcon,
  axe: axeIcon,
  archer: archerIcon,
  spy: spyIcon,
  light: lightIcon,
  marcher: marcherIcon,
  heavy: heavyIcon,
  ram: ramIcon,
  catapult: catapultIcon,
  knight: knightIcon,
  snob: snobIcon,
  militia: militiaIcon,
};

/** Recursos básicos: holz = madeira, lehm = argila, eisen = ferro. */
export type ResId = 'wood' | 'clay' | 'iron';

export const TW_RES_ICONS: Record<ResId, string> = {
  wood: holzIcon,
  clay: lehmIcon,
  iron: eisenIcon,
};
