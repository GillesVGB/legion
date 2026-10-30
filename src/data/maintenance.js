import { existsSync, lstatSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { operationSettings } from '../config/features.js';

const MB = 1048576,
  DAY = 86400000;
function fileBytes(path) {
  const entry = lstatSync(path);
  return entry.isSymbolicLink()
    ? 0
    : entry.isDirectory()
      ? readdirSync(path).reduce((sum, name) => sum + fileBytes(join(path, name)), 0)
      : entry.size;
}
export function cleanupRuntimeCaches(projectRoot) {
  const root = resolve(projectRoot),
    result = { removedBytes: 0, failures: [] };
  for (const parts of [
    ['.npm', '_cacache'],
    ['.npm', '_logs'],
    ['node_modules', '.cache'],
  ]) {
    const target = resolve(root, ...parts);
    if (!target.startsWith(root + sep)) continue;
    try {
      let current = root,
        linked = lstatSync(root).isSymbolicLink();
      for (const part of parts) {
        current = join(current, part);
        if (!existsSync(current)) {
          linked = true;
          break;
        }
        if (lstatSync(current).isSymbolicLink()) {
          linked = true;
          break;
        }
      }
      if (linked) continue;
      const bytes = fileBytes(target);
      rmSync(target, { recursive: true, force: true });
      result.removedBytes += bytes;
    } catch (error) {
      result.failures.push(String(error.code || error.name));
    }
  }
  return result;
}

export function maintainStorage(ctx, now = Date.now()) {
  const db = ctx.store.db,
    last = Number(ctx.store.setting('storage:last-cleanup') || 0);
  if (last && now >= last && now - last < 3600000) return;
  const cutoff = now - operationSettings(ctx).logs.localRetentionDays * DAY,
    cursor = Number(ctx.store.setting('audit:cursor') || 0);
  ctx.store.transaction(() => {
    db.prepare('DELETE FROM recent_messages WHERE updated_at<?').run(now - DAY);
    // Delivered Discord logs remain available there; keep pending jobs and business evidence.
    db.prepare(
      'UPDATE audit_deliveries SET payloads=NULL WHERE message_id IS NOT NULL AND last_id<=? AND payloads IS NOT NULL',
    ).run(cursor);
    db.prepare(
      'DELETE FROM message_audit WHERE audit_id IN (SELECT id FROM audit WHERE id<=? AND created_at<?) AND NOT EXISTS (SELECT 1 FROM audit_deliveries d WHERE d.message_id IS NULL AND message_audit.audit_id BETWEEN d.first_id AND d.last_id)',
    ).run(cursor, cutoff);
    db.prepare(
      "DELETE FROM audit WHERE id<=? AND created_at<? AND (event LIKE 'interaction.%' OR event LIKE 'dashboard.action.%' OR event LIKE 'message.%' OR event IN ('security.guild_links_allowed','security.media_links_allowed','security.ticket_links_allowed')) AND NOT EXISTS (SELECT 1 FROM audit_deliveries d WHERE d.message_id IS NULL AND audit.id BETWEEN d.first_id AND d.last_id)",
    ).run(cursor, cutoff);
    db.prepare(
      'DELETE FROM audit_deliveries WHERE message_id IS NOT NULL AND last_id<=? AND NOT EXISTS (SELECT 1 FROM audit WHERE id BETWEEN audit_deliveries.first_id AND audit_deliveries.last_id)',
    ).run(cursor);
    ctx.store.setSetting('storage:last-cleanup', String(now));
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA shrink_memory;');
  const path = db
    .prepare('PRAGMA database_list')
    .all()
    .find((item) => item.name === 'main')?.file;
  if (!path) return;
  const pages = db.prepare('PRAGMA page_count').get().page_count,
    free = db.prepare('PRAGMA freelist_count').get().freelist_count,
    size = db.prepare('PRAGMA page_size').get().page_size;
  if (free * size < 8 * MB || free < pages / 5) return;
  const disk = statfsSync(path);
  if (disk.bavail * disk.bsize > (pages - free) * size + 16 * MB)
    db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
}
