import { analyze } from './analysis.js';
import { icon } from './icons.js';
import { CoverageMap } from './map.js';
import { compareCoverage } from './planning.js';
import {
  metrics,
  recommendation,
  ranking,
  signalDistribution,
  analytics,
  dataView,
  sourceLabels,
} from './views.js';

const get = (id) => document.getElementById(id);
// Keep a clean document for offline exports, before Leaflet adds interactive DOM.
const original = document.documentElement.cloneNode(true);
let { data, source } = JSON.parse(get('initial-data').textContent);
let period = 'all',
  mode = 'grid',
  map,
  tipTimer;
let algorithm = 'best';
const routes = {
  overview: ['Карта покрытия', 'Уровень сигнала и площадки для новых базовых станций.'],
  analytics: [
    'Аналитика покрытия',
    'Сравнение алгоритмов выбора площадок и качества сигнала по времени суток.',
  ],
  data: ['Исходные данные', 'Состав набора, границы района и результаты очистки замеров.'],
};
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
function notify(message) {
  get('notice').textContent = message;
  get('notice').hidden = false;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => (get('notice').hidden = true), 3000);
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function setupExpandedMap() {
  const panel = get('map-card');
  const home = panel.parentElement;
  const dialog = get('map-dialog');
  const button = get('fullscreen-map');

  function updateButton(expanded) {
    button.setAttribute('aria-pressed', String(expanded));
    button.title = expanded ? 'Выйти из полного экрана' : 'Карта на весь экран';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = icon(expanded ? 'collapse' : 'expand');
    button.focus({ preventScroll: true });
  }

  button.addEventListener('click', () => {
    if (dialog.open) return dialog.close();
    dialog.append(panel);
    dialog.showModal();
    updateButton(true);
  });
  dialog.addEventListener('close', () => {
    home.prepend(panel);
    updateButton(false);
  });
}
setupExpandedMap();
function exportMap() {
  const page = original.cloneNode(true);
  page.querySelector('#initial-data').textContent = JSON.stringify({ data, source }).replace(
    /</g,
    '\\u003c',
  );
  download('coverage-map.html', '<!doctype html>\n' + page.outerHTML, 'text/html;charset=utf-8');
}
function renderOverview(refit = false) {
  const summary = data.periods[period];
  const coverage = compareCoverage(data.candidates, summary, data.bounds.earth_radius_m);
  get('metrics').innerHTML = metrics(data, period, algorithm, coverage);
  get('recommend').innerHTML = recommendation(summary, algorithm);
  document
    .querySelectorAll('[data-algorithm]')
    .forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.algorithm === algorithm)),
    );
  get('worst').innerHTML = ranking(summary);
  get('distribution').innerHTML = signalDistribution(summary);
  get('show-pair')?.addEventListener('click', () => map.showPair());
  get('worst')
    .querySelectorAll('[data-cell]')
    .forEach((button) => (button.onclick = () => map.focusCell(button.dataset.cell)));
  get('period').value = period;
  document
    .querySelectorAll('[data-mode]')
    .forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  if (!map) {
    map = new CoverageMap();
    refit = true;
  }
  map.map.invalidateSize();
  map.mode = mode;
  map.setData(data, period, algorithm, coverage, refit);
  get('save-json').title = 'Результат полного перебора для всех суток';
}
function route(refit = false) {
  const requested = location.hash.slice(1);
  const name = Object.hasOwn(routes, requested) ? requested : 'overview';
  for (const key of Object.keys(routes)) get(key).hidden = key !== name;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  get('page-title').textContent = routes[name][0];
  get('page-description').textContent = routes[name][1];
  get('source-badge').textContent = sourceLabels[source];
  if (name === 'overview') renderOverview(refit);
  if (name === 'analytics') get('analytics').innerHTML = analytics(data);
  if (name === 'data') {
    get('data').innerHTML = dataView(data, source);
    get('export-map').onclick = exportMap;
  }
}
window.addEventListener('hashchange', () => {
  route();
  window.scrollTo(0, 0);
});
// Native anchors match the section IDs. Keep the navigation and title in view.
document.querySelectorAll('nav a,.brand').forEach(
  (a) =>
    (a.onclick = (e) => {
      e.preventDefault();
      history.replaceState(null, '', a.getAttribute('href'));
      route();
      window.scrollTo(0, 0);
    }),
);
get('period').onchange = (e) => {
  period = e.target.value;
  renderOverview();
};
document.querySelectorAll('[data-algorithm]').forEach(
  (button) =>
    (button.onclick = () => {
      algorithm = button.dataset.algorithm;
      get('layer-signal').checked = true;
      get('layer-radius').checked = true;
      get('layer-sites').checked = true;
      renderOverview();
    }),
);
document.querySelectorAll('[data-mode]').forEach(
  (button) =>
    (button.onclick = () => {
      mode = button.dataset.mode;
      map.setMode(mode);
      document
        .querySelectorAll('[data-mode]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    }),
);
get('save-json').onclick = () => {
  download('result.json', JSON.stringify(data.result, null, 2), 'application/json');
  notify('Подготовлен result.json за все сутки');
};

const filenames = ['measurements', 'towers', 'candidates'];
const directions = { south: 'Юг', west: 'Запад', north: 'Север', east: 'Восток' };
get('file-inputs').innerHTML = filenames
  .map(
    (name) =>
      '<label class="file-field">' +
      name +
      '.csv<input type="file" accept=".csv,text/csv" id="file-' +
      name +
      '" required></label>',
  )
  .join('');
get('bound-inputs').innerHTML = Object.entries(directions)
  .map(
    ([key, label]) =>
      '<label>' +
      label +
      '<input id="bound-' +
      key +
      '" type="number" step="any" required placeholder="' +
      data.bounds[key] +
      '"></label>',
  )
  .join('');
function syncBoundsForm() {
  const choice = get('bounds-source').value;
  get('bounds-file-row').hidden = choice !== 'file';
  get('file-bounds').disabled = choice !== 'file';
  get('bound-inputs').hidden = choice !== 'manual';
  for (const key of Object.keys(directions)) get('bound-' + key).disabled = choice !== 'manual';
}
get('bounds-source').onchange = syncBoundsForm;
syncBoundsForm();
async function readBounds() {
  const choice = get('bounds-source').value;
  if (choice === 'current') return data.bounds;
  if (choice === 'manual')
    return Object.fromEntries(
      Object.keys(directions).map((key) => [key, get('bound-' + key).valueAsNumber]),
    );
  const file = get('file-bounds').files[0];
  if (!file) throw new Error('Выберите bounds.json с параметрами района.');
  const contents = await file.text();
  try {
    return JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Проверьте формат JSON в файле границ.');
  }
}
get('open-import').onclick = () => {
  get('import-error').hidden = true;
  get('import-dialog').showModal();
};
get('close-import').onclick = () => get('import-dialog').close();
get('import-dialog').onclick = (e) => {
  if (e.target === get('import-dialog')) {
    const box = e.target.getBoundingClientRect();
    if (
      e.clientX < box.left ||
      e.clientX > box.right ||
      e.clientY < box.top ||
      e.clientY > box.bottom
    )
      e.target.close();
  }
};
get('import-form').onsubmit = async (e) => {
  e.preventDefault();
  const submit = e.currentTarget.querySelector('[type=submit]');
  submit.disabled = true;
  get('import-error').hidden = true;
  try {
    const entries = await Promise.all(
      filenames.map(async (name) => [name, await get('file-' + name).files[0].text()]),
    );
    const bounds = await readBounds();
    const next = analyze(Object.fromEntries(entries), bounds);
    data = next;
    for (const key of Object.keys(directions))
      get('bound-' + key).placeholder = String(next.bounds[key]);
    source = 'csv';
    period = 'all';
    mode = 'grid';
    algorithm = 'best';
    get('layer-radius').checked = false;
    get('layer-signal').checked = true;
    history.replaceState(null, '', '#overview');
    route(true);
    get('import-dialog').close();
    window.scrollTo(0, 0);
    notify('Карта пересчитана по загруженным CSV');
  } catch (error) {
    get('import-error').textContent = error.message;
    get('import-error').hidden = false;
  } finally {
    submit.disabled = false;
  }
};
route(true);
