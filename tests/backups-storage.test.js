import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createDataBackup, backupSummary } from '../src/data/backups.js';
const MAIN = '1555685630640652338';
function fixture(t, settings = {}) {
  const root = join(process.cwd(), '.test-tmp');
  fs.mkdirSync(root, { recursive: true });
  const path = fs.mkdtempSync(join(root, 'backup-storage-'));
  const source = join(path, `legion-${MAIN}.sqlite`),
    db = new DatabaseSync(source);
  db.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE contents(value TEXT); INSERT INTO contents VALUES('veilig');",
  );
  db.prepare('INSERT INTO settings VALUES(?,?)').run(
    'dashboard-config',
    JSON.stringify({ operations: { backups: settings } }),
  );
  db.close();
  t.after(() => fs.rmSync(path, { recursive: true, force: true }));
  return { path, source };
}
function legacy(path, id, content, createdAt) {
  const folder = join(path, 'backups', id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(join(folder, 'text.txt'), content);
  fs.writeFileSync(
    join(folder, 'manifest.json'),
    JSON.stringify({
      app: 'legion',
      complete: true,
      version: 'old',
      createdAt,
      files: ['text.txt'],
    }),
  );
  return folder;
}
function decoded(folder, name) {
  const manifest = JSON.parse(fs.readFileSync(join(folder, 'manifest.json'), 'utf8'));
  return gunzipSync(fs.readFileSync(join(folder, manifest.storage[name])));
}

test('grote bestanden worden met begrensde gzipblokken volledig herstelbaar opgeslagen', (t) => {
  const { path } = fixture(t),
    content = Buffer.from('Gesprek met meerdere regels.\n'.repeat(16000));
  fs.mkdirSync(join(path, 'transcripts'));
  fs.writeFileSync(join(path, 'transcripts', 'gesprek.txt'), content);
  const result = createDataBackup(path, 'test'),
    folder = join(path, 'backups', result.id);
  assert.deepEqual(decoded(folder, 'transcripts/gesprek.txt'), content);
  const summary = backupSummary(path)[0];
  assert.equal(summary.compressed, true);
  assert.ok(summary.bytes < content.length / 8);
  assert.equal(fs.readFileSync(join(path, 'transcripts', 'gesprek.txt')).length, content.length);
});

test('bestaande volledige back-ups worden veilig gecomprimeerd, ook zonder nieuwe update', (t) => {
  const { path } = fixture(t),
    id = '2026-10-27T00-00-00-000Z-old-aabbcc',
    folder = legacy(path, id, 'Oud gesprek\n'.repeat(20000), 1000);
  fs.writeFileSync(join(path, 'backups', 'state.json'), JSON.stringify({ version: 'old', id }));
  const result = createDataBackup(path, 'old', { automatic: true });
  assert.equal(result.reason, 'current');
  assert.equal(decoded(folder, 'text.txt').toString(), 'Oud gesprek\n'.repeat(20000));
  assert.equal(fs.existsSync(join(folder, 'text.txt')), false);
  assert.equal(backupSummary(path).length, 1);
  assert.equal(backupSummary(path)[0].compressed, true);
});

test('bytebudget verwijdert alleen oudere eigen back-ups en behoudt de nieuwste volledige kopie', (t) => {
  const { path } = fixture(t, { keep: 30, maxTotalMB: 16 }),
    older = '2026-10-26T00-00-00-000Z-old-aabbcc',
    newer = '2026-10-27T00-00-00-000Z-old-aabbcc';
  legacy(path, older, Buffer.alloc(10 * 1024 * 1024), 1000);
  const folder = legacy(path, newer, Buffer.alloc(10 * 1024 * 1024), 2000);
  fs.mkdirSync(join(path, 'backups', 'eigen-map'));
  fs.writeFileSync(join(path, 'backups', 'eigen-map', 'notitie'), 'Bewaren');
  fs.writeFileSync(
    join(path, 'backups', 'state.json'),
    JSON.stringify({ version: 'old', id: newer }),
  );
  createDataBackup(path, 'old', { automatic: true });
  assert.equal(fs.existsSync(join(path, 'backups', older)), false);
  assert.equal(decoded(folder, 'text.txt').length, 10 * 1024 * 1024);
  assert.equal(fs.readFileSync(join(path, 'backups', 'eigen-map', 'notitie'), 'utf8'), 'Bewaren');
  assert.ok(backupSummary(path)[0].bytes < 16 * 1024 * 1024);
});

test('ruimtegebrek behoudt actieve gegevens, vorige back-up en updatekoppeling', (t) => {
  const { path, source } = fixture(t),
    previous = createDataBackup(path, 'old', { automatic: true }),
    state = fs.readFileSync(join(path, 'backups', 'state.json'), 'utf8');
  const original = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 0, bsize: 4096 });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => createDataBackup(path, 'new', { automatic: true }),
      (error) => error.code === 'BACKUP_SPACE',
    );
  } finally {
    fs.statfsSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(join(path, 'backups', 'state.json'), 'utf8'), state);
  assert.equal(backupSummary(path)[0].id, previous.id);
  assert.equal(backupSummary(path).length, 1);
  assert.ok(!fs.readdirSync(join(path, 'backups')).some((name) => name.startsWith('.partial-')));
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT value FROM contents').get().value, 'veilig');
  } finally {
    db.close();
  }
});

test('alleen herkenbare verlaten partial-back-ups worden opgeruimd', (t) => {
  const { path } = fixture(t),
    root = join(path, 'backups'),
    partial = join(root, '.partial-2026-10-26T00-00-00-000Z-old-aabbcc');
  fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(join(partial, 'temp'), 'verlopen');
  fs.utimesSync(partial, new Date(0), new Date(0));
  fs.mkdirSync(join(root, '.partial-mijn-map'));
  fs.writeFileSync(join(root, '.partial-mijn-map', 'temp'), 'bewaren');
  createDataBackup(path, 'new');
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.readFileSync(join(root, '.partial-mijn-map', 'temp'), 'utf8'), 'bewaren');
});
