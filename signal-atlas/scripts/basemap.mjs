// Rebuild from the nine OpenFreeMap z13 vector tiles in .cache (see README).
import { readFile, writeFile } from 'node:fs/promises';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
const size = 1024;
const elements = [],
  labels = [],
  placed = [];
const escape = (str) =>
  String(str).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );
const roads = {
  path: [1.4, '#fafbf5'],
  service: [2.4, '#fdfdf8'],
  minor: [4.8, '#fffef9'],
  tertiary: [7, '#fffff9'],
  secondary: [9, '#fff9e2'],
  primary: [12, '#fff0bf'],
  trunk: [13, '#ffedb9'],
  motorway: [14, '#fff0bf'],
  rail: [2, '#a6b3ac'],
};
for (let x = 5792; x <= 5794; x++)
  for (let y = 3013; y <= 3015; y++) {
    const tile = new VectorTile(
      new Pbf(await readFile(new URL('../.cache/' + x + '-' + y + '.pbf', import.meta.url))),
    );
    const ox = (x - 5792) * size,
      oy = (y - 3013) * size;
    const viewport = [];
    function features(name, draw) {
      const layer = tile.layers[name];
      for (let i = 0; i < (layer?.length || 0); i++) {
        const f = layer.feature(i);
        const lines = f
          .loadGeometry()
          .map((line) =>
            line.map((p) => [
              Math.round((p.x * size) / f.extent),
              Math.round((p.y * size) / f.extent),
            ]),
          );
        draw(f.properties, lines);
      }
    }
    function path(lines, attrs, polygon = false) {
      viewport.push(
        '<path d="' +
          lines
            .map((line) => 'M' + line.map((p) => p.join(',')).join(' ') + (polygon ? 'Z' : ''))
            .join('') +
          '" ' +
          attrs +
          '/>',
      );
    }
    features('landuse', (p, lines) => {
      const color = {
        pitch: '#cadfba',
        playground: '#dce8c8',
        industrial: '#e2e0d7',
        school: '#e4e4d8',
        university: '#e1e4d6',
        hospital: '#e9e1d8',
      }[p.class];
      if (color) path(lines, 'fill="' + color + '"', true);
    });
    features('landcover', (p, lines) =>
      path(lines, 'fill="' + (p.class === 'wood' ? '#bed6b9' : '#d2e3c1') + '"', true),
    );
    features('park', (_, lines) => path(lines, 'fill="#cee0bf"', true));
    features('building', (_, lines) =>
      path(lines, 'fill="#d8dcd4" stroke="#d0d6cd" stroke-width=".55"', true),
    );
    features('water', (_, lines) => path(lines, 'fill="#b7d9df"', true));
    features('waterway', (p, lines) =>
      path(
        lines,
        'fill="none" stroke="#b8d6db" stroke-width="' + (p.class === 'river' ? 5 : 2.2) + '"',
      ),
    );
    const streets = [];
    features('transportation', (p, lines) => {
      if (roads[p.class]) streets.push({ lines, spec: roads[p.class], kind: p.class });
    });
    streets.sort((a, b) => a.spec[0] - b.spec[0]);
    for (const {
      lines,
      spec: [w],
    } of streets)
      if (w >= 4) path(lines, 'fill="none" stroke="#cdd2c7" stroke-width="' + (w + 1.8) + '"');
    for (const {
      lines,
      spec: [w, color],
      kind,
    } of streets)
      path(
        lines,
        'fill="none" stroke="' +
          color +
          '" stroke-width="' +
          w +
          '"' +
          (kind === 'rail' ? ' stroke-dasharray="5 2"' : ''),
      );
    features('transportation_name', (p, lines) => {
      if (!['primary', 'secondary', 'tertiary', 'minor'].includes(p.class)) return;
      const name = p['name:ru'] || p.name;
      if (!name) return;
      const line = lines.reduce((a, b) => (a.length > b.length ? a : b));
      const start = line[0],
        end = line.at(-1);
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 90) return;
      const middle = line[Math.floor(line.length / 2)];
      const lx = ox + (line.length === 2 ? (start[0] + end[0]) / 2 : middle[0]),
        ly = oy + (line.length === 2 ? (start[1] + end[1]) / 2 : middle[1]);
      if (placed.some((l) => Math.hypot(lx - l.x, ly - l.y) < (l.name === name ? 390 : 103)))
        return;
      let angle = (Math.atan2(end[1] - start[1], end[0] - start[0]) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      placed.push({ x: lx, y: ly, name });
      labels.push(
        '<text transform="translate(' +
          lx +
          ' ' +
          ly +
          ') rotate(' +
          angle.toFixed(1) +
          ')">' +
          escape(name.replace(/^улица /, 'ул. ').replace(/^проспект /, 'пр. ')) +
          '</text>',
      );
    });
    elements.push(
      '<svg x="' +
        ox +
        '" y="' +
        oy +
        '" width="1024" height="1024" overflow="hidden">' +
        viewport.join('') +
        '</svg>',
    );
  }
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3072 3072" width="3072" height="3072"><rect width="100%" height="100%" fill="#e8ebe2"/><g stroke-linejoin="round" stroke-linecap="round">' +
  elements.join('') +
  '</g><g font-family="Arial,sans-serif" font-size="13.5" fill="#6c756c" text-anchor="middle" stroke="#f7f7ed" stroke-width="2.8" paint-order="stroke">' +
  labels.join('') +
  '</g></svg>';
await writeFile(new URL('../assets/bishkek.svg', import.meta.url), svg);
