import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { dashboardFixture, ACTOR, OTHER } from './dashboard-fixture.js';
import { operationSettings, validateOperations } from '../src/config/features.js';
import { awardMessageXp, handleLevelCommand } from '../src/modules/leveling/index.js';
import { levelCardSvg, renderLevelCard } from '../src/modules/leveling/cards.js';
import { syncLevelNotifications } from '../src/modules/leveling/notifications.js';
import { syncVoiceXp } from '../src/modules/leveling/voice.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function fixture(t) {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.contexts.values().next().value,
    guild = f.guilds.get(ctx.config.guildId);
  const channel = guild.channels.cache.get(ctx.config.planningChannelId),
    member = guild.members.cache.get(OTHER);
  const send = channel.send;
  channel.send = async (payload) => {
    const message = await send(payload);
    message.attachments = new Collection(
      (payload.files || []).map((file, i) => [String(i), { name: file.name }]),
    );
    return message;
  };
  const settings = (changes) =>
    (ctx.config.operations = {
      ...ctx.config.operations,
      leveling: { ...operationSettings(ctx).leveling, ...changes },
    });
  const message = (i) => ({
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    author: member.user,
    member,
    content: `Dit is een geldig bericht ${i}`,
  });
  const cross = () => {
    for (let i = 0; i < 7; i++) awardMessageXp(ctx, message(i), 1000 + i * 60_000);
    return notice();
  };
  const notice = () => ctx.store.db.prepare('SELECT * FROM level_up_notices').get();
  return { ...f, ctx, guild, channel, member, settings, message, cross, notice };
}

test('rankkaart is een echte PNG met vaste afmetingen, geescapete namen en juiste voortgang', async () => {
  const name = 'Gilles <script>&"<image href="https://evil.test/">';
  const svg = levelCardSvg({ name, xp: 1725, rank: 3 });
  assert.match(svg, /&lt;script&gt;&amp;&quot;/);
  assert.doesNotMatch(svg, /<script>|href="https:/);
  assert.match(svg, /125 \/ 900 XP/);
  assert.match(svg, /NOG 775 XP/);
  assert.match(svg, /RANG #3/);
  const image = await renderLevelCard({ displayName: name }, { xp: 1725, rank: 3 });
  assert.ok(image.subarray(0, 8).equals(signature));
  assert.equal(image.readUInt32BE(16), 1000);
  assert.equal(image.readUInt32BE(20), 320);
  assert.ok(image.length < 300_000);
  assert.match(levelCardSvg({ name: 'Lid', xp: 100, levelUp: true }), /LEVEL OMHOOG/);
});

test('avatar gebruikt uitsluitend begrensde Discord-PNGs; ongeldige bron geeft een leesbare kaart', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('CDN offline');
  };
  await renderLevelCard(
    { displayName: 'Gilles', displayAvatarURL: () => 'https://evil.test/avatar.png' },
    { xp: 0 },
  );
  assert.equal(requests, 0);
  const fallback = await renderLevelCard(
    {
      displayName: 'Gilles',
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user/avatar.png',
    },
    { xp: 0 },
  );
  assert.equal(requests, 1);
  assert.ok(fallback.subarray(0, 8).equals(signature));
  globalThis.fetch = async () => new Response(new Uint8Array(310_000));
  assert.ok(
    (
      await renderLevelCard(
        {
          displayName: 'Gilles',
          displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user/avatar.png',
        },
        { xp: 0 },
      )
    )
      .subarray(0, 8)
      .equals(signature),
  );
});

test('/level levert uitsluitend een publieke PNG met beschrijving voor schermlezers', async (t) => {
  const f = fixture(t);
  f.cross();
  let reply,
    deferred = true;
  await handleLevelCommand(f.ctx, {
    commandName: 'level',
    guild: f.guild,
    user: f.member.user,
    options: { getUser: () => null },
    deferReply: async (options) => {
      deferred = options;
    },
    editReply: async (payload) => {
      reply = payload;
    },
  });
  assert.equal(deferred, undefined);
  assert.equal(reply.embeds, undefined);
  assert.equal(reply.content, undefined);
  assert.equal(reply.files.length, 1);
  assert.ok(reply.files[0].attachment.subarray(0, 8).equals(signature));
  assert.match(reply.files[0].description, /105 XP/);
});

test('bericht-levelovergang bewaart exact één melding en verstuurt alleen een PNG zonder embed of tag', async (t) => {
  const f = fixture(t),
    notice = f.cross();
  assert.equal(notice.level, 1);
  assert.equal(notice.xp, 105);
  assert.equal(notice.channel_id, f.channel.id);
  await Promise.all([
    syncLevelNotifications(f.ctx, f.guild),
    syncLevelNotifications(f.ctx, f.guild),
  ]);
  assert.equal(f.channel.posted.size, 1);
  assert.equal(f.notice().status, 'sent');
  const message = f.channel.posted.last();
  assert.equal(message.embeds.length, 0);
  assert.equal(message.attachments.first().name, `level-up-${notice.id}.png`);
  assert.equal(message.content, '');
  assert.equal(f.notice().message_id, message.id);
  await syncLevelNotifications(f.ctx, f.guild);
  awardMessageXp(f.ctx, f.message(8), 600_000);
  await syncLevelNotifications(f.ctx, f.guild);
  assert.equal(f.channel.posted.size, 1);
  assert.equal(f.source.store.db.prepare('SELECT COUNT(*) AS n FROM level_up_notices').get().n, 0);
});

test('spraak maakt ook een levelkaart klaar en bewaart het oorspronkelijke kanaal bij vertrek', async (t) => {
  const f = fixture(t),
    voice = f.guild.makeChannel('100000000000009001', 'Spraak');
  voice.type = ChannelType.GuildVoice;
  f.guild.voiceStates = {
    cache: new Collection(
      [ACTOR, OTHER].map((id) => [
        id,
        { id, member: f.guild.members.cache.get(id), channel: voice, channelId: voice.id },
      ]),
    ),
  };
  f.settings({ voiceXpPerMinute: 60 });
  f.ctx.store.db.prepare('INSERT INTO member_levels(user_id,total_xp) VALUES(?,?)').run(OTHER, 90);
  syncVoiceXp(f.ctx, f.guild, 0);
  f.guild.voiceStates.cache.delete(OTHER);
  syncVoiceXp(f.ctx, f.guild, 15_000);
  assert.equal(f.notice().channel_id, voice.id);
  assert.equal(f.notice().xp, 105);
  await syncLevelNotifications(f.ctx, f.guild);
  assert.equal(voice.posted.size, 1);
  assert.equal(f.channel.posted.size, 0);
});

test('dashboardkanaal geldt voor beide XP-bronnen; verzenden naar een andere guild wordt geweigerd', async (t) => {
  const f = fixture(t),
    destination = f.guild.makeChannel('100000000000009002', 'Levels');
  f.settings({ levelUpChannelId: destination.id });
  f.cross();
  await syncLevelNotifications(f.ctx, f.guild);
  assert.equal(destination.posted.size, 1);
  assert.equal(f.channel.posted.size, 0);
  const second = fixture(t);
  second.cross();
  second.settings({ levelUpChannelId: f.source.config.panelChannelId });
  await syncLevelNotifications(second.ctx, second.guild);
  assert.equal(second.notice().status, 'pending');
  assert.equal(second.notice().last_error, '10003');
});

test('mislukte verzending blijft klaarstaan, herstelt later en dupliceert een reeds geplaatst bericht niet', async (t) => {
  const f = fixture(t);
  f.cross();
  const send = f.channel.send;
  let sent = false;
  f.channel.send = async (payload) => {
    const message = await send(payload);
    if (!sent) {
      sent = true;
      throw Object.assign(new Error('Verbinding verbroken na plaatsen'), { code: 'ECONNRESET' });
    }
    return message;
  };
  await syncLevelNotifications(f.ctx, f.guild, 1_000_000);
  assert.equal(f.notice().status, 'pending');
  assert.equal(f.channel.posted.size, 1);
  await syncLevelNotifications(f.ctx, f.guild, 1_001_000);
  assert.equal(f.notice().status, 'pending');
  await syncLevelNotifications(f.ctx, f.guild, 1_020_000);
  assert.equal(f.notice().status, 'sent');
  assert.equal(f.channel.posted.size, 1);
});

test('ontbrekende bijlagerechten verliezen geen melding; herstel van rechten verstuurt alsnog', async (t) => {
  const f = fixture(t);
  f.cross();
  f.channel.permissionsFor = () => new PermissionsBitField(0n);
  await syncLevelNotifications(f.ctx, f.guild, 1_000_000);
  assert.equal(f.notice().last_error, 'LEVEL_CHANNEL_PERMISSIONS');
  assert.equal(f.channel.posted.size, 0);
  f.channel.permissionsFor = () =>
    new PermissionsBitField([P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles]);
  await syncLevelNotifications(f.ctx, f.guild, 1_020_000);
  assert.equal(f.notice().status, 'sent');
  assert.equal(f.channel.posted.size, 1);
});

test('uitschakelen geeft geen oude levelmeldingen; nieuw inschakelen meldt alleen een volgende overgang', async (t) => {
  const f = fixture(t);
  f.settings({ levelUpMessages: false });
  f.cross();
  assert.equal(f.notice(), undefined);
  f.settings({ levelUpMessages: true });
  awardMessageXp(f.ctx, f.message(9), 600_000);
  await syncLevelNotifications(f.ctx, f.guild);
  assert.equal(f.notice(), undefined);
  assert.equal(f.channel.posted.size, 0);
  const other = fixture(t);
  other.cross();
  other.settings({ enabled: false });
  await syncLevelNotifications(other.ctx, other.guild);
  assert.equal(other.notice().status, 'skipped');
  assert.equal(other.channel.posted.size, 0);
});

test('meldingsinstellingen accepteren een leeg kanaal, valideren IDs en blijven per server apart', (t) => {
  const f = fixture(t);
  assert.deepEqual(
    validateOperations({ leveling: { levelUpChannelId: '', levelUpMessages: true } }),
    { leveling: { levelUpChannelId: '', levelUpMessages: true } },
  );
  assert.throws(() =>
    validateOperations({ leveling: { levelUpChannelId: 'https://example.org' } }),
  );
  f.settings({ levelUpMessages: false });
  assert.equal(operationSettings(f.source).leveling.levelUpMessages, true);
});
