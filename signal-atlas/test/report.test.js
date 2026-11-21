import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const project = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);

function generate(source, out) {
  return exec(process.execPath, ['scripts/analyze.mjs', '--data', source, '--out', out], {
    cwd: project,
  });
}

test('Повторный запуск после завершения владельца блокировки', async (t) => {
  const { stdout: pid } = await exec(process.execPath, ['-p', 'process.pid']);
  const out = await mkdtemp(join(tmpdir(), 'efir-retry-'));
  const oldLock = join(out, '.efir-writing');
  const staleClaim = join(out, `.efir-publish-${pid.trim()}-${randomUUID()}`);
  await writeFile(oldLock, '');
  await mkdir(staleClaim);
  t.after(async () => {
    for (const name of ['index.html', 'result.json', '.efir-writing']) {
      await rm(join(out, name), { force: true });
    }
    await rmdir(staleClaim);
    await rmdir(out);
  });
  await generate('data/demo', out);
  assert.ok((await readFile(join(out, 'index.html'), 'utf8')).includes('initial-data'));
});

test('Два процесса с разными наборами оставляют согласованные HTML и JSON', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'efir-pair-'));
  const html = join(out, 'index.html');
  const json = join(out, 'result.json');
  t.after(async () => {
    await Promise.all([html, json].map((path) => rm(path, { force: true })));
    await rmdir(out);
  });
  await Promise.all([generate('data/07_coverage', out), generate('data/demo', out)]);
  const text = await readFile(html, 'utf8');
  const payload = text.match(/id="initial-data">([\s\S]*?)<\/script>/);
  assert.deepEqual(JSON.parse(payload[1]).data.result, JSON.parse(await readFile(json, 'utf8')));
  assert.deepEqual((await readdir(out)).sort(), ['index.html', 'result.json']);
});

test('При ошибке записи HTML сохраняется предыдущий JSON', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'efir-rollback-'));
  const html = join(out, 'index.html');
  const json = join(out, 'result.json');
  await mkdir(html);
  await writeFile(json, '{"previous":true}');
  t.after(async () => {
    await rm(json);
    await rmdir(html);
    await rmdir(out);
  });
  await assert.rejects(generate('data/demo', out), /rename[^\n]*index\.html/);
  assert.equal(await readFile(json, 'utf8'), '{"previous":true}');
  assert.deepEqual((await readdir(out)).sort(), ['index.html', 'result.json']);
});
