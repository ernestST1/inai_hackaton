// Границы встроенного SVG в пикселях Web Mercator на уровне 13.
const BASE_ZOOM = 13;
const TILE_SIZE = 256;
const BASE_NORTHWEST = [5792, 3013];
const BASE_SOUTHEAST = [5795, 3016];
const WORLD_MIN_ZOOM = 2;

function streetBounds(map) {
  const corner = (tile) => map.unproject(L.point(tile).multiplyBy(TILE_SIZE), BASE_ZOOM);
  return L.latLngBounds(corner(BASE_NORTHWEST), corner(BASE_SOUTHEAST));
}

// Масштаб Leaflet удваивает стороны карты при каждом целом шаге.
// Для подложки округляем вверх, чтобы оба края окна оставались внутри изображения.
// Для схемы без улиц округляем вниз, чтобы исследуемый район помещался целиком.
export function zoomForExtent(view, extent, fill, snap) {
  const ratioX = view.x / extent.x;
  const ratioY = view.y / extent.y;
  const zoom = BASE_ZOOM + Math.log2(fill ? Math.max(ratioX, ratioY) : Math.min(ratioX, ratioY));
  const steps = fill ? Math.ceil(zoom / snap) : Math.floor(zoom / snap);
  return Number((steps * snap).toFixed(2));
}

export class MapViewport {
  constructor(map, image) {
    this.map = map;
    const bounds = streetBounds(map);
    // Небольшой запас компенсирует округление координат Leaflet до пикселя.
    this.streetFrame = bounds.pad(-0.003);
    L.imageOverlay(image, bounds, { pane: 'tilePane', alt: 'Улицы, парки и реки Бишкека' }).addTo(
      map,
    );
    this.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });
    this.onlineInput = document.getElementById('online-map');
    this.zoomIn = document.getElementById('zoom-in');
    this.zoomOut = document.getElementById('zoom-out');
    this.zoomIn.onclick = () => map.zoomIn();
    this.zoomOut.onclick = () => map.zoomOut();
    document.getElementById('fit-map').onclick = () => this.fitDistrict();
    this.onlineInput.onchange = () => {
      if (this.onlineInput.checked) this.tiles.addTo(map);
      else this.tiles.remove();
      this.refresh();
    };
    map.on('zoomend zoomlevelschange', () => this.updateButtons());
    new ResizeObserver(() => this.refresh()).observe(map.getContainer());
  }

  setDistrict({ south, west, north, east }) {
    this.district = L.latLngBounds([south, west], [north, east]);
    this.fitDistrict();
  }

  fitDistrict() {
    this.setFrame(this.district);
    this.map.fitBounds(this.district, { padding: [16, 16], maxZoom: 17, animate: false });
  }

  showArea(bounds) {
    if (!this.frame.contains(bounds))
      this.setFrame(
        L.latLngBounds(this.district.getSouthWest(), this.district.getNorthEast()).extend(bounds),
      );
    this.map.fitBounds(bounds, { padding: [18, 18], animate: false });
  }

  setFrame(area) {
    this.frame = this.streetFrame.contains(area) ? this.streetFrame : area.pad(0.35);
    this.refresh();
  }

  refresh() {
    if (!this.frame) return;
    const map = this.map;
    if (!map.getContainer().clientWidth || !map.getContainer().clientHeight) return;
    map.invalidateSize({ animate: false });
    const size = map.getSize();
    const online = this.onlineInput.checked;
    const hasStreets = this.frame === this.streetFrame;
    const span = map
      .project(this.frame.getSouthEast(), BASE_ZOOM)
      .subtract(map.project(this.frame.getNorthWest(), BASE_ZOOM));
    const snap = L.Browser.any3d ? map.options.zoomSnap : 1;
    const minimum = online ? WORLD_MIN_ZOOM : zoomForExtent(size, span, hasStreets, snap);
    const limits = online ? null : this.frame;
    map.setMinZoom(Math.min(map.getMaxZoom(), Math.max(WORLD_MIN_ZOOM, minimum)));
    if (map.options.maxBounds !== limits) map.setMaxBounds(limits);
    if (limits && Number.isFinite(map.getZoom())) map.panInsideBounds(limits, { animate: false });
    document.getElementById('schematic-note').hidden = online || hasStreets;
    this.updateButtons();
  }

  updateButtons() {
    const zoom = this.map.getZoom();
    this.zoomIn.disabled = this.map.getMaxZoom() - zoom < 1e-6;
    this.zoomOut.disabled = zoom - this.map.getMinZoom() < 1e-6;
  }
}
