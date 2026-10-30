import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { dashboardFixture, ACTOR, APPLICANT, OTHER } from './dashboard-fixture.js';
import {
  handleApplicationQueueLeadMessage,
  syncApplicationQueue,
} from '../src/modules/tickets/service.js';
import { Locks } from '../src/common/locks.js';

async function fixture(t) {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.source,
    guild = f.guilds.get(ctx.config.guildId),
    dossier = ctx.store.caseById(f.open.id),
    channel = guild.channels.cache.get(dossier.channel_id);
  const category = guild.makeChannel('100000000000000901', 'Sollicitatie Wachtrij');
  category.type = 4;
  ctx.store.setSetting('application-queue-category', category.id);
  const board = guild.makeChannel('1564738761026441316', 'wachtrij');
  board.parentId = category.id;
  channel.setParent = async (id) => {
    channel.parentId = id;
  };
  channel.permissionOverwrites.cache.set(APPLICANT, {
    allow: new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]),
    deny: new PermissionsBitField(),
  });
  channel.permissionOverwrites.edit = async (user, permissions) => {
    let overwrite = channel.permissionOverwrites.cache.get(user);
    if (!overwrite) {
      overwrite = { allow: new PermissionsBitField(), deny: new PermissionsBitField() };
      channel.permissionOverwrites.cache.set(user, overwrite);
    }
    for (const [key, value] of Object.entries(permissions)) {
      overwrite.allow.remove(P[key]);
      overwrite.deny.remove(P[key]);
      if (value === true) overwrite.allow.add(P[key]);
      if (value === false) overwrite.deny.add(P[key]);
    }
  };
  const lead = guild.members.cache.get(ACTOR);
  lead.permissions = new PermissionsBitField();
  ctx.store.markApplicationQueued(dossier.id, ACTOR);
  await syncApplicationQueue(ctx, guild);
  assert.equal(channel.permissionOverwrites.cache.get(APPLICANT).deny.has(P.SendMessages), true);
  const message = (user = ACTOR, extra = {}) => ({
    guild,
    guildId: guild.id,
    channelId: channel.id,
    channel,
    author: { id: user, bot: false },
    member: guild.members.cache.get(user),
    content: 'Kun je je motivatie verder toelichten?',
    attachments: new Collection(),
    ...extra,
  });
  return { ...f, ctx, guild, dossier, channel, message };
}

test('een gewoon Leadbericht opent alleen antwoorden voor de sollicitant en onderhoud vergrendelt het ticket niet opnieuw', async (t) => {
  const f = await fixture(t),
    send = f.channel.send;
  let noticePayload;
  f.channel.send = async (payload) => {
    noticePayload = payload;
    return send(payload);
  };
  assert.equal(await handleApplicationQueueLeadMessage(f.ctx, f.message()), true);
  const saved = f.ctx.store.caseById(f.dossier.id),
    overwrite = f.channel.permissionOverwrites.cache.get(APPLICANT);
  assert.equal(overwrite.allow.has(P.SendMessages), true);
  assert.equal(overwrite.deny.has(P.CreatePrivateThreads), true);
  assert.equal(saved.payload.queueReplyFor, saved.payload.queueAt);
  assert.equal(saved.payload.queueReplyOpenedBy, ACTOR);
  assert.equal(saved.payload.queueStatus, 'queued');
  assert.equal(saved.payload.queueReplyNoticeFor, saved.payload.queueAt);
  assert.ok(saved.payload.queueReplyNoticeId);
  assert.deepEqual(noticePayload.allowedMentions, {
    parse: [],
    users: [APPLICANT],
    repliedUser: false,
  });
  assert.match(noticePayload.content, /De leiding heeft gereageerd.*weer antwoorden/);
  assert.equal(f.channel.name, 'wachtrij-kai-mercier');
  await syncApplicationQueue({ ...f.ctx }, f.guild);
  assert.equal(f.channel.permissionOverwrites.cache.get(APPLICANT).allow.has(P.SendMessages), true);
  await handleApplicationQueueLeadMessage(f.ctx, f.message());
  assert.equal(
    f.ctx.store.db
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE event='application.queue_replies_opened'")
      .get().n,
    1,
  );
  assert.equal(
    [...f.channel.posted.values()].filter((item) =>
      item.content.includes('De leiding heeft gereageerd.'),
    ).length,
    1,
  );
});

test('sollicitant, gewone leden, botmeldingen en berichten in een ander dossier openen de wachtrij niet', async (t) => {
  const f = await fixture(t);
  for (const message of [
    f.message(APPLICANT),
    f.message(OTHER),
    f.message(ACTOR, { author: { id: ACTOR, bot: true } }),
    f.message(ACTOR, { webhookId: 'webhook' }),
    f.message(ACTOR, { content: '' }),
    f.message(ACTOR, { guild: { id: 'andere-server' } }),
    f.message(ACTOR, { channel: { ...f.channel, topic: 'ander dossier' } }),
  ])
    assert.equal(await handleApplicationQueueLeadMessage(f.ctx, message), false);
  assert.equal(f.ctx.store.caseById(f.dossier.id).payload.queueReplyFor, undefined);
  assert.equal(f.channel.permissionOverwrites.cache.get(APPLICANT).deny.has(P.SendMessages), true);
});

test('een mislukte rechtenwijziging wordt door de normale wachtrijsynchronisatie hersteld', async (t) => {
  const f = await fixture(t),
    edit = f.channel.permissionOverwrites.edit;
  f.channel.permissionOverwrites.edit = async () => {
    throw Object.assign(new Error('tijdelijke fout'), { code: 50013 });
  };
  await assert.rejects(handleApplicationQueueLeadMessage(f.ctx, f.message()), /tijdelijke fout/);
  f.channel.permissionOverwrites.edit = edit;
  await syncApplicationQueue(f.ctx, f.guild);
  assert.equal(f.channel.permissionOverwrites.cache.get(APPLICANT).allow.has(P.SendMessages), true);
});

test('opnieuw in de wachtrij zetten vergrendelt weer, en een gesloten sollicitatie wordt niet geopend', async (t) => {
  const f = await fixture(t);
  await handleApplicationQueueLeadMessage(f.ctx, f.message());
  const payload = { ...f.ctx.store.caseById(f.dossier.id).payload, queueStatus: 'released' };
  f.ctx.store.db
    .prepare('UPDATE cases SET payload=? WHERE id=?')
    .run(JSON.stringify(payload), f.dossier.id);
  f.ctx.store.markApplicationQueued(f.dossier.id, ACTOR);
  await syncApplicationQueue(f.ctx, f.guild);
  assert.equal(f.ctx.store.caseById(f.dossier.id).payload.queueReplyFor, undefined);
  assert.equal(f.channel.permissionOverwrites.cache.get(APPLICANT).deny.has(P.SendMessages), true);
  f.ctx.store.closeCase(f.dossier.id, 'closed', APPLICANT);
  assert.equal(await handleApplicationQueueLeadMessage(f.ctx, f.message()), false);
  assert.equal(f.channel.permissionOverwrites.cache.get(APPLICANT).deny.has(P.SendMessages), true);
});

test('een Leadbericht tijdens een lopende dossieractie wacht tot die is afgerond in plaats van verloren te gaan', async (t) => {
  const f = await fixture(t),
    locks = new Locks();
  let release;
  const processing = locks.run(
    f.dossier.id,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const answer = locks.run(
    f.dossier.id,
    () => handleApplicationQueueLeadMessage(f.ctx, f.message()),
    { wait: true },
  );
  await assert.rejects(
    locks.run(f.dossier.id, () => {}),
    /al verwerkt/,
  );
  assert.equal(f.channel.permissionOverwrites.cache.get(APPLICANT).deny.has(P.SendMessages), true);
  release();
  await processing;
  assert.equal(await answer, true);
  assert.equal(f.channel.permissionOverwrites.cache.get(APPLICANT).allow.has(P.SendMessages), true);
});

test('een mislukte ticketmelding wordt bij onderhoud opnieuw geprobeerd zonder het typen te blokkeren', async (t) => {
  const f = await fixture(t),
    send = f.channel.send;
  f.channel.send = async () => {
    throw new Error('Versturen tijdelijk mislukt');
  };
  await assert.rejects(
    handleApplicationQueueLeadMessage(f.ctx, f.message()),
    /Versturen tijdelijk mislukt/,
  );
  assert.equal(f.channel.permissionOverwrites.cache.get(APPLICANT).allow.has(P.SendMessages), true);
  assert.equal(f.ctx.store.caseById(f.dossier.id).payload.queueReplyNoticeFor, undefined);
  f.channel.send = send;
  await syncApplicationQueue(f.ctx, f.guild);
  await syncApplicationQueue(f.ctx, f.guild);
  assert.equal(
    [...f.channel.posted.values()].filter((item) =>
      item.content.includes('De leiding heeft gereageerd.'),
    ).length,
    1,
  );
  assert.ok(f.ctx.store.caseById(f.dossier.id).payload.queueReplyNoticeId);
});

test('een reeds verstuurde melding wordt na een opslagfout teruggevonden in plaats van dubbel geplaatst', async (t) => {
  const f = await fixture(t),
    mark = f.ctx.store.markApplicationQueueReplyNoticeSent.bind(f.ctx.store);
  f.ctx.store.markApplicationQueueReplyNoticeSent = () => {
    throw new Error('Opslag tijdelijk mislukt');
  };
  await assert.rejects(
    handleApplicationQueueLeadMessage(f.ctx, f.message()),
    /Opslag tijdelijk mislukt/,
  );
  const posted = [...f.channel.posted.values()].find((item) =>
    item.content.includes('De leiding heeft gereageerd.'),
  );
  assert.ok(posted);
  f.ctx.store.markApplicationQueueReplyNoticeSent = mark;
  await syncApplicationQueue(f.ctx, f.guild);
  assert.equal(
    [...f.channel.posted.values()].filter((item) =>
      item.content.includes('De leiding heeft gereageerd.'),
    ).length,
    1,
  );
  assert.equal(f.ctx.store.caseById(f.dossier.id).payload.queueReplyNoticeId, posted.id);
});
