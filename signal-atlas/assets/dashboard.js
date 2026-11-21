(() => {
  // src/csv.js
  function nextLine(text, index) {
    return text[index] === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
  }
  function readRecord(text, start, delimiter, singleLineColumns) {
    const fields = [];
    let value = "", quoted = false, closed = false;
    let continuation;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      const newline = char === "\n" || char === "\r";
      if (quoted) {
        if (newline && singleLineColumns.has(fields.length)) {
          return { error: "перенос в обязательном поле замера", next: nextLine(text, i) };
        }
        if (newline && continuation === void 0) continuation = nextLine(text, i);
        if (char !== '"') value += char;
        else if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (char === delimiter) {
        fields.push(value.trim());
        value = "";
        closed = false;
      } else if (newline) {
        fields.push(value.trim());
        return { fields, next: nextLine(text, i), continuation };
      } else if (char === '"' && !closed && !value.trim()) {
        quoted = true;
        value = "";
      } else if (char === '"' || closed && char.trim()) {
        const end = text.slice(i).search(/[\r\n]/);
        const next = continuation ?? (end < 0 ? text.length : nextLine(text, i + end));
        return { error: "ошибка кавычек", next };
      } else value += char;
    }
    if (quoted) return { error: "поле в кавычках не закрыто", next: continuation ?? text.length };
    fields.push(value.trim());
    return { fields, next: text.length, continuation };
  }
  function parseCsv(source2, required, filename, { recoverRows = false } = {}) {
    const text = source2.replace(/^\uFEFF/, "");
    const firstLine = text.trimStart().split(/[\r\n]/, 1)[0];
    const delimiter = [",", ";", "	"].sort(
      (a, b) => firstLine.split(b).length - firstLine.split(a).length
    )[0];
    let columns;
    const singleLineColumns = /* @__PURE__ */ new Set();
    const rows = [];
    for (let index = 0; index < text.length; ) {
      const record = readRecord(text, index, delimiter, singleLineColumns);
      index = record.next;
      if (record.error) {
        if (!columns || !recoverRows)
          throw new Error(
            filename + " — " + record.error + " в записи " + (rows.length + (columns ? 2 : 1)) + "."
          );
        rows.push(null);
        continue;
      }
      const { fields } = record;
      if (fields.length === 1 && fields[0] === "") continue;
      if (!columns) {
        columns = fields.map((name) => name.toLowerCase());
        if (new Set(columns).size !== columns.length)
          throw new Error(filename + " — заголовки повторяются.");
        const missing = required.filter((name) => !columns.includes(name));
        if (missing.length) throw new Error(filename + " — отсутствуют поля " + missing.join(", "));
        if (recoverRows) {
          for (const name of required) singleLineColumns.add(columns.indexOf(name));
        }
        continue;
      }
      if (fields.length !== columns.length) {
        rows.push(null);
        if (recoverRows && record.continuation !== void 0) index = record.continuation;
        continue;
      }
      rows.push(Object.fromEntries(columns.map((name, i) => [name, fields[i]])));
    }
    if (!columns) throw new Error(filename + " — отсутствуют поля " + required.join(", "));
    return rows;
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
    const offset = zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    return Date.parse(date + "T" + time + fraction + offset);
  }
  function timeInfo(text) {
    const timestamp = parseTimestamp(text);
    const localHour = new Date(timestamp + BISHKEK_OFFSET_MS).getUTCHours();
    if (!Number.isFinite(localHour)) return { key: text, period: null };
    return { key: timestamp, period: localHour >= 6 && localHour < 18 ? "day" : "night" };
  }
  function cleanMeasurements(csv, bounds) {
    const records = parseCsv(csv, ["lat", "lon", "rsrp_dbm", "timestamp"], "measurements.csv", {
      recoverRows: true
    });
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
    const sorted = [...values].sort((a2, b2) => a2 - b2);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    const left = sorted[middle - 1];
    const right = sorted[middle];
    if (left === right) return left;
    const a = decimalParts(left);
    const b = decimalParts(right);
    const exponent = Math.min(a.exponent, b.exponent);
    const sum = a.coefficient * 10n ** BigInt(a.exponent - exponent) + b.coefficient * 10n ** BigInt(b.exponent - exponent);
    return Number(String(sum * 5n) + "e" + (exponent - 1));
  }
  function decimalParts(value) {
    const [mantissa, exponent = "0"] = String(value).split("e");
    const [whole, fraction = ""] = mantissa.split(".");
    return { coefficient: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length };
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
    if (!bounds || typeof bounds !== "object")
      throw new Error("Ожидается объект с границами района.");
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
      throw new Error(
        "Проверьте границы района. Юг должен быть южнее севера, запад — западнее востока."
      );
    }
    if (!Number.isFinite(grid_origin_lat) || Math.abs(grid_origin_lat) >= 90 || !Number.isFinite(grid_origin_lon) || Math.abs(grid_origin_lon) > 180) {
      throw new Error("Проверьте координаты начала сетки в bounds.json.");
    }
    const validRadius = Number.isFinite(earth_radius_m) && earth_radius_m > 0;
    if (grid_origin_lat > south || grid_origin_lon > west) {
      throw new Error("Широта начала сетки должна быть ≤ южной границы, долгота — ≤ западной.");
    }
    if (cell_size_m !== CELL_METRES || !["Asia/Bishkek", "UTC+6", "+06:00"].includes(timezone) || !validRadius) {
      throw new Error(
        "Для района Бишкека укажите шаг 200 м, зону Asia/Bishkek и положительный радиус Земли."
      );
    }
    return {
      south,
      west,
      north,
      east,
      grid_origin_lat,
      grid_origin_lon,
      cell_size_m,
      earth_radius_m,
      timezone: "Asia/Bishkek"
    };
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
    const {
      north,
      east,
      grid_origin_lat: originLat,
      grid_origin_lon: originLon,
      cell_size_m,
      earth_radius_m
    } = validateBounds(bounds);
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
  function compareCoverage(candidates, summary, earthRadius) {
    const byCell = /* @__PURE__ */ new Map();
    const counts = { shared: 0, best: 0, greedy: 0 };
    const selected = candidates.filter(
      (site) => summary.plan.best.ids.includes(site.id) || summary.plan.greedy.ids.includes(site.id)
    );
    for (const cell of summary.cells) {
      if (cell.level !== "weak") continue;
      const covering = selected.filter((site) => coversCell(site, cell, earthRadius));
      const best = covering.filter((site) => summary.plan.best.ids.includes(site.id)).map((site) => site.id);
      const greedy = covering.filter((site) => summary.plan.greedy.ids.includes(site.id)).map((site) => site.id);
      let category = null;
      if (best.length && greedy.length) category = "shared";
      else if (best.length) category = "best";
      else if (greedy.length) category = "greedy";
      if (category) counts[category]++;
      byCell.set(cell.id, { best, greedy, category });
    }
    return { byCell, counts };
  }
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
    const periods2 = {};
    for (const period2 of PERIODS) {
      const summary = summarizeCells(groups, period2);
      const weakCells = summary.cells.filter((cell) => cell.level === "weak");
      const plan2 = planSites(candidates, weakCells, bounds.earth_radius_m);
      periods2[period2] = { ...summary, plan: plan2 };
    }
    const { cells, plan } = periods2.all;
    const result = {
      worst_cells: cells.slice(0, 3).map((cell) => ({
        cell_id: cell.id,
        rsrp_median: cell.rsrp
      })),
      best_candidates: plan.best.ids,
      dropped_rows: total - accepted.length,
      covered_weak_cells: plan.best.count
    };
    return { bounds, towers, candidates, dropped, total, periods: periods2, result };
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
    expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    collapse: '<path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5"/>',
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

  // src/format.js
  var numberFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
  var formatNumber = (value) => numberFormat.format(value).replace("-", "−");
  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
    );
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
    const bounds = [
      [southWest.lat, southWest.lon],
      [northEast.lat, northEast.lon]
    ];
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

  // src/basemap.js
  var BISHKEK_BBOX = [8296780798186e-6, 5283327395071e-6, 8311456707617e-6, 5298003304502e-6];
  var WMS_ENDPOINT = "https://ows.terrestris.de/osm/service";
  var WMS_LAYER = "OSM-WMS";

  // src/map-viewport.js
  var BASE_ZOOM = 13;
  var WORLD_MIN_ZOOM = 2;
  function streetBounds() {
    const [west, south, east, north] = BISHKEK_BBOX;
    const projection = L.CRS.EPSG3857;
    return L.latLngBounds(
      projection.unproject(L.point(west, south)),
      projection.unproject(L.point(east, north))
    );
  }
  function zoomForExtent(view, extent, fill, snap) {
    const ratioX = view.x / extent.x;
    const ratioY = view.y / extent.y;
    const zoom = BASE_ZOOM + Math.log2(fill ? Math.max(ratioX, ratioY) : Math.min(ratioX, ratioY));
    const steps = fill ? Math.ceil(zoom / snap) : Math.floor(zoom / snap);
    return Number((steps * snap).toFixed(2));
  }
  var MapViewport = class {
    constructor(map2, image) {
      this.map = map2;
      const bounds = streetBounds();
      this.streetFrame = bounds.pad(-3e-3);
      L.imageOverlay(image, bounds, { pane: "tilePane", alt: "Улицы, парки и реки Бишкека" }).addTo(
        map2
      );
      this.tiles = L.tileLayer.wms(WMS_ENDPOINT, {
        layers: WMS_LAYER,
        format: "image/png",
        version: "1.1.1",
        maxNativeZoom: 14,
        maxZoom: 19
      });
      const osmLink = document.getElementById("osm-view");
      map2.on("moveend", () => {
        const center = map2.getCenter().wrap();
        osmLink.href = `https://www.openstreetmap.org/#map=${Math.round(map2.getZoom())}/${center.lat.toFixed(5)}/${center.lng.toFixed(5)}`;
      });
      this.onlineInput = document.getElementById("online-map");
      this.zoomIn = document.getElementById("zoom-in");
      this.zoomOut = document.getElementById("zoom-out");
      this.zoomIn.onclick = () => map2.zoomIn();
      this.zoomOut.onclick = () => map2.zoomOut();
      document.getElementById("fit-map").onclick = () => this.fitDistrict();
      this.onlineInput.onchange = () => {
        if (this.onlineInput.checked) this.tiles.addTo(map2);
        else this.tiles.remove();
        this.refresh();
      };
      map2.on("zoomend zoomlevelschange", () => this.updateButtons());
      new ResizeObserver(() => this.refresh()).observe(map2.getContainer());
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
          L.latLngBounds(this.district.getSouthWest(), this.district.getNorthEast()).extend(bounds)
        );
      this.map.fitBounds(bounds, { padding: [18, 18], animate: false });
    }
    setFrame(area) {
      this.frame = this.streetFrame.contains(area) ? this.streetFrame : area.pad(0.35);
      this.refresh();
    }
    refresh() {
      if (!this.frame) return;
      const map2 = this.map;
      if (!map2.getContainer().clientWidth || !map2.getContainer().clientHeight) return;
      map2.invalidateSize({ animate: false });
      const size = map2.getSize();
      const online = this.onlineInput.checked;
      const hasStreets = this.frame === this.streetFrame;
      const span = map2.project(this.frame.getSouthEast(), BASE_ZOOM).subtract(map2.project(this.frame.getNorthWest(), BASE_ZOOM));
      const snap = L.Browser.any3d ? map2.options.zoomSnap : 1;
      const minimum = online ? WORLD_MIN_ZOOM : zoomForExtent(size, span, hasStreets, snap);
      const limits = online ? null : this.frame;
      map2.setMinZoom(Math.min(map2.getMaxZoom(), Math.max(WORLD_MIN_ZOOM, minimum)));
      if (map2.options.maxBounds !== limits) map2.setMaxBounds(limits);
      if (limits && Number.isFinite(map2.getZoom())) map2.panInsideBounds(limits, { animate: false });
      document.getElementById("schematic-note").hidden = online || hasStreets;
      this.updateButtons();
    }
    updateButtons() {
      const zoom = this.map.getZoom();
      this.zoomIn.disabled = this.map.getMaxZoom() - zoom < 1e-6;
      this.zoomOut.disabled = zoom - this.map.getMinZoom() < 1e-6;
    }
  };

  // src/map.js
  var statusText = { strong: "Сильный сигнал", medium: "Средний сигнал", weak: "Слабый сигнал" };
  var colors = { strong: "#49b488", medium: "#efbd55", weak: "#e77e70" };
  var latlng = (point) => [point.lat, point.lon];
  var outlineColors = { shared: "#42584b", best: "#1561a0", greedy: "#7d3495" };
  var get = (id) => document.getElementById(id);
  function cellPopup(cell, coveringSites) {
    const coverage = coveringSites?.length ? `Покрыта новой БС: ${coveringSites.map(escapeHtml).join(", ")}` : "Вне охвата выбранной пары";
    return `<div class="cell-details">
    <strong>${escapeHtml(cell.id)}</strong>
    <div class="signal-reading"><i class="swatch ${cell.level}"></i>${statusText[cell.level]}</div>
    <dl><dt>Медиана</dt><dd>${formatNumber(cell.rsrp)} дБм</dd>
    <dt>Замеры</dt><dd>${formatNumber(cell.count)}</dd>
    <dt>Центр</dt><dd>${cell.lat.toFixed(5)}, ${cell.lon.toFixed(5)}</dd></dl>
    ${coveringSites ? `<div class="cell-coverage">${coverage}</div>` : ""}
  </div>`;
  }
  var CoverageMap = class {
    constructor() {
      this.map = L.map("map", {
        zoomControl: false,
        minZoom: 2,
        maxZoom: 19,
        zoomSnap: 0.1,
        zoomDelta: 0.75,
        maxBoundsViscosity: 1,
        bounceAtZoomLimits: false,
        preferCanvas: true,
        attributionControl: false
        // Источник и лицензия всегда видны под картой.
      });
      const map2 = this.map;
      this.viewport = new MapViewport(map2, JSON.parse(get("basemap-data").textContent));
      map2.createPane("heatSurface").style.zIndex = 350;
      L.control.scale({ imperial: false, maxWidth: 95, position: "bottomleft" }).addTo(map2);
      this.surface = L.layerGroup().addTo(map2);
      this.markers = L.layerGroup().addTo(map2);
      this.shapes = /* @__PURE__ */ new Map();
      this.mode = "grid";
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
      menu.onchange = (event) => {
        if (event.target.id === "online-map") return;
        if (event.target.id === "layer-signal") {
          this.drawSurface();
          return;
        }
        if (event.target.id === "layer-radius") this.drawSurface();
        this.drawMarkers();
      };
    }
    setData(data2, period2, algorithm2, coverage, refit = false) {
      this.data = data2;
      if (this.period !== data2.periods[period2]) this.heat = null;
      this.period = data2.periods[period2];
      this.algorithm = algorithm2;
      this.coverage = coverage;
      this.grid = gridFor(data2.bounds);
      if (refit) this.viewport.setDistrict(data2.bounds);
      this.drawSurface();
      this.drawMarkers();
    }
    setMode(mode2) {
      this.mode = mode2;
      get("layer-signal").checked = true;
      this.drawSurface();
    }
    drawSurface() {
      this.surface.clearLayers();
      this.shapes.clear();
      const visible = get("layer-signal").checked;
      const legend = get("coverage-legend");
      const showCoverage = get("layer-radius").checked;
      legend.hidden = !visible || !showCoverage;
      get("signal-legend").hidden = !visible;
      if (!visible) return;
      const heat = this.mode === "heat";
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
        <strong>${best === greedy ? "Охват равен" : `Перебор выигрывает на ${best - greedy} яч.`}</strong>`;
      }
      for (const c of this.period.cells) {
        const bounds = [
          [c.lat - dLat / 2, c.lon - dLon / 2],
          [c.lat + dLat / 2, c.lon + dLon / 2]
        ];
        const hit = this.coverage.byCell.get(c.id);
        const outline = showCoverage && hit?.category;
        const shape = L.rectangle(bounds, {
          stroke: Boolean(outline) || !heat,
          color: outline ? outlineColors[outline] : "#f5f7ec",
          opacity: outline ? 1 : 0.86,
          weight: outline ? 2.3 : 1.15,
          dashArray: outline === "greedy" ? "4 2" : null,
          fill: true,
          fillColor: colors[c.level],
          fillOpacity: heat ? 0 : 0.5
        });
        shape.bindPopup(cellPopup(c, showCoverage ? hit?.[this.algorithm] : void 0));
        this.shapes.set(c.id, shape);
        this.surface.addLayer(shape);
      }
    }
    drawMarkers() {
      this.markers.clearLayers();
      const pair = this.period.plan[this.algorithm].ids;
      const exclusion = get("layer-exclusion").checked;
      if (exclusion)
        for (const tower of this.data.towers) {
          L.circle(latlng(tower), {
            radius: MIN_TOWER_DISTANCE_M,
            color: "#a15b19",
            weight: 1.8,
            dashArray: "3 4",
            fillColor: "#d99448",
            fillOpacity: 0.15,
            interactive: false
          }).addTo(this.markers);
        }
      for (const c of this.data.candidates) {
        const chosen = pair.includes(c.id);
        if (chosen && get("layer-radius").checked)
          L.circle(latlng(c), {
            radius: COVERAGE_RADIUS_M,
            color: outlineColors[this.algorithm],
            weight: 1.8,
            dashArray: "6 5",
            fillOpacity: 0.04,
            interactive: false
          }).addTo(this.markers);
        const id = escapeHtml(c.id);
        const popup = "<strong>Площадка " + id + "</strong>" + (chosen ? "Входит в выбранную пару" : c.allowed ? "Допустимая площадка" : "Ближе 500 м к существующей БС");
        if (chosen && get("layer-sites").checked) {
          L.marker(latlng(c), {
            title: "Площадка " + c.id,
            alt: "Площадка " + c.id,
            zIndexOffset: 100,
            icon: L.divIcon({
              className: "candidate-icon",
              iconSize: [54, 25],
              html: `<span class="candidate-pin ${this.algorithm}">${icon("pin", 12)}${id}</span>`
            })
          }).bindPopup(popup).addTo(this.markers);
        } else if (get("layer-other").checked || exclusion && !c.allowed) {
          L.circleMarker(latlng(c), {
            radius: 5,
            color: "white",
            weight: 2,
            fillOpacity: 1,
            fillColor: c.allowed ? "#428779" : "#a15b19"
          }).bindTooltip(id).bindPopup(popup).addTo(this.markers);
        }
      }
      if (get("layer-towers").checked)
        for (const t of this.data.towers) {
          const blocked = exclusion ? this.data.candidates.filter(
            (site) => haversine(t, site, this.data.bounds.earth_radius_m) < MIN_TOWER_DISTANCE_M
          ) : [];
          const reason = blocked.length ? "<br>В запретной зоне: " + blocked.map((site) => escapeHtml(site.id)).join(", ") : "";
          L.marker(latlng(t), {
            title: "Базовая станция " + t.id,
            alt: "Базовая станция " + t.id,
            icon: L.divIcon({
              className: "station-icon",
              iconSize: [24, 24],
              html: '<span class="station-pin">' + icon("tower", 15) + "</span>"
            })
          }).bindPopup(
            "<strong>Станция " + escapeHtml(t.id) + "</strong>Существующая базовая станция" + reason
          ).addTo(this.markers);
        }
    }
    focusCell(id) {
      if (!get("layer-signal").checked) {
        get("layer-signal").checked = true;
        this.drawSurface();
      }
      const shape = this.shapes.get(id);
      if (shape) {
        this.map.setView(shape.getBounds().getCenter(), Math.max(16, this.map.getZoom()), {
          animate: false
        });
        shape.openPopup();
      }
    }
    showPair() {
      get("layer-signal").checked = true;
      get("layer-radius").checked = get("layer-sites").checked = true;
      this.drawSurface();
      this.drawMarkers();
      const points = this.data.candidates.filter(
        (c) => this.period.plan[this.algorithm].ids.includes(c.id)
      );
      const extent = L.latLngBounds([]);
      for (const c of points) extent.extend(L.latLng(latlng(c)).toBounds(2 * COVERAGE_RADIUS_M));
      if (extent.isValid()) this.viewport.showArea(extent);
    }
  };

  // src/views.js
  var percent = (count, total) => total ? Math.round(count * 100 / total) : 0;
  var levels = { strong: "Сильные", medium: "Средние", weak: "Слабые" };
  var periods = { all: "Все сутки", day: "День", night: "Ночь" };
  function histogram(values, caption) {
    const max = Math.max(1, ...values);
    const bars = values.map((value, index) => {
      const height = Math.max(1, 25 * value / max);
      const opacity = value ? 0.52 + 0.42 * value / max : 0.14;
      return `<rect x="${index * 6}" y="${27 - height}" width="4" height="${height}" rx="1.5" fill="currentColor" opacity="${opacity}"/>`;
    });
    return `<svg class="spark" role="img" aria-label="${caption}" viewBox="0 0 71 29"><title>${caption}</title>${bars.join("")}</svg>`;
  }
  function metricBins(cells, coverage, algorithm2) {
    const bins = Array.from({ length: 4 }, () => Array(12).fill(0));
    const west = cells.reduce((min, cell) => Math.min(min, cell.col), Infinity);
    const east = cells.reduce((max, cell) => Math.max(max, cell.col), -Infinity);
    for (const cell of cells) {
      const bin = Math.floor((cell.col - west) * 11 / Math.max(1, east - west));
      bins[0][bin] += cell.count;
      bins[1][bin]++;
      if (cell.level === "weak") {
        bins[2][bin]++;
        if (coverage.byCell.get(cell.id)[algorithm2].length) bins[3][bin]++;
      }
    }
    return bins;
  }
  function metrics(data2, period2, algorithm2, coverage) {
    const { cells, counts, plan, samples } = data2.periods[period2];
    const covered = plan[algorithm2].count;
    const bins = metricBins(cells, coverage, algorithm2);
    const sampleNote = period2 === "all" ? `из ${formatNumber(data2.total)} исходных строк` : `${periods[period2]} · UTC+6`;
    const cards = [
      ["signal", "Принято замеров", formatNumber(samples), sampleNote, "#398a7e", "#e4f1eb"],
      [
        "grid",
        "Ячейки покрытия",
        formatNumber(cells.length),
        "от 5 замеров в ячейке",
        "#6383a6",
        "#e9eff7"
      ],
      [
        "weak",
        "Слабые ячейки",
        formatNumber(counts.weak),
        "медиана ниже −105 дБм",
        "#c76e5c",
        "#f9eae4"
      ],
      [
        "target",
        "Охват слабых ячеек",
        counts.weak ? `${percent(covered, counts.weak)} %` : "—",
        `${formatNumber(covered)} из ${formatNumber(counts.weak)} в радиусе пары`,
        "#43886a",
        "#e3f1e5"
      ]
    ];
    return cards.map(
      ([pic, title, value, note, color, tint], index) => `
    <article class="metric" style="--accent:${color};--tint:${tint}">
      <div class="metric-title"><span class="metric-icon">${icon(pic, 17)}</span>${title}</div>
      <strong>${value}</strong><small>${note}</small>
      ${histogram(bins[index], `${title} по полосам с запада на восток (учтённые ячейки)`)}
    </article>`
    ).join("");
  }
  function recommendation({ counts, plan }, algorithm2) {
    const pair = plan[algorithm2];
    const header = `<div class="eyebrow">${icon("target")} Выбор площадок</div>
    <h2>${algorithm2 === "best" ? "Оптимальная пара" : "Жадная пара"}</h2>`;
    if (!pair.ids.length) {
      return `${header}<p class="empty">Для пары нужны две допустимые площадки. Сейчас доступно ${plan.eligible}.</p>`;
    }
    const chips = pair.ids.map(
      (id) => `<span class="site-token">${icon("pin", 15)}${escapeHtml(id)}</span>`
    );
    return `${header}
    <div class="site-pair">${chips.join("<span>+</span>")}</div>
    <p>В радиусе пары <b>${pair.count} из ${counts.weak}</b> слабых ячеек</p>
    <div class="cover-track"><span style="width:${percent(pair.count, counts.weak)}%"></span></div>
    <button id="show-pair" class="pair-action">${icon("aim", 15)}Показать на карте</button>`;
  }
  function ranking({ cells }) {
    const rows = cells.slice(0, 3).map(
      (cell, index) => `
    <button class="rank-row" data-cell="${escapeHtml(cell.id)}" aria-label="Показать ячейку ${escapeHtml(cell.id)} на карте">
      <span class="rank-index">0${index + 1}</span>
      <span class="rank-name">${escapeHtml(cell.id)}<small>Замеров · ${cell.count}</small></span>
      <span class="value-tag" data-level="${cell.level}">${formatNumber(cell.rsrp)} дБм</span>
    </button>`
    );
    return `<div class="ranking-head"><h2>Худшие ячейки</h2><span class="tag">Топ-3</span></div>
    <p class="muted">По медианному уровню сигнала</p>
    ${rows.join("") || '<div class="empty">Нет ячеек с пятью замерами за этот период.</div>'}`;
  }
  var heading = (pic, title) => `<div class="detail-head"><i>${icon(pic)}</i><h2>${title}</h2></div>`;
  var stat = (label, value) => `<div class="stat-line"><span>${label}</span><b>${value}</b></div>`;
  function signalDistribution({ cells, counts }) {
    if (!cells.length) return '<p class="muted">Нет ячеек с пятью замерами за этот период.</p>';
    const bars = Object.keys(levels).map(
      (level) => `<span class="${level}" style="width:${100 * counts[level] / (cells.length || 1)}%"></span>`
    );
    const legend = Object.entries(levels).map(
      ([level, label]) => `<span><b class="swatch ${level}"></b>${label} ${counts[level]}</span>`
    );
    return `<div class="daybars" aria-hidden="true">${bars.join("")}</div>
    <div class="breakdown">${legend.join("")}</div>`;
  }
  function dayRow(period2, data2) {
    const summary = data2.periods[period2];
    const isDay = period2 === "day";
    return `<div class="compare-row">
    <div class="period-title">
      <strong class="inline">${icon(isDay ? "sun" : "moon", 16)}${periods[period2]}</strong>
      <small>${isDay ? "06:00–17:59" : "18:00–05:59"} · ${formatNumber(summary.samples)} замеров</small>
    </div>
    ${signalDistribution(summary)}
  </div>`;
  }
  function analytics(data2) {
    const { plan, counts } = data2.periods.all;
    const methods = [
      ["Полный перебор", plan.best],
      ["Жадный выбор", plan.greedy]
    ];
    const comparison = methods.map(
      ([label, method]) => `
    <div class="compare-row">
      <div><strong>${label}</strong><small>${method.ids.map(escapeHtml).join(" + ") || "Нет пары"}</small></div>
      <div class="bar-track"><span style="width:${percent(method.count, counts.weak)}%"></span></div>
      <p>Слабые ячейки в зоне пары: <b>${method.count} / ${counts.weak}</b></p>
    </div>`
    );
    return `<div class="section-grid">
    <article class="panel detail">
      ${heading("compare", "Выбор двух площадок")}${comparison.join("")}
      <div class="note">Проверено пар: ${plan.pairs}. Выигрыш полного перебора: ${plan.best.count - plan.greedy.count} яч.</div>
      <p>Жадный алгоритм сначала выбирает площадку с наибольшим охватом, затем максимизирует число дополнительных ячеек.</p>
    </article>
    <article class="panel detail">
      ${heading("clock", "Покрытие днём и ночью")}${dayRow("day", data2)}${dayRow("night", data2)}
      <div class="note">В каждом периоде учитываются ячейки с пятью и более замерами. Время Бишкека, UTC+6.</div>
      <p>Для пространственного сравнения выберите период на карте сигнала.</p>
    </article>
  </div>`;
  }
  var sourceLabels = {
    participants: "Набор участников",
    demo: "Демоданные",
    csv: "Загруженные данные"
  };
  function dataView(data2, source2) {
    const { dropped, bounds, periods: periods2 } = data2;
    return `<div class="section-grid">
    <article class="panel detail">
      ${heading("database", "Входной набор")}
      ${stat("Источник", sourceLabels[source2])}
      ${source2 === "participants" ? "<p>07_coverage · Синтетическая модель радиопокрытия района Бишкека.</p>" : ""}
      ${stat("Строк в measurements.csv", formatNumber(data2.total))}
      ${stat("Базовых станций", data2.towers.length)}
      ${stat("Площадок-кандидатов", data2.candidates.length)}
      ${stat("Допустимых площадок", periods2.all.plan.eligible)}
      <div class="note">Границы WGS 84<br>Юг ${bounds.south} · Север ${bounds.north}<br>Запад ${bounds.west} · Восток ${bounds.east}</div>
      <div class="data-actions"><button id="export-map" class="btn">${icon("download", 16)}Скачать HTML-карту</button></div>
    </article>
    <article class="panel detail">
      ${heading("list", "Очистка замеров")}
      ${stat("Принято", formatNumber(periods2.all.samples))}
      ${stat("Отброшено строк", formatNumber(data2.result.dropped_rows))}
      ${stat("Дубликаты", formatNumber(dropped.duplicate))}
      ${stat("RSRP вне диапазона", formatNumber(dropped.signal))}
      ${stat("За границей района", formatNumber(dropped.outside))}
      ${stat("Повреждённые строки и числа", formatNumber(dropped.malformed))}
      ${stat("Неверное время", formatNumber(dropped.timestamp))}
      <div class="note">Ячеек с 1–4 замерами: ${periods2.all.sparse}. Они исключены из карты и рейтинга.</div>
    </article>
  </div>`;
  }

  // src/app.js
  var get2 = (id) => document.getElementById(id);
  var original = document.documentElement.cloneNode(true);
  var { data, source } = JSON.parse(get2("initial-data").textContent);
  var period = "all";
  var mode = "grid";
  var map;
  var tipTimer;
  var algorithm = "best";
  var routes = {
    overview: ["Карта покрытия", "Уровень сигнала и площадки для новых базовых станций."],
    analytics: [
      "Аналитика покрытия",
      "Сравнение алгоритмов выбора площадок и качества сигнала по времени суток."
    ],
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
  function setupExpandedMap() {
    const panel = get2("map-card");
    const home = panel.parentElement;
    const dialog = get2("map-dialog");
    const button = get2("fullscreen-map");
    function updateButton(expanded) {
      button.setAttribute("aria-pressed", String(expanded));
      button.title = expanded ? "Выйти из полного экрана" : "Карта на весь экран";
      button.setAttribute("aria-label", button.title);
      button.innerHTML = icon(expanded ? "collapse" : "expand");
      button.focus({ preventScroll: true });
    }
    button.addEventListener("click", () => {
      if (dialog.open) return dialog.close();
      dialog.append(panel);
      dialog.showModal();
      updateButton(true);
    });
    dialog.addEventListener("close", () => {
      home.prepend(panel);
      updateButton(false);
    });
  }
  setupExpandedMap();
  function exportMap() {
    const page = original.cloneNode(true);
    page.querySelector("#initial-data").textContent = JSON.stringify({ data, source }).replace(
      /</g,
      "\\u003c"
    );
    download("coverage-map.html", "<!doctype html>\n" + page.outerHTML, "text/html;charset=utf-8");
  }
  function renderOverview(refit = false) {
    const summary = data.periods[period];
    const coverage = compareCoverage(data.candidates, summary, data.bounds.earth_radius_m);
    get2("metrics").innerHTML = metrics(data, period, algorithm, coverage);
    get2("recommend").innerHTML = recommendation(summary, algorithm);
    document.querySelectorAll("[data-algorithm]").forEach(
      (button) => button.setAttribute("aria-pressed", String(button.dataset.algorithm === algorithm))
    );
    get2("worst").innerHTML = ranking(summary);
    get2("distribution").innerHTML = signalDistribution(summary);
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
    map.setData(data, period, algorithm, coverage, refit);
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
  document.querySelectorAll("nav a,.brand").forEach(
    (a) => a.onclick = (e) => {
      e.preventDefault();
      history.replaceState(null, "", a.getAttribute("href"));
      route();
      window.scrollTo(0, 0);
    }
  );
  get2("period").onchange = (e) => {
    period = e.target.value;
    renderOverview();
  };
  document.querySelectorAll("[data-algorithm]").forEach(
    (button) => button.onclick = () => {
      algorithm = button.dataset.algorithm;
      get2("layer-signal").checked = true;
      get2("layer-radius").checked = true;
      get2("layer-sites").checked = true;
      renderOverview();
    }
  );
  document.querySelectorAll("[data-mode]").forEach(
    (button) => button.onclick = () => {
      mode = button.dataset.mode;
      map.setMode(mode);
      document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    }
  );
  get2("save-json").onclick = () => {
    download("result.json", JSON.stringify(data.result, null, 2), "application/json");
    notify("Подготовлен result.json за все сутки");
  };
  var filenames = ["measurements", "towers", "candidates"];
  var directions = { south: "Юг", west: "Запад", north: "Север", east: "Восток" };
  get2("file-inputs").innerHTML = filenames.map(
    (name) => '<label class="file-field">' + name + '.csv<input type="file" accept=".csv,text/csv" id="file-' + name + '" required></label>'
  ).join("");
  get2("bound-inputs").innerHTML = Object.entries(directions).map(
    ([key, label]) => "<label>" + label + '<input id="bound-' + key + '" type="number" step="any" required placeholder="' + data.bounds[key] + '"></label>'
  ).join("");
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
    if (choice === "manual")
      return Object.fromEntries(
        Object.keys(directions).map((key) => [key, get2("bound-" + key).valueAsNumber])
      );
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
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom)
        e.target.close();
    }
  };
  get2("import-form").onsubmit = async (e) => {
    e.preventDefault();
    const submit = e.currentTarget.querySelector("[type=submit]");
    submit.disabled = true;
    get2("import-error").hidden = true;
    try {
      const entries = await Promise.all(
        filenames.map(async (name) => [name, await get2("file-" + name).files[0].text()])
      );
      const bounds = await readBounds();
      const next = analyze(Object.fromEntries(entries), bounds);
      data = next;
      for (const key of Object.keys(directions))
        get2("bound-" + key).placeholder = String(next.bounds[key]);
      source = "csv";
      period = "all";
      mode = "grid";
      algorithm = "best";
      get2("layer-radius").checked = false;
      get2("layer-signal").checked = true;
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
