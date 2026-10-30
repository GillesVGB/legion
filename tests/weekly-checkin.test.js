import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardFixture, ACTOR, OTHER } from './dashboard-fixture.js';
import {
  syncWeeklyActivityCheck,
  weeklyCheckDeadline,
  cancelActivityCheck,
  createActivityCheck,
} from '../src/modules/check-ins/index.js';
import { loadDashboardSettings, saveDashboardSettings } from '../src/dashboard/settings.js';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/data/store.js';
const DESTINATION = '1555685632704249932';
const NOW = Date.parse('2026-10-20T10:00:00Z'),
  FIRST = Date.parse('2026-10-23T05:30:00Z');
function fixture(t) {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.contexts.values().next().value,
    guild = f.guilds.get(ctx.config.guildId),
    lead = guild.members.cache.get(ACTOR);
  guild.members.cache
    .get(OTHER)
    .roles.cache.set(ctx.config.memberRoleId, guild.roles.cache.get(ctx.config.memberRoleId));
  const channel = guild.channels.cache.get(ctx.config.planningChannelId),
    permissions = channel.permissionsFor;
  channel.permissionsFor = (member) =>
    member.roles?.cache.has(ctx.config.memberRoleId)
      ? new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory])
      : permissions(member);
  const target = guild.makeChannel(DESTINATION, 'mededelingen'),
    targetPermissions = target.permissionsFor;
  target.permissionsFor = (member) =>
    member.roles?.cache.has(ctx.config.memberRoleId)
      ? new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory])
      : targetPermissions(member);
  return { ...f, ctx, guild, lead };
}
test('weekcheck start met reden en vrijdagdeadline; dubbel onderhoud, herladen en annuleren dupliceren de week niet', async (t) => {
  const f = fixture(t);
  t.mock.method(Date, 'now', () => NOW);
  loadDashboardSettings(f.ctx);
  await Promise.all([
    syncWeeklyActivityCheck(f.ctx, f.guild, NOW),
    syncWeeklyActivityCheck(f.ctx, f.guild, NOW),
  ]);
  const check = f.ctx.store.db.prepare('SELECT * FROM activity_check_sessions').get();
  assert.equal(check.deadline_at, FIRST);
  assert.equal(check.reason, 'Tweewekelijkse activiteitencheck');
  const post = f.guild.channels.cache.get(check.channel_id).posted.get(check.message_id);
  assert.match(post.embeds[0].description, /Tweewekelijkse activiteitencheck/);
  assert.ok(post.reactions.cache.get('✅').me);
  loadDashboardSettings(f.ctx);
  await syncWeeklyActivityCheck(f.ctx, f.guild, NOW);
  assert.equal(
    f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_sessions').get().n,
    1,
  );
  await cancelActivityCheck(f.ctx, f.guild, f.lead, check.id);
  await syncWeeklyActivityCheck(f.ctx, f.guild, NOW + 1000);
  assert.equal(
    f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_sessions').get().n,
    1,
  );
  saveDashboardSettings(f.ctx, { operations: { activityCheck: { weeklyEnabled: false } } }, ACTOR);
  loadDashboardSettings(f.ctx);
  assert.equal(f.ctx.config.operations.activityCheck.weeklyEnabled, false);
});
test('activiteitencheck herhaalt standaard om de twee weken en behoudt Belgische tijd door wintertijd', () => {
  const ctx = { config: { operations: { activityCheck: { weeklyEnabled: true } } } };
  assert.equal(weeklyCheckDeadline(ctx, NOW).deadline, FIRST);
  assert.deepEqual(weeklyCheckDeadline(ctx, FIRST + 60000), {
    date: '2026-11-06',
    deadline: Date.parse('2026-11-06T06:30:00Z'),
  });
  assert.deepEqual(weeklyCheckDeadline(ctx, Date.parse('2026-11-18T12:00:00Z')), {
    date: '2026-11-20',
    deadline: Date.parse('2026-11-20T06:30:00Z'),
  });
  ctx.config.operations.activityCheck.weeklyIntervalWeeks = 1;
  assert.deepEqual(weeklyCheckDeadline(ctx, FIRST + 60000), {
    date: '2026-10-30',
    deadline: Date.parse('2026-10-30T06:30:00Z'),
  });
});
test('interval van de automatische check is instelbaar in dashboard van 1 tot 12 weken', (t) => {
  const f = fixture(t);
  loadDashboardSettings(f.ctx);
  assert.equal(f.ctx.config.operations.activityCheck.weeklyIntervalWeeks, 2);
  saveDashboardSettings(
    f.ctx,
    { operations: { activityCheck: { weeklyIntervalWeeks: 3 } } },
    ACTOR,
  );
  assert.equal(f.ctx.config.operations.activityCheck.weeklyIntervalWeeks, 3);
  assert.throws(() =>
    saveDashboardSettings(
      f.ctx,
      { operations: { activityCheck: { weeklyIntervalWeeks: 13 } } },
      ACTOR,
    ),
  );
  loadDashboardSettings(f.ctx);
  assert.equal(f.ctx.config.operations.activityCheck.weeklyIntervalWeeks, 3);
});
test('een handmatige check met dezelfde deadline wordt hergebruikt; andere lopende checks worden niet overschreven', async (t) => {
  const f = fixture(t);
  t.mock.method(Date, 'now', () => NOW);
  const { check } = await createActivityCheck(
    f.ctx,
    f.guild,
    f.lead,
    { date: '23-10-2026', time: '07:30', channelId: f.ctx.config.planningChannelId },
    NOW,
  );
  loadDashboardSettings(f.ctx);
  await syncWeeklyActivityCheck(f.ctx, f.guild, NOW);
  assert.equal(
    f.ctx.store.db.prepare('SELECT check_id FROM activity_check_occurrences').get().check_id,
    check.id,
  );
  assert.equal(
    f.ctx.store.db.prepare('SELECT reason FROM activity_check_sessions WHERE id=?').get(check.id)
      .reason,
    'Tweewekelijkse activiteitencheck',
  );
  assert.equal(
    f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_sessions').get().n,
    1,
  );
});
test('een mislukte start bewaart geen weekclaim en community krijgt geen automatische weekcheck', async (t) => {
  const f = fixture(t);
  loadDashboardSettings(f.ctx);
  f.ctx.config.operations.activityCheck.weeklyChannelId = '999999999999999999';
  await assert.rejects(syncWeeklyActivityCheck(f.ctx, f.guild, NOW));
  assert.equal(
    f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_occurrences').get().n,
    0,
  );
  await syncWeeklyActivityCheck(f.source, f.guilds.get(f.source.config.guildId), NOW);
  assert.equal(
    f.source.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_sessions').get().n,
    0,
  );
});
test('SQLite-herstart bewaart de weekclaim en voorraad, en migratie vult oude checks zonder reden aan', async (t) => {
  const f = fixture(t);
  t.mock.method(Date, 'now', () => NOW);
  const directory = mkdtempSync(join(tmpdir(), 'bakarov-weekly-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'fixture.sqlite');
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, filename);
  loadDashboardSettings(f.ctx);
  await syncWeeklyActivityCheck(f.ctx, f.guild, NOW);
  const original = f.ctx.store.db.prepare('SELECT id FROM activity_check_sessions').get().id;
  f.ctx.store.db
    .prepare(
      "INSERT INTO gangpot_assets(id,request_id,kind,name,quantity,direction,actor_id,created_at) VALUES('asset','persist-request','item','repairkit',2,'in',?,?)",
    )
    .run(ACTOR, NOW);
  f.ctx.store.db.exec(
    'ALTER TABLE activity_check_sessions DROP COLUMN reason; PRAGMA user_version=18;',
  );
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, filename);
  loadDashboardSettings(f.ctx);
  await syncWeeklyActivityCheck(f.ctx, f.guild, NOW + 1000);
  assert.equal(
    f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_sessions').get().n,
    1,
  );
  assert.equal(
    f.ctx.store.db.prepare('SELECT check_id FROM activity_check_occurrences').get().check_id,
    original,
  );
  assert.equal(f.ctx.store.db.prepare('SELECT quantity FROM gangpot_assets').get().quantity, 2);
  assert.equal(f.ctx.store.db.prepare('PRAGMA user_version').get().user_version, 20);
});
