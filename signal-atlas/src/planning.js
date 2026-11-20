import { coversCell, haversine } from './geo.js';
import { compareSiteIds } from './input.js';

export const MIN_TOWER_DISTANCE_M = 500;

// Две пары могут покрывать разные ячейки при одинаковом общем охвате.
export function compareCoverage(candidates, summary, earthRadius) {
  const byCell = new Map();
  const counts = { shared: 0, best: 0, greedy: 0 };
  const selected = candidates.filter(
    (site) => summary.plan.best.ids.includes(site.id) || summary.plan.greedy.ids.includes(site.id),
  );
  for (const cell of summary.cells) {
    if (cell.level !== 'weak') continue;
    const covering = selected.filter((site) => coversCell(site, cell, earthRadius));
    const best = covering
      .filter((site) => summary.plan.best.ids.includes(site.id))
      .map((site) => site.id);
    const greedy = covering
      .filter((site) => summary.plan.greedy.ids.includes(site.id))
      .map((site) => site.id);
    let category = null;
    if (best.length && greedy.length) category = 'shared';
    else if (best.length) category = 'best';
    else if (greedy.length) category = 'greedy';
    if (category) counts[category]++;
    byCell.set(cell.id, { best, greedy, category });
  }
  return { byCell, counts };
}

export function markEligibleSites(sites, towers, earthRadius) {
  return sites.map((site) => ({
    ...site,
    allowed: towers.every((tower) => haversine(site, tower, earthRadius) >= MIN_TOWER_DISTANCE_M),
  }));
}

// Число ячеек в объединении. Пересечение радиусов двух площадок учитывается один раз.
function coveredByPair(first, second) {
  let count = first.covered.size;
  for (const cellId of second.covered) {
    if (!first.covered.has(cellId)) count++;
  }
  return count;
}

function exhaustivePair(options) {
  let best = { ids: [], count: 0 };
  let pairs = 0;
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      const first = options[i];
      const second = options[j];
      const count = coveredByPair(first, second);
      // Порядок ID определяет победителя при равенстве, включая нулевой охват.
      if (pairs === 0 || count > best.count) {
        best = { ids: [first.id, second.id], count };
      }
      pairs++;
    }
  }
  return { best, pairs };
}

function greedyPair(options) {
  let best = { ids: [], count: 0 };
  if (options.length < 2) return best;

  let first = options[0];
  for (const site of options) {
    if (site.covered.size > first.covered.size) first = site;
  }
  for (const second of options) {
    if (second === first) continue;
    const count = coveredByPair(first, second);
    if (best.ids.length === 0 || count > best.count) {
      best = { ids: [first.id, second.id], count };
    }
  }
  return best;
}

export function planSites(candidates, weakCells, earthRadius) {
  const options = [];
  for (const site of candidates) {
    if (!site.allowed) continue;
    const covered = new Set();
    for (const cell of weakCells) {
      if (coversCell(site, cell, earthRadius)) covered.add(cell.id);
    }
    options.push({ id: site.id, covered });
  }
  options.sort(compareSiteIds);
  const { best, pairs } = exhaustivePair(options);
  return { best, greedy: greedyPair(options), pairs, eligible: options.length };
}
