import { readFile, writeFile, mkdir, rename, rm, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { analyze } from '../src/analysis.js';
const root = new URL('../',import.meta.url);
const sourceFolders = new Map([
  [resolve(fileURLToPath(new URL('data/07_coverage',root))), 'participants'],
  [resolve(fileURLToPath(new URL('data/demo',root))), 'demo']
]);
const read = path => readFile(new URL(path,root),'utf8');
const uri = async (path, mime) => 'data:' + mime + ';base64,' + (await readFile(new URL(path,root))).toString('base64');
const safeJson = value => JSON.stringify(value).replace(/</g,'\\u003c');

async function fontCss() {
  const [cyrillic,latin] = await Promise.all(['cyrillic','latin'].map(set => uri('assets/inter-' + set + '-wght-normal.woff2','font/woff2')));
  const face = (url,range) => '@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(' + url + ') format("woff2");unicode-range:' + range + '}';
  return face(cyrillic,'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116') + face(latin,'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD');
}

export async function buildReport(data, source) {
  const [template,baseMap,leaflet,leafletCss,styles,bundle,fonts,leafletLicense,fontLicense] = await Promise.all([
    read('src/page.html'), uri('assets/bishkek.svg','image/svg+xml'), read('vendor/leaflet.js'),
    read('vendor/leaflet.css'), read('src/style.css'), read('assets/dashboard.js'), fontCss(),read('vendor/LICENSE'),read('assets/Inter-LICENSE.txt')
  ]);
  const values = {
    '/*__STYLES__*/':fonts + '\n' + leafletCss + '\n' + styles,
    '__DATA__':safeJson({data,source}), '__BASE__':safeJson(baseMap),
    '/*__LEAFLET__*/':'/*' + leafletLicense + '*/\n' + leaflet.replace(/^\/\/# sourceMappingURL=.*$/gm,''),
    '/*__APP__*/':bundle
  };
  return template.replace(/\/\*__(?:STYLES|LEAFLET|APP)__\*\/|__(?:DATA|BASE)__/g,key => values[key])
    .replace('</head>', () => '<!-- Inter font license\n' + fontLicense.replaceAll('--','—') + '\n-->\n</head>');
}

export async function makeReport(directory, bounds, out) {
  const keys = ['measurements','towers','candidates'];
  const files = Object.fromEntries(await Promise.all(keys.map(async key => [key,await readFile(join(directory,key + '.csv'),'utf8')])));
  const data = analyze(files,bounds);
  const source = sourceFolders.get(resolve(directory)) || 'csv';
  const html = await buildReport(data,source);
  await mkdir(out,{recursive:true});
  const lock = join(out,'.efir-writing');
  const handle = await open(lock,'wx');
  const token = randomUUID();
  const htmlTmp = join(out,token + '.html.tmp'), jsonTmp = join(out,token + '.json.tmp');
  try {
    await writeFile(htmlTmp,html);
    await writeFile(jsonTmp,JSON.stringify(data.result,null,2));
    await rename(htmlTmp,join(out,'index.html'));
    await rename(jsonTmp,join(out,'result.json'));
  } finally {
    await handle.close();
    await Promise.all([htmlTmp,jsonTmp,lock].map(path => rm(path,{force:true})));
  }
  return data;
}
