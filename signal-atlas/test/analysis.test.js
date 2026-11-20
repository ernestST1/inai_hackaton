import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, classify, median, planSites, timeInfo } from '../src/analysis.js';
import { parseCsv } from '../src/csv.js';
import { DEMO_BOUNDS, EARTH_RADIUS, gridFor, haversine } from '../src/geo.js';

const header = 'lat,lon,rsrp_dbm,timestamp\n';
function siteCsv(sites) {
  const rows = sites.map(site => [site.id, site.lat, site.lon].join(','));
  return 'id,lat,lon\n' + rows.join('\n');
}

function run(rows, towers = [], candidates = [], bounds = DEMO_BOUNDS) {
  return analyze({
    measurements: header + rows.join('\n'),
    towers: siteCsv(towers),
    candidates: siteCsv(candidates)
  }, bounds);
}

const grid = gridFor(DEMO_BOUNDS);
const point = (row, col) => grid.point(row + 0.5, col + 0.5);
function samples(center, values) {
  return values.map((rsrp, i) => {
    const timestamp = '2026-11-20T12:00:' + String(i).padStart(2, '0');
    return [center.lat, center.lon, rsrp, timestamp].join(',');
  });
}
const metersNorth = (meters, id) => ({
  id, lat: 42.86 + meters * 180 / (Math.PI * EARTH_RADIUS), lon: 74.6, allowed: true
});

// На этой тестовой сфере 0,005° по меридиану дают ровно 500 м при вычислениях с плавающей точкой.
const thresholdRadius = 500 / (0.005 * (Math.PI / 180));
const thresholdSite = (m,id) => ({id,lat:m/500*0.005,lon:0,allowed:true});

test('CSV · BOM, переносы строк, разделители внутри поля и двойные кавычки', () => {
  const rows = parseCsv('\uFEFFid;lat;lon\r\n"A;""1""\nB";42.9;74.1\r\n',['id','lat','lon'],'test');
  assert.deepEqual(rows,[{id:'A;"1"\nB',lat:'42.9',lon:'74.1'}]);
  assert.throws(()=>parseCsv('a,b\n"1,2',['a'],'test'),/кавычках/);
  assert.throws(()=>parseCsv('a,c\n1,2',['b'],'test'),/поля b/);
});

test('Очистка · каждая строка отбрасывается один раз, −140 и −44 дБм допустимы', () => {
  const p = point(2,3);
  const valid = samples(p,[-140,-44,-100,-100,-100]);
  const rows = [...valid,valid[0],p.lat+','+p.lon+',-141,x',p.lat+','+p.lon+',-43,x','0,0,-90,x',',74,-100,x','42,x,-100,x','42,74'];
  const out = run(rows);
  assert.deepEqual(out.dropped,{duplicate:1,signal:2,outside:1,malformed:3,timestamp:0});
  assert.equal(out.result.dropped_rows,7);
  assert.equal(out.periods.all.cells[0].rsrp,-100);
  assert.equal(out.periods.all.cells[0].count,5);
});

test('Сетка · шаг 200 м и включение четырёх углов района', () => {
  const {south,north,west,east} = DEMO_BOUNDS;
  const rows = [[south,west],[north,east],[south,east],[north,west]].map(([lat,lon]) => [lat,lon,-90,'2026-11-20T12:00'].join(','));
  const out = run(rows);
  assert.equal(out.result.dropped_rows,0);
  assert.equal(out.periods.all.sparse,4);
  assert.equal(out.periods.all.cells.length,0);
  assert.ok(Math.abs(haversine(grid.point(0,0),grid.point(1,0))-200)<1e-6);
  assert.ok(Math.abs(haversine({lat:south,lon:west},{lat:south,lon:west+grid.dLon})-200)<1e-5);
});

test('Ячейки · медиана, границы цветов, минимум замеров и порядок при равенстве', () => {
  assert.equal(median([-100,-110]),-105);
  assert.deepEqual([-105.1,-105,-90.1,-90].map(classify),['weak','medium','medium','strong']);
  const rows = [
    ...samples(point(1, 3), Array(5).fill(-120)),
    ...samples(point(1, 1), Array(5).fill(-120)),
    ...samples(point(1, 4), Array(5).fill(-90)),
    ...samples(point(1, 5), Array(4).fill(-135))
  ];
  const out = run(rows);
  assert.deepEqual(out.result.worst_cells.map(c=>c.cell_id),['X001_Y001','X003_Y001','X004_Y001']);
  assert.equal(out.periods.all.sparse,1);
  assert.equal(out.result.dropped_rows,0);
  assert.deepEqual(run(rows.reverse()).result,out.result);
});

test('День и ночь · местное время Бишкека и порог замеров для каждого периода', () => {
  const examples = [
    ['2026-01-01 05:59', 'night'],
    ['2026-01-01 06:00', 'day'],
    ['2026-01-01 17:59', 'day'],
    ['2026-01-01 18:00', 'night'],
    ['2026-01-01T12:00:00Z', 'night'],
    ['2026-01-01T08:00:00+08:00', 'day'],
    ['2026-02-31 09:00', null]
  ];
  for (const [stamp, period] of examples) {
    assert.equal(timeInfo(stamp).period, period, stamp);
  }
  const p = point(0,0);
  const day = samples(p,Array(5).fill(-90));
  const night = samples(p,Array(4).fill(-120)).map(s=>s.replace('T12','T22'));
  const out = run([...day,...night,p.lat+','+p.lon+',-110,bad',day[0].replace('T12','T06')+'Z']);
  assert.equal(out.dropped.timestamp,1);
  assert.equal(out.result.dropped_rows,2);
  assert.equal(out.periods.all.samples,9);
  assert.equal(out.periods.day.cells[0].rsrp,-90);
  assert.equal(out.periods.night.cells.length,0);
});

test('Станции · площадка на 499,9 м отклоняется, на 500 м допускается', () => {
  const tower = thresholdSite(0,'T');
  const candidates = [thresholdSite(499.9,'A'),thresholdSite(500,'B'),thresholdSite(501,'C')];
  assert.equal(haversine(tower,candidates[1],thresholdRadius),500);
  const out = run([], [tower], candidates, {...DEMO_BOUNDS,earth_radius_m:thresholdRadius});
  assert.deepEqual(out.candidates.map(c=>c.allowed),[false,true,true]);
  assert.deepEqual(out.result.best_candidates,['B','C']);
});

test('Охват · 1 км включительно, ячейка в пересечении считается один раз', () => {
  const options = [thresholdSite(0,'A'),thresholdSite(500,'B')];
  const cells = [-1000,-1000.1,450,1450,1500,1500.1].map((m,i)=>thresholdSite(m,'K'+i));
  assert.equal(haversine(options[0],cells[0],thresholdRadius),1000);
  assert.equal(planSites(options,cells,thresholdRadius).best.count,4);
  assert.equal(planSites(options.slice(0,1),cells,thresholdRadius).best.ids.length,0);
});

test('Выбор пары · пример, где полный перебор покрывает больше жадного выбора', () => {
  const options = [metersNorth(0,'A'),metersNorth(-1000,'B'),metersNorth(1000,'C')];
  const cells = [-1900,-1800,-930,-870,-800,800,870,930,1800,1900].map((m,i)=>metersNorth(m,'K'+i));
  const plan = planSites(options,cells);
  assert.deepEqual(plan.best,{ids:['B','C'],count:10});
  assert.deepEqual(plan.greedy,{ids:['A','B'],count:8});
  assert.equal(plan.pairs,3);
});

test('Входные файлы · ошибки координат, идентификаторов и границ района', () => {
  assert.throws(()=>run([], [{id:'A',lat:'',lon:74}]),/towers.csv/);
  assert.throws(()=>run([],[],[metersNorth(0,'C'),metersNorth(10,'C')]),/candidates.csv/);
  assert.throws(()=>gridFor({...DEMO_BOUNDS,north:10}),/границы/);
});

test('Сетка · отдельное начало координат и замеры на северной и восточной границах', () => {
  const at = grid.point(1,2), end = grid.point(5,6);
  const custom = gridFor({lat_min:at.lat,lon_min:at.lon,lat_max:end.lat,lon_max:end.lon,
    grid_origin_lat:DEMO_BOUNDS.south,grid_origin_lon:DEMO_BOUNDS.west});
  assert.deepEqual(custom.index(at.lat,at.lon),[1,2]);
  assert.deepEqual(custom.index(end.lat,end.lon),[4,5]);
  assert.deepEqual(custom.point(2,3),grid.point(2,3));
});
