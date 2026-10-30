import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { dashboardFixture, OTHER } from './dashboard-fixture.js';
import { recordMessageEvent, redactMessageText, rememberMessage } from '../src/logging/messages.js';
import { auditPayloads, auditPresentation, dashboardAuditItem } from '../src/logging/format.js';
import { flushAuditLogs } from '../src/logging/audit.js';
import { saveDashboardSettings } from '../src/dashboard/settings.js';
const NOW = Date.parse('2026-10-16T12:00:00Z');
function fixture(t) {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.contexts.values().next().value,
    guild = f.guilds.get(ctx.config.guildId);
  ctx.store.setSetting(
    'audit:cursor',
    String(ctx.store.db.prepare('SELECT MAX(id) AS n FROM audit').get().n),
  );
  return { ...f, ctx, guild, channel: guild.channels.cache.get(ctx.config.botLogChannelId) };
}
function message(f, text = 'Dit was het bericht.') {
  return {
    id: '100000000000001234',
    guild: f.guild,
    guildId: f.guild.id,
    channelId: f.ctx.config.planningChannelId,
    author: f.guild.members.cache.get(OTHER).user,
    member: f.guild.members.cache.get(OTHER),
    createdTimestamp: NOW - 1000,
    partial: false,
    content: text,
    attachments: new Collection(),
  };
}
const row = (f, id) => f.ctx.store.db.prepare('SELECT * FROM audit WHERE id=?').get(id);
const snapshot = (f, id) =>
  JSON.parse(
    f.ctx.store.db.prepare('SELECT snapshot FROM message_audit WHERE audit_id=?').get(id).snapshot,
  );
const size = (card) =>
  (card.title?.length || 0) +
  (card.description?.length || 0) +
  (card.footer?.text?.length || 0) +
  (card.fields || []).reduce((n, item) => n + item.name.length + item.value.length, 0);

test('verwijderde berichten tonen hun tekst, auteur, kanaal en bijlagen met een Nederlandse titel', async (t) => {
  const f = fixture(t),
    item = message(f, 'Hallo Bakarov!\nIk ben erbij.');
  item.attachments.set('file', {
    name: 'foto.png',
    url: 'https://cdn.discordapp.com/attachments/1/2/foto.png',
    size: 123,
  });
  const id = recordMessageEvent(f.ctx, 'message.delete', item);
  await flushAuditLogs(f.ctx, f.guild, NOW);
  const cards = [...f.channel.posted.values()].flatMap((value) => value.embeds),
    text = JSON.stringify(cards);
  assert.ok(cards.some((card) => card.title === '🗑️ Bericht verwijderd'));
  assert.ok(
    text.includes('Hallo Bakarov!') &&
      text.includes('Ik ben erbij.') &&
      text.includes(OTHER) &&
      text.includes(item.channelId) &&
      text.includes('foto.png'),
  );
  assert.equal(snapshot(f, id).after.text, item.content);
  assert.ok(!text.includes('"user":'));
});
test('bewerkte berichten tonen de oude en nieuwe tekst; een onbekende oude inhoud wordt niet verzonnen', (t) => {
  const f = fixture(t),
    before = message(f, 'Oorspronkelijke tekst'),
    after = message(f, 'Aangepaste tekst'),
    id = recordMessageEvent(f.ctx, 'message.edit', after, before),
    view = auditPresentation(row(f, id), snapshot(f, id));
  assert.deepEqual(
    view.sections.map((item) => item.text),
    ['Oorspronkelijke tekst', 'Aangepaste tekst'],
  );
  const unknownAfter = { ...after, id: '100000000000001235' },
    unknownBefore = { ...before, id: unknownAfter.id, partial: true, content: null };
  const unknown = recordMessageEvent(f.ctx, 'message.edit', unknownAfter, unknownBefore);
  assert.ok(
    auditPresentation(row(f, unknown), snapshot(f, unknown)).sections[0].text.includes(
      'niet beschikbaar',
    ),
  );
  const count = f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
  recordMessageEvent(f.ctx, 'message.edit', after, after);
  recordMessageEvent(f.ctx, 'message.delete', { ...after, author: { bot: true } });
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, count);
});
test('lege tekst en een niet gecachet bericht krijgen verschillende duidelijke meldingen', (t) => {
  const f = fixture(t),
    empty = recordMessageEvent(f.ctx, 'message.delete', message(f, '')),
    missing = recordMessageEvent(f.ctx, 'message.delete', {
      ...message(f),
      partial: true,
      content: null,
      author: null,
    });
  assert.ok(
    auditPresentation(row(f, empty), snapshot(f, empty)).sections[0].text.includes('geen tekst'),
  );
  assert.ok(
    auditPresentation(row(f, missing), snapshot(f, missing)).sections[0].text.includes(
      'niet beschikbaar',
    ),
  );
});
test('lange oude en nieuwe berichten blijven volledig behouden binnen alle Discord-embedlimieten', (t) => {
  const f = fixture(t),
    before = message(f, '`'.repeat(3900) + ' OUDE EINDE'),
    after = message(f, 'a'.repeat(3900) + ' NIEUWE EINDE'),
    id = recordMessageEvent(f.ctx, 'message.edit', after, before),
    payloads = auditPayloads(f.ctx, [row(f, id)], 'preview');
  assert.ok(payloads.length > 1);
  for (const payload of payloads) {
    assert.ok(payload.embeds.length <= 10);
    assert.ok(payload.embeds.reduce((n, card) => n + size(card), 0) <= 6000);
    for (const card of payload.embeds) {
      assert.ok(card.fields.length <= 25);
      assert.ok(card.fields.every((field) => field.value.length <= 1024));
    }
  }
  const fields = payloads.flatMap((payload) => payload.embeds).flatMap((card) => card.fields);
  for (const [name, original] of [
    ['Voor wijziging', before.content],
    ['Na wijziging', after.content],
  ]) {
    const reconstructed = fields
      .filter((field) => field.name.startsWith(name))
      .map((field) => field.value.slice(4, -4).replaceAll('\u200b', ''))
      .join('');
    assert.equal(reconstructed, original);
  }
});
test('verzenden van meerdere logdelen herstelt na een storing en een crash zonder dubbele delen', async (t) => {
  const f = fixture(t),
    id = recordMessageEvent(
      f.ctx,
      'message.edit',
      message(f, 'N'.repeat(4000)),
      message(f, 'O'.repeat(4000)),
    ),
    send = f.channel.send;
  let attempts = 0;
  f.channel.send = async (payload) => {
    attempts++;
    if (attempts === 2) throw Object.assign(new Error('Offline'), { code: 503 });
    return send(payload);
  };
  await flushAuditLogs(f.ctx, f.guild, NOW);
  assert.equal(f.channel.posted.size, 1);
  let job = f.ctx.store.db
    .prepare('SELECT * FROM audit_deliveries WHERE first_id<=? AND last_id>=?')
    .get(id, id);
  assert.equal(JSON.parse(job.message_ids).length, 1);
  f.channel.send = send;
  await flushAuditLogs(f.ctx, f.guild, NOW + 61000);
  job = f.ctx.store.db.prepare('SELECT * FROM audit_deliveries WHERE id=?').get(job.id);
  assert.equal(f.channel.posted.size, JSON.parse(job.payloads).length);
  const count = f.channel.posted.size;
  f.ctx.store.db
    .prepare("UPDATE audit_deliveries SET message_id=NULL,message_ids='[]' WHERE id=?")
    .run(job.id);
  f.ctx.store.setSetting('audit:cursor', '0');
  await flushAuditLogs(f.ctx, f.guild, NOW + 62000);
  assert.equal(f.channel.posted.size, count);
});
test('berichtinhoud gaat naar het expliciet ingestelde botlogkanaal', async (t) => {
  const f = fixture(t);
  f.channel.permissionsFor = () =>
    new PermissionsBitField([P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks]);
  recordMessageEvent(f.ctx, 'message.delete', message(f, 'Alleen voor de leiding'));
  await flushAuditLogs(f.ctx, f.guild, NOW);
  assert.equal(f.channel.id, '1555685637129109586');
  assert.equal(f.channel.posted.size, 1);
  const privateChannel = f.guild.channels.cache.get(f.ctx.config.logChannelId);
  assert.equal(privateChannel.posted.size, 0);
  assert.ok(
    JSON.stringify([...f.channel.posted.values()].flatMap((item) => item.embeds)).includes(
      'Alleen voor de leiding',
    ),
  );
});
test('een wachtend log uit een eerdere versie volgt het huidige botlogkanaal', async (t) => {
  const f = fixture(t),
    id = recordMessageEvent(f.ctx, 'message.delete', message(f, 'Log op de gevraagde plek'));
  f.ctx.store.db
    .prepare('INSERT INTO audit_deliveries(id,first_id,last_id,channel_id) VALUES(?,?,?,?)')
    .run('previous-job', id, id, f.ctx.config.logChannelId);
  await flushAuditLogs(f.ctx, f.guild, NOW);
  assert.equal(f.channel.posted.size, 1);
  assert.equal(f.guild.channels.cache.get(f.ctx.config.logChannelId).posted.size, 0);
  assert.equal(
    f.ctx.store.db.prepare("SELECT channel_id FROM audit_deliveries WHERE id='previous-job'").get()
      .channel_id,
    f.channel.id,
  );
});
test('tokens, wachtwoorden en toegangssleutels blijven verborgen, gewone tekst en normale links blijven leesbaar', (t) => {
  const f = fixture(t),
    raw = `Tekst ${f.ctx.config.token}\nwachtwoord=geheim\nhttps://example.com/nieuws\nhttps://example.com/#login=privaat\nhttps://discord.gg/invite`,
    id = recordMessageEvent(f.ctx, 'message.delete', message(f, raw)),
    saved = JSON.stringify(snapshot(f, id));
  assert.ok(
    !saved.includes(f.ctx.config.token) && !saved.includes('geheim') && !saved.includes('privaat'),
  );
  assert.ok(saved.includes('https://example.com/nieuws'));
  assert.ok(!redactMessageText('https://example.com/t#k=private-key').includes('private-key'));
});
test('uitgeschakelde logs bewaren geen nieuwe berichtinhoud; oude metadata blijft leesbaar zonder gefingeerde tekst', (t) => {
  const f = fixture(t);
  saveDashboardSettings(f.ctx, { operations: { logs: { enabled: false } } }, '100000000000000001');
  const id = recordMessageEvent(f.ctx, 'message.delete', message(f, 'Niet bewaren'));
  assert.equal(
    f.ctx.store.db.prepare('SELECT * FROM message_audit WHERE audit_id=?').get(id),
    undefined,
  );
  const view = dashboardAuditItem(f.ctx, f.guild, row(f, id));
  assert.ok(view.presentation.sections[0].text.includes('niet beschikbaar'));
});

test('een verwijderd bericht buiten de Discordcache behoudt tekst en bijlagen via de begrensde schijfcache', (t) => {
  const f = fixture(t),
    item = message(f, 'Bewaard voor een verwijderingslog');
  item.attachments.set('file', {
    name: 'bewijs.png',
    url: 'https://cdn.discordapp.com/attachments/1/2/bewijs.png',
    size: 123,
  });
  assert.equal(rememberMessage(f.ctx, item, NOW), true);
  const partial = {
    id: item.id,
    guildId: f.guild.id,
    channelId: item.channelId,
    partial: true,
    content: null,
    attachments: new Collection(),
  };
  const id = recordMessageEvent(f.ctx, 'message.delete', partial, null, { now: NOW + 1000 }),
    saved = snapshot(f, id);
  assert.equal(saved.after.text, item.content);
  assert.equal(saved.authorId, item.author.id);
  assert.equal(saved.authorName, item.member.displayName);
  assert.equal(saved.after.attachments[0].name, 'bewijs.png');
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM recent_messages').get().n, 0);
});

test('wijzigingen gebruiken de laatste bekende tekst en werken de schijfcache bij voor een latere verwijdering', (t) => {
  const f = fixture(t),
    before = message(f, 'Eerste tekst'),
    after = message(f, 'Tweede tekst');
  rememberMessage(f.ctx, before, NOW);
  const partial = { ...before, partial: true, content: null, author: null, member: null };
  const edit = recordMessageEvent(f.ctx, 'message.edit', after, partial, { now: NOW + 1000 });
  assert.equal(snapshot(f, edit).before.text, 'Eerste tekst');
  assert.equal(snapshot(f, edit).after.text, 'Tweede tekst');
  const deleted = recordMessageEvent(f.ctx, 'message.delete', partial, null, { now: NOW + 2000 });
  assert.equal(snapshot(f, deleted).after.text, 'Tweede tekst');
});

test('oude berichten vervallen na 24 uur en de schijfcache bewaart maximaal duizend berichten per server', (t) => {
  const f = fixture(t),
    item = message(f, 'Te oud');
  rememberMessage(f.ctx, item, NOW);
  const partial = { ...item, partial: true, content: null, author: null, member: null };
  const expired = recordMessageEvent(f.ctx, 'message.delete', partial, null, {
    now: NOW + 24 * 60 * 60 * 1000,
  });
  assert.equal(snapshot(f, expired).after.available, false);
  for (let i = 0; i < 1002; i++)
    rememberMessage(
      f.ctx,
      { ...item, id: String(BigInt(item.id) + BigInt(i)), content: `Bericht ${i}` },
      NOW + i,
    );
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM recent_messages').get().n, 1000);
  assert.equal(
    f.ctx.store.db
      .prepare('SELECT message_id FROM recent_messages WHERE message_id=?')
      .get(item.id),
    undefined,
  );
  rememberMessage(f.ctx, { ...item, id: '100000000000009999' }, NOW + 24 * 60 * 60 * 1000 + 1002);
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM recent_messages').get().n, 1);
});

test('de schijfcache schermt geheimen af en deelt geen inhoud tussen kanalen, auteurs of servers', (t) => {
  const f = fixture(t),
    item = message(
      f,
      `Normale tekst ${f.ctx.config.token} wachtwoord=geheim https://example.com/#k=privaat`,
    );
  rememberMessage(f.ctx, item, NOW);
  const stored = f.ctx.store.db
    .prepare('SELECT snapshot FROM recent_messages WHERE message_id=?')
    .get(item.id).snapshot;
  assert.ok(
    !stored.includes(f.ctx.config.token) &&
      !stored.includes('geheim') &&
      !stored.includes('privaat'),
  );
  const partial = { ...item, partial: true, content: null, author: null, member: null };
  const wrongChannel = recordMessageEvent(
    f.ctx,
    'message.delete',
    { ...partial, channelId: 'other-channel' },
    null,
    { now: NOW + 1 },
  );
  assert.equal(snapshot(f, wrongChannel).after.available, false);
  const wrongAuthor = recordMessageEvent(
    f.ctx,
    'message.delete',
    { ...partial, author: { id: '100000000000000088' } },
    null,
    { now: NOW + 2 },
  );
  assert.equal(snapshot(f, wrongAuthor).after.available, false);
  rememberMessage(f.ctx, item, NOW + 3);
  assert.equal(
    recordMessageEvent(f.ctx, 'message.delete', { ...partial, guildId: 'other-guild' }, null, {
      now: NOW + 4,
    }),
    undefined,
  );
  assert.equal(
    recordMessageEvent(
      f.ctx,
      'message.delete',
      { ...partial, guildId: f.guild.id, guild: { id: 'other-guild' } },
      null,
      { now: NOW + 4 },
    ),
    undefined,
  );
  assert.equal(rememberMessage(f.ctx, { ...item, guildId: 'other-guild' }, NOW + 4), false);
});

test('bots en uitgeschakelde logs schrijven geen nieuwe berichtinhoud in de schijfcache', (t) => {
  const f = fixture(t),
    item = message(f, 'Niet opslaan');
  assert.equal(rememberMessage(f.ctx, { ...item, author: { id: 'bot', bot: true } }, NOW), false);
  rememberMessage(f.ctx, item, NOW);
  saveDashboardSettings(f.ctx, { operations: { logs: { enabled: false } } }, '100000000000000001');
  assert.equal(rememberMessage(f.ctx, { ...item, id: '100000000000009999' }, NOW + 1), false);
  const id = recordMessageEvent(
    f.ctx,
    'message.delete',
    { ...item, partial: true, content: null, author: null },
    null,
    { now: NOW + 2 },
  );
  assert.equal(
    f.ctx.store.db.prepare('SELECT * FROM message_audit WHERE audit_id=?').get(id),
    undefined,
  );
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM recent_messages').get().n, 0);
});
