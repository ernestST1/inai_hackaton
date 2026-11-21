import assert from 'node:assert/strict';
import test from 'node:test';
import { zoomForExtent } from '../src/map-viewport.js';

// Встроенное изображение занимает 3 × 3 тайла по 256 пикселей при zoom = 13.
const image = { x: 768, y: 768 };

test('Минимальный офлайн-масштаб заполняет и широкое, и высокое окно карты', () => {
  for (const view of [
    { x: 1400, y: 460 },
    { x: 365, y: 740 },
    { x: 450, y: 330 },
  ]) {
    for (const step of [0.1, 1]) {
      const zoom = zoomForExtent(view, image, true, step);
      const pixels = image.x * 2 ** (zoom - 13);
      assert.ok(pixels >= Math.max(view.x, view.y));
      assert.ok(pixels / 2 ** step < Math.max(view.x, view.y));
    }
  }
});

test('Район вне подложки целиком помещается в окно при максимальном отдалении', () => {
  const district = { x: 300, y: 900 };
  const view = { x: 900, y: 370 };
  const zoom = zoomForExtent(view, district, false, 0.1);
  const scale = 2 ** (zoom - 13);
  assert.ok(district.x * scale <= view.x && district.y * scale <= view.y);
  assert.ok(district.y * scale * 2 ** 0.1 > view.y);
});
