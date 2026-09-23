// Helpers de formulário do jogo compartilhados pelos módulos Vanta
// (port direto do TW Vanta, linhas 116-197, com types e sem mudança de
// comportamento). "Formulário" aqui são as tabelas nativas do jogo
// (place&mode=call, info_village) cujos inputs/checkboxes a suíte preenche.

import { UNITS, UNIT_POP } from './vanta-utils';

/** Aldeia com unidades disponíveis (linha da tabela do jogo). */
export interface VillageUnits {
  units: Record<string, number>;
}

/**
 * Distribui `requested` unidades pelas `villages` (menor disponibilidade
 * primeiro, fatia igual do restante — "water fill" do Vanta).
 */
export function waterFill(units: readonly string[], requested: Record<string, number>, villages: VillageUnits[]): Record<string, number>[] {
  const allocation = villages.map((): Record<string, number> => ({}));
  for (const unit of units) {
    let remaining = requested[unit] ?? 0;
    if (remaining <= 0) {
      villages.forEach((_, i) => {
        const row = allocation[i];
        if (row !== undefined) row[unit] = 0;
      });
      continue;
    }
    const pool = villages
      .map((v, i) => ({ i, avail: v.units[unit] ?? 0 }))
      .filter((e) => e.avail > 0)
      .sort((a, b) => a.avail - b.avail);
    for (let j = 0; j < pool.length && remaining > 0; j++) {
      const entry = pool[j];
      if (entry === undefined) continue;
      const share = Math.floor(remaining / (pool.length - j));
      const give = Math.min(share, entry.avail);
      const target = allocation[entry.i];
      if (target !== undefined) target[unit] = give;
      remaining -= give;
    }
  }
  return allocation;
}

/** Preenche a linha `awayId_<unit>` do jogo com o MÁXIMO de cada unidade. */
export function fillRowMax(awayId: string, units: readonly string[]): void {
  units.forEach((unit) => {
    const input = document.getElementById(`${awayId}_${unit}`);
    if (input === null || !(input instanceof HTMLInputElement)) return;
    const max = parseInt(input.max, 10);
    if (!max) return;
    input.value = String(max);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Preenche a linha `awayId_<unit>` com a alocação calculada (waterFill). */
export function fillRowAllocated(awayId: string, units: readonly string[], alloc: Record<string, number>): void {
  units.forEach((unit) => {
    const input = document.getElementById(`${awayId}_${unit}`);
    if (input === null || !(input instanceof HTMLInputElement)) return;
    input.value = String(alloc[unit] ?? 0);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/**
 * Clica checkboxes e preenche linhas em cascata (stagger) — o jogo precisa de
 * um tick entre o clique e o preenchimento para habilitar os inputs.
 * onAllDone dispara quando a última linha termina.
 */
export function staggerFill(
  rows: HTMLElement[],
  opts: {
    getCheckbox: (row: HTMLElement) => HTMLInputElement | null;
    fillFn: ((row: HTMLElement, checkbox: HTMLInputElement) => void) | null;
    onAllDone: () => void;
    staggerMs?: number;
    fillDelayMs?: number;
  },
): void {
  let pending = rows.length;
  if (pending === 0) {
    opts.onAllDone();
    return;
  }
  rows.forEach((row, i) => {
    window.setTimeout(() => {
      const cb = opts.getCheckbox(row);
      if (cb === null) {
        if (--pending === 0) opts.onAllDone();
        return;
      }
      cb.click();
      const fillFn = opts.fillFn;
      if (fillFn !== null && fillFn !== undefined) {
        window.setTimeout(() => {
          fillFn(row, cb);
          if (--pending === 0) opts.onAllDone();
        }, opts.fillDelayMs ?? 100);
      } else if (--pending === 0) opts.onAllDone();
    }, i * (opts.staggerMs ?? 50));
  });
}

/** Popula a linha-resumo (unidades + pop) de uma tabela Vanta. */
export function populateResumo(
  rowId: string,
  cellPrefix: string,
  label: string,
  unitData: Record<string, number>,
  pop: number,
  opts?: { alocado?: boolean; requested?: Record<string, number> },
): void {
  const row = document.getElementById(rowId);
  if (row === null) return;
  row.classList.toggle('vanta-resumo-alocado', opts?.alocado === true);
  const labelCell = document.getElementById(`${cellPrefix}label`);
  if (labelCell !== null) labelCell.textContent = label;
  UNITS.forEach((u) => {
    const cell = document.getElementById(`${cellPrefix}${u}`);
    if (cell === null) return;
    const v = unitData[u] ?? 0;
    cell.textContent = v > 0 ? String(v) : '–';
    if (opts?.requested !== undefined) {
      const req = opts.requested[u] ?? 0;
      cell.className = req > 0 && v < req ? 'vanta-shortfall' : v > 0 ? '' : 'vanta-zero';
    } else {
      cell.className = v > 0 ? '' : 'vanta-zero';
    }
  });
  const popCell = document.getElementById(`${cellPrefix}pop`);
  if (popCell !== null) popCell.textContent = pop > 0 ? String(pop) : '–';
  row.style.display = '';
}

export { UNITS, UNIT_POP };
