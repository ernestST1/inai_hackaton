import { randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { BISHKEK_BBOX, MAP_IMAGE_SIZE, WMS_ENDPOINT, WMS_LAYER } from '../src/basemap.js';

// Обновление подложки — отдельная команда. Обычная сборка читает готовый PNG с диска.
const request = new URL(WMS_ENDPOINT);
request.search = new URLSearchParams({
  SERVICE: 'WMS',
  VERSION: '1.1.1',
  REQUEST: 'GetMap',
  LAYERS: WMS_LAYER,
  STYLES: '',
  SRS: 'EPSG:3857',
  BBOX: BISHKEK_BBOX.join(','),
  WIDTH: MAP_IMAGE_SIZE,
  HEIGHT: MAP_IMAGE_SIZE,
  FORMAT: 'image/png',
});
const response = await fetch(request, {
  headers: { 'User-Agent': 'EfirCoverageAtlas/1.0 (https://github.com/ernestST1/inai_hackaton)' },
  signal: AbortSignal.timeout(60000),
});
if (!response.ok) throw new Error('Сервис карты вернул HTTP ' + response.status);
const image = Buffer.from(await response.arrayBuffer());
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
if (
  image.length < 33 ||
  !image.subarray(0, 8).equals(pngSignature) ||
  image.readUInt32BE(16) !== MAP_IMAGE_SIZE ||
  image.readUInt32BE(20) !== MAP_IMAGE_SIZE
) {
  throw new Error('Сервис вернул другой формат или размер карты.');
}
const destination = new URL('../assets/bishkek.png', import.meta.url);
const temporary = new URL(randomUUID() + '.tmp', destination);
try {
  await writeFile(temporary, image);
  await rename(temporary, destination);
} finally {
  await rm(temporary, { force: true });
}
console.log('Карта Бишкека сохранена в assets/bishkek.png');
