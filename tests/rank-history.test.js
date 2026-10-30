import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardFixture, ACTOR, APPLICANT } from './dashboard-fixture.js';
import {
  syncProbationStarts,
  syncProbationReviews,
  handleProbationButton,
  recordRankChange,
} from '../src/modules/members/rank-history.js';

test('rank changes are saved separately and include the approving Leads for /promotie', async (t) => {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.contexts.get(f.base.guilds[0].guildId),
    guild = f.guilds.get(ctx.config.guildId);
  const target = guild.members.cache.get(String(BigInt('100000000000000020') + 8n)),
    from = ctx.config.roster.roleIds[8],
    to = ctx.config.roster.roleIds[7];
  const before = { ...target, roles: { ...target.roles, cache: new Map(target.roles.cache) } };
  target.roles.cache.delete(from);
  target.roles.cache.set(to, guild.roles.cache.get(to));
  const now = Date.now();
  ctx.store.db
    .prepare(
      "INSERT INTO promotions(id,member_id,role_id,proposer_id,reason,created_at,status,channel_id) VALUES('historytest01',?,?,?,'goed werk',?,'approved','100000000000000300')",
    )
    .run(target.id, to, ACTOR, now);
  for (const [voter, response] of [
    [ACTOR, 'approve'],
    ['100000000000000080', 'approve'],
    ['100000000000000081', 'reject'],
  ])
    ctx.store.db
      .prepare(
        'INSERT INTO promotion_votes(proposal_id,voter_id,response,updated_at) VALUES(?,?,?,?)',
      )
      .run('historytest01', voter, response, now);
  await recordRankChange(ctx, before, target, now);
  const entry = ctx.store.db.prepare('SELECT * FROM rank_history WHERE member_id=?').get(target.id);
  assert.deepEqual(JSON.parse(entry.added_roles), [to]);
  assert.deepEqual(JSON.parse(entry.removed_roles), [from]);
  assert.equal(entry.source, 'promotie');
  assert.match(entry.actor_id, new RegExp(ACTOR));
  assert.equal(
    ctx.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='rank.change'").get().n,
    1,
  );
});

test('accepted applications start a 14-day probation and Lead can review or extend it', async (t) => {
  const f = dashboardFixture();
  t.after(f.close);
  const main = f.contexts.get(f.base.guilds[0].guildId),
    guild = f.guilds.get(main.config.guildId);
  const nonLead = guild.addMember(APPLICANT, 'Sollicitant', []);
  syncProbationStarts(f.contexts);
  const row = main.store.db
    .prepare('SELECT * FROM probation_reviews WHERE case_id=?')
    .get(f.closed.id);
  assert.ok(row);
  assert.equal(row.member_id, '100000000000000020');
  assert.equal(row.due_at - row.started_at, 14 * 24 * 60 * 60 * 1000);
  main.store.db
    .prepare('UPDATE probation_reviews SET due_at=?,review_due_sent_at=NULL WHERE case_id=?')
    .run(Date.now() - 1, row.case_id);
  await syncProbationReviews(main, guild, Date.now());
  const current = main.store.db
    .prepare('SELECT * FROM probation_reviews WHERE case_id=?')
    .get(row.case_id);
  const message = guild.channels.cache.get(current.channel_id).posted.get(current.message_id);
  assert.match(message.embeds[0].description, /Beoordeling vanaf/);
  assert.equal(message.components.length, 1);
  const lead = guild.members.cache.get(ACTOR);
  let updated;
  await handleProbationButton(
    main,
    {
      user: lead.user,
      member: lead,
      message,
      update: async (payload) => {
        updated = payload;
      },
    },
    'extended',
    row.case_id,
  );
  const extended = main.store.db
    .prepare('SELECT * FROM probation_reviews WHERE case_id=?')
    .get(row.case_id);
  assert.equal(extended.status, 'pending');
  assert.equal(extended.due_at - extended.reviewed_at, 14 * 24 * 60 * 60 * 1000);
  assert.equal(extended.review_due_sent_at, null);
  assert.deepEqual(updated.components, []);
  await assert.rejects(
    handleProbationButton(
      main,
      { user: nonLead.user, member: nonLead, message, update: async () => {} },
      'passed',
      row.case_id,
    ),
    /Lead-rol/,
  );
});
