import test from 'node:test';
import assert from 'node:assert/strict';
import { median, classify } from '../src/cells.js';
import { cleanMeasurements, readSites, timeInfo } from '../src/input.js';
import { validateBounds, DEMO_BOUNDS } from '../src/geo.js';
import { compareCoverage } from '../src/planning.js';

test('Медиана сохраняет десятичную точность и значения рядом с границами классов', () => {
  assert.equal(median([-44.1, -44.2]), -44.15);
  assert.equal(median([-110.2, -110.1]), -110.15);
  assert.equal(median([-105.000003, -104.999999]), -105.000001);
  assert.equal(classify(median([-105.000003, -104.999999])), 'weak');
  assert.equal(classify(median([-90.000003, -89.999997])), 'strong');
  assert.equal(median([-90.00000000000003, -90.00000000000001]), -90.00000000000002);
});

test('Замеры после битых кавычек сохраняются, дополнительные поля могут быть многострочными', () => {
  const csv = [
    '\uFEFFlat;lon;rsrp_dbm;timestamp;note',
    '  "42.87";74.60; "-112,2" ;2026-06-01T06:00; "первый ""замер"""',
    '42.87;74.60;"-115;2026-06-01T07:00;bad',
    '42.87;74.60;-110;2026-06-01T08:00;"две',
    'строки"',
    '42.87;74.60;-10"7;2026-06-01T09:00;bad',
    '42.87;74.60;-106;2026-06-01T10:00;ok',
    '42.87;74.60;-110;2026-06-01T11:00;"не закрыто',
    '42.87;74.60;-102;2026-06-01T12:00;ok',
    '42.87;74.60;-101;"оборвано',
  ].join('\r\n');
  const { accepted, dropped, total } = cleanMeasurements(csv, DEMO_BOUNDS);
  assert.deepEqual(
    accepted.map((row) => row.rsrp),
    [-112.2, -110, -106, -102],
  );
  assert.equal(dropped.malformed, 4);
  assert.equal(total, 8);
  assert.throws(() => readSites('id,lat,lon\nX"1,42,74', 'towers.csv'), /towers.csv.*кавычек/);
  assert.throws(() => cleanMeasurements('lat,lo"n,rsrp_dbm,timestamp\n', DEMO_BOUNDS), /кавычек/);
});

test('Компактные смещения учитываются при определении периода и поиске дублей', () => {
  const local = timeInfo('2026-01-01T06:00:00+06:00');
  assert.equal(local.period, 'day');
  assert.deepEqual(timeInfo('2026-01-01T06:00:00+0600'), local);
  assert.deepEqual(timeInfo('2025-12-31T20:30:00-0330'), local);
  const csv =
    'lat,lon,rsrp_dbm,timestamp\n42.87,74.60,-99,2026-01-01T06:00+0600\n42.87,74.60,-99,2026-01-01T00:00Z';
  assert.equal(cleanMeasurements(csv, DEMO_BOUNDS).dropped.duplicate, 1);
});

test('Псевдонимы UTC+6 и начало сетки на юго-западе', () => {
  for (const timezone of ['Asia/Bishkek', 'UTC+6', '+06:00']) {
    assert.equal(validateBounds({ ...DEMO_BOUNDS, timezone }).timezone, 'Asia/Bishkek');
  }
  const { south, west } = DEMO_BOUNDS;
  validateBounds({ ...DEMO_BOUNDS, grid_origin_lat: south, grid_origin_lon: west - 0.01 });
  assert.throws(
    () => validateBounds({ ...DEMO_BOUNDS, grid_origin_lat: south + 0.001 }),
    /начала сетки/,
  );
  assert.throws(
    () => validateBounds({ ...DEMO_BOUNDS, grid_origin_lon: west + 0.001 }),
    /начала сетки/,
  );
  assert.throws(() => validateBounds({ ...DEMO_BOUNDS, timezone: 'UTC+5' }), /зону/);
});

test('Карта различает общие и уникальные ячейки обеих пар без двойного учёта', () => {
  const site = (id, lon) => ({ id, lat: 0, lon });
  const sites = [site('A', 0), site('B', 0.005), site('C', 0.04), site('D', 0.08)];
  const plan = { best: { ids: ['A', 'B'] }, greedy: { ids: ['B', 'C'] } };
  const cells = [-0.008, 0.003, 0.04, 0.08].map((lon, i) => ({
    ...site(String(i), lon),
    level: 'weak',
  }));
  cells.push({ ...site('strong', 0), level: 'strong' });
  const { counts, byCell } = compareCoverage(sites, { cells, plan });
  assert.deepEqual(counts, { shared: 1, best: 1, greedy: 1 });
  assert.deepEqual(byCell.get('1'), { category: 'shared', best: ['A', 'B'], greedy: ['B'] });
  assert.deepEqual(byCell.get('3'), { category: null, best: [], greedy: [] });
  assert.equal(byCell.has('strong'), false);
});
