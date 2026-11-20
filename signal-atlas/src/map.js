import { COVERAGE_RADIUS_M, gridFor } from './geo.js';
import { icon, escapeHtml } from './icons.js';
import { heatOverlays } from './heat.js';

const statusText = { strong:'Сильный сигнал', medium:'Средний сигнал', weak:'Слабый сигнал' };
const colors = { strong:'#49b488', medium:'#efbd55', weak:'#e77e70' };
const latlng = point => [point.lat,point.lon];
export const displayNumber = value => new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value).replace('-','−');
const number = displayNumber;
const get = id => document.getElementById(id);

export class CoverageMap {
  constructor() {
    this.map = L.map('map', {zoomControl:false, minZoom:2, maxZoom:19, zoomSnap:.1, zoomDelta:.75, preferCanvas:true, attributionControl:true});
    const map = this.map;
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution('<a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>');
    const nw = map.unproject([5792*256,3013*256],13), se = map.unproject([5795*256,3016*256],13);
    const base = JSON.parse(get('basemap-data').textContent);
    L.imageOverlay(base,[nw,se],{pane:'tilePane',alt:'Улицы, парки и реки Бишкека'}).addTo(map);
    map.createPane('heatSurface').style.zIndex = 350;
    L.control.scale({imperial:false, maxWidth:95, position:'bottomleft'}).addTo(map);
    this.surface = L.layerGroup().addTo(map);
    this.markers = L.layerGroup().addTo(map);
    this.shapes = new Map();
    this.mode = 'grid';
    get('zoom-in').onclick = () => map.zoomIn();
    get('zoom-out').onclick = () => map.zoomOut();
    get('fit-map').onclick = () => this.fit();
    const menu = get('layer-menu'), toggle = get('toggle-layers');
    const closeMenu = () => { menu.hidden = true; toggle.setAttribute('aria-expanded','false'); };
    toggle.onclick = () => { menu.hidden = !menu.hidden; toggle.setAttribute('aria-expanded', String(!menu.hidden)); };
    document.addEventListener('click', e => { if (!e.target.closest('.layer-box')) closeMenu(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { closeMenu(); toggle.focus(); } });
    menu.onchange = () => this.drawMarkers();
    const online = document.createElement('label');
    online.innerHTML = '<input type="checkbox" id="online-map">Онлайн-подложка OSM';
    menu.append(online);
    const onlineTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,maxNativeZoom:19});
    get('online-map').onchange = e => e.target.checked ? onlineTiles.addTo(map) : onlineTiles.remove();
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(get('map'));
  }

  setData(data, period, refit = false) {
    this.data = data;
    this.period = data.periods[period];
    this.grid = gridFor(data.bounds);
    this.heat = null;
    if (refit) this.fit();
    this.drawSurface();
    this.drawMarkers();
  }
  fit() {
    const {south,west,north,east} = this.data.bounds;
    this.map.invalidateSize().fitBounds([[south,west],[north,east]],{padding:[16,16],maxZoom:17,animate:false});
  }
  setMode(mode) {
    this.mode = mode;
    this.drawSurface();
  }
  drawSurface() {
    this.surface.clearLayers();
    this.shapes.clear();
    const heat = this.mode === 'heat';
    if (heat) {
      this.heat ||= heatOverlays(this.period.cells,this.grid);
      this.surface.addLayer(this.heat);
    }
    const {dLat,dLon} = this.grid;
    for (const c of this.period.cells) {
      const bounds = [[c.lat-dLat/2,c.lon-dLon/2],[c.lat+dLat/2,c.lon+dLon/2]];
      const shape = L.rectangle(bounds, {stroke:!heat, color:'#f5f7ec',opacity:.86,weight:1.15,
        fill:true, fillColor:colors[c.level],fillOpacity:heat ? 0 : .63});
      shape.bindPopup('<strong>' + c.id + '</strong>' + statusText[c.level] + ' · ' + number(c.rsrp) + ' дБм<br>Замеров: ' + c.count + '<br>Центр: ' + c.lat.toFixed(5) + ', ' + c.lon.toFixed(5));
      this.shapes.set(c.id,shape);
      this.surface.addLayer(shape);
    }
  }
  drawMarkers() {
    this.markers.clearLayers();
    const pair = this.period.plan.best.ids;
    for (const c of this.data.candidates) {
      const chosen = pair.includes(c.id);
      if (chosen && get('layer-radius').checked)
        L.circle(latlng(c), {radius:COVERAGE_RADIUS_M,color:'#176448',weight:1.8,dashArray:'6 5',fillOpacity:.04,interactive:false}).addTo(this.markers);
      const id = escapeHtml(c.id);
      const popup = '<strong>Площадка ' + id + '</strong>' + (chosen ? 'Рекомендована для новой БС' : c.allowed ? 'Допустимая площадка' : 'Ближе 500 м к существующей БС');
      if (chosen && get('layer-sites').checked) {
        L.marker(latlng(c), {title:'Площадка ' + c.id, alt:'Площадка ' + c.id, zIndexOffset:100,
          icon:L.divIcon({className:'candidate-icon',iconSize:[54,25],html:'<span class="candidate-pin">' + icon('pin',12) + id + '</span>'})
        }).bindPopup(popup).addTo(this.markers);
      } else if (get('layer-other').checked) {
        L.circleMarker(latlng(c),{radius:5,color:'white',weight:2,fillOpacity:1,fillColor:c.allowed ? '#428779' : '#8a9691'}).bindPopup(popup).addTo(this.markers);
      }
    }
    if (get('layer-towers').checked) for (const t of this.data.towers) {
      L.marker(latlng(t), {title:'Базовая станция ' + t.id, alt:'Базовая станция ' + t.id,
        icon:L.divIcon({className:'station-icon',iconSize:[24,24],html:'<span class="station-pin">' + icon('tower',15) + '</span>'})
      }).bindPopup('<strong>Станция ' + escapeHtml(t.id) + '</strong>Существующая базовая станция').addTo(this.markers);
    }
  }
  focusCell(id) {
    const shape = this.shapes.get(id);
    if (shape) {
      this.map.setView(shape.getBounds().getCenter(), Math.max(16,this.map.getZoom()),{animate:false});
      shape.openPopup();
    }
  }
  showPair() {
    get('layer-radius').checked = get('layer-sites').checked = true;
    this.drawMarkers();
    const points = this.data.candidates.filter(c => this.period.plan.best.ids.includes(c.id));
    const extent = L.latLngBounds([]);
    for (const c of points) extent.extend(L.latLng(latlng(c)).toBounds(2 * COVERAGE_RADIUS_M));
    if (extent.isValid()) this.map.fitBounds(extent,{padding:[18,18],animate:false});
  }
}
