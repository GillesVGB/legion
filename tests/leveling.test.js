import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType } from 'discord.js';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import vm from 'node:vm';
import { dashboardFixture, ACTOR, OTHER } from './dashboard-fixture.js';
import { Store } from '../src/data/store.js';
import { commands } from '../src/commands/definitions.js';
import { operationSettings, validateOperations } from '../src/config/features.js';
import { saveDashboardSettings, loadDashboardSettings } from '../src/dashboard/settings.js';
import { Dashboard } from '../src/dashboard/server.js';
import { Locks } from '../src/common/locks.js';
import { awardMessageXp, handleLevelCommand } from '../src/modules/leveling/index.js';
import { levelProfile, levelProgress, levelRanking } from '../src/modules/leveling/profiles.js';
import {
  syncVoiceXp,
  eligibleVoiceMembers,
  clearVoiceXpTracking,
} from '../src/modules/leveling/voice.js';

function fixture(t) {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.contexts.values().next().value,
    guild = f.guilds.get(ctx.config.guildId);
  const channel = guild.channels.cache.get(ctx.config.planningChannelId);
  const message = (content = 'Hallo Bakarov, hoe gaat het?', extra = {}) => ({
    guild,
    guildId: guild.id,
    channelId: channel.id,
    channel,
    content,
    author: guild.members.cache.get(OTHER).user,
    member: guild.members.cache.get(OTHER),
    ...extra,
  });
  const settings = (changes) => {
    ctx.config.operations = {
      ...ctx.config.operations,
      leveling: { ...operationSettings(ctx).leveling, ...changes },
    };
  };
  const voice = guild.makeChannel('100000000000009001', 'Samen spelen');
  voice.type = ChannelType.GuildVoice;
  guild.voiceStates = { cache: new Collection() };
  const state = (user, extra = {}) => ({
    id: user,
    member: guild.members.cache.get(user),
    channel: voice,
    channelId: voice.id,
    selfMute: false,
    serverMute: false,
    selfDeaf: false,
    serverDeaf: false,
    ...extra,
  });
  const pair = () => {
    guild.voiceStates.cache.set(ACTOR, state(ACTOR));
    guild.voiceStates.cache.set(OTHER, state(OTHER));
  };
  return { ...f, ctx, guild, channel, message, settings, voice, state, pair };
}

test('levels gebruiken gezamenlijke bericht- en spraak-XP met correcte grenzen en voortgang', () => {
  assert.deepEqual(levelProgress(0), {
    level: 0,
    xp: 0,
    current: 0,
    required: 100,
    remaining: 100,
  });
  assert.equal(levelProgress(99).level, 0);
  assert.equal(levelProgress(100).level, 1);
  assert.equal(levelProgress(399).remaining, 1);
  assert.equal(levelProgress(400).level, 2);
  assert.equal(levelProgress(-100).xp, 0);
});

test('berichten geven eenmaal XP per cooldown; herhaling, korte tekst en alleen links verdienen niets', (t) => {
  const f = fixture(t);
  assert.equal(awardMessageXp(f.ctx, f.message(), 0).total_xp, 15);
  assert.equal(awardMessageXp(f.ctx, f.message('Een nieuw bericht'), 30_000), null);
  assert.equal(awardMessageXp(f.ctx, f.message('Een nieuw bericht'), 60_000).total_xp, 30);
  assert.equal(awardMessageXp(f.ctx, f.message(' EEN  nieuw bericht '), 120_000), null);
  for (const content of ['', 'ok', '     ', '😀😀😀😀😀', 'https://example.org/video'])
    assert.equal(awardMessageXp(f.ctx, f.message(content), 200_000), null);
  assert.equal(awardMessageXp(f.ctx, f.message('Een nieuw bericht'), 660_000).total_xp, 45);
  assert.equal(levelProfile(f.ctx, OTHER).message_count, 3);
});

test('bots, webhooks, uitgesloten categorieën en uitgeschakelde modules geven geen XP', (t) => {
  const f = fixture(t);
  for (const extra of [
    { author: { id: OTHER, bot: true } },
    { webhookId: 'hook' },
    { system: true },
    { partial: true },
    { guild: { id: 'anders' } },
  ])
    assert.equal(awardMessageXp(f.ctx, f.message(undefined, extra)), null);
  f.settings({ ignoredChannelIds: f.channel.id });
  assert.equal(awardMessageXp(f.ctx, f.message()), null);
  f.settings({ ignoredChannelIds: '100000000000009999' });
  f.channel.parentId = '100000000000009999';
  assert.equal(awardMessageXp(f.ctx, f.message()), null);
  f.channel.parentId = null;
  f.settings({ ignoredChannelIds: '', messageEnabled: false });
  assert.equal(awardMessageXp(f.ctx, f.message()), null);
  f.settings({ messageEnabled: true, enabled: false });
  assert.equal(awardMessageXp(f.ctx, f.message()), null);
  f.settings({ enabled: true });
  const entry = f.source.store.caseById(f.open.id),
    guild = f.guilds.get(f.source.config.guildId);
  assert.equal(
    awardMessageXp(
      f.source,
      f.message(undefined, {
        guild,
        guildId: guild.id,
        channelId: entry.channel_id,
        channel: guild.channels.cache.get(entry.channel_id),
      }),
    ).total_xp,
    15,
  );
  assert.equal(levelProfile(f.ctx, OTHER).total_xp, 0);
});

test('spraak vereist genoeg actieve mensen in hetzelfde gewone kanaal en slaat AFK, bots, mute en deaf over', (t) => {
  const f = fixture(t),
    settings = () => operationSettings(f.ctx).leveling;
  f.pair();
  assert.equal(eligibleVoiceMembers(f.guild, settings()).size, 2);
  for (const flag of ['selfMute', 'serverMute', 'selfDeaf', 'serverDeaf', 'suppress']) {
    f.guild.voiceStates.cache.set(OTHER, f.state(OTHER, { [flag]: true }));
    assert.equal(eligibleVoiceMembers(f.guild, settings()).size, 0, flag);
  }
  f.pair();
  f.guild.afkChannelId = f.voice.id;
  assert.equal(eligibleVoiceMembers(f.guild, settings()).size, 0);
  f.guild.afkChannelId = null;
  f.settings({ ignoredChannelIds: f.voice.id });
  assert.equal(eligibleVoiceMembers(f.guild, settings()).size, 0);
  f.settings({ ignoredChannelIds: '' });
  const second = f.guild.makeChannel('100000000000009002', 'Ander kanaal');
  second.type = ChannelType.GuildVoice;
  f.guild.voiceStates.cache.set(OTHER, f.state(OTHER, { channel: second, channelId: second.id }));
  assert.equal(eligibleVoiceMembers(f.guild, settings()).size, 0);
  f.pair();
  f.guild.members.cache.get(OTHER).user.bot = true;
  assert.equal(eligibleVoiceMembers(f.guild, settings()).size, 0);
});

test('spraak-XP telt seconden en fracties correct; vertrek stopt XP voor de resterende solodeelnemer', (t) => {
  const f = fixture(t);
  f.pair();
  syncVoiceXp(f.ctx, f.guild, 0);
  for (let tick = 15_000; tick <= 60_000; tick += 15_000) syncVoiceXp(f.ctx, f.guild, tick);
  assert.equal(levelProfile(f.ctx, OTHER).voice_xp, 5);
  assert.equal(levelProfile(f.ctx, ACTOR).voice_seconds, 60);
  f.guild.voiceStates.cache.delete(OTHER);
  syncVoiceXp(f.ctx, f.guild, 90_000);
  syncVoiceXp(f.ctx, f.guild, 120_000);
  assert.equal(levelProfile(f.ctx, ACTOR).voice_seconds, 90);
  assert.equal(levelProfile(f.ctx, OTHER).voice_seconds, 90);
  f.pair();
  syncVoiceXp(f.ctx, f.guild, 150_000);
  syncVoiceXp(f.ctx, f.guild, 180_000);
  assert.equal(levelProfile(f.ctx, OTHER).voice_xp, 10);
  assert.equal(levelProfile(f.ctx, OTHER).voice_seconds, 120);
  awardMessageXp(f.ctx, f.message(), 1000);
  assert.equal(levelProfile(f.ctx, OTHER).total_xp, 25);
});

test('herverbinden, herstarten, uitschakelen en instellingen wijzigen geven geen XP voor offline tijd', (t) => {
  const f = fixture(t);
  f.pair();
  syncVoiceXp(f.ctx, f.guild, 0);
  syncVoiceXp(f.ctx, f.guild, 60_000);
  clearVoiceXpTracking(f.contexts);
  syncVoiceXp(f.ctx, f.guild, 3_600_000);
  assert.equal(levelProfile(f.ctx, OTHER).voice_xp, 5);
  f.settings({ voiceEnabled: false });
  syncVoiceXp(f.ctx, f.guild, 3_660_000);
  f.settings({ voiceEnabled: true });
  syncVoiceXp(f.ctx, f.guild, 7_000_000);
  assert.equal(levelProfile(f.ctx, OTHER).voice_xp, 5);
  f.settings({ voiceXpPerMinute: 10 });
  syncVoiceXp(f.ctx, f.guild, 7_060_000);
  assert.equal(levelProfile(f.ctx, OTHER).voice_xp, 5);
  syncVoiceXp(f.ctx, f.guild, 7_660_000);
  assert.equal(levelProfile(f.ctx, OTHER).voice_xp, 15); // A stalled tick counts at most one minute.
});

test('voortgang en berichtcooldowns blijven na SQLite-herstart bewaard en zijn per guild gescheiden', (t) => {
  const f = fixture(t),
    root = resolve('.test-tmp');
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, 'leveling-')),
    filename = join(folder, 'levels.sqlite');
  t.after(() => {
    assert.ok(resolve(folder).startsWith(root + sep));
    rmSync(folder, { recursive: true, force: true });
  });
  const original = f.ctx.store;
  f.ctx.store = new Store(f.ctx.config, filename);
  try {
    awardMessageXp(f.ctx, f.message(), 1000);
    f.pair();
    syncVoiceXp(f.ctx, f.guild, 0);
    syncVoiceXp(f.ctx, f.guild, 20_000);
  } finally {
    f.ctx.store.close();
  }
  f.ctx.store = new Store(f.ctx.config, filename);
  f.ctx.levelingVoice = null;
  try {
    assert.equal(levelProfile(f.ctx, OTHER).total_xp, 16);
    assert.equal(awardMessageXp(f.ctx, f.message('Andere tekst'), 2000), null);
    syncVoiceXp(f.ctx, f.guild, 3_600_000);
    syncVoiceXp(f.ctx, f.guild, 3_640_000);
    assert.equal(levelProfile(f.ctx, OTHER).voice_xp, 5);
    assert.equal(levelProfile(f.ctx, OTHER).voice_seconds, 60);
    assert.equal(levelProfile(f.source, OTHER).total_xp, 0);
  } finally {
    f.ctx.store.close();
    f.ctx.store = original;
  }
});

test('levelcommando’s zijn publiek in beide guilds en de ranglijst bevat alleen huidige echte leden', async (t) => {
  const f = fixture(t);
  for (const community of [false, true])
    for (const name of ['level', 'levels'])
      assert.ok(commands(500, community).some((command) => command.name === name));
  for (let count = 0; count < 7; count++)
    awardMessageXp(f.ctx, f.message(`Geldig bericht nummer ${count}`), 1000 + count * 60_000);
  assert.equal(levelRanking(f.ctx, f.guild)[0].level, 1);
  let deferred, reply;
  await handleLevelCommand(f.ctx, {
    commandName: 'level',
    guild: f.guild,
    user: f.guild.members.cache.get(OTHER).user,
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
  assert.match(reply.files[0].description, /105 XP/);
  assert.deepEqual(reply.allowedMentions.parse, []);
  f.guild.members.cache.delete(OTHER);
  assert.equal(levelRanking(f.ctx, f.guild).length, 0);
});

test('ledenberichten geven XP in changelog, logs, transcripts en alle tekst- en threadsoorten', (t) => {
  const f = fixture(t);
  const channels = [
    [f.ctx.config.updateChannelId, ChannelType.GuildAnnouncement],
    [f.ctx.config.botLogChannelId, ChannelType.GuildText],
    [f.ctx.config.logChannelId, ChannelType.GuildText],
    [f.ctx.config.warnLogChannelId, ChannelType.GuildText],
    ['100000000000009021', ChannelType.PublicThread],
    ['100000000000009022', ChannelType.PrivateThread],
    ['100000000000009023', ChannelType.AnnouncementThread],
    ['100000000000009024', ChannelType.GuildVoice],
  ];
  channels.forEach(([id, type], i) => {
    const channel = { id, type };
    const profile = awardMessageXp(
      f.ctx,
      f.message(`Geldig bericht in kanaal ${i}`, { channelId: id, channel }),
      1000 + i * 60_000,
    );
    assert.equal(profile.total_xp, (i + 1) * 15, `Kanaal ${id}`);
  });
  const community = f.guilds.get(f.source.config.guildId);
  for (const [i, id] of [
    f.source.config.applicationTranscriptChannelId,
    f.source.config.ticketTranscriptChannelId,
  ].entries()) {
    assert.equal(
      awardMessageXp(
        f.source,
        f.message(`Transcriptkanaal testbericht ${i}`, {
          guild: community,
          guildId: community.id,
          channelId: id,
          channel: community.channels.cache.get(id),
        }),
        1000 + i * 60_000,
      ).total_xp,
      (i + 1) * 15,
    );
  }
});

test('dashboard toont levels en module-instellingen veilig; XP-instellingen worden per guild bewaard', (t) => {
  const f = fixture(t);
  awardMessageXp(f.ctx, f.message(), 1000);
  f.guild.members.cache.get(OTHER).displayName = '<script>naam</script>';
  saveDashboardSettings(
    f.ctx,
    {
      operations: {
        leveling: { messageXp: 20, voiceMinMembers: 3, ignoredChannelIds: f.voice.id },
      },
    },
    ACTOR,
  );
  loadDashboardSettings(f.ctx);
  assert.equal(operationSettings(f.ctx).leveling.messageXp, 20);
  assert.equal(operationSettings(f.source).leveling.messageXp, 15);
  assert.throws(() => validateOperations({ leveling: { messageCooldownSeconds: 0 } }));
  assert.throws(() =>
    validateOperations({ leveling: { ignoredChannelIds: 'https://example.org' } }),
  );
  const data = new Dashboard({ ...f, locks: new Locks() }).summary(f.ctx, f.guild),
    source = readFileSync(new URL('../src/dashboard/public/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({ data, Intl, Date, Number, String, Math, URL, console });
  vm.runInContext(
    source.slice(0, source.indexOf('// Dashboard events')) + '\nstate.data=data;',
    context,
  );
  const html = vm.runInContext('levelingPage()', context),
    settings = vm.runInContext('modulesPage()', context);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(settings, /leveling.voiceXpPerMinute/);
  assert.match(settings, /leveling.messageCooldownSeconds/);
  const ignoredInput = settings.match(/<input\b[^>]*name="leveling\.ignoredChannelIds"[^>]*>/)?.[0];
  assert.ok(ignoredInput);
  assert.doesNotMatch(ignoredInput, /\brequired\b/);
});
