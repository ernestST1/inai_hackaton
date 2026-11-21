import { COVERAGE_RADIUS_M, gridFor, haversine } from './geo.js';
import { MIN_TOWER_DISTANCE_M } from './planning.js';
import { icon } from './icons.js';
import { escapeHtml, formatNumber } from './format.js';
import { heatOverlays } from './heat.js';
import { MapViewport } from './map-viewport.js';

const statusText = { strong: 'Сильный сигнал', medium: 'Средний сигнал', weak: 'Слабый сигнал' };
const colors = { strong: '#49b488', medium: '#efbd55', weak: '#e77e70' };
const latlng = (point) => [point.lat, point.lon];
const outlineColors = { shared: '#42584b', best: '#1561a0', greedy: '#7d3495' };
const get = (id) => document.getElementById(id);

function cellPopup(cell, coveringSites) {
  const coverage = coveringSites?.length
    ? `Покрыта новой БС: ${coveringSites.map(escapeHtml).join(', ')}`
    : 'Вне охвата выбранной пары';
  return `<div class="cell-details">
    <strong>${escapeHtml(cell.id)}</strong>
    <div class="signal-reading"><i class="swatch ${cell.level}"></i>${statusText[cell.level]}</div>
    <dl><dt>Медиана</dt><dd>${formatNumber(cell.rsrp)} дБм</dd>
    <dt>Замеры</dt><dd>${formatNumber(cell.count)}</dd>
    <dt>Центр</dt><dd>${cell.lat.toFixed(5)}, ${cell.lon.toFixed(5)}</dd></dl>
    ${coveringSites ? `<div class="cell-coverage">${coverage}</div>` : ''}
  </div>`;
}

export class CoverageMap {
  constructor() {
    this.map = L.map('map', {
      zoomControl: false,
      minZoom: 2,
      maxZoom: 19,
      zoomSnap: 0.1,
      zoomDelta: 0.75,
      maxBoundsViscosity: 1,
      bounceAtZoomLimits: false,
      preferCanvas: true,
      attributionControl: false, // Источник и лицензия всегда видны под картой.
    });
    const map = this.map;
    this.viewport = new MapViewport(map, JSON.parse(get('basemap-data').textContent));
    map.createPane('heatSurface').style.zIndex = 350;
    L.control.scale({ imperial: false, maxWidth: 95, position: 'bottomleft' }).addTo(map);
    this.surface = L.layerGroup().addTo(map);
    this.markers = L.layerGroup().addTo(map);
    this.shapes = new Map();
    this.mode = 'grid';
    const menu = get('layer-menu'),
      toggle = get('toggle-layers');
    const closeMenu = () => {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    };
    toggle.onclick = () => {
      menu.hidden = !menu.hidden;
      toggle.setAttribute('aria-expanded', String(!menu.hidden));
    };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.layer-box')) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) {
        closeMenu();
        toggle.focus();
      }
    });
    menu.onchange = (event) => {
      if (event.target.id === 'online-map') return;
      if (event.target.id === 'layer-signal') {
        this.drawSurface();
        return;
      }
      if (event.target.id === 'layer-radius') this.drawSurface();
      this.drawMarkers();
    };
  }

  setData(data, period, algorithm, coverage, refit = false) {
    this.data = data;
    if (this.period !== data.periods[period]) this.heat = null;
    this.period = data.periods[period];
    this.algorithm = algorithm;
    this.coverage = coverage;
    this.grid = gridFor(data.bounds);
    if (refit) this.viewport.setDistrict(data.bounds);
    this.drawSurface();
    this.drawMarkers();
  }
  setMode(mode) {
    this.mode = mode;
    get('layer-signal').checked = true;
    this.drawSurface();
  }
  drawSurface() {
    this.surface.clearLayers();
    this.shapes.clear();
    const visible = get('layer-signal').checked;
    const legend = get('coverage-legend');
    const showCoverage = get('layer-radius').checked;
    legend.hidden = !visible || !showCoverage;
    get('signal-legend').hidden = !visible;
    if (!visible) return;
    const heat = this.mode === 'heat';
    if (heat) {
      this.heat ||= heatOverlays(this.period.cells, this.grid);
      this.surface.addLayer(this.heat);
    }
    const { dLat, dLon } = this.grid;
    if (showCoverage) {
      const { shared, best, greedy } = this.coverage.counts;
      legend.innerHTML = `<strong>Охват слабых ячеек</strong>
        <span><b class="coverage-key shared"></b>Обе пары · ${shared}</span>
        <span><b class="coverage-key best"></b>Только перебор · ${best}</span>
        <span><b class="coverage-key greedy"></b>Только жадный · ${greedy}</span>
        <strong>${best === greedy ? 'Охват равен' : `Перебор выигрывает на ${best - greedy} яч.`}</strong>`;
    }
    for (const c of this.period.cells) {
      const bounds = [
        [c.lat - dLat / 2, c.lon - dLon / 2],
        [c.lat + dLat / 2, c.lon + dLon / 2],
      ];
      const hit = this.coverage.byCell.get(c.id);
      const outline = showCoverage && hit?.category;
      const shape = L.rectangle(bounds, {
        stroke: Boolean(outline) || !heat,
        color: outline ? outlineColors[outline] : '#f5f7ec',
        opacity: outline ? 1 : 0.86,
        weight: outline ? 2.3 : 1.15,
        dashArray: outline === 'greedy' ? '4 2' : null,
        fill: true,
        fillColor: colors[c.level],
        fillOpacity: heat ? 0 : 0.5,
      });
      shape.bindPopup(cellPopup(c, showCoverage ? hit?.[this.algorithm] : undefined));
      this.shapes.set(c.id, shape);
      this.surface.addLayer(shape);
    }
  }
  drawMarkers() {
    this.markers.clearLayers();
    const pair = this.period.plan[this.algorithm].ids;
    const exclusion = get('layer-exclusion').checked;
    if (exclusion)
      for (const tower of this.data.towers) {
        L.circle(latlng(tower), {
          radius: MIN_TOWER_DISTANCE_M,
          color: '#a15b19',
          weight: 1.8,
          dashArray: '3 4',
          fillColor: '#d99448',
          fillOpacity: 0.15,
          interactive: false,
        }).addTo(this.markers);
      }
    for (const c of this.data.candidates) {
      const chosen = pair.includes(c.id);
      if (chosen && get('layer-radius').checked)
        L.circle(latlng(c), {
          radius: COVERAGE_RADIUS_M,
          color: outlineColors[this.algorithm],
          weight: 1.8,
          dashArray: '6 5',
          fillOpacity: 0.04,
          interactive: false,
        }).addTo(this.markers);
      const id = escapeHtml(c.id);
      const popup =
        '<strong>Площадка ' +
        id +
        '</strong>' +
        (chosen
          ? 'Входит в выбранную пару'
          : c.allowed
            ? 'Допустимая площадка'
            : 'Ближе 500 м к существующей БС');
      if (chosen && get('layer-sites').checked) {
        L.marker(latlng(c), {
          title: 'Площадка ' + c.id,
          alt: 'Площадка ' + c.id,
          zIndexOffset: 100,
          icon: L.divIcon({
            className: 'candidate-icon',
            iconSize: [54, 25],
            html: `<span class="candidate-pin ${this.algorithm}">${icon('pin', 12)}${id}</span>`,
          }),
        })
          .bindPopup(popup)
          .addTo(this.markers);
      } else if (get('layer-other').checked || (exclusion && !c.allowed)) {
        L.circleMarker(latlng(c), {
          radius: 5,
          color: 'white',
          weight: 2,
          fillOpacity: 1,
          fillColor: c.allowed ? '#428779' : '#a15b19',
        })
          .bindTooltip(id)
          .bindPopup(popup)
          .addTo(this.markers);
      }
    }
    if (get('layer-towers').checked)
      for (const t of this.data.towers) {
        const blocked = exclusion
          ? this.data.candidates.filter(
              (site) => haversine(t, site, this.data.bounds.earth_radius_m) < MIN_TOWER_DISTANCE_M,
            )
          : [];
        const reason = blocked.length
          ? '<br>В запретной зоне: ' + blocked.map((site) => escapeHtml(site.id)).join(', ')
          : '';
        L.marker(latlng(t), {
          title: 'Базовая станция ' + t.id,
          alt: 'Базовая станция ' + t.id,
          icon: L.divIcon({
            className: 'station-icon',
            iconSize: [24, 24],
            html: '<span class="station-pin">' + icon('tower', 15) + '</span>',
          }),
        })
          .bindPopup(
            '<strong>Станция ' +
              escapeHtml(t.id) +
              '</strong>Существующая базовая станция' +
              reason,
          )
          .addTo(this.markers);
      }
  }
  focusCell(id) {
    if (!get('layer-signal').checked) {
      get('layer-signal').checked = true;
      this.drawSurface();
    }
    const shape = this.shapes.get(id);
    if (shape) {
      this.map.setView(shape.getBounds().getCenter(), Math.max(16, this.map.getZoom()), {
        animate: false,
      });
      shape.openPopup();
    }
  }
  showPair() {
    get('layer-signal').checked = true;
    get('layer-radius').checked = get('layer-sites').checked = true;
    this.drawSurface();
    this.drawMarkers();
    const points = this.data.candidates.filter((c) =>
      this.period.plan[this.algorithm].ids.includes(c.id),
    );
    const extent = L.latLngBounds([]);
    for (const c of points) extent.extend(L.latLng(latlng(c)).toBounds(2 * COVERAGE_RADIUS_M));
    if (extent.isValid()) this.viewport.showArea(extent);
  }
}
