import { mkdir, writeFile } from 'node:fs/promises';
import { DEMO_BOUNDS, gridFor } from '../src/geo.js';

const folder = new URL('../data/demo/', import.meta.url);
await mkdir(folder, { recursive: true });
let seed = 1172026;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
const grid = gridFor(DEMO_BOUNDS);
const coordinates = (x, y) => {
  const { lat, lon } = grid.point(y, x);
  return lat.toFixed(7) + ',' + lon.toFixed(7);
};
const towers = [
  [3, 3],
  [8.5, 9],
  [12.4, 3.5],
  [19.5, 11],
  [21, 4],
  [2.6, 9.7],
];
const candidates = [
  [2, 4],
  [3, 8],
  [6, 5],
  [7, 3],
  [7, 12],
  [3, 6.4],
  [4.7, 7.2],
  [10, 4],
  [10, 2],
  [11.6, 7.2],
  [14.6, 10.2],
  [16.4, 7.7],
  [16.5, 4],
  [19, 5],
  [20, 9],
  [16, 11],
  [11.5, 12],
  [13.8, 2],
  [21.6, 7.7],
  [1.8, 10],
];
const siteCsv = (points, prefix) =>
  [
    'id,lat,lon',
    ...points.map(([x, y], i) => prefix + String(i + 1).padStart(2, '0') + ',' + coordinates(x, y)),
  ].join('\n') + '\n';
const active = [];
for (let y = 1; y < 13; y++)
  for (let x = 1; x < 22; x++) {
    const inside = ((x - 11) / 11.5) ** 2 + ((y - 6.5 - 1.5 * Math.sin(x / 3)) / 6) ** 2;
    if (inside < 1 && random() > 0.12) active.push([x, y]);
  }
const rows = [];
for (let i = 0; i < 4832; i++) {
  const [col, row] = active[i % active.length];
  const x = col + random(),
    y = row + random();
  const basin = (cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2));
  const time = new Date(Date.UTC(2026, 9, 12, 18) + i * 61000);
  const hour = (time.getUTCHours() + 6) % 24;
  const signal =
    -81 -
    37 * basin(5.6, 7.6, 3.9, 3.5) -
    40 * basin(16.1, 6.8, 4.0, 3.9) -
    9 * basin(11, 2, 5, 2) -
    (hour >= 6 && hour < 18 ? 3 : 0) +
    (random() - 0.5) * 9;
  rows.push(coordinates(x, y) + ',' + Math.round(signal) + ',' + time.toISOString());
}
for (let i = 0; i < 88; i++) rows.push(rows[i * 13]);
for (let i = 0; i < 48; i++) rows.push(coordinates(4, 5) + ',-145,' + i);
for (let i = 0; i < 32; i++) rows.push('42.70000,74.60100,-96,' + i);
await Promise.all([
  writeFile(
    new URL('measurements.csv', folder),
    'lat,lon,rsrp_dbm,timestamp\n' + rows.join('\n') + '\n',
  ),
  writeFile(new URL('towers.csv', folder), siteCsv(towers, 'B')),
  writeFile(new URL('candidates.csv', folder), siteCsv(candidates, 'C')),
  writeFile(new URL('bounds.json', folder), JSON.stringify(DEMO_BOUNDS, null, 2) + '\n'),
]);
