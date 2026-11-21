import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { analyze } from '../src/analysis.js';
import { MAP_IMAGE_SIZE } from '../src/basemap.js';

const dataset = new URL('../data/07_coverage/', import.meta.url);
const report = new URL('../dist/', import.meta.url);
const read = (folder, name) => readFile(new URL(name, folder), 'utf8');

test('Набор участников · расчёт из CSV, result.json и данные HTML-карты', async () => {
  const files = {
    measurements: await read(dataset, 'measurements.csv'),
    towers: await read(dataset, 'towers.csv'),
    candidates: await read(dataset, 'candidates.csv')
  };
  const bounds = JSON.parse(await read(dataset, 'bounds.json'));
  const data = analyze(files, bounds);
  const { all, day, night } = data.periods;
  assert.equal(data.total, 5000);
  assert.equal(data.candidates.length, 20);
  assert.equal(data.towers.length, 4);
  assert.equal(all.samples, 4800);
  assert.equal(all.cells.length, 387);
  assert.equal(all.sparse, 11);
  assert.equal(day.samples + night.samples, all.samples);
  const dropped = Object.values(data.dropped).reduce((sum, count) => sum + count, 0);
  assert.equal(dropped, data.result.dropped_rows);

  const expected = JSON.parse(await read(dataset, 'expected.json'));
  assert.deepEqual(data.result, expected, 'Результат расчёта из исходных CSV');
  assert.deepEqual(JSON.parse(await read(report, 'result.json')), expected, 'JSON в поставке');

  const html = await read(report, 'index.html');
  const payload = html.match(/<script type="application\/json" id="initial-data">([\s\S]*?)<\/script>/);
  assert.ok(payload, 'В HTML-карте присутствуют рассчитанные данные');
  const embedded = JSON.parse(payload[1]);
  assert.deepEqual(embedded.data, data, 'Встроенный набор соответствует расчёту по всем периодам');
  assert.equal(embedded.source, 'participants');
});

test('Автономный отчёт содержит исходное изображение карты сервиса WMS', async () => {
  const html = await read(report, 'index.html');
  const payload = html.match(/id="basemap-data">([\s\S]*?)<\/script>/);
  assert.ok(payload);
  const dataUrl = JSON.parse(payload[1]);
  const prefix = 'data:image/png;base64,';
  assert.ok(dataUrl.startsWith(prefix));
  const image = Buffer.from(dataUrl.slice(prefix.length), 'base64');
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(image.readUInt32BE(16), MAP_IMAGE_SIZE);
  assert.equal(image.readUInt32BE(20), MAP_IMAGE_SIZE);
  const original = await readFile(new URL('../assets/bishkek.png', import.meta.url));
  assert.ok(image.equals(original), 'Встроенный PNG побайтово совпадает с подложкой проекта');
});
