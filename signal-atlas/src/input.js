import { parseCsv } from './csv.js';

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i;
const ISO_TIMESTAMP = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/i;
const BISHKEK_OFFSET_MS = 6 * 60 * 60 * 1000;
const MIN_RSRP_DBM = -140;
const MAX_RSRP_DBM = -44;

function parseNumber(text) {
  if (typeof text !== 'string' || !DECIMAL_NUMBER.test(text)) return NaN;
  return Number(text.replace(',', '.'));
}

function parseTimestamp(text) {
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);

  const parts = ISO_TIMESTAMP.exec(text);
  if (!parts) return NaN;
  const [, year, month, day, hour, minute, second = '00', fraction = '', zone = '+06:00'] = parts;

  // Date.parse может перенести 31 февраля в март. Валидируем календарную дату до преобразования.
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > lastDay) return NaN;
  if (+hour >= 24 || +minute >= 60 || +second >= 60) return NaN;
  const date = [year, month, day].join('-');
  const time = [hour, minute, second].join(':');
  return Date.parse(date + 'T' + time + fraction + zone);
}

export function timeInfo(text) {
  const timestamp = parseTimestamp(text);
  const localHour = new Date(timestamp + BISHKEK_OFFSET_MS).getUTCHours();
  if (!Number.isFinite(localHour)) return { key: text, period: null };
  return { key: timestamp, period: localHour >= 6 && localHour < 18 ? 'day' : 'night' };
}

export function cleanMeasurements(csv, bounds) {
  const records = parseCsv(csv, ['lat', 'lon', 'rsrp_dbm', 'timestamp'], 'measurements.csv');
  const dropped = { malformed: 0, signal: 0, outside: 0, timestamp: 0, duplicate: 0 };
  const accepted = [];
  const seen = new Set();

  // Первая неподходящая проверка определяет причину отбрасывания строки.
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

    // В ключ входят четыре нормализованных поля: 74.6 и 74.600 обозначают одну долготу.
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

export function compareSiteIds(first, second) {
  if (first.id === second.id) return 0;
  return first.id < second.id ? -1 : 1;
}

export function readSites(csv, filename) {
  const records = parseCsv(csv, ['id', 'lat', 'lon'], filename);
  const sites = [];
  const ids = new Set();
  for (const [index, row] of records.entries()) {
    const id = row?.id;
    const lat = parseNumber(row?.lat);
    const lon = parseNumber(row?.lon);
    const validLat = Number.isFinite(lat) && Math.abs(lat) <= 90;
    const validLon = Number.isFinite(lon) && Math.abs(lon) <= 180;
    if (!id || ids.has(id) || !validLat || !validLon) {
      throw new Error(filename + ' — проверьте ID и координаты в записи ' + (index + 2) + '.');
    }
    ids.add(id);
    sites.push({ id, lat, lon });
  }
  return sites.sort(compareSiteIds);
}
