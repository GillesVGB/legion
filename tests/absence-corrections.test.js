import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardFixture, ACTOR, OTHER } from './dashboard-fixture.js';
import {
  repairApprovedAbsenceWarnings,
  syncAbsenceCorrections,
} from '../src/modules/absence/corrections.js';
import { syncActivityWarnings } from '../src/modules/check-ins/index.js';
const APPROVAL = Date.parse('2026-10-12T12:00:00Z'),
  DEADLINE = Date.parse('2026-10-16T18:00:00Z'),
  WARN = DEADLINE + 1000,
  NOW = Date.parse('2026-10-17T10:00:00Z');
function fixture(t) {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.contexts.values().next().value,
    guild = f.guilds.get(ctx.config.guildId);
  return { ...f, ctx, guild, db: ctx.store.db };
}
function absence(f, id, options = {}) {
  const {
    user = OTHER,
    kind = 'range',
    activity = null,
    status = 'approved',
    start = '2026-10-12',
    end = '2026-10-19',
    approved = APPROVAL,
    weeks = ['2026-10-17'],
    created = APPROVAL - 1000,
  } = options;
  f.db
    .prepare(
      'INSERT INTO absence_requests(id,user_id,kind,activity_id,start_date,end_date,weeks,reason,status,created_at,reviewed_at,reviewer_id,channel_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      user,
      kind,
      activity,
      start,
      end,
      JSON.stringify(weeks),
      'Persoonlijke reden die niet in openbare logs hoort',
      status,
      created,
      approved,
      ACTOR,
      f.ctx.config.logChannelId,
    );
}
function checkWarn(f, id = 'check1', user = OTHER, actor = f.guild.members.me.id) {
  f.db
    .prepare(
      "INSERT INTO activity_check_sessions(id,creator_id,channel_id,created_at,deadline_at,status,checked_at) VALUES(?,?,?,?,?,'closed',?)",
    )
    .run(id, ACTOR, f.ctx.config.planningChannelId, APPROVAL, DEADLINE, WARN);
  const warning = f.ctx.store.addWarnInside(user, actor, 'Niet gereageerd', WARN);
  f.db
    .prepare(
      "INSERT INTO activity_check_members(check_id,user_id,status,warn_id) VALUES(?,?,'warned',?)",
    )
    .run(id, user, warning.id);
  f.db
    .prepare(
      'INSERT INTO activity_check_warnings(activity_id,user_id,warn_id,created_at) VALUES(?,?,?,?)',
    )
    .run(id, user, warning.id, WARN);
  return warning.id;
}
test('een vóór de warn goedgekeurde afwezigheid trekt uitsluitend de gekoppelde automatische check-in-warn in', async (t) => {
  const f = fixture(t);
  absence(f, 'approved');
  const id = checkWarn(f),
    manual = f.ctx.store.addWarn(OTHER, ACTOR, 'Handmatige warn voor iets anders');
  assert.deepEqual(repairApprovedAbsenceWarnings(f.ctx, f.guild, NOW), [id]);
  assert.equal(f.ctx.store.warnCount(OTHER), 1);
  assert.equal(
    f.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(manual.id).removed_at,
    null,
  );
  assert.equal(
    f.db.prepare('SELECT status FROM activity_check_members WHERE warn_id=?').get(id).status,
    'exempt',
  );
  assert.deepEqual(repairApprovedAbsenceWarnings(f.ctx, f.guild, NOW + 1000), []);
  await syncAbsenceCorrections(f.ctx, f.guild, NOW);
  await syncAbsenceCorrections(f.ctx, f.guild, NOW + 1000);
  await syncActivityWarnings(f.ctx, f.guild, NOW);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM absence_warn_corrections').get().n, 1);
  assert.equal(f.calls.filter((call) => call.method === 'dm' && call.user === OTHER).length, 1);
  const logs = f.guild.channels.cache.get(f.ctx.config.warnLogChannelId).posted;
  assert.equal(logs.size, 1);
  const card = [...logs.values()][0].embeds[0];
  assert.match(card.title, /ingetrokken/);
  assert.doesNotMatch(card.description, /Persoonlijke reden/);
});
test('pending, afgewezen, later goedgekeurde en niet-dekkende afmeldingen veroorzaken geen historische intrekking', (t) => {
  const f = fixture(t);
  const id = checkWarn(f);
  absence(f, 'pending', { status: 'pending' });
  absence(f, 'rejected', { status: 'rejected' });
  absence(f, 'late', { approved: WARN + 1 });
  absence(f, 'other-date', { start: '2026-11-01', end: '2026-11-05' });
  absence(f, 'planning-only', { kind: 'planning', activity: 'check1' });
  absence(f, 'unknown-approval', { approved: null });
  assert.deepEqual(repairApprovedAbsenceWarnings(f.ctx, f.guild, NOW), []);
  assert.equal(f.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(id).removed_at, null);
});
test('legacy planningwarn wordt alleen ingetrokken voor de juiste planning, nooit voor een handmatig gekoppelde staffwarn', (t) => {
  const f = fixture(t);
  f.db
    .prepare(
      'INSERT INTO activities(id,title,description,location,starts_at,ends_at,creator_id,channel_id) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      'old-planning',
      'Oude activiteit',
      '',
      'HQ',
      DEADLINE,
      DEADLINE + 3600000,
      ACTOR,
      f.ctx.config.planningChannelId,
    );
  const warning = f.ctx.store.addWarnInside(
    OTHER,
    f.guild.members.me.id,
    'Oude automatische planningwarn',
    WARN,
  );
  f.db
    .prepare(
      'INSERT INTO activity_check_warnings(activity_id,user_id,warn_id,created_at) VALUES(?,?,?,?)',
    )
    .run('old-planning', OTHER, warning.id, WARN);
  absence(f, 'wrong-planning', { kind: 'planning', activity: 'other' });
  assert.deepEqual(repairApprovedAbsenceWarnings(f.ctx, f.guild, NOW), []);
  absence(f, 'right-planning', { kind: 'planning', activity: 'old-planning' });
  assert.deepEqual(repairApprovedAbsenceWarnings(f.ctx, f.guild, NOW), [warning.id]);
  const manual = checkWarn(f, 'manual-link', OTHER, ACTOR);
  assert.deepEqual(repairApprovedAbsenceWarnings(f.ctx, f.guild, NOW), []);
  assert.equal(
    f.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(manual).removed_at,
    null,
  );
});
test('ontbrekende gangpotvrijstelling wordt hersteld vanuit een eerdere goedkeuring; ingetrokken vrijstelling blijft ingetrokken', (t) => {
  const f = fixture(t),
    period = '2026-10-17',
    end = Date.parse('2026-10-17T22:00:00Z');
  f.db
    .prepare('INSERT INTO gangpot_periods(id,starts_at,ends_at,weekly_amount) VALUES(?,?,?,?)')
    .run(period, APPROVAL - 86400000, end, 25000);
  absence(f, 'range');
  absence(f, 'revoked-range', { user: ACTOR });
  f.db
    .prepare(
      'INSERT INTO gangpot_exemptions(id,user_id,period_id,request_id,actor_id,reason,created_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run('revoked', ACTOR, period, 'revoked-range', ACTOR, 'Teruggetrokken', APPROVAL, end);
  const ids = [];
  for (const user of [OTHER, ACTOR]) {
    const warning = f.ctx.store.addWarnInside(user, f.guild.members.me.id, 'Gangpot', end + 1000);
    ids.push(warning.id);
    f.db
      .prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at,warn_id) VALUES(?,?,?,?)')
      .run(period, user, APPROVAL, warning.id);
  }
  assert.deepEqual(repairApprovedAbsenceWarnings(f.ctx, f.guild, end + 10000), [ids[0]]);
  assert.equal(
    f.db.prepare('SELECT warn_cleared_by_payment FROM gangpot_dues WHERE user_id=?').get(OTHER)
      .warn_cleared_by_payment,
    1,
  );
  assert.equal(
    f.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(ids[1]).removed_at,
    null,
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS n FROM gangpot_exemptions WHERE user_id=?').get(ACTOR).n,
    1,
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM gangpot_entries').get().n, 0);
});
test('ontbrekende goedkeuringsdatum mag alleen met een bestaande goedkeuringsaudit worden aangevuld', (t) => {
  const f = fixture(t),
    id = checkWarn(f);
  absence(f, 'legacy', { approved: null });
  assert.deepEqual(repairApprovedAbsenceWarnings(f.ctx, f.guild, NOW), []);
  f.db
    .prepare('INSERT INTO audit(event,actor_id,details,created_at) VALUES(?,?,?,?)')
    .run('absence.approve', ACTOR, JSON.stringify({ id: 'legacy' }), APPROVAL);
  assert.deepEqual(repairApprovedAbsenceWarnings(f.ctx, f.guild, NOW), [id]);
});
test('correctielog herstelt een reeds verstuurd bericht na een fout zonder dubbele log of DM', async (t) => {
  const f = fixture(t);
  absence(f, 'approved');
  const id = checkWarn(f),
    channel = f.guild.channels.cache.get(f.ctx.config.warnLogChannelId),
    send = channel.send;
  channel.send = async (payload) => {
    await send(payload);
    throw new Error('ACK_LOST');
  };
  await syncAbsenceCorrections(f.ctx, f.guild, NOW);
  assert.equal(channel.posted.size, 1);
  assert.equal(f.ctx.store.warnCount(OTHER), 0);
  channel.send = send;
  await syncAbsenceCorrections(f.ctx, f.guild, NOW + 60001);
  assert.equal(channel.posted.size, 1);
  assert.equal(f.calls.filter((call) => call.method === 'dm' && call.user === OTHER).length, 1);
  assert.ok(
    f.db.prepare('SELECT log_id FROM absence_warn_corrections WHERE warn_id=?').get(id).log_id,
  );
});
test('een fout bij het vastleggen rolt de volledige correctie terug en raakt een eerder handmatig ingetrokken warn niet aan', (t) => {
  const f = fixture(t);
  absence(f, 'approved');
  const id = checkWarn(f);
  f.db.exec(
    "CREATE TRIGGER fail_correction BEFORE INSERT ON absence_warn_corrections BEGIN SELECT RAISE(ABORT,'TEST_ROLLBACK'); END",
  );
  assert.throws(() => repairApprovedAbsenceWarnings(f.ctx, f.guild, NOW), /TEST_ROLLBACK/);
  assert.equal(f.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(id).removed_at, null);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='absence.warn.corrected'")
      .get().n,
    0,
  );
  f.db.exec('DROP TRIGGER fail_correction');
  f.db
    .prepare('UPDATE warnings SET removed_at=?,removed_by=?,removed_reason=? WHERE id=?')
    .run(NOW - 1, ACTOR, 'Handmatig beoordeeld', id);
  assert.deepEqual(repairApprovedAbsenceWarnings(f.ctx, f.guild, NOW), []);
  assert.equal(
    f.db.prepare('SELECT removed_reason FROM warnings WHERE id=?').get(id).removed_reason,
    'Handmatig beoordeeld',
  );
});
