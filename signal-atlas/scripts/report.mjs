import { readFile, writeFile, mkdir, rename, rm, readdir, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { analyze } from '../src/analysis.js';
const root = new URL('../', import.meta.url);
const sourceFolders = new Map([
  [resolve(fileURLToPath(new URL('data/07_coverage', root))), 'participants'],
  [resolve(fileURLToPath(new URL('data/demo', root))), 'demo'],
]);
const read = (path) => readFile(new URL(path, root), 'utf8');
const uri = async (path, mime) =>
  'data:' + mime + ';base64,' + (await readFile(new URL(path, root))).toString('base64');
const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

async function fontCss() {
  const [cyrillic, latin] = await Promise.all(
    ['cyrillic', 'latin'].map((set) =>
      uri('assets/inter-' + set + '-wght-normal.woff2', 'font/woff2'),
    ),
  );
  const face = (url, range) =>
    '@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(' +
    url +
    ') format("woff2");unicode-range:' +
    range +
    '}';
  return (
    face(cyrillic, 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116') +
    face(
      latin,
      'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    )
  );
}

export async function buildReport(data, source) {
  const [
    template,
    baseMap,
    leaflet,
    leafletCss,
    styles,
    bundle,
    fonts,
    leafletLicense,
    fontLicense,
  ] = await Promise.all([
    read('src/page.html'),
    uri('assets/bishkek.png', 'image/png'),
    read('vendor/leaflet.js'),
    read('vendor/leaflet.css'),
    read('src/style.css'),
    read('assets/dashboard.js'),
    fontCss(),
    read('vendor/LICENSE'),
    read('assets/Inter-LICENSE.txt'),
  ]);
  const values = {
    '/*__STYLES__*/': fonts + '\n' + leafletCss + '\n' + styles,
    __DATA__: safeJson({ data, source }),
    __BASE__: safeJson(baseMap),
    '/*__LEAFLET__*/':
      '/*' + leafletLicense + '*/\n' + leaflet.replace(/^\/\/# sourceMappingURL=.*$/gm, ''),
    '/*__APP__*/': bundle,
  };
  return template
    .replace(/\/\*__(?:STYLES|LEAFLET|APP)__\*\/|__(?:DATA|BASE)__/g, (key) => values[key])
    .replace(
      '</head>',
      () => '<!-- Inter font license\n' + fontLicense.replaceAll('--', '—') + '\n-->\n</head>',
    );
}

export async function makeReport(directory, bounds, out) {
  const keys = ['measurements', 'towers', 'candidates'];
  const files = Object.fromEntries(
    await Promise.all(
      keys.map(async (key) => [key, await readFile(join(directory, key + '.csv'), 'utf8')]),
    ),
  );
  const data = analyze(files, bounds);
  const source = sourceFolders.get(resolve(directory)) || 'csv';
  const html = await buildReport(data, source);
  await mkdir(out, { recursive: true });
  const token = randomUUID();
  const htmlTmp = join(out, token + '.html.tmp'),
    jsonTmp = join(out, token + '.json.tmp');
  try {
    await writeFile(htmlTmp, html);
    await writeFile(jsonTmp, JSON.stringify(data.result, null, 2));
    await publishPair(out, token, htmlTmp, jsonTmp);
  } finally {
    await Promise.all([htmlTmp, jsonTmp].map((path) => rm(path, { force: true })));
  }
  return data;
}

function ownerIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function replaceReportFiles(out, htmlTmp, jsonTmp) {
  const jsonPath = join(out, 'result.json');
  const previous = await readFile(jsonPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  await rename(jsonTmp, jsonPath);
  try {
    await rename(htmlTmp, join(out, 'index.html'));
  } catch (error) {
    if (previous === null) {
      await rm(jsonPath);
    } else {
      await writeFile(jsonTmp, previous);
      await rename(jsonTmp, jsonPath);
    }
    throw error;
  }
}

// Каждый процесс объявляет намерение до чтения списка. Если объявления пересеклись,
// уступаем и повторяем попытку. Остаток от завершившегося процесса не блокирует запуск.
async function publishPair(out, token, htmlTmp, jsonTmp) {
  const claim = '.efir-publish-' + process.pid + '-' + token;
  const claimPath = join(out, claim);
  for (let attempt = 0; attempt < 30; attempt++) {
    await mkdir(claimPath);
    try {
      const busy = (await readdir(out)).some((name) => {
        const owner = /^\.efir-publish-(\d+)-[0-9a-f-]{36}$/.exec(name);
        return name !== claim && owner && ownerIsRunning(Number(owner[1]));
      });
      if (!busy) {
        await replaceReportFiles(out, htmlTmp, jsonTmp);
        return;
      }
    } finally {
      await rmdir(claimPath);
    }
    await delay(15 + Math.random() * 45);
  }
  throw new Error('Другой процесс сохраняет отчёт в эту папку. Повторите запуск.');
}
