const MIN_SAMPLES_PER_CELL = 5;
const WEAK_BELOW_DBM = -105;
const STRONG_FROM_DBM = -90;

export function classify(rsrp) {
  if (rsrp < WEAK_BELOW_DBM) return 'weak';
  if (rsrp >= STRONG_FROM_DBM) return 'strong';
  return 'medium';
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function groupByCell(measurements, grid) {
  const groups = new Map();
  for (const measurement of measurements) {
    const [row, col] = grid.index(measurement.lat, measurement.lon);
    const id = 'X' + String(col).padStart(3, '0') + '_Y' + String(row).padStart(3, '0');
    if (!groups.has(id)) {
      const center = grid.point(row + 0.5, col + 0.5);
      groups.set(id, { id, row, col, ...center, all: [], day: [], night: [] });
    }
    const group = groups.get(id);
    group.all.push(measurement.rsrp);
    group[measurement.period].push(measurement.rsrp);
  }
  return groups;
}

export function summarizeCells(groups, period) {
  const cells = [];
  const counts = { weak: 0, medium: 0, strong: 0 };
  let samples = 0;
  let sparse = 0;

  for (const group of groups.values()) {
    const values = group[period];
    if (values.length === 0) continue;
    samples += values.length;
    if (values.length < MIN_SAMPLES_PER_CELL) {
      sparse++;
      continue;
    }
    const { id, row, col, lat, lon } = group;
    const rsrp = median(values);
    const level = classify(rsrp);
    counts[level]++;
    cells.push({ id, row, col, lat, lon, rsrp, count: values.length, level });
  }

  // При равных медианах результат воспроизводится по индексам строки и столбца.
  cells.sort((a, b) => a.rsrp - b.rsrp || a.row - b.row || a.col - b.col);
  return { cells, counts, samples, sparse };
}
