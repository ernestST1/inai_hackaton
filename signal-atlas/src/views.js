import { icon } from './icons.js';
import { escapeHtml, formatNumber } from './format.js';

const percent = (count, total) => (total ? Math.round((count * 100) / total) : 0);
const levels = { strong: 'Сильные', medium: 'Средние', weak: 'Слабые' };
const periods = { all: 'Все сутки', day: 'День', night: 'Ночь' };

function histogram(values, caption) {
  const max = Math.max(1, ...values);
  const bars = values.map((value, index) => {
    const height = Math.max(1, (25 * value) / max);
    const opacity = value ? 0.52 + (0.42 * value) / max : 0.14;
    return `<rect x="${index * 6}" y="${27 - height}" width="4" height="${height}" rx="1.5" fill="currentColor" opacity="${opacity}"/>`;
  });
  return `<svg class="spark" role="img" aria-label="${caption}" viewBox="0 0 71 29"><title>${caption}</title>${bars.join('')}</svg>`;
}

function metricBins(cells, coverage, algorithm) {
  const bins = Array.from({ length: 4 }, () => Array(12).fill(0));
  const west = cells.reduce((min, cell) => Math.min(min, cell.col), Infinity);
  const east = cells.reduce((max, cell) => Math.max(max, cell.col), -Infinity);
  for (const cell of cells) {
    const bin = Math.floor(((cell.col - west) * 11) / Math.max(1, east - west));
    bins[0][bin] += cell.count;
    bins[1][bin]++;
    if (cell.level === 'weak') {
      bins[2][bin]++;
      if (coverage.byCell.get(cell.id)[algorithm].length) bins[3][bin]++;
    }
  }
  return bins;
}

export function metrics(data, period, algorithm, coverage) {
  const { cells, counts, plan, samples } = data.periods[period];
  const covered = plan[algorithm].count;
  const bins = metricBins(cells, coverage, algorithm);
  const sampleNote =
    period === 'all'
      ? `из ${formatNumber(data.total)} исходных строк`
      : `${periods[period]} · UTC+6`;
  const cards = [
    ['signal', 'Принято замеров', formatNumber(samples), sampleNote, '#398a7e', '#e4f1eb'],
    [
      'grid',
      'Ячейки покрытия',
      formatNumber(cells.length),
      'от 5 замеров в ячейке',
      '#6383a6',
      '#e9eff7',
    ],
    [
      'weak',
      'Слабые ячейки',
      formatNumber(counts.weak),
      'медиана ниже −105 дБм',
      '#c76e5c',
      '#f9eae4',
    ],
    [
      'target',
      'Охват слабых ячеек',
      counts.weak ? `${percent(covered, counts.weak)} %` : '—',
      `${formatNumber(covered)} из ${formatNumber(counts.weak)} в радиусе пары`,
      '#43886a',
      '#e3f1e5',
    ],
  ];
  return cards
    .map(
      ([pic, title, value, note, color, tint], index) => `
    <article class="metric" style="--accent:${color};--tint:${tint}">
      <div class="metric-title"><span class="metric-icon">${icon(pic, 17)}</span>${title}</div>
      <strong>${value}</strong><small>${note}</small>
      ${histogram(bins[index], `${title} по полосам с запада на восток (учтённые ячейки)`)}
    </article>`,
    )
    .join('');
}

export function recommendation({ counts, plan }, algorithm) {
  const pair = plan[algorithm];
  const header = `<div class="eyebrow">${icon('target')} Выбор площадок</div>
    <h2>${algorithm === 'best' ? 'Оптимальная пара' : 'Жадная пара'}</h2>`;
  if (!pair.ids.length) {
    return `${header}<p class="empty">Для пары нужны две допустимые площадки. Сейчас доступно ${plan.eligible}.</p>`;
  }
  const chips = pair.ids.map(
    (id) => `<span class="site-token">${icon('pin', 15)}${escapeHtml(id)}</span>`,
  );
  return `${header}
    <div class="site-pair">${chips.join('<span>+</span>')}</div>
    <p>В радиусе пары <b>${pair.count} из ${counts.weak}</b> слабых ячеек</p>
    <div class="cover-track"><span style="width:${percent(pair.count, counts.weak)}%"></span></div>
    <button id="show-pair" class="pair-action">${icon('aim', 15)}Показать на карте</button>`;
}

export function ranking({ cells }) {
  const rows = cells.slice(0, 3).map(
    (cell, index) => `
    <button class="rank-row" data-cell="${escapeHtml(cell.id)}" aria-label="Показать ячейку ${escapeHtml(cell.id)} на карте">
      <span class="rank-index">0${index + 1}</span>
      <span class="rank-name">${escapeHtml(cell.id)}<small>Замеров · ${cell.count}</small></span>
      <span class="value-tag" data-level="${cell.level}">${formatNumber(cell.rsrp)} дБм</span>
    </button>`,
  );
  return `<div class="ranking-head"><h2>Худшие ячейки</h2><span class="tag">Топ-3</span></div>
    <p class="muted">По медианному уровню сигнала</p>
    ${rows.join('') || '<div class="empty">Нет ячеек с пятью замерами за этот период.</div>'}`;
}

const heading = (pic, title) =>
  `<div class="detail-head"><i>${icon(pic)}</i><h2>${title}</h2></div>`;
const stat = (label, value) => `<div class="stat-line"><span>${label}</span><b>${value}</b></div>`;

function dayRow(period, data) {
  const { cells, counts, samples } = data.periods[period];
  const isDay = period === 'day';
  const bars = Object.keys(levels).map(
    (level) =>
      `<span class="${level}" style="width:${(100 * counts[level]) / (cells.length || 1)}%"></span>`,
  );
  const legend = Object.entries(levels).map(
    ([level, label]) => `<span><b class="swatch ${level}"></b>${label} ${counts[level]}</span>`,
  );
  return `<div class="compare-row">
    <div class="period-title">
      <strong class="inline">${icon(isDay ? 'sun' : 'moon', 16)}${periods[period]}</strong>
      <small>${isDay ? '06:00–17:59' : '18:00–05:59'} · ${formatNumber(samples)} замеров</small>
    </div>
    <div class="daybars">${bars.join('')}</div>
    <div class="breakdown">${legend.join('')}</div>
  </div>`;
}

export function analytics(data) {
  const { plan, counts } = data.periods.all;
  const methods = [
    ['Полный перебор', plan.best],
    ['Жадный выбор', plan.greedy],
  ];
  const comparison = methods.map(
    ([label, method]) => `
    <div class="compare-row">
      <div><strong>${label}</strong><small>${method.ids.map(escapeHtml).join(' + ') || 'Нет пары'}</small></div>
      <div class="bar-track"><span style="width:${percent(method.count, counts.weak)}%"></span></div>
      <p>Слабые ячейки в зоне пары: <b>${method.count} / ${counts.weak}</b></p>
    </div>`,
  );
  return `<div class="section-grid">
    <article class="panel detail">
      ${heading('compare', 'Выбор двух площадок')}${comparison.join('')}
      <div class="note">Проверено пар: ${plan.pairs}. Выигрыш полного перебора: ${plan.best.count - plan.greedy.count} яч.</div>
      <p>Жадный алгоритм сначала выбирает площадку с наибольшим охватом, затем максимизирует число дополнительных ячеек.</p>
    </article>
    <article class="panel detail">
      ${heading('clock', 'Покрытие днём и ночью')}${dayRow('day', data)}${dayRow('night', data)}
      <div class="note">В каждом периоде учитываются ячейки с пятью и более замерами. Время Бишкека, UTC+6.</div>
      <p>Для пространственного сравнения выберите период на карте сигнала.</p>
    </article>
  </div>`;
}

export const sourceLabels = {
  participants: 'Набор участников',
  demo: 'Демоданные',
  csv: 'Загруженные данные',
};
export function dataView(data, source) {
  const { dropped, bounds, periods } = data;
  return `<div class="section-grid">
    <article class="panel detail">
      ${heading('database', 'Входной набор')}
      ${stat('Источник', sourceLabels[source])}
      ${source === 'participants' ? '<p>07_coverage · Синтетическая модель радиопокрытия района Бишкека.</p>' : ''}
      ${stat('Строк в measurements.csv', formatNumber(data.total))}
      ${stat('Базовых станций', data.towers.length)}
      ${stat('Площадок-кандидатов', data.candidates.length)}
      ${stat('Допустимых площадок', periods.all.plan.eligible)}
      <div class="note">Границы WGS 84<br>Юг ${bounds.south} · Север ${bounds.north}<br>Запад ${bounds.west} · Восток ${bounds.east}</div>
      <div class="data-actions"><button id="export-map" class="btn">${icon('download', 16)}Скачать HTML-карту</button></div>
    </article>
    <article class="panel detail">
      ${heading('list', 'Очистка замеров')}
      ${stat('Принято', formatNumber(periods.all.samples))}
      ${stat('Отброшено строк', formatNumber(data.result.dropped_rows))}
      ${stat('Дубликаты', formatNumber(dropped.duplicate))}
      ${stat('RSRP вне диапазона', formatNumber(dropped.signal))}
      ${stat('За границей района', formatNumber(dropped.outside))}
      ${stat('Повреждённые строки и числа', formatNumber(dropped.malformed))}
      ${stat('Неверное время', formatNumber(dropped.timestamp))}
      <div class="note">Ячеек с 1–4 замерами: ${periods.all.sparse}. Они исключены из карты и рейтинга.</div>
    </article>
  </div>`;
}
