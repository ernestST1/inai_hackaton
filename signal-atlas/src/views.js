import { icon, escapeHtml } from './icons.js';
import { displayNumber as num } from './map.js';
import { coversCell } from './geo.js';
const pct = (n,total) => total ? Math.round(n*100/total) : 0;
const signalNames = {strong:'Сильные',medium:'Средние',weak:'Слабые'};
const labels = {all:'Все сутки',day:'День',night:'Ночь'};
const escape = escapeHtml;

function histogram(values, caption) {
  const max = Math.max(1,...values);
  const bars = values.map((v,i) => {
    const height = Math.max(1,25*v/max);
    return '<rect x="' + (i*6) + '" y="' + (27-height) + '" width="4" height="' + height + '" rx="1.5" fill="currentColor" opacity="' + (v ? .52+.42*v/max : .14) + '"/>';
  }).join('');
  return '<svg class="spark" role="img" aria-label="' + caption + '" viewBox="0 0 71 29"><title>' + caption + '</title>' + bars + '</svg>';
}

export function metrics(data, period) {
  const {cells,counts,plan,samples} = data.periods[period];
  const bins = Array.from({length:4}, () => Array(12).fill(0));
  const min = cells.reduce((n,c)=>Math.min(n,c.col),Infinity), max = cells.reduce((n,c)=>Math.max(n,c.col),-Infinity);
  const sites = data.candidates.filter(c => plan.best.ids.includes(c.id));
  for (const c of cells) {
    const i = Math.floor((c.col-min)*11/Math.max(1,max-min));
    bins[0][i] += c.count;
    bins[1][i]++;
    if (c.level === 'weak') {
      bins[2][i]++;
      if (sites.some(s => coversCell(s,c,data.bounds.earth_radius_m))) bins[3][i]++;
    }
  }
  const definitions = [
    ['signal','Принято замеров',num(samples),period === 'all' ? 'из ' + num(data.total) + ' исходных строк' : labels[period] + ' · UTC+6','#398a7e','#e4f1eb'],
    ['grid','Ячейки покрытия',num(cells.length),'от 5 замеров в ячейке','#6383a6','#e9eff7'],
    ['weak','Слабые ячейки',num(counts.weak),'медиана ниже −105 дБм','#c76e5c','#f9eae4'],
    ['target','Охват слабых ячеек',counts.weak ? pct(plan.best.count,counts.weak) + ' %' : '—',num(plan.best.count) + ' из ' + num(counts.weak) + ' в радиусе пары','#43886a','#e3f1e5']
  ];
  return definitions.map(([pic,title,value,sub,color,tint],i) => '<article class="metric" style="--accent:' + color + ';--tint:' + tint + '"><div class="metric-title"><span class="metric-icon">' + icon(pic,17) + '</span>' + title + '</div><strong>' + value + '</strong><small>' + sub + '</small>' + histogram(bins[i], title + ' по полосам с запада на восток (учтённые ячейки)') + '</article>').join('');
}
export function recommendation({counts,plan}) {
  const pair = plan.best.ids;
  const tokens = pair.map(id => '<span class="site-token">' + icon('pin',15) + escape(id) + '</span>').join('<span>+</span>');
  return '<div class="eyebrow">' + icon('target') + ' Рекомендация</div><h2>Оптимальная пара</h2>' +
    (pair.length ? '<div class="site-pair">' + tokens + '</div><p>В радиусе пары <b>' + plan.best.count + ' из ' + counts.weak +
    '</b> слабых ячеек</p><div class="cover-track"><span style="width:' + pct(plan.best.count,counts.weak) + '%"></span></div><button id="show-pair" class="pair-action">' + icon('aim',15) + 'Показать на карте</button>' :
    '<p class="empty">Для пары нужны две допустимые площадки. Сейчас доступно ' + plan.eligible + '.</p>');
}
export function ranking({cells}) {
  return '<div class="ranking-head"><h2>Худшие ячейки</h2><span class="tag">Топ-3</span></div><p class="muted">По медианному уровню сигнала</p>' +
    (cells.slice(0,3).map((c,i) => '<button class="rank-row" data-cell="' + c.id + '" aria-label="Показать ячейку ' + c.id + ' на карте"><span class="rank-index">0' + (i+1) + '</span><span class="rank-name">' + c.id + '<small>Замеров · ' + c.count + '</small></span><span class="value-tag" data-level="' + c.level + '">' + num(c.rsrp) + ' дБм</span></button>').join('') || '<div class="empty">Нет ячеек с пятью замерами за этот период.</div>');
}
const heading = (pic,title) => '<div class="detail-head"><i>' + icon(pic) + '</i><h2>' + title + '</h2></div>';
const stat = (label,value) => '<div class="stat-line"><span>' + label + '</span><b>' + value + '</b></div>';
function dayRow(period, data) {
  const {cells,counts,samples} = data.periods[period];
  const levels = ['strong','medium','weak'];
  return '<div class="compare-row"><div class="period-title"><strong class="inline">' + icon(period === 'day' ? 'sun' : 'moon',16) + labels[period] + '</strong><small>' +
    (period === 'day' ? '06:00–17:59' : '18:00–05:59') + ' · ' + num(samples) + ' замеров</small></div><div class="daybars">' +
    levels.map(l => '<span class="' + l + '" style="width:' + (counts[l]*100/(cells.length || 1)) + '%"></span>').join('') +
    '</div><div class="breakdown">' + levels.map(l => '<span><b class="swatch ' + l + '"></b>' + signalNames[l] + ' ' + counts[l] + '</span>').join('') + '</div></div>';
}
export function analytics(data) {
  const {plan,counts} = data.periods.all;
  const comparison = [['Полный перебор',plan.best],['Жадный выбор',plan.greedy]].map(([label,method]) =>
    '<div class="compare-row"><div><strong>' + label + '</strong><small>' + (method.ids.map(escape).join(' + ') || 'Нет пары') + '</small></div><div class="bar-track"><span style="width:' +
    pct(method.count,counts.weak) + '%"></span></div><p>Слабые ячейки в зоне пары: <b>' + method.count + ' / ' + counts.weak + '</b></p></div>').join('');
  return '<div class="section-grid"><article class="panel detail">' + heading('compare','Выбор двух площадок') + comparison + '<div class="note">Проверено пар: ' + plan.pairs +
    '. Выигрыш полного перебора: ' + (plan.best.count-plan.greedy.count) + ' яч.</div><p>Жадный алгоритм сначала выбирает площадку с наибольшим охватом, затем максимизирует число дополнительных ячеек.</p></article><article class="panel detail">' +
    heading('clock','Покрытие днём и ночью') + dayRow('day',data) + dayRow('night',data) + '<div class="note">В каждом периоде учитываются ячейки с пятью и более замерами. Время Бишкека, UTC+6.</div><p>Для пространственного сравнения выберите период на карте сигнала.</p></article></div>';
}
export const sourceLabels = {participants:'Набор участников', demo:'Демоданные', csv:'Загруженные данные'};
export function dataView(data, source) {
  const {dropped,bounds,periods} = data;
  return '<div class="section-grid"><article class="panel detail">' + heading('database','Входной набор') +
    stat('Источник', sourceLabels[source]) +
    (source === 'participants' ? '<p>07_coverage · Синтетическая модель радиопокрытия района Бишкека.</p>' : '') +
    stat('Строк в measurements.csv',num(data.total)) + stat('Базовых станций',data.towers.length) +
    stat('Площадок-кандидатов',data.candidates.length) + stat('Допустимых площадок',periods.all.plan.eligible) +
    '<div class="note">Границы WGS 84<br>Юг ' + bounds.south + ' · Север ' + bounds.north + '<br>Запад ' + bounds.west + ' · Восток ' + bounds.east + '</div>' +
    '<div class="data-actions"><button id="export-map" class="btn">' + icon('download',16) + 'Скачать HTML-карту</button></div></article><article class="panel detail">' +
    heading('list','Очистка замеров') + stat('Принято',num(periods.all.samples)) + stat('Отброшено строк',num(data.result.dropped_rows)) +
    stat('Дубликаты',num(dropped.duplicate)) + stat('RSRP вне диапазона',num(dropped.signal)) + stat('За границей района',num(dropped.outside)) +
    stat('Повреждённые строки и числа',num(dropped.malformed)) + stat('Неверное время',num(dropped.timestamp)) +
    '<div class="note">Ячеек с 1–4 замерами: ' + periods.all.sparse + '. Они исключены из карты и рейтинга.</div></article></div>';
}
