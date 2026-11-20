(() => {
  // src/csv.js
  function parseCsv(source2, required, filename) {
    const text = source2.replace(/^\uFEFF/, "");
    const header = text.split(/[\r\n]/, 1)[0];
    const delimiter = [",", ";", "	"].sort((a, b) => header.split(b).length - header.split(a).length)[0];
    const records = [];
    let record = [], value = "", quoted = false, closed = false;
    function finishRecord() {
      record.push(value.trim());
      if (record.length > 1 || record[0] !== "") records.push(record);
      record = [];
      value = "";
      closed = false;
    }
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char !== '"') value += char;
        else if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (char === delimiter) {
        record.push(value.trim());
        value = "";
        closed = false;
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i++;
        finishRecord();
      } else if (char === '"' && !value && !closed) {
        quoted = true;
      } else if (char === '"' || closed && char.trim()) {
        throw new Error(filename + " — ошибка кавычек в записи " + (records.length + 1));
      } else value += char;
    }
    if (quoted) throw new Error(filename + " — поле в кавычках не закрыто.");
    finishRecord();
    const columns = (records.shift() || []).map((name) => name.toLowerCase());
    if (new Set(columns).size !== columns.length) throw new Error(filename + " — заголовки повторяются.");
    const missing = required.filter((name) => !columns.includes(name));
    if (missing.length) throw new Error(filename + " — отсутствуют поля " + missing.join(", "));
    return records.map((fields) => fields.length === columns.length ? Object.fromEntries(columns.map((column, i) => [column, fields[i]])) : null);
  }

  // src/input.js
  var DECIMAL_NUMBER = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i;
  var ISO_TIMESTAMP = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/i;
  var BISHKEK_OFFSET_MS = 6 * 60 * 60 * 1e3;
  var MIN_RSRP_DBM = -140;
  var MAX_RSRP_DBM = -44;
  function parseNumber(text) {
    if (typeof text !== "string" || !DECIMAL_NUMBER.test(text)) return NaN;
    return Number(text.replace(",", "."));
  }
  function parseTimestamp(text) {
    if (/^\d{10}$/.test(text)) return Number(text) * 1e3;
    if (/^\d{13}$/.test(text)) return Number(text);
    const parts = ISO_TIMESTAMP.exec(text);
    if (!parts) return NaN;
    const [, year, month, day, hour, minute, second = "00", fraction = "", zone = "+06:00"] = parts;
    const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    if (+month < 1 || +month > 12 || +day < 1 || +day > lastDay) return NaN;
    if (+hour >= 24 || +minute >= 60 || +second >= 60) return NaN;
    const date = [year, month, day].join("-");
    const time = [hour, minute, second].join(":");
    return Date.parse(date + "T" + time + fraction + zone);
  }
  function timeInfo(text) {
    const timestamp = parseTimestamp(text);
    const localHour = new Date(timestamp + BISHKEK_OFFSET_MS).getUTCHours();
    if (!Number.isFinite(localHour)) return { key: text, period: null };
    return { key: timestamp, period: localHour >= 6 && localHour < 18 ? "day" : "night" };
  }
  function cleanMeasurements(csv, bounds) {
    const records = parseCsv(csv, ["lat", "lon", "rsrp_dbm", "timestamp"], "measurements.csv");
    const dropped = { malformed: 0, signal: 0, outside: 0, timestamp: 0, duplicate: 0 };
    const accepted = [];
    const seen = /* @__PURE__ */ new Set();
    for (const row of records) {
      const lat = parseNumber(row?.lat);
      const lon = parseNumber(row?.lon);
      const rsrp = parseNumber(row?.rsrp_dbm);
      if (![lat, lon, rsrp].every(Number.isFinite)) {
        dropped.malformed++;
        continue;
      }
      if (rsrp < MIN_RSRP_DBM || rsrp > MAX_RSRP_DBM) {
        dropped.signal++;
        continue;
      }
      if (lat < bounds.south || lat > bounds.north || lon < bounds.west || lon > bounds.east) {
        dropped.outside++;
        continue;
      }
      const time = timeInfo(row.timestamp);
      if (!time.period) {
        dropped.timestamp++;
        continue;
      }
      const key = JSON.stringify([lat, lon, rsrp, time.key]);
      if (seen.has(key)) {
        dropped.duplicate++;
        continue;
      }
      seen.add(key);
      accepted.push({ lat, lon, rsrp, period: time.period });
    }
    return { accepted, dropped, total: records.length };
  }
  function compareSiteIds(first, second) {
    if (first.id === second.id) return 0;
    return first.id < second.id ? -1 : 1;
  }
  function readSites(csv, filename) {
    const records = parseCsv(csv, ["id", "lat", "lon"], filename);
    const sites = [];
    const ids = /* @__PURE__ */ new Set();
    for (const [index, row] of records.entries()) {
      const id = row?.id;
      const lat = parseNumber(row?.lat);
      const lon = parseNumber(row?.lon);
      const validLat = Number.isFinite(lat) && Math.abs(lat) <= 90;
      const validLon = Number.isFinite(lon) && Math.abs(lon) <= 180;
      if (!id || ids.has(id) || !validLat || !validLon) {
        throw new Error(filename + " — проверьте ID и координаты в записи " + (index + 2) + ".");
      }
      ids.add(id);
      sites.push({ id, lat, lon });
    }
    return sites.sort(compareSiteIds);
  }

  // src/cells.js
  var MIN_SAMPLES_PER_CELL = 5;
  var WEAK_BELOW_DBM = -105;
  var STRONG_FROM_DBM = -90;
  function classify(rsrp) {
    if (rsrp < WEAK_BELOW_DBM) return "weak";
    if (rsrp >= STRONG_FROM_DBM) return "strong";
    return "medium";
  }
  function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  function groupByCell(measurements, grid) {
    const groups = /* @__PURE__ */ new Map();
    for (const measurement of measurements) {
      const [row, col] = grid.index(measurement.lat, measurement.lon);
      const id = "X" + String(col).padStart(3, "0") + "_Y" + String(row).padStart(3, "0");
      if (!groups.has(id)) {
        const center = grid.point(row + 0.5, col + 0.5);
        groups.set(id, { id, row, col, ...center, all: [], day: [], night: [] });
      }
      const group = groups.get(id);
      group.all.push(measurement.rsrp);
      group[measurement.period].push(measurement.rsrp);
    }
    return groups;
  }
  function summarizeCells(groups, period2) {
    const cells = [];
    const counts = { weak: 0, medium: 0, strong: 0 };
    let samples = 0;
    let sparse = 0;
    for (const group of groups.values()) {
      const values = group[period2];
      if (values.length === 0) continue;
      samples += values.length;
      if (values.length < MIN_SAMPLES_PER_CELL) {
        sparse++;
        continue;
      }
      const { id, row, col, lat, lon } = group;
      const rsrp = median(values);
      const level = classify(rsrp);
      counts[level]++;
      cells.push({ id, row, col, lat, lon, rsrp, count: values.length, level });
    }
    cells.sort((a, b) => a.rsrp - b.rsrp || a.row - b.row || a.col - b.col);
    return { cells, counts, samples, sparse };
  }

  // src/geo.js
  var RADIANS_PER_DEGREE = Math.PI / 180;
  var EARTH_RADIUS = 6371e3;
  var CELL_METRES = 200;
  var COVERAGE_RADIUS_M = 1e3;
  function validateBounds(bounds = {}) {
    if (!bounds || typeof bounds !== "object") throw new Error("Ожидается объект с границами района.");
    const {
      south = bounds.lat_min,
      west = bounds.lon_min,
      north = bounds.lat_max,
      east = bounds.lon_max,
      grid_origin_lat = south,
      grid_origin_lon = west,
      cell_size_m = CELL_METRES,
      earth_radius_m = EARTH_RADIUS,
      timezone = "Asia/Bishkek"
    } = bounds;
    if (![south, west, north, east].every(Number.isFinite) || south <= -90 || north >= 90 || west < -180 || east > 180 || south >= north || west >= east) {
      throw new Error("Проверьте границы района. Юг должен быть южнее севера, запад — западнее востока.");
    }
    if (!Number.isFinite(grid_origin_lat) || Math.abs(grid_origin_lat) >= 90 || !Number.isFinite(grid_origin_lon) || Math.abs(grid_origin_lon) > 180) {
      throw new Error("Проверьте координаты начала сетки в bounds.json.");
    }
    const validRadius = Number.isFinite(earth_radius_m) && earth_radius_m > 0;
    if (cell_size_m !== CELL_METRES || timezone !== "Asia/Bishkek" || !validRadius) {
      throw new Error("Для района Бишкека укажите шаг 200 м, зону Asia/Bishkek и положительный радиус Земли.");
    }
    return { south, west, north, east, grid_origin_lat, grid_origin_lon, cell_size_m, earth_radius_m, timezone };
  }
  function haversine(a, b, radius = EARTH_RADIUS) {
    const dLat = (b.lat - a.lat) * RADIANS_PER_DEGREE;
    const dLon = (b.lon - a.lon) * RADIANS_PER_DEGREE;
    const latA = a.lat * RADIANS_PER_DEGREE;
    const latB = b.lat * RADIANS_PER_DEGREE;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  function coversCell(site, cell, radius = EARTH_RADIUS) {
    return haversine(site, cell, radius) <= COVERAGE_RADIUS_M;
  }
  function snapGridLine(value) {
    const line = Math.round(value);
    return Math.abs(value - line) < 1e-10 ? line : value;
  }
  function gridFor(bounds) {
    const { north, east, grid_origin_lat: originLat, grid_origin_lon: originLon, cell_size_m, earth_radius_m } = validateBounds(bounds);
    const dLat = cell_size_m / (earth_radius_m * RADIANS_PER_DEGREE);
    const dLon = dLat / Math.cos(originLat * RADIANS_PER_DEGREE);
    const rowAt = (lat) => snapGridLine((lat - originLat) / dLat);
    const colAt = (lon) => snapGridLine((lon - originLon) / dLon);
    const maxRow = Math.ceil(rowAt(north)) - 1;
    const maxCol = Math.ceil(colAt(east)) - 1;
    return {
      dLat,
      dLon,
      index(lat, lon) {
        return [Math.min(maxRow, Math.floor(rowAt(lat))), Math.min(maxCol, Math.floor(colAt(lon)))];
      },
      point(row, col) {
        return { lat: originLat + row * dLat, lon: originLon + col * dLon };
      }
    };
  }

  // src/planning.js
  var MIN_TOWER_DISTANCE_M = 500;
  function markEligibleSites(sites, towers, earthRadius) {
    return sites.map((site) => ({
      ...site,
      allowed: towers.every((tower) => haversine(site, tower, earthRadius) >= MIN_TOWER_DISTANCE_M)
    }));
  }
  function coveredByPair(first, second) {
    let count = first.covered.size;
    for (const cellId of second.covered) {
      if (!first.covered.has(cellId)) count++;
    }
    return count;
  }
  function exhaustivePair(options) {
    let best = { ids: [], count: 0 };
    let pairs = 0;
    for (let i = 0; i < options.length; i++) {
      for (let j = i + 1; j < options.length; j++) {
        const first = options[i];
        const second = options[j];
        const count = coveredByPair(first, second);
        if (pairs === 0 || count > best.count) {
          best = { ids: [first.id, second.id], count };
        }
        pairs++;
      }
    }
    return { best, pairs };
  }
  function greedyPair(options) {
    let best = { ids: [], count: 0 };
    if (options.length < 2) return best;
    let first = options[0];
    for (const site of options) {
      if (site.covered.size > first.covered.size) first = site;
    }
    for (const second of options) {
      if (second === first) continue;
      const count = coveredByPair(first, second);
      if (best.ids.length === 0 || count > best.count) {
        best = { ids: [first.id, second.id], count };
      }
    }
    return best;
  }
  function planSites(candidates, weakCells, earthRadius) {
    const options = [];
    for (const site of candidates) {
      if (!site.allowed) continue;
      const covered = /* @__PURE__ */ new Set();
      for (const cell of weakCells) {
        if (coversCell(site, cell, earthRadius)) covered.add(cell.id);
      }
      options.push({ id: site.id, covered });
    }
    options.sort(compareSiteIds);
    const { best, pairs } = exhaustivePair(options);
    return { best, greedy: greedyPair(options), pairs, eligible: options.length };
  }

  // src/analysis.js
  var PERIODS = ["all", "day", "night"];
  function analyze(files, rawBounds) {
    const bounds = validateBounds(rawBounds);
    const { accepted, dropped, total } = cleanMeasurements(files.measurements, bounds);
    const groups = groupByCell(accepted, gridFor(bounds));
    const towers = readSites(files.towers, "towers.csv");
    const sites = readSites(files.candidates, "candidates.csv");
    const candidates = markEligibleSites(sites, towers, bounds.earth_radius_m);
    const periods = {};
    for (const period2 of PERIODS) {
      const summary = summarizeCells(groups, period2);
      const weakCells = summary.cells.filter((cell) => cell.level === "weak");
      const plan2 = planSites(candidates, weakCells, bounds.earth_radius_m);
      periods[period2] = { ...summary, plan: plan2 };
    }
    const { cells, plan } = periods.all;
    const result = {
      worst_cells: cells.slice(0, 3).map((cell) => ({
        cell_id: cell.id,
        rsrp_median: cell.rsrp
      })),
      best_candidates: plan.best.ids,
      dropped_rows: total - accepted.length,
      covered_weak_cells: plan.best.count
    };
    return { bounds, towers, candidates, dropped, total, periods, result };
  }

  // src/icons.js
  var paths = {
    brand: '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M7.7 7.8a6 6 0 0 0 0 8.4m8.6-8.4a6 6 0 0 1 0 8.4M4.4 4.7a10.5 10.5 0 0 0 0 14.6m15.2-14.6a10.5 10.5 0 0 1 0 14.6"/>',
    map: '<path d="m3 5 6-2 6 3 6-2v15l-6 2-6-3-6 2zM9 3v15m6-12v15"/>',
    chart: '<path d="M4 3v17h17M9 15v-4m5 4V6m5 9V9"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v13c0 4 16 4 16 0V5M4 11c0 4 16 4 16 0"/>',
    pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.3"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v4c0 1 .8 2 2 2h12a2 2 0 0 0 2-2v-4"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
    signal: '<path d="M3 19v-3m5 3v-7m5 7V8m5 11V4" stroke-width="2.8"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/>',
    weak: '<path d="M3 18v-3m5 3v-7m5 7V7" stroke-width="2.6"/><path d="m17 5 4 4m0-4-4 4"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    heat: '<path d="M13 2c0 4-4 5-4 9-2-1-2-3-2-3-6 7-2 13 5 13 7 0 11-8 5-15 0 4-2 5-2 5s2-5-2-9Z"/>',
    layers: '<path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
    tower: '<path d="m8 21 4-11 4 11m-7-3h6M7 5a7 7 0 0 0 0 9m10-9a7 7 0 0 1 0 9M4 2a11 11 0 0 0 0 15M20 2a11 11 0 0 1 0 15"/><circle cx="12" cy="9" r="1.2" fill="currentColor"/>',
    aim: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
    plus: '<path d="M5 12h14m-7-7v14"/>',
    minus: '<path d="M5 12h14"/>',
    focus: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20.5 14.5a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z"/>',
    list: '<path d="M9 5h12M9 12h12M9 19h12"/><circle cx="4" cy="5" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="19" r="1"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.2"/>',
    file: '<path d="M5 2h9l5 5v15H5zM14 2v6h5M8 13h8m-8 4h6"/>',
    compare: '<path d="M4 6h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="18" r="2" fill="currentColor"/>'
  };
  function icon(name, size = 18) {
    return '<svg class="icon" aria-hidden="true" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + paths[name] + "</svg>";
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  // src/heat.js
  var CELLS_PER_BLOCK = 16;
  var PIXELS_PER_CELL = 8;
  var BLOCK_PIXELS = CELLS_PER_BLOCK * PIXELS_PER_CELL;
  var COLOR_STOPS = [
    [-130, [199, 75, 68]],
    [-106, [235, 128, 112]],
    [-105, [238, 177, 95]],
    [-95, [241, 207, 122]],
    [-90, [135, 195, 146]],
    [-70, [58, 161, 125]]
  ];
  function signalColor(rsrp) {
    for (let i = 1; i < COLOR_STOPS.length; i++) {
      const [high, end] = COLOR_STOPS[i];
      if (rsrp > high) continue;
      const [low, start] = COLOR_STOPS[i - 1];
      const fraction = Math.max(0, (rsrp - low) / (high - low));
      return start.map((value, channel) => Math.round(value + (end[channel] - value) * fraction));
    }
    return COLOR_STOPS.at(-1)[1];
  }
  function interpolateRsrp(medians, x, y) {
    const left = Math.floor(x);
    const bottom = Math.floor(y);
    let weightedSum = 0;
    let totalWeight = 0;
    for (let dy = 0; dy <= 1; dy++) {
      const row = bottom + dy;
      for (let dx = 0; dx <= 1; dx++) {
        const col = left + dx;
        const rsrp = medians.get(row + "," + col);
        if (rsrp === void 0) continue;
        const weight = (1 - Math.abs(x - col)) * (1 - Math.abs(y - row));
        weightedSum += rsrp * weight;
        totalWeight += weight;
      }
    }
    return weightedSum / totalWeight;
  }
  function renderBlock(cells, medians, grid) {
    const firstRow = Math.floor(cells[0].row / CELLS_PER_BLOCK) * CELLS_PER_BLOCK;
    const firstCol = Math.floor(cells[0].col / CELLS_PER_BLOCK) * CELLS_PER_BLOCK;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = BLOCK_PIXELS;
    const context = canvas.getContext("2d");
    const image = context.createImageData(BLOCK_PIXELS, BLOCK_PIXELS);
    for (const { row, col } of cells) {
      for (let y = 0; y < PIXELS_PER_CELL; y++) {
        for (let x = 0; x < PIXELS_PER_CELL; x++) {
          const gridX = col + (x + 0.5) / PIXELS_PER_CELL - 0.5;
          const gridY = row + (y + 0.5) / PIXELS_PER_CELL - 0.5;
          const color = signalColor(interpolateRsrp(medians, gridX, gridY));
          const pixelX = (col - firstCol) * PIXELS_PER_CELL + x;
          const pixelY = BLOCK_PIXELS - 1 - ((row - firstRow) * PIXELS_PER_CELL + y);
          const offset = (pixelY * BLOCK_PIXELS + pixelX) * 4;
          image.data.set([...color, 185], offset);
        }
      }
    }
    context.putImageData(image, 0, 0);
    const southWest = grid.point(firstRow, firstCol);
    const northEast = grid.point(firstRow + CELLS_PER_BLOCK, firstCol + CELLS_PER_BLOCK);
    const bounds = [[southWest.lat, southWest.lon], [northEast.lat, northEast.lon]];
    return L.imageOverlay(canvas.toDataURL(), bounds, { pane: "heatSurface" });
  }
  function heatOverlays(cells, grid) {
    const medians = /* @__PURE__ */ new Map();
    const blocks = /* @__PURE__ */ new Map();
    for (const cell of cells) {
      medians.set(cell.row + "," + cell.col, cell.rsrp);
      const blockRow = Math.floor(cell.row / CELLS_PER_BLOCK);
      const blockCol = Math.floor(cell.col / CELLS_PER_BLOCK);
      const blockId = blockRow + "," + blockCol;
      if (!blocks.has(blockId)) blocks.set(blockId, []);
      blocks.get(blockId).push(cell);
    }
    const layer = L.layerGroup();
    for (const block of blocks.values()) {
      renderBlock(block, medians, grid).addTo(layer);
    }
    return layer;
  }

  // src/map.js
  var statusText = { strong: "Сильный сигнал", medium: "Средний сигнал", weak: "Слабый сигнал" };
  var colors = { strong: "#49b488", medium: "#efbd55", weak: "#e77e70" };
  var latlng = (point) => [point.lat, point.lon];
  var displayNumber = (value) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value).replace("-", "−");
  var number = displayNumber;
  var get = (id) => document.getElementById(id);
  var CoverageMap = class {
    constructor() {
      this.map = L.map("map", { zoomControl: false, minZoom: 2, maxZoom: 19, zoomSnap: 0.1, zoomDelta: 0.75, preferCanvas: true, attributionControl: true });
      const map2 = this.map;
      map2.attributionControl.setPrefix(false);
      map2.attributionControl.addAttribution('<a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>');
      const nw = map2.unproject([5792 * 256, 3013 * 256], 13), se = map2.unproject([5795 * 256, 3016 * 256], 13);
      const base = JSON.parse(get("basemap-data").textContent);
      L.imageOverlay(base, [nw, se], { pane: "tilePane", alt: "Улицы, парки и реки Бишкека" }).addTo(map2);
      map2.createPane("heatSurface").style.zIndex = 350;
      L.control.scale({ imperial: false, maxWidth: 95, position: "bottomleft" }).addTo(map2);
      this.surface = L.layerGroup().addTo(map2);
      this.markers = L.layerGroup().addTo(map2);
      this.shapes = /* @__PURE__ */ new Map();
      this.mode = "grid";
      get("zoom-in").onclick = () => map2.zoomIn();
      get("zoom-out").onclick = () => map2.zoomOut();
      get("fit-map").onclick = () => this.fit();
      const menu = get("layer-menu"), toggle = get("toggle-layers");
      const closeMenu = () => {
        menu.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      };
      toggle.onclick = () => {
        menu.hidden = !menu.hidden;
        toggle.setAttribute("aria-expanded", String(!menu.hidden));
      };
      document.addEventListener("click", (e) => {
        if (!e.target.closest(".layer-box")) closeMenu();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !menu.hidden) {
          closeMenu();
          toggle.focus();
        }
      });
      menu.onchange = () => this.drawMarkers();
      const online = document.createElement("label");
      online.innerHTML = '<input type="checkbox" id="online-map">Онлайн-подложка OSM';
      menu.append(online);
      const onlineTiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, maxNativeZoom: 19 });
      get("online-map").onchange = (e) => e.target.checked ? onlineTiles.addTo(map2) : onlineTiles.remove();
      const resize = new ResizeObserver(() => map2.invalidateSize());
      resize.observe(get("map"));
    }
    setData(data2, period2, refit = false) {
      this.data = data2;
      this.period = data2.periods[period2];
      this.grid = gridFor(data2.bounds);
      this.heat = null;
      if (refit) this.fit();
      this.drawSurface();
      this.drawMarkers();
    }
    fit() {
      const { south, west, north, east } = this.data.bounds;
      this.map.invalidateSize().fitBounds([[south, west], [north, east]], { padding: [16, 16], maxZoom: 17, animate: false });
    }
    setMode(mode2) {
      this.mode = mode2;
      this.drawSurface();
    }
    drawSurface() {
      this.surface.clearLayers();
      this.shapes.clear();
      const heat = this.mode === "heat";
      if (heat) {
        this.heat ||= heatOverlays(this.period.cells, this.grid);
        this.surface.addLayer(this.heat);
      }
      const { dLat, dLon } = this.grid;
      for (const c of this.period.cells) {
        const bounds = [[c.lat - dLat / 2, c.lon - dLon / 2], [c.lat + dLat / 2, c.lon + dLon / 2]];
        const shape = L.rectangle(bounds, {
          stroke: !heat,
          color: "#f5f7ec",
          opacity: 0.86,
          weight: 1.15,
          fill: true,
          fillColor: colors[c.level],
          fillOpacity: heat ? 0 : 0.63
        });
        shape.bindPopup("<strong>" + c.id + "</strong>" + statusText[c.level] + " · " + number(c.rsrp) + " дБм<br>Замеров: " + c.count + "<br>Центр: " + c.lat.toFixed(5) + ", " + c.lon.toFixed(5));
        this.shapes.set(c.id, shape);
        this.surface.addLayer(shape);
      }
    }
    drawMarkers() {
      this.markers.clearLayers();
      const pair = this.period.plan.best.ids;
      for (const c of this.data.candidates) {
        const chosen = pair.includes(c.id);
        if (chosen && get("layer-radius").checked)
          L.circle(latlng(c), { radius: COVERAGE_RADIUS_M, color: "#176448", weight: 1.8, dashArray: "6 5", fillOpacity: 0.04, interactive: false }).addTo(this.markers);
        const id = escapeHtml(c.id);
        const popup = "<strong>Площадка " + id + "</strong>" + (chosen ? "Рекомендована для новой БС" : c.allowed ? "Допустимая площадка" : "Ближе 500 м к существующей БС");
        if (chosen && get("layer-sites").checked) {
          L.marker(latlng(c), {
            title: "Площадка " + c.id,
            alt: "Площадка " + c.id,
            zIndexOffset: 100,
            icon: L.divIcon({ className: "candidate-icon", iconSize: [54, 25], html: '<span class="candidate-pin">' + icon("pin", 12) + id + "</span>" })
          }).bindPopup(popup).addTo(this.markers);
        } else if (get("layer-other").checked) {
          L.circleMarker(latlng(c), { radius: 5, color: "white", weight: 2, fillOpacity: 1, fillColor: c.allowed ? "#428779" : "#8a9691" }).bindPopup(popup).addTo(this.markers);
        }
      }
      if (get("layer-towers").checked) for (const t of this.data.towers) {
        L.marker(latlng(t), {
          title: "Базовая станция " + t.id,
          alt: "Базовая станция " + t.id,
          icon: L.divIcon({ className: "station-icon", iconSize: [24, 24], html: '<span class="station-pin">' + icon("tower", 15) + "</span>" })
        }).bindPopup("<strong>Станция " + escapeHtml(t.id) + "</strong>Существующая базовая станция").addTo(this.markers);
      }
    }
    focusCell(id) {
      const shape = this.shapes.get(id);
      if (shape) {
        this.map.setView(shape.getBounds().getCenter(), Math.max(16, this.map.getZoom()), { animate: false });
        shape.openPopup();
      }
    }
    showPair() {
      get("layer-radius").checked = get("layer-sites").checked = true;
      this.drawMarkers();
      const points = this.data.candidates.filter((c) => this.period.plan.best.ids.includes(c.id));
      const extent = L.latLngBounds([]);
      for (const c of points) extent.extend(L.latLng(latlng(c)).toBounds(2 * COVERAGE_RADIUS_M));
      if (extent.isValid()) this.map.fitBounds(extent, { padding: [18, 18], animate: false });
    }
  };

  // src/views.js
  var pct = (n, total) => total ? Math.round(n * 100 / total) : 0;
  var signalNames = { strong: "Сильные", medium: "Средние", weak: "Слабые" };
  var labels = { all: "Все сутки", day: "День", night: "Ночь" };
  var escape = escapeHtml;
  function histogram(values, caption) {
    const max = Math.max(1, ...values);
    const bars = values.map((v, i) => {
      const height = Math.max(1, 25 * v / max);
      return '<rect x="' + i * 6 + '" y="' + (27 - height) + '" width="4" height="' + height + '" rx="1.5" fill="currentColor" opacity="' + (v ? 0.52 + 0.42 * v / max : 0.14) + '"/>';
    }).join("");
    return '<svg class="spark" role="img" aria-label="' + caption + '" viewBox="0 0 71 29"><title>' + caption + "</title>" + bars + "</svg>";
  }
  function metrics(data2, period2) {
    const { cells, counts, plan, samples } = data2.periods[period2];
    const bins = Array.from({ length: 4 }, () => Array(12).fill(0));
    const min = cells.reduce((n, c) => Math.min(n, c.col), Infinity), max = cells.reduce((n, c) => Math.max(n, c.col), -Infinity);
    const sites = data2.candidates.filter((c) => plan.best.ids.includes(c.id));
    for (const c of cells) {
      const i = Math.floor((c.col - min) * 11 / Math.max(1, max - min));
      bins[0][i] += c.count;
      bins[1][i]++;
      if (c.level === "weak") {
        bins[2][i]++;
        if (sites.some((s) => coversCell(s, c, data2.bounds.earth_radius_m))) bins[3][i]++;
      }
    }
    const definitions = [
      ["signal", "Принято замеров", displayNumber(samples), period2 === "all" ? "из " + displayNumber(data2.total) + " исходных строк" : labels[period2] + " · UTC+6", "#398a7e", "#e4f1eb"],
      ["grid", "Ячейки покрытия", displayNumber(cells.length), "от 5 замеров в ячейке", "#6383a6", "#e9eff7"],
      ["weak", "Слабые ячейки", displayNumber(counts.weak), "медиана ниже −105 дБм", "#c76e5c", "#f9eae4"],
      ["target", "Охват слабых ячеек", counts.weak ? pct(plan.best.count, counts.weak) + " %" : "—", displayNumber(plan.best.count) + " из " + displayNumber(counts.weak) + " в радиусе пары", "#43886a", "#e3f1e5"]
    ];
    return definitions.map(([pic, title, value, sub, color, tint], i) => '<article class="metric" style="--accent:' + color + ";--tint:" + tint + '"><div class="metric-title"><span class="metric-icon">' + icon(pic, 17) + "</span>" + title + "</div><strong>" + value + "</strong><small>" + sub + "</small>" + histogram(bins[i], title + " по полосам с запада на восток (учтённые ячейки)") + "</article>").join("");
  }
  function recommendation({ counts, plan }) {
    const pair = plan.best.ids;
    const tokens = pair.map((id) => '<span class="site-token">' + icon("pin", 15) + escape(id) + "</span>").join("<span>+</span>");
    return '<div class="eyebrow">' + icon("target") + " Рекомендация</div><h2>Оптимальная пара</h2>" + (pair.length ? '<div class="site-pair">' + tokens + "</div><p>В радиусе пары <b>" + plan.best.count + " из " + counts.weak + '</b> слабых ячеек</p><div class="cover-track"><span style="width:' + pct(plan.best.count, counts.weak) + '%"></span></div><button id="show-pair" class="pair-action">' + icon("aim", 15) + "Показать на карте</button>" : '<p class="empty">Для пары нужны две допустимые площадки. Сейчас доступно ' + plan.eligible + ".</p>");
  }
  function ranking({ cells }) {
    return '<div class="ranking-head"><h2>Худшие ячейки</h2><span class="tag">Топ-3</span></div><p class="muted">По медианному уровню сигнала</p>' + (cells.slice(0, 3).map((c, i) => '<button class="rank-row" data-cell="' + c.id + '" aria-label="Показать ячейку ' + c.id + ' на карте"><span class="rank-index">0' + (i + 1) + '</span><span class="rank-name">' + c.id + "<small>Замеров · " + c.count + '</small></span><span class="value-tag" data-level="' + c.level + '">' + displayNumber(c.rsrp) + " дБм</span></button>").join("") || '<div class="empty">Нет ячеек с пятью замерами за этот период.</div>');
  }
  var heading = (pic, title) => '<div class="detail-head"><i>' + icon(pic) + "</i><h2>" + title + "</h2></div>";
  var stat = (label, value) => '<div class="stat-line"><span>' + label + "</span><b>" + value + "</b></div>";
  function dayRow(period2, data2) {
    const { cells, counts, samples } = data2.periods[period2];
    const levels = ["strong", "medium", "weak"];
    return '<div class="compare-row"><div class="period-title"><strong class="inline">' + icon(period2 === "day" ? "sun" : "moon", 16) + labels[period2] + "</strong><small>" + (period2 === "day" ? "06:00–17:59" : "18:00–05:59") + " · " + displayNumber(samples) + ' замеров</small></div><div class="daybars">' + levels.map((l) => '<span class="' + l + '" style="width:' + counts[l] * 100 / (cells.length || 1) + '%"></span>').join("") + '</div><div class="breakdown">' + levels.map((l) => '<span><b class="swatch ' + l + '"></b>' + signalNames[l] + " " + counts[l] + "</span>").join("") + "</div></div>";
  }
  function analytics(data2) {
    const { plan, counts } = data2.periods.all;
    const comparison = [["Полный перебор", plan.best], ["Жадный выбор", plan.greedy]].map(([label, method]) => '<div class="compare-row"><div><strong>' + label + "</strong><small>" + (method.ids.map(escape).join(" + ") || "Нет пары") + '</small></div><div class="bar-track"><span style="width:' + pct(method.count, counts.weak) + '%"></span></div><p>Слабые ячейки в зоне пары: <b>' + method.count + " / " + counts.weak + "</b></p></div>").join("");
    return '<div class="section-grid"><article class="panel detail">' + heading("compare", "Выбор двух площадок") + comparison + '<div class="note">Проверено пар: ' + plan.pairs + ". Выигрыш полного перебора: " + (plan.best.count - plan.greedy.count) + ' яч.</div><p>Жадный алгоритм сначала выбирает площадку с наибольшим охватом, затем максимизирует число дополнительных ячеек.</p></article><article class="panel detail">' + heading("clock", "Покрытие днём и ночью") + dayRow("day", data2) + dayRow("night", data2) + '<div class="note">В каждом периоде учитываются ячейки с пятью и более замерами. Время Бишкека, UTC+6.</div><p>Для пространственного сравнения выберите период на карте сигнала.</p></article></div>';
  }
  var sourceLabels = { participants: "Набор участников", demo: "Демоданные", csv: "Загруженные данные" };
  function dataView(data2, source2) {
    const { dropped, bounds, periods } = data2;
    return '<div class="section-grid"><article class="panel detail">' + heading("database", "Входной набор") + stat("Источник", sourceLabels[source2]) + (source2 === "participants" ? "<p>07_coverage · Синтетическая модель радиопокрытия района Бишкека.</p>" : "") + stat("Строк в measurements.csv", displayNumber(data2.total)) + stat("Базовых станций", data2.towers.length) + stat("Площадок-кандидатов", data2.candidates.length) + stat("Допустимых площадок", periods.all.plan.eligible) + '<div class="note">Границы WGS 84<br>Юг ' + bounds.south + " · Север " + bounds.north + "<br>Запад " + bounds.west + " · Восток " + bounds.east + '</div><div class="data-actions"><button id="export-map" class="btn">' + icon("download", 16) + 'Скачать HTML-карту</button></div></article><article class="panel detail">' + heading("list", "Очистка замеров") + stat("Принято", displayNumber(periods.all.samples)) + stat("Отброшено строк", displayNumber(data2.result.dropped_rows)) + stat("Дубликаты", displayNumber(dropped.duplicate)) + stat("RSRP вне диапазона", displayNumber(dropped.signal)) + stat("За границей района", displayNumber(dropped.outside)) + stat("Повреждённые строки и числа", displayNumber(dropped.malformed)) + stat("Неверное время", displayNumber(dropped.timestamp)) + '<div class="note">Ячеек с 1–4 замерами: ' + periods.all.sparse + ". Они исключены из карты и рейтинга.</div></article></div>";
  }

  // src/app.js
  var get2 = (id) => document.getElementById(id);
  var original = document.documentElement.cloneNode(true);
  var { data, source } = JSON.parse(get2("initial-data").textContent);
  var period = "all";
  var mode = "grid";
  var map;
  var tipTimer;
  var routes = {
    overview: ["Карта покрытия", "Уровень сигнала и площадки для новых базовых станций."],
    analytics: ["Аналитика покрытия", "Сравнение алгоритмов выбора площадок и качества сигнала по времени суток."],
    data: ["Исходные данные", "Состав набора, границы района и результаты очистки замеров."]
  };
  for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = icon(el.dataset.icon);
  function notify(message) {
    get2("notice").textContent = message;
    get2("notice").hidden = false;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => get2("notice").hidden = true, 3e3);
  }
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3e4);
  }
  function exportMap() {
    const page = original.cloneNode(true);
    page.querySelector("#initial-data").textContent = JSON.stringify({ data, source }).replace(/</g, "\\u003c");
    download("coverage-map.html", "<!doctype html>\n" + page.outerHTML, "text/html;charset=utf-8");
  }
  function renderOverview(refit = false) {
    const summary = data.periods[period];
    get2("metrics").innerHTML = metrics(data, period);
    get2("recommend").innerHTML = recommendation(summary);
    get2("worst").innerHTML = ranking(summary);
    get2("show-pair")?.addEventListener("click", () => map.showPair());
    get2("worst").querySelectorAll("[data-cell]").forEach((button) => button.onclick = () => map.focusCell(button.dataset.cell));
    get2("period").value = period;
    document.querySelectorAll("[data-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mode === mode)));
    if (!map) {
      map = new CoverageMap();
      refit = true;
    }
    map.map.invalidateSize();
    map.mode = mode;
    map.setData(data, period, refit);
    get2("save-json").title = "Результат полного перебора для всех суток";
  }
  function route(refit = false) {
    const requested = location.hash.slice(1);
    const name = Object.hasOwn(routes, requested) ? requested : "overview";
    for (const key of Object.keys(routes)) get2(key).hidden = key !== name;
    for (const link of document.querySelectorAll("[data-nav]")) {
      if (link.dataset.nav === name) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    get2("page-title").textContent = routes[name][0];
    get2("page-description").textContent = routes[name][1];
    get2("source-badge").textContent = sourceLabels[source];
    if (name === "overview") renderOverview(refit);
    if (name === "analytics") get2("analytics").innerHTML = analytics(data);
    if (name === "data") {
      get2("data").innerHTML = dataView(data, source);
      get2("export-map").onclick = exportMap;
    }
  }
  window.addEventListener("hashchange", () => {
    route();
    window.scrollTo(0, 0);
  });
  document.querySelectorAll("nav a,.brand").forEach((a) => a.onclick = (e) => {
    e.preventDefault();
    history.replaceState(null, "", a.getAttribute("href"));
    route();
    window.scrollTo(0, 0);
  });
  get2("period").onchange = (e) => {
    period = e.target.value;
    renderOverview();
  };
  document.querySelectorAll("[data-mode]").forEach((button) => button.onclick = () => {
    mode = button.dataset.mode;
    map.setMode(mode);
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  });
  get2("save-json").onclick = () => {
    download("result.json", JSON.stringify(data.result, null, 2), "application/json");
    notify("Подготовлен result.json за все сутки");
  };
  var filenames = ["measurements", "towers", "candidates"];
  var directions = { south: "Юг", west: "Запад", north: "Север", east: "Восток" };
  get2("file-inputs").innerHTML = filenames.map((name) => '<label class="file-field">' + name + '.csv<input type="file" accept=".csv,text/csv" id="file-' + name + '" required></label>').join("");
  get2("bound-inputs").innerHTML = Object.entries(directions).map(([key, label]) => "<label>" + label + '<input id="bound-' + key + '" type="number" step="any" required placeholder="' + data.bounds[key] + '"></label>').join("");
  function syncBoundsForm() {
    const choice = get2("bounds-source").value;
    get2("bounds-file-row").hidden = choice !== "file";
    get2("file-bounds").disabled = choice !== "file";
    get2("bound-inputs").hidden = choice !== "manual";
    for (const key of Object.keys(directions)) get2("bound-" + key).disabled = choice !== "manual";
  }
  get2("bounds-source").onchange = syncBoundsForm;
  syncBoundsForm();
  async function readBounds() {
    const choice = get2("bounds-source").value;
    if (choice === "current") return data.bounds;
    if (choice === "manual") return Object.fromEntries(Object.keys(directions).map((key) => [key, get2("bound-" + key).valueAsNumber]));
    const file = get2("file-bounds").files[0];
    if (!file) throw new Error("Выберите bounds.json с параметрами района.");
    const contents = await file.text();
    try {
      return JSON.parse(contents.replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("Проверьте формат JSON в файле границ.");
    }
  }
  get2("open-import").onclick = () => {
    get2("import-error").hidden = true;
    get2("import-dialog").showModal();
  };
  get2("close-import").onclick = () => get2("import-dialog").close();
  get2("import-dialog").onclick = (e) => {
    if (e.target === get2("import-dialog")) {
      const box = e.target.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) e.target.close();
    }
  };
  get2("import-form").onsubmit = async (e) => {
    e.preventDefault();
    const submit = e.currentTarget.querySelector("[type=submit]");
    submit.disabled = true;
    get2("import-error").hidden = true;
    try {
      const entries = await Promise.all(filenames.map(async (name) => [name, await get2("file-" + name).files[0].text()]));
      const bounds = await readBounds();
      const next = analyze(Object.fromEntries(entries), bounds);
      data = next;
      source = "csv";
      period = "all";
      mode = "grid";
      get2("layer-radius").checked = false;
      history.replaceState(null, "", "#overview");
      route(true);
      get2("import-dialog").close();
      window.scrollTo(0, 0);
      notify("Карта пересчитана по загруженным CSV");
    } catch (error) {
      get2("import-error").textContent = error.message;
      get2("import-error").hidden = false;
    } finally {
      submit.disabled = false;
    }
  };
  route(true);
})();
