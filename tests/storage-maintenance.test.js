import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dashboardFixture } from './dashboard-fixture.js';
import { cleanupRuntimeCaches, maintainStorage } from '../src/data/maintenance.js';

test('opslagonderhoud behoudt bedrijfsbewijs en wachtende logs, en ruimt alleen afgeleverde oude berichtkopieën op', (t) => {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.contexts.values().next().value,
    db = ctx.store.db,
    now = Date.now(),
    old = now - 100 * 86400000;
  const add = (event, created) =>
    Number(
      db
        .prepare('INSERT INTO audit(event,actor_id,details,created_at) VALUES(?,?,?,?)')
        .run(event, 'lid', '{}', created).lastInsertRowid,
    );
  const delivered = add('message.delete', old),
    absence = add('absence.approve', old),
    membership = add('member.update', old),
    pending = add('message.delete', old);
  db.prepare('INSERT INTO message_audit VALUES(?,?)').run(delivered, '{}');
  db.prepare('INSERT INTO message_audit VALUES(?,?)').run(pending, '{}');
  db.prepare(
    'INSERT INTO audit_deliveries(id,first_id,last_id,channel_id,message_id,payloads) VALUES(?,?,?,?,?,?)',
  ).run('done', delivered, membership, 'kanaal', 'bericht', '[{}]');
  db.prepare('INSERT INTO audit_deliveries(id,first_id,last_id,channel_id) VALUES(?,?,?,?)').run(
    'pending',
    pending,
    pending,
    'kanaal',
  );
  ctx.store.setSetting('audit:cursor', String(pending));
  db.prepare('INSERT INTO recent_messages VALUES(?,?,?,?)').run('oud', 'kanaal', '{}', old);
  maintainStorage(ctx, now);
  assert.equal(db.prepare('SELECT id FROM audit WHERE id=?').get(delivered), undefined);
  for (const id of [absence, membership, pending])
    assert.ok(db.prepare('SELECT id FROM audit WHERE id=?').get(id));
  assert.ok(db.prepare('SELECT * FROM message_audit WHERE audit_id=?').get(pending));
  assert.equal(
    db.prepare("SELECT payloads FROM audit_deliveries WHERE id='done'").get().payloads,
    null,
  );
  assert.ok(db.prepare("SELECT * FROM audit_deliveries WHERE id='pending'").get());
  assert.equal(db.prepare('SELECT * FROM recent_messages').get(), undefined);
});

test('opruiming van installatiecache laat database, back-ups, configuratie en dependencies staan', (t) => {
  const temp = join(process.cwd(), '.test-tmp');
  mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, 'cache-cleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of [
    '.npm/_cacache',
    '.npm/_logs',
    'node_modules/.cache',
    'data/backups',
    'node_modules/discord.js',
  ]) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'bestand'), 'bewaren');
  }
  writeFileSync(join(root, '.env'), 'privé');
  writeFileSync(join(root, 'data', 'legion.sqlite'), 'database');
  const result = cleanupRuntimeCaches(root);
  assert.ok(result.removedBytes > 0);
  assert.deepEqual(result.failures, []);
  for (const name of ['.npm/_cacache', '.npm/_logs', 'node_modules/.cache'])
    assert.equal(existsSync(join(root, name)), false);
  for (const name of [
    'data/backups/bestand',
    'node_modules/discord.js/bestand',
    '.env',
    'data/legion.sqlite',
  ])
    assert.equal(existsSync(join(root, name)), true);
});
