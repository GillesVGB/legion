import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, loadConfig } from '../src/config/index.js';

const project = fileURLToPath(new URL('../', import.meta.url));
function modules(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((item) => {
    const path = join(folder, item.name);
    return item.isDirectory()
      ? item.name === 'public'
        ? []
        : modules(path)
      : item.name.endsWith('.js')
        ? [path]
        : [];
  });
}

test('alle verplaatste bibliotheken en hun assets laden zonder Discord te starten', async () => {
  const entry = resolve(project, 'src/app/bot.js');
  const files = modules(join(project, 'src')).filter((file) => file !== entry);
  assert.ok(files.length > 50);
  for (const file of files) await import(pathToFileURL(file).href);
});

test('de projectroot, runtimegegevens en bestaande hostingconfiguratie blijven op dezelfde plaats', () => {
  assert.equal(ROOT, resolve(project));
  const config = loadConfig({}, false);
  assert.equal(config.dataDir, join(ROOT, 'data'));
  assert.equal(
    loadConfig({ DATA_DIR: './private-data' }, false).dataDir,
    join(ROOT, 'private-data'),
  );
  assert.equal(config.guilds.length, 2);
  for (const path of [
    'index.js',
    'src/commands/definitions.js',
    'src/data/store.js',
    'src/dashboard/public/index.html',
    'src/ui/assets/logo.webp',
    'src/modules/transcripts/public/page.html',
  ])
    assert.ok(existsSync(join(ROOT, path)), path);
  assert.deepEqual(
    readdirSync(join(ROOT, 'src'), { withFileTypes: true }).filter((item) => item.isFile()),
    [],
  );
});
