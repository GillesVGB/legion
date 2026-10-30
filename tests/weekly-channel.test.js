import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { dashboardFixture, ACTOR, OTHER } from './dashboard-fixture.js';
import { Store } from '../src/data/store.js';
import { loadDashboardSettings, saveDashboardSettings } from '../src/dashboard/settings.js';
import {
  createActivityCheck,
  respondActivityCheck,
  moveActivityCheck,
  cleanupMovedActivityChecks,
  syncWeeklyActivityCheck,
  handleActivityCheckReaction,
} from '../src/modules/check-ins/index.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const FIRST = Date.parse('2026-10-23T05:30:00Z');
const DESTINATION = '1555685632704249932';
const CUSTOM = '100000000000000777';
const SECOND = '100000000000000020';
function fixture(t, persistent = false) {
  t.mock.method(Date, 'now', () => NOW);
  const f = dashboardFixture(),
    ctx = f.contexts.values().next().value,
    guild = f.guilds.get(ctx.config.guildId);
  let directory, filename;
  if (persistent) {
    directory = mkdtempSync(join(tmpdir(), 'bakarov-weekly-channel-'));
    filename = join(directory, 'fixture.sqlite');
    ctx.store.close();
    ctx.store = new Store(ctx.config, filename);
  }
  t.after(() => {
    f.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  guild.members.cache
    .get(OTHER)
    .roles.cache.set(ctx.config.memberRoleId, guild.roles.cache.get(ctx.config.memberRoleId));
  const visible = (channel) => {
    const permissions = channel.permissionsFor;
    channel.permissionsFor = (member) =>
      member.roles?.cache.has(ctx.config.memberRoleId)
        ? new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory])
        : permissions(member);
    return channel;
  };
  const source = visible(guild.channels.cache.get(ctx.config.planningChannelId));
  const target = visible(guild.makeChannel(DESTINATION, 'activiteitencheck'));
  return {
    ...f,
    ctx,
    guild,
    source,
    target,
    filename,
    lead: guild.members.cache.get(ACTOR),
    record: (id) =>
      ctx.store.db.prepare('SELECT * FROM activity_check_sessions WHERE id=?').get(id),
  };
}
function oldWeeklyConfiguration(f, channel = f.source.id) {
  f.ctx.store.setSetting('activitycheck:weekly-config:1', '1');
  f.ctx.store.setSetting('branding:version', 'bakarov-1');
  saveDashboardSettings(
    f.ctx,
    {
      operations: {
        activityCheck: {
          weeklyEnabled: true,
          weeklyStartDate: '2026-10-23',
          weeklyTime: '07:30',
          weeklyReason: 'Wekelijkse activiteitencheck',
          weeklyChannelId: channel,
        },
      },
    },
    ACTOR,
  );
}

test('opgeslagen weekcheck in planning migreert eenmaal naar het activiteitenkanaal en behoudt latere dashboardkeuzes na SQLite-herstart', (t) => {
  const f = fixture(t, true);
  oldWeeklyConfiguration(f);
  loadDashboardSettings(f.ctx);
  assert.equal(f.ctx.config.operations.activityCheck.weeklyChannelId, DESTINATION);
  assert.equal(
    JSON.parse(f.ctx.store.setting('dashboard-config')).operations.activityCheck.weeklyChannelId,
    DESTINATION,
  );
  assert.ok(f.ctx.store.setting('activitycheck:weekly-channel:2'));
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, f.filename);
  loadDashboardSettings(f.ctx);
  assert.equal(f.ctx.config.operations.activityCheck.weeklyChannelId, DESTINATION);
  saveDashboardSettings(
    f.ctx,
    { operations: { activityCheck: { weeklyChannelId: CUSTOM } } },
    ACTOR,
  );
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, f.filename);
  loadDashboardSettings(f.ctx);
  assert.equal(f.ctx.config.operations.activityCheck.weeklyChannelId, CUSTOM);
  saveDashboardSettings(
    f.ctx,
    { operations: { activityCheck: { weeklyChannelId: f.source.id } } },
    ACTOR,
  );
  loadDashboardSettings(f.ctx);
  assert.equal(f.ctx.config.operations.activityCheck.weeklyChannelId, f.source.id);
});

test('een al gekozen eigen weekcheckkanaal wordt bij de kanaalmigratie behouden', (t) => {
  const f = fixture(t);
  oldWeeklyConfiguration(f, CUSTOM);
  loadDashboardSettings(f.ctx);
  assert.equal(f.ctx.config.operations.activityCheck.weeklyChannelId, CUSTOM);
  assert.ok(f.ctx.store.setting('activitycheck:weekly-channel:2'));
});

test('verplaatsen bewaart de bestaande weekcheck en bevestigingen, herstelt gemiste vinkjes en publiceert vóór wisselen en verwijderen', async (t) => {
  const f = fixture(t);
  const { check, posted } = await createActivityCheck(
    f.ctx,
    f.guild,
    f.lead,
    {
      date: '23-10-2026',
      time: '07:30',
      reason: 'Wekelijkse activiteitencheck',
      channelId: f.source.id,
    },
    NOW,
  );
  f.ctx.store.db
    .prepare('INSERT INTO activity_check_occurrences(deadline_date,check_id) VALUES(?,?)')
    .run('2026-10-23', check.id);
  await respondActivityCheck(
    f.ctx,
    f.guild,
    f.guild.members.cache.get(OTHER),
    check.id,
    { channelId: f.source.id, messageId: posted.id },
    NOW + 1000,
  );
  posted.reactions.cache.get('✅').users.cache.set(SECOND, f.guild.members.cache.get(SECOND).user);
  const originalMembers = f.ctx.store.db
    .prepare('SELECT user_id FROM activity_check_members WHERE check_id=? ORDER BY user_id')
    .all(check.id);
  const send = f.target.send,
    remove = posted.delete;
  let sends = 0,
    deletions = 0;
  f.target.send = async (payload) => {
    sends++;
    const bound = f.record(check.id);
    assert.equal(bound.channel_id, f.source.id);
    assert.equal(bound.message_id, posted.id);
    assert.ok(f.source.posted.has(posted.id));
    return send(payload);
  };
  posted.delete = async () => {
    deletions++;
    const bound = f.record(check.id);
    assert.equal(bound.channel_id, DESTINATION);
    assert.ok(f.target.posted.has(bound.message_id));
    return remove();
  };
  await moveActivityCheck(f.ctx, f.guild, check.id, DESTINATION, NOW + 2000);
  const moved = f.record(check.id),
    replacement = f.target.posted.get(moved.message_id);
  for (const key of [
    'id',
    'creator_id',
    'deadline_at',
    'created_at',
    'published_at',
    'reason',
    'status',
  ])
    assert.equal(moved[key], check[key], key);
  assert.equal(moved.deadline_at, FIRST);
  assert.equal(moved.channel_id, DESTINATION);
  assert.notEqual(moved.message_id, posted.id);
  assert.deepEqual(
    f.ctx.store.db
      .prepare('SELECT user_id FROM activity_check_members WHERE check_id=? ORDER BY user_id')
      .all(check.id),
    originalMembers,
  );
  assert.equal(
    f.ctx.store.db
      .prepare('SELECT check_id FROM activity_check_occurrences WHERE deadline_date=?')
      .get('2026-10-23').check_id,
    check.id,
  );
  const saved = f.ctx.store.db
    .prepare('SELECT * FROM activity_check_members WHERE check_id=? AND user_id=?')
    .get(check.id, OTHER);
  assert.equal(saved.status, 'responded');
  assert.equal(saved.responded_at, NOW + 1000);
  const recovered = f.ctx.store.db
    .prepare('SELECT * FROM activity_check_members WHERE check_id=? AND user_id=?')
    .get(check.id, SECOND);
  assert.equal(recovered.status, 'responded');
  assert.ok(recovered.responded_at !== null);
  assert.ok(replacement.reactions.cache.get('✅').me);
  assert.match(replacement.embeds[0].description, /Wekelijkse activiteitencheck/);
  assert.equal(f.source.posted.has(posted.id), false);
  assert.equal(sends, 1);
  assert.equal(deletions, 1);
  await moveActivityCheck(f.ctx, f.guild, check.id, DESTINATION, NOW + 3000);
  assert.equal(f.target.posted.size, 1);
  assert.equal(f.record(check.id).message_id, replacement.id);
  assert.equal(sends, 1);
  assert.equal(deletions, 1);
  assert.equal(
    f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_sessions').get().n,
    1,
  );
});

test('ontbrekende doelkanaalrechten laten het oorspronkelijke checkbericht en de koppeling intact', async (t) => {
  const f = fixture(t),
    { check, posted } = await createActivityCheck(
      f.ctx,
      f.guild,
      f.lead,
      {
        date: '23-10-2026',
        time: '07:30',
        reason: 'Wekelijkse activiteitencheck',
        channelId: f.source.id,
      },
      NOW,
    );
  const permissions = f.target.permissionsFor;
  f.target.permissionsFor = (member) =>
    member.id === f.guild.members.me.id
      ? new PermissionsBitField([
          P.ViewChannel,
          P.SendMessages,
          P.ReadMessageHistory,
          P.AddReactions,
          P.ManageMessages,
        ])
      : permissions(member);
  await assert.rejects(moveActivityCheck(f.ctx, f.guild, check.id, DESTINATION, NOW + 1000));
  const saved = f.record(check.id);
  assert.equal(saved.channel_id, f.source.id);
  assert.equal(saved.message_id, posted.id);
  assert.equal(saved.status, 'open');
  assert.ok(f.source.posted.has(posted.id));
  assert.equal(f.target.posted.size, 0);
});

test('een verloren verzendbevestiging herstelt het geplaatste doelbericht via de footer na een herstart zonder tweede bericht', async (t) => {
  const f = fixture(t, true),
    { check, posted } = await createActivityCheck(
      f.ctx,
      f.guild,
      f.lead,
      {
        date: '23-10-2026',
        time: '07:30',
        reason: 'Wekelijkse activiteitencheck',
        channelId: f.source.id,
      },
      NOW,
    );
  const send = f.target.send;
  let sends = 0;
  f.target.send = async (payload) => {
    sends++;
    await send(payload);
    throw Object.assign(new Error('Verzendbevestiging verloren'), { code: 'ETIMEDOUT' });
  };
  await assert.rejects(
    moveActivityCheck(f.ctx, f.guild, check.id, DESTINATION, NOW + 1000),
    /Verzendbevestiging verloren/,
  );
  assert.equal(f.target.posted.size, 1);
  const replacement = f.target.posted.first();
  assert.equal(f.record(check.id).channel_id, f.source.id);
  assert.equal(f.record(check.id).message_id, posted.id);
  assert.ok(f.source.posted.has(posted.id));
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, f.filename);
  await moveActivityCheck(f.ctx, f.guild, check.id, DESTINATION, NOW + 2000);
  assert.equal(sends, 1);
  assert.equal(f.target.posted.size, 1);
  assert.equal(f.record(check.id).message_id, replacement.id);
  assert.equal(f.record(check.id).channel_id, DESTINATION);
  assert.ok(replacement.reactions.cache.get('✅').me);
  assert.equal(f.source.posted.has(posted.id), false);
});

test('tijdelijk mislukte verwijdering wordt bewaard en na herstart herhaald zonder opnieuw te posten', async (t) => {
  const f = fixture(t, true),
    { check, posted } = await createActivityCheck(
      f.ctx,
      f.guild,
      f.lead,
      {
        date: '23-10-2026',
        time: '07:30',
        reason: 'Wekelijkse activiteitencheck',
        channelId: f.source.id,
      },
      NOW,
    );
  const remove = posted.delete;
  let attempts = 0;
  posted.delete = async () => {
    attempts++;
    if (attempts === 1)
      throw Object.assign(new Error('Discord tijdelijk onbereikbaar'), { code: 503 });
    return remove();
  };
  await moveActivityCheck(f.ctx, f.guild, check.id, DESTINATION, NOW + 1000);
  const replacementId = f.record(check.id).message_id;
  assert.equal(f.record(check.id).channel_id, DESTINATION);
  assert.ok(f.target.posted.has(replacementId));
  assert.ok(f.source.posted.has(posted.id));
  assert.equal(attempts, 1);
  assert.equal(
    f.ctx.store.db
      .prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'activitycheck:move-cleanup:%'")
      .get().n,
    1,
  );
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, f.filename);
  await cleanupMovedActivityChecks(f.ctx, f.guild, NOW + 61001);
  assert.equal(attempts, 2);
  assert.equal(f.source.posted.has(posted.id), false);
  assert.equal(f.target.posted.size, 1);
  assert.equal(f.record(check.id).message_id, replacementId);
  assert.equal(
    f.ctx.store.db
      .prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'activitycheck:move-cleanup:%'")
      .get().n,
    0,
  );
  await cleanupMovedActivityChecks(f.ctx, f.guild, NOW + 62000);
  assert.equal(attempts, 2);
  assert.equal(f.target.posted.size, 1);
});

test('een bestaande weekclaim verhindert de kanaalverplaatsing door de weekplanner niet', async (t) => {
  const f = fixture(t),
    { check, posted } = await createActivityCheck(
      f.ctx,
      f.guild,
      f.lead,
      {
        date: '23-10-2026',
        time: '07:30',
        reason: 'Wekelijkse activiteitencheck',
        channelId: f.source.id,
      },
      NOW,
    );
  f.ctx.store.db
    .prepare('INSERT INTO activity_check_occurrences(deadline_date,check_id) VALUES(?,?)')
    .run('2026-10-23', check.id);
  await respondActivityCheck(
    f.ctx,
    f.guild,
    f.guild.members.cache.get(OTHER),
    check.id,
    { channelId: f.source.id, messageId: posted.id },
    NOW + 1000,
  );
  oldWeeklyConfiguration(f);
  loadDashboardSettings(f.ctx);
  await syncWeeklyActivityCheck(f.ctx, f.guild, NOW + 2000);
  await syncWeeklyActivityCheck(f.ctx, f.guild, NOW + 3000);
  assert.equal(f.record(check.id).channel_id, DESTINATION);
  assert.equal(f.record(check.id).deadline_at, FIRST);
  assert.equal(
    f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_sessions').get().n,
    1,
  );
  assert.equal(
    f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_occurrences').get().n,
    1,
  );
  assert.equal(
    f.ctx.store.db.prepare('SELECT check_id FROM activity_check_occurrences').get().check_id,
    check.id,
  );
  assert.equal(
    f.ctx.store.db
      .prepare('SELECT responded_at FROM activity_check_members WHERE check_id=? AND user_id=?')
      .get(check.id, OTHER).responded_at,
    NOW + 1000,
  );
  assert.equal(f.source.posted.has(posted.id), false);
  assert.equal(f.target.posted.size, 1);
});

test('een vertraagd vinkjesevent van het verwijderde bronbericht bevestigt het lid op dezelfde verplaatste check', async (t) => {
  const f = fixture(t),
    { check, posted } = await createActivityCheck(
      f.ctx,
      f.guild,
      f.lead,
      {
        date: '23-10-2026',
        time: '07:30',
        reason: 'Wekelijkse activiteitencheck',
        channelId: f.source.id,
      },
      NOW,
    );
  const originalReaction = posted.reactions.cache.get('✅'),
    user = f.guild.members.cache.get(OTHER).user;
  await moveActivityCheck(f.ctx, f.guild, check.id, DESTINATION, NOW + 1000);
  const moved = f.record(check.id),
    replacementId = moved.message_id;
  assert.equal(f.source.posted.has(posted.id), false);
  assert.equal(
    f.ctx.store.setting(`activitycheck:moved-from:${f.source.id}:${posted.id}`),
    check.id,
  );
  assert.equal(
    f.ctx.store.db
      .prepare('SELECT responded_at FROM activity_check_members WHERE check_id=? AND user_id=?')
      .get(check.id, OTHER).responded_at,
    null,
  );
  originalReaction.users.cache.set(OTHER, user);
  await handleActivityCheckReaction(f.ctx, originalReaction, user, true, NOW + 2000);
  const entry = f.ctx.store.db
    .prepare('SELECT * FROM activity_check_members WHERE check_id=? AND user_id=?')
    .get(check.id, OTHER);
  assert.equal(entry.status, 'responded');
  assert.equal(entry.responded_at, NOW + 2000);
  assert.equal(f.record(check.id).channel_id, DESTINATION);
  assert.equal(f.record(check.id).message_id, replacementId);
  assert.equal(f.target.posted.size, 1);
  assert.equal(f.source.posted.size, 0);
  assert.ok(
    f.target.posted
      .get(replacementId)
      .embeds[0].fields.some(
        (field) => field.name === '✅ Actief bevestigd' && field.value.includes(`<@${OTHER}>`),
      ),
  );
});
