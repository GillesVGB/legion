import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PermissionsBitField, MessageFlags } from 'discord.js';
import { dashboardFixture, ACTOR, OTHER } from './dashboard-fixture.js';
import {
  beginWarnAppeal,
  submitWarnAppeal,
  decideWarnAppeal,
  syncWarnAppeals,
  appealById,
  warnAppealMessage,
  handleWarnAppealButton,
  handleWarnAppealCommand,
} from '../src/modules/moderation/appeals.js';
import { warnAppealRow, warnAppealRows } from '../src/modules/moderation/appeal-ui.js';
import { Store } from '../src/data/store.js';
import { reconcileGangpotDebt } from '../src/modules/gangpot/index.js';
import { Dashboard } from '../src/dashboard/server.js';
import { Locks } from '../src/common/locks.js';
import { commands } from '../src/commands/definitions.js';
import { writeWarnLog } from '../src/modules/tickets/service.js';
const NOW = Date.parse('2026-10-17T12:00:00Z');
function fixture(t) {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.contexts.values().next().value,
    guild = f.guilds.get(ctx.config.guildId),
    lead = guild.members.cache.get(ACTOR);
  return {
    ...f,
    ctx,
    guild,
    lead,
    warning: (user = OTHER) => ctx.store.addWarn(user, ACTOR, 'Afspraak niet gevolgd'),
  };
}
test('alleen de eigenaar kan bezwaar maken; een klik maakt één concept en /bezwaar dient de uitleg eenmaal in', async (t) => {
  const f = fixture(t),
    warning = f.warning();
  await assert.rejects(beginWarnAppeal(f.ctx, f.guild, ACTOR, warning.id), /eigen gangwarn/);
  const draft = await beginWarnAppeal(f.ctx, f.guild, OTHER, warning.id, NOW);
  assert.equal(draft.status, 'draft');
  assert.equal((await beginWarnAppeal(f.ctx, f.guild, OTHER, warning.id, NOW)).id, draft.id);
  await syncWarnAppeals(f.ctx, f.guild, NOW);
  assert.equal(f.guild.channels.cache.get(f.ctx.config.logChannelId).posted.size, 0);
  const pending = await submitWarnAppeal(
    f.ctx,
    f.guild,
    OTHER,
    'Ik was al afgemeld.',
    undefined,
    NOW,
  );
  assert.equal(pending.id, draft.id);
  assert.equal(pending.status, 'pending');
  const again = await submitWarnAppeal(f.ctx, f.guild, OTHER, 'Andere tekst', warning.id, NOW);
  assert.equal(again.reason, 'Ik was al afgemeld.');
  await syncWarnAppeals(f.ctx, f.guild, NOW);
  assert.equal(f.guild.channels.cache.get(f.ctx.config.logChannelId).posted.size, 1);
  assert.ok(appealById(f.ctx, draft.id).message_id);
  assert.equal(f.ctx.store.warnCount(OTHER), 1);
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM warn_appeals').get().n, 1);
});
test('Lead keurt goed en trekt alleen de betreffende warn in; een gangpotronde herstelt die niet opnieuw', async (t) => {
  const f = fixture(t),
    warning = f.warning(),
    other = f.warning();
  f.ctx.store.db
    .prepare('INSERT INTO gangpot_periods(id,starts_at,ends_at,weekly_amount) VALUES(?,?,?,?)')
    .run('2026-10-17', NOW - 86400000, NOW + 1000, 25000);
  f.ctx.store.db
    .prepare(
      'INSERT INTO gangpot_dues(period_id,user_id,enrolled_at,warn_id,warn_cleared_by_payment) VALUES(?,?,?,?,1)',
    )
    .run('2026-10-17', OTHER, NOW - 86400000, warning.id);
  const appeal = await submitWarnAppeal(
    f.ctx,
    f.guild,
    OTHER,
    'De registratie klopt niet.',
    warning.id,
    NOW,
  );
  await syncWarnAppeals(f.ctx, f.guild, NOW);
  const result = await decideWarnAppeal(f.ctx, f.guild, f.lead, appeal.id, 'approve', NOW + 1000);
  assert.equal(result.status, 'approved');
  assert.equal(f.ctx.store.warnCount(OTHER), 1);
  reconcileGangpotDebt(f.ctx, '2026-10-17', OTHER, f.guild.members.me.id, NOW + 10000);
  assert.equal(f.ctx.store.warnCount(OTHER), 1);
  assert.equal(
    f.ctx.store.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(other.id).removed_at,
    null,
  );
  assert.equal(
    (await decideWarnAppeal(f.ctx, f.guild, f.lead, appeal.id, 'reject', NOW + 2000)).status,
    'approved',
  );
  await syncWarnAppeals(f.ctx, f.guild, NOW + 2000);
  await syncWarnAppeals(f.ctx, f.guild, NOW + 3000);
  assert.equal(f.calls.filter((call) => call.method === 'dm' && call.user === OTHER).length, 1);
  assert.equal(f.guild.channels.cache.get(f.ctx.config.logChannelId).posted.size, 1);
});
test('afwijzen laat de gangwarn actief en admins zonder Lead of een Lead voor het eigen bezwaar kunnen niet beslissen', async (t) => {
  const f = fixture(t),
    warning = f.warning(),
    appeal = await submitWarnAppeal(f.ctx, f.guild, OTHER, 'Mijn uitleg.', warning.id, NOW),
    admin = f.guild.addMember('100000000000000088', 'Admin', [], true);
  await assert.rejects(decideWarnAppeal(f.ctx, f.guild, admin, appeal.id, 'approve'), /Lead/);
  f.lead.roles.cache.clear();
  await assert.rejects(decideWarnAppeal(f.ctx, f.guild, f.lead, appeal.id, 'approve'), /Lead/);
  f.lead.roles.cache.set(
    f.ctx.config.staffRoleIds[0],
    f.guild.roles.cache.get(f.ctx.config.staffRoleIds[0]),
  );
  const own = f.warning(ACTOR),
    ownAppeal = await submitWarnAppeal(f.ctx, f.guild, ACTOR, 'Eigen bezwaar.', own.id, NOW);
  await assert.rejects(
    decideWarnAppeal(f.ctx, f.guild, f.lead, ownAppeal.id, 'approve'),
    /ander Lead/,
  );
  assert.equal(
    (await decideWarnAppeal(f.ctx, f.guild, f.lead, appeal.id, 'reject')).status,
    'rejected',
  );
  assert.equal(f.ctx.store.warnCount(OTHER), 1);
});
test('een inmiddels ingetrokken warn sluit het bezwaar zonder een tweede intrekking', async (t) => {
  const f = fixture(t),
    warning = f.warning(),
    appeal = await submitWarnAppeal(f.ctx, f.guild, OTHER, 'Was afgemeld.', warning.id, NOW);
  f.ctx.store.removeWarn(warning.id, ACTOR, 'Al gecorrigeerd');
  await syncWarnAppeals(f.ctx, f.guild, NOW);
  assert.equal(appealById(f.ctx, appeal.id).status, 'cancelled');
  assert.equal(f.ctx.store.warnCount(OTHER), 0);
  assert.equal(
    f.ctx.store.db.prepare('SELECT removed_reason FROM warnings WHERE id=?').get(warning.id)
      .removed_reason,
    'Al gecorrigeerd',
  );
  await assert.rejects(beginWarnAppeal(f.ctx, f.guild, OTHER, warning.id), /al ingetrokken/);
});
test('beoordelingsknoppen zijn aan kanaal en bericht gebonden; leden krijgen privé uitleg zonder formulier, ook vanuit DM', async (t) => {
  const f = fixture(t),
    warning = f.warning();
  let flags,
    response,
    form = false;
  const interaction = {
    customId: `warnappeal:start:${f.guild.id}:${warning.id}`,
    inGuild: () => true,
    guild: f.guild,
    guildId: f.guild.id,
    client: f.client,
    user: { id: OTHER },
    deferReply: async (value) => {
      flags = value.flags;
    },
    editReply: async (value) => {
      response = value;
    },
    showModal: async () => {
      form = true;
    },
  };
  await handleWarnAppealButton(f.ctx, interaction);
  assert.equal(flags, MessageFlags.Ephemeral);
  assert.match(response.content, /\/bezwaar uitleg:/);
  assert.equal(form, false);
  await handleWarnAppealButton(f.ctx, {
    ...interaction,
    inGuild: () => false,
    guild: undefined,
    guildId: undefined,
  });
  assert.equal(flags, undefined);
  const appeal = await submitWarnAppeal(f.ctx, f.guild, OTHER, 'Mijn uitleg.', warning.id, NOW);
  await syncWarnAppeals(f.ctx, f.guild, NOW);
  const saved = appealById(f.ctx, appeal.id);
  const decision = {
    ...interaction,
    customId: `warnappeal:approve:${appeal.id}`,
    member: f.lead,
    channelId: saved.channel_id,
    message: { id: 'copied' },
  };
  await assert.rejects(handleWarnAppealButton(f.ctx, decision), /knop hoort niet/);
  await handleWarnAppealButton(f.ctx, { ...decision, message: { id: saved.message_id } });
  assert.equal(f.ctx.store.warnCount(OTHER), 0);
});
test('bezwaar in de community of zonder uitleg wordt geweigerd en Lead-uitleg wordt niet openbaar geplaatst', async (t) => {
  const f = fixture(t),
    warning = f.warning();
  await assert.rejects(
    submitWarnAppeal(f.source, f.guilds.get(f.source.config.guildId), OTHER, 'Uitleg', warning.id),
    /hoofdserver/,
  );
  await assert.rejects(submitWarnAppeal(f.ctx, f.guild, OTHER, '', warning.id), /1 tot 1000/);
  await assert.rejects(
    submitWarnAppeal(f.ctx, f.guild, OTHER, 'x'.repeat(1001), warning.id),
    /1000/,
  );
  const publicChannel = f.guild.channels.cache.get(f.ctx.config.planningChannelId);
  publicChannel.permissionsFor = () => new PermissionsBitField(8n);
  f.ctx.config.logChannelId = publicChannel.id;
  await assert.rejects(
    submitWarnAppeal(f.ctx, f.guild, OTHER, 'Mijn privé-uitleg', warning.id),
    /privé/,
  );
  assert.equal(publicChannel.posted.size, 0);
});
test('een verloren berichtbevestiging, geblokkeerde DM en herhaalde rondes maken geen dubbele dossiers of meldingen', async (t) => {
  const f = fixture(t),
    warning = f.warning(),
    appeal = await submitWarnAppeal(f.ctx, f.guild, OTHER, 'Mijn uitleg.', warning.id, NOW),
    channel = f.guild.channels.cache.get(f.ctx.config.logChannelId),
    send = channel.send;
  channel.send = async (payload) => {
    await send(payload);
    throw new Error('ACK_LOST');
  };
  await syncWarnAppeals(f.ctx, f.guild, NOW);
  channel.send = send;
  await syncWarnAppeals(f.ctx, f.guild, NOW + 60001);
  assert.equal(channel.posted.size, 1);
  let dms = 0;
  f.guild.members.cache.get(OTHER).user.send = async () => {
    dms++;
    throw Object.assign(new Error('Geblokkeerd'), { code: 50007 });
  };
  await decideWarnAppeal(f.ctx, f.guild, f.lead, appeal.id, 'approve', NOW + 70000);
  await syncWarnAppeals(f.ctx, f.guild, NOW + 70000);
  await syncWarnAppeals(f.ctx, f.guild, NOW + 140000);
  assert.equal(dms, 1);
});
test('lange markdownuitleg blijft volledig binnen embedlimieten en knoppen voor oudere eigen warns zijn geldig', async (t) => {
  const f = fixture(t),
    warning = f.warning(),
    appeal = await submitWarnAppeal(f.ctx, f.guild, OTHER, '*'.repeat(1000), warning.id, NOW),
    card = warnAppealMessage(f.ctx, appeal).embeds[0].toJSON();
  assert.ok(card.fields.every((field) => field.value.length <= 1024));
  assert.equal(
    card.fields
      .slice(1)
      .map((field) => field.value)
      .join('')
      .replaceAll('\\', ''),
    '*'.repeat(1000),
  );
  const row = warnAppealRow(f.guild.id, warning.id).toJSON();
  assert.equal(row.components[0].label, 'Bezwaar maken');
  const rows = warnAppealRows(
    f.guild.id,
    Array.from({ length: 30 }, () => ({ id: warning.id, removed_at: null })),
  );
  assert.equal(rows.length, 5);
  rows.forEach((item) => assert.equal(item.toJSON().components.length, 5));
  await writeWarnLog(f.ctx, f.guild, 'Gangwarn', 'Uitleg', [warnAppealRow(f.guild.id, warning.id)]);
  assert.equal(
    [...f.guild.channels.cache.get(f.ctx.config.warnLogChannelId).posted.values()][0].components
      .length,
    1,
  );
});
test('commandoreactie is privé en de dashboardbeslissing vraagt bevestiging en actuele Lead-rechten', async (t) => {
  const f = fixture(t),
    warning = f.warning();
  assert.ok(commands(500, false).some((item) => item.name === 'bezwaar'));
  assert.ok(!commands(500, true).some((item) => item.name === 'bezwaar'));
  let flags;
  await handleWarnAppealCommand(f.ctx, {
    guild: f.guild,
    user: { id: OTHER },
    deferReply: async (value) => {
      flags = value.flags;
    },
    editReply: async () => {},
    options: { getString: (key) => (key === 'uitleg' ? 'Mijn uitleg.' : warning.id) },
  });
  assert.equal(flags, MessageFlags.Ephemeral);
  const appeal = f.ctx.store.db.prepare('SELECT * FROM warn_appeals').get(),
    dashboard = new Dashboard({ client: f.client, contexts: f.contexts, locks: new Locks() });
  await assert.rejects(
    dashboard.action(f.ctx, f.guild, f.lead, { action: 'appeal.approve', id: appeal.id }),
    /Bevestig/,
  );
  await dashboard.action(f.ctx, f.guild, f.lead, {
    action: 'appeal.approve',
    id: appeal.id,
    confirm: true,
  });
  assert.equal(f.ctx.store.warnCount(OTHER), 0);
});
test('concept en ingediend bezwaar blijven na een SQLite-herstart beschikbaar', async (t) => {
  const f = fixture(t),
    dir = mkdtempSync(join(tmpdir(), 'bakarov-appeals-')),
    filename = join(dir, 'legacy.sqlite');
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, filename);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const warning = f.warning(),
    draft = await beginWarnAppeal(f.ctx, f.guild, OTHER, warning.id, NOW);
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, filename);
  const submitted = await submitWarnAppeal(
    f.ctx,
    f.guild,
    OTHER,
    'Na de herstart.',
    undefined,
    NOW,
  );
  assert.equal(submitted.id, draft.id);
  f.ctx.store.close();
  f.ctx.store = new Store(f.ctx.config, filename);
  await syncWarnAppeals(f.ctx, f.guild, NOW);
  assert.equal(appealById(f.ctx, draft.id).status, 'pending');
  assert.ok(appealById(f.ctx, draft.id).message_id);
});
