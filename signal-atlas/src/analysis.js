import { cleanMeasurements, readSites } from './input.js';
import { groupByCell, summarizeCells } from './cells.js';
import { gridFor, validateBounds } from './geo.js';
import { markEligibleSites, planSites } from './planning.js';

export { timeInfo } from './input.js';
export { classify, median } from './cells.js';
export { planSites } from './planning.js';
export const PERIODS = ['all', 'day', 'night'];

/** Общий расчёт для браузера и CLI. На входе тексты трёх CSV и параметры района. */
export function analyze(files, rawBounds) {
  const bounds = validateBounds(rawBounds);
  const { accepted, dropped, total } = cleanMeasurements(files.measurements, bounds);
  const groups = groupByCell(accepted, gridFor(bounds));

  const towers = readSites(files.towers, 'towers.csv');
  const sites = readSites(files.candidates, 'candidates.csv');
  const candidates = markEligibleSites(sites, towers, bounds.earth_radius_m);

  const periods = {};
  for (const period of PERIODS) {
    const summary = summarizeCells(groups, period);
    const weakCells = summary.cells.filter(cell => cell.level === 'weak');
    const plan = planSites(candidates, weakCells, bounds.earth_radius_m);
    periods[period] = { ...summary, plan };
  }

  // Ответ жюри всегда относится ко всем суткам, независимо от периода на карте.
  const { cells, plan } = periods.all;
  const result = {
    worst_cells: cells.slice(0, 3).map(cell => ({
      cell_id: cell.id,
      rsrp_median: cell.rsrp
    })),
    best_candidates: plan.best.ids,
    dropped_rows: total - accepted.length,
    covered_weak_cells: plan.best.count
  };

  return { bounds, towers, candidates, dropped, total, periods, result };
}
