import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeReport } from './report.mjs';
const path = (relative) => fileURLToPath(new URL('../' + relative, import.meta.url));
await build({
  entryPoints: [path('src/app.js')],
  outfile: path('assets/dashboard.js'),
  bundle: true,
  format: 'iife',
  target: 'es2021',
  charset: 'utf8',
  legalComments: 'inline',
});
await makeReport(
  path('data/07_coverage'),
  JSON.parse(await readFile(path('data/07_coverage/bounds.json'), 'utf8')),
  path('dist'),
);
console.log('Готовы dist/index.html и dist/result.json');
