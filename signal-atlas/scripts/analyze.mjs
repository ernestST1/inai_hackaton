import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { makeReport } from './report.mjs';

async function readBounds(directory, argument) {
  const coordinates = argument?.split(',');
  if (coordinates?.length === 4) {
    const [south, west, north, east] = coordinates.map(value => value.trim() ? Number(value) : NaN);
    return { south, west, north, east };
  }
  const filename = argument || join(directory, 'bounds.json');
  const contents = await readFile(filename, 'utf8');
  return JSON.parse(contents.replace(/^\uFEFF/, ''));
}

async function main() {
  const { values } = parseArgs({
    options: {
      data: { type: 'string' },
      bounds: { type: 'string' },
      out: { type: 'string', default: 'output' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help) {
    console.log('node scripts/analyze.mjs --data <папка CSV> [--bounds <файл JSON | юг,запад,север,восток>] [--out <папка результата>]');
    console.log('По умолчанию границы читаются из bounds.json в папке CSV.');
    return;
  }
  if (!values.data) throw new Error('Укажите папку с тремя CSV через --data.');

  const directory = resolve(values.data);
  const output = resolve(values.out);
  const bounds = await readBounds(directory, values.bounds);
  const { periods, result, total } = await makeReport(directory, bounds, output);
  const pair = result.best_candidates.join(' + ') || 'нет допустимой пары';
  console.log('Принято замеров: ' + periods.all.samples + ' / ' + total);
  console.log('Отброшено: ' + result.dropped_rows + '. Пара: ' + pair + '. Охват: ' + result.covered_weak_cells);
  console.log(join(output, 'index.html'));
  console.log(join(output, 'result.json'));
}

try {
  await main();
} catch (error) {
  console.error('Ошибка расчёта. ' + error.message);
  process.exitCode = 1;
}
