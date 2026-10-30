import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, MessageFlags } from 'discord.js';
import { dashboardFixture, ACTOR, OTHER } from './dashboard-fixture.js';
import {
  monthlyReport,
  monthWindow,
  monthId,
  monthlyReportMessage,
  syncMonthlyReports,
  handleMonthlyReport,
} from '../src/modules/reports/monthly.js';
import {
  saveDashboardSettings,
  loadDashboardSettings,
  validateDashboardSettings,
} from '../src/dashboard/settings.js';
import { commands } from '../src/commands/definitions.js';
import { Dashboard } from '../src/dashboard/server.js';
import { Locks } from '../src/common/locks.js';
import { createTranscriptServer } from '../src/modules/transcripts/server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/data/store.js';
const NOW = Date.parse('2026-10-17T10:00:00Z'),
  DUE = Date.parse('2026-11-01T08:00:00Z');
function fixture(t) {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.contexts.values().next().value,
    guild = f.guilds.get(ctx.config.guildId);
  return { ...f, ctx, guild, db: ctx.store.db };
}
function activity(f, id, at, status = 'open') {
  f.db
    .prepare(
      'INSERT INTO activities(id,title,description,location,starts_at,ends_at,creator_id,channel_id,status) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(id, id, '', 'HQ', at, at + 3600000, ACTOR, f.ctx.config.planningChannelId, status);
}
test('maandgrenzen gebruiken Belgische tijd, inclusief wintertijd en de jaarwisseling', () => {
  const october = monthWindow('2026-10');
  assert.equal(new Date(october.start).toISOString(), '2026-09-30T22:00:00.000Z');
  assert.equal(new Date(october.end).toISOString(), '2026-10-31T23:00:00.000Z');
  assert.equal((october.end - october.start) / 3600000, 745);
  assert.equal(monthId(october.start), '2026-10');
  assert.equal(monthWindow('2026-12').end, Date.parse('2026-12-31T23:00:00Z'));
  assert.throws(() => monthWindow('2026-13'));
  assert.throws(() => monthWindow('../data'));
});
test('rapport telt registraties per maand, sluit geannuleerde reacties en teruggedraaide betalingen uit en verandert geen gegevens', (t) => {
  const f = fixture(t),
    { start, end } = monthWindow('2026-10');
  activity(f, 'before', start - 1);
  activity(f, 'inside', start);
  activity(f, 'last', end - 1);
  activity(f, 'after', end);
  activity(f, 'cancelled', NOW, 'cancelled');
  for (const [id, response] of [
    ['before', 'yes'],
    ['inside', 'yes'],
    ['last', 'late'],
    ['after', 'yes'],
    ['cancelled', 'no'],
  ])
    f.db.prepare('INSERT INTO activity_rsvps VALUES(?,?,?,?)').run(id, OTHER, response, NOW);
  f.db
    .prepare(
      'INSERT INTO promotions(id,member_id,role_id,proposer_id,reason,created_at,status,closed_at,channel_id) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'promoted',
      OTHER,
      f.ctx.config.roster.roleIds[1],
      ACTOR,
      'Goed werk',
      start - 1,
      'approved',
      NOW,
      f.ctx.config.logChannelId,
    );
  f.db
    .prepare(
      'INSERT INTO promotions(id,member_id,role_id,proposer_id,reason,created_at,status,closed_at,channel_id) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'rejected',
      ACTOR,
      f.ctx.config.roster.roleIds[1],
      ACTOR,
      'Voorstel',
      NOW,
      'rejected',
      NOW,
      f.ctx.config.logChannelId,
    );
  for (const [id, kind, amount, at, voided] of [
    ['payment', 'payment', 25000, start, 0],
    ['late', 'payment', 10000, end - 1, 0],
    ['old', 'payment', 1000, start - 1, 0],
    ['new', 'payment', 1000, end, 0],
    ['void', 'payment', 99000, NOW, 1],
    ['donation', 'donation', 5000, NOW, 0],
    ['expense', 'expense', 3000, NOW, 0],
  ]) {
    f.db
      .prepare(
        'INSERT INTO gangpot_entries(id,request_id,kind,user_id,amount,actor_id,paid_at,created_at,voided_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(id, id, kind, OTHER, amount, ACTOR, at, NOW, voided ? NOW : null);
  }
  f.db
    .prepare(
      "INSERT INTO absence_requests(id,user_id,kind,start_date,end_date,reason,status,created_at,channel_id) VALUES(?,?,'range',?,?,'Privé','approved',?,?)",
    )
    .run('away', OTHER, '2026-10-15', '2026-10-20', NOW, f.ctx.config.logChannelId);
  const report = monthlyReport(f.ctx, '2026-10', DUE);
  assert.equal(report.activities.total, 3);
  assert.equal(report.activities.cancelled, 1);
  assert.deepEqual(report.attendance, { yes: 1, late: 1, no: 0, maybe: 0, approvedAway: 1 });
  assert.deepEqual(report.promotions, { proposed: 1, approved: 1, rejected: 1 });
  assert.deepEqual(report.gangpot, {
    payments: 35000,
    donations: 5000,
    expenses: 3000,
    net: 37000,
    contributors: 1,
  });
  assert.equal(report.members.find((item) => item.id === OTHER).contribution, 35000);
  assert.equal(report.partial, false);
  assert.doesNotMatch(JSON.stringify(report), /Privé|Goed werk/);
  assert.equal(monthlyReport(f.ctx, '2026-10', NOW).partial, true);
  assert.throws(() => monthlyReport(f.ctx, '2026-11', NOW), /huidige maand/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM gangpot_entries').get().n, 7);
  monthlyReportMessage(f.ctx, report).embeds[0].toJSON();
});
test('check-ins tellen bevestigingen, vrijstellingen en warns zonder geannuleerde checks mee te rekenen', (t) => {
  const f = fixture(t);
  for (const [id, status] of [
    ['closed', 'closed'],
    ['cancelled', 'cancelled'],
    ['pending', 'open'],
  ])
    f.db
      .prepare(
        'INSERT INTO activity_check_sessions(id,creator_id,channel_id,created_at,deadline_at,status) VALUES(?,?,?,?,?,?)',
      )
      .run(id, ACTOR, f.ctx.config.planningChannelId, NOW, NOW + 1000, status);
  for (const [check, user, status] of [
    ['closed', OTHER, 'responded'],
    ['closed', ACTOR, 'exempt'],
    ['closed', 'warned-user', 'warned'],
    ['cancelled', OTHER, 'responded'],
    ['pending', OTHER, 'pending'],
  ])
    f.db
      .prepare('INSERT INTO activity_check_members(check_id,user_id,status) VALUES(?,?,?)')
      .run(check, user, status);
  assert.deepEqual(monthlyReport(f.ctx, '2026-10', DUE).checkins, {
    total: 3,
    cancelled: 1,
    closed: 1,
    confirmed: 1,
    exempt: 1,
    warned: 1,
    pending: 1,
  });
});
test('automatische rapportage begint vanaf installatie en verstuurt na de maandgrens precies eenmaal, ook bij herhaalde of gelijktijdige rondes', async (t) => {
  const f = fixture(t),
    channel = f.guild.channels.cache.get(f.ctx.config.logChannelId);
  await syncMonthlyReports(f.ctx, f.guild, NOW);
  assert.equal(channel.posted.size, 0);
  assert.equal(f.ctx.store.setting('monthly:starts'), '2026-10');
  await syncMonthlyReports(f.ctx, f.guild, DUE - 1);
  assert.equal(channel.posted.size, 0);
  await Promise.all([
    syncMonthlyReports(f.ctx, f.guild, DUE),
    syncMonthlyReports(f.ctx, f.guild, DUE),
  ]);
  assert.equal(channel.posted.size, 1);
  const job = f.db.prepare('SELECT * FROM monthly_reports').get();
  assert.equal(job.month, '2026-10');
  assert.equal(job.sent_at, DUE);
  await syncMonthlyReports({ ...f.ctx }, f.guild, DUE + 86400000);
  assert.equal(channel.posted.size, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM monthly_reports').get().n, 1);
});
test('rapport herstelt een verstuurd bericht na een verloren bevestiging zonder dubbel bericht; momentopname blijft gelijk', async (t) => {
  const f = fixture(t),
    channel = f.guild.channels.cache.get(f.ctx.config.logChannelId),
    send = channel.send;
  f.ctx.store.setSetting('monthly:starts', '2026-10');
  channel.send = async (payload) => {
    await send(payload);
    throw new Error('ACK_LOST');
  };
  await syncMonthlyReports(f.ctx, f.guild, DUE);
  assert.equal(channel.posted.size, 1);
  const before = f.db.prepare('SELECT payload FROM monthly_reports').get().payload;
  channel.send = send;
  activity(f, 'later-data', NOW);
  await syncMonthlyReports(f.ctx, f.guild, DUE + 60001);
  assert.equal(channel.posted.size, 1);
  assert.ok(f.db.prepare('SELECT message_id FROM monthly_reports').get().message_id);
  assert.equal(f.db.prepare('SELECT payload FROM monthly_reports').get().payload, before);
});
test('verzending kan worden uitgezet, tijd blijft instelbaar en gemiste maanden worden begrensd ingehaald', async (t) => {
  const f = fixture(t),
    channel = f.guild.channels.cache.get(f.ctx.config.logChannelId);
  f.ctx.store.setSetting('monthly:starts', '2026-08');
  saveDashboardSettings(
    f.ctx,
    { operations: { monthlyReports: { enabled: false, sendTime: '10:30' } } },
    ACTOR,
  );
  await syncMonthlyReports(f.ctx, f.guild, DUE);
  assert.equal(channel.posted.size, 0);
  saveDashboardSettings(f.ctx, { operations: { monthlyReports: { enabled: true } } }, ACTOR);
  await syncMonthlyReports(f.ctx, f.guild, DUE);
  assert.equal(channel.posted.size, 2);
  await syncMonthlyReports(f.ctx, f.guild, DUE + 60000);
  assert.equal(channel.posted.size, 2);
  await syncMonthlyReports(f.ctx, f.guild, DUE + 90 * 60000);
  assert.equal(channel.posted.size, 3);
  assert.throws(() =>
    validateDashboardSettings({ operations: { monthlyReports: { sendTime: '25:00' } } }),
  );
  const restored = { ...f.ctx, config: { ...f.ctx.config, operations: undefined } };
  loadDashboardSettings(restored);
  assert.equal(restored.config.operations.monthlyReports.sendTime, '10:30');
});
test('automatische maandrapporten lekken niet naar een openbaar kanaal en herstellen na terugzetten naar privé', async (t) => {
  const f = fixture(t);
  f.ctx.store.setSetting('monthly:starts', '2026-10');
  const unsafe = f.guild.channels.cache.get(f.ctx.config.planningChannelId),
    permissions = unsafe.permissionsFor;
  unsafe.permissionsFor = () => new PermissionsBitField(8n);
  f.ctx.config.monthlyReportChannelId = unsafe.id;
  await syncMonthlyReports(f.ctx, f.guild, DUE);
  assert.equal(unsafe.posted.size, 0);
  assert.ok(f.db.prepare('SELECT last_error FROM monthly_reports').get().last_error);
  unsafe.permissionsFor = permissions;
  f.ctx.config.monthlyReportChannelId = f.ctx.config.logChannelId;
  await syncMonthlyReports(f.ctx, f.guild, DUE + 60001);
  assert.ok(f.db.prepare('SELECT message_id FROM monthly_reports').get().message_id);
});
test('commando en dashboard vereisen actuele leidingrechten en werken uitsluitend in de hoofdserver', async (t) => {
  const f = fixture(t);
  assert.ok(commands(500, false).some((item) => item.name === 'maandoverzicht'));
  assert.ok(!commands(500, true).some((item) => item.name === 'maandoverzicht'));
  const member = f.guild.members.cache.get(ACTOR);
  let payload, flags;
  await handleMonthlyReport(f.ctx, {
    member,
    memberPermissions: member.permissions,
    options: { getString: () => monthId() },
    deferReply: async (value) => {
      flags = value.flags;
    },
    editReply: async (value) => {
      payload = value;
    },
  });
  assert.equal(flags, MessageFlags.Ephemeral);
  assert.match(payload.embeds[0].data.title, /Maandoverzicht/);
  await assert.rejects(
    handleMonthlyReport(f.ctx, {
      member: f.guild.members.cache.get(OTHER),
      memberPermissions: new PermissionsBitField(0n),
    }),
    /leiding/,
  );
  const dashboard = new Dashboard({ client: f.client, contexts: f.contexts, locks: new Locks() }),
    server = await createTranscriptServer(f.contexts, 0, dashboard);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`,
    path = `/api/dashboard/guilds/${f.ctx.config.guildId}/monthly?month=2026-10`;
  assert.equal((await fetch(origin + path)).status, 401);
  const code = new URL(dashboard.issueLogin(ACTOR, f.ctx.config.guildId)).hash.slice(7),
    login = await fetch(origin + '/api/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://dashboard.test' },
      body: JSON.stringify({ code }),
    });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0],
    response = await fetch(origin + path, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).month, '2026-10');
  const community = await fetch(
    origin + `/api/dashboard/guilds/${f.source.config.guildId}/monthly?month=2026-10`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(community.status, 400);
  member.permissions = new PermissionsBitField(0n);
  member.roles.cache.clear();
  assert.equal((await fetch(origin + path, { headers: { Cookie: cookie } })).status, 403);
});
test('een herstart met dezelfde SQLite-database bewaart rapportagejobs, momentopnames en verzonden bericht-ID’s', async (t) => {
  const f = fixture(t),
    dir = mkdtempSync(join(tmpdir(), 'bakarov-monthly-restart-')),
    filename = join(dir, 'legacy.sqlite');
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, filename);
  t.after(() => rmSync(dir, { recursive: true, force: true })); // fixture closes the current store first
  await syncMonthlyReports(f.ctx, f.guild, NOW);
  await syncMonthlyReports(f.ctx, f.guild, DUE);
  const before = f.ctx.store.db.prepare('SELECT * FROM monthly_reports').get();
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, filename);
  await syncMonthlyReports(f.ctx, f.guild, DUE + 86400000);
  const after = f.ctx.store.db.prepare('SELECT * FROM monthly_reports').get();
  assert.equal(after.message_id, before.message_id);
  assert.equal(after.payload, before.payload);
  assert.equal(f.guild.channels.cache.get(f.ctx.config.logChannelId).posted.size, 1);
});
