const RADIANS_PER_DEGREE = Math.PI / 180;
export const EARTH_RADIUS = 6_371_000;
export const CELL_METRES = 200;
export const COVERAGE_RADIUS_M = 1_000;
export const DEMO_BOUNDS = { south: 42.8608, west: 74.576, north: 42.886, east: 74.633 };

export function validateBounds(bounds = {}) {
  if (!bounds || typeof bounds !== 'object')
    throw new Error('Ожидается объект с границами района.');
  const {
    south = bounds.lat_min,
    west = bounds.lon_min,
    north = bounds.lat_max,
    east = bounds.lon_max,
    grid_origin_lat = south,
    grid_origin_lon = west,
    cell_size_m = CELL_METRES,
    earth_radius_m = EARTH_RADIUS,
    timezone = 'Asia/Bishkek',
  } = bounds;
  if (
    ![south, west, north, east].every(Number.isFinite) ||
    south <= -90 ||
    north >= 90 ||
    west < -180 ||
    east > 180 ||
    south >= north ||
    west >= east
  ) {
    throw new Error(
      'Проверьте границы района. Юг должен быть южнее севера, запад — западнее востока.',
    );
  }
  if (
    !Number.isFinite(grid_origin_lat) ||
    Math.abs(grid_origin_lat) >= 90 ||
    !Number.isFinite(grid_origin_lon) ||
    Math.abs(grid_origin_lon) > 180
  ) {
    throw new Error('Проверьте координаты начала сетки в bounds.json.');
  }
  const validRadius = Number.isFinite(earth_radius_m) && earth_radius_m > 0;
  if (grid_origin_lat > south || grid_origin_lon > west) {
    throw new Error('Широта начала сетки должна быть ≤ южной границы, долгота — ≤ западной.');
  }
  if (
    cell_size_m !== CELL_METRES ||
    !['Asia/Bishkek', 'UTC+6', '+06:00'].includes(timezone) ||
    !validRadius
  ) {
    throw new Error(
      'Для района Бишкека укажите шаг 200 м, зону Asia/Bishkek и положительный радиус Земли.',
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
    timezone: 'Asia/Bishkek',
  };
}

export function haversine(a, b, radius = EARTH_RADIUS) {
  const dLat = (b.lat - a.lat) * RADIANS_PER_DEGREE;
  const dLon = (b.lon - a.lon) * RADIANS_PER_DEGREE;
  const latA = a.lat * RADIANS_PER_DEGREE;
  const latB = b.lat * RADIANS_PER_DEGREE;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function coversCell(site, cell, radius = EARTH_RADIUS) {
  return haversine(site, cell, radius) <= COVERAGE_RADIUS_M;
}

// Возвращаем точку на линию сетки при погрешности перевода градусов в метры.
function snapGridLine(value) {
  const line = Math.round(value);
  return Math.abs(value - line) < 1e-10 ? line : value;
}

export function gridFor(bounds) {
  const {
    north,
    east,
    grid_origin_lat: originLat,
    grid_origin_lon: originLon,
    cell_size_m,
    earth_radius_m,
  } = validateBounds(bounds);
  const dLat = cell_size_m / (earth_radius_m * RADIANS_PER_DEGREE);
  const dLon = dLat / Math.cos(originLat * RADIANS_PER_DEGREE);
  const rowAt = (lat) => snapGridLine((lat - originLat) / dLat);
  const colAt = (lon) => snapGridLine((lon - originLon) / dLon);
  // Верхняя и правая границы входят в последнюю ячейку района.
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
    },
  };
}
