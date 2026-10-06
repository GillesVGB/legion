import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Collection, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Dashboard } from '../src/dashboard.mjs';
import { Locks } from '../src/locks.mjs';
import { startTranscriptViewer } from '../src/viewer-server.mjs';
import { recoverCase } from '../src/case-recovery.mjs';
import { requestCaseDecision, decideCase } from '../src/service.mjs';
import { publishRoster } from '../src/roster.mjs';
import { dashboardFixture, ACTOR, APPLICANT } from './dashboard-fixture.mjs';

function tunnel() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  return child;
}
test('dashboard start ook in files/remote-modus, kiest eigen URL en laat remote transcriptadres intact', async t => {
  const f = dashboardFixture(); t.after(f.close);
  const remote = f.contexts.values().next().value;
  remote.config.transcriptViewerMode = 'remote'; remote.config.transcriptSiteURL = 'https://remote.example';
  f.source.config.transcriptViewerMode = 'files'; f.source.config.transcriptSiteURL = '';
  const dashboard = new Dashboard({ ...f, locks: new Locks() });
  let child, ready;
  const connected = new Promise(resolve => { ready = resolve; });
  const stop = await startTranscriptViewer({ ...f.base, transcriptPort: 0 }, f.contexts, ready, dashboard, {
    spawnTunnel: () => child = tunnel(), fetchHealth: async () => Response.json({ ok: true })
  }); t.after(stop);
  assert.throws(() => dashboard.issueLogin(ACTOR, f.source.config.guildId), /verbinding/);
  assert.equal(dashboard.logins.size, 0);
  child.stderr.write('https://ready-legion-test.trycloudflare.com'); await connected;
  assert.equal(new URL(dashboard.issueLogin(ACTOR, f.source.config.guildId)).origin, 'https://ready-legion-test.trycloudflare.com');
  assert.equal(remote.config.transcriptSiteURL, 'https://remote.example');
  assert.equal(f.source.config.transcriptSiteURL, '');
  assert.equal(f.source.store.setting('dashboard-origin'), 'https://ready-legion-test.trycloudflare.com');
});
test('ontbrekende cloudflared geeft een concrete fout en herstelt na een nieuwe verbinding', async t => {
  const f = dashboardFixture(); t.after(f.close);
  const dashboard = new Dashboard({ ...f, locks: new Locks() }); let child, attempts = 0, ready;
  const connected = new Promise(resolve => { ready = resolve; });
  const stop = await startTranscriptViewer({ ...f.base, transcriptPort: 0 }, f.contexts, ready, dashboard, {
    retryDelayMs: 5, spawnTunnel: () => { child = tunnel(); if (++attempts === 2) setImmediate(() => child.stderr.write('https://recovered-test.trycloudflare.com')); return child; },
    fetchHealth: async () => Response.json({ ok: true })
  }); t.after(stop);
  child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  assert.throws(() => dashboard.currentOrigin(), /cloudflared niet vinden/);
  await connected;
  assert.equal(dashboard.currentOrigin(), 'https://recovered-test.trycloudflare.com');
  assert.equal(f.source.config.transcriptSiteURL, dashboard.currentOrigin());
});

function recoveryFixture(t) {
  const f = dashboardFixture(); t.after(f.close);
  const open = f.source.store.caseById(f.open.id);
  const guild = f.guilds.get(f.source.config.guildId), channel = guild.channels.cache.get(open.channel_id);
  channel.topic = `Legion dossier:${f.open.id} | application | eigenaar:${APPLICANT}`;
  channel.parentId = f.source.config.applicationCategoryId;
  const overwrite = (allow = 0n, deny = 0n) => ({ allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) });
  channel.permissionOverwrites.cache.set(guild.id, overwrite(0n, P.ViewChannel));
  channel.permissionOverwrites.cache.set(APPLICANT, overwrite(P.ViewChannel | P.SendMessages));
  channel.permissionOverwrites.cache.set(guild.members.me.id, overwrite(P.ViewChannel));
  const intro = channel.posted.get(open.message_id);
  intro.components = [{ components: [{ customId: `application:askaccept:${f.open.id}`, disabled: false }] }];
  const store = new Store(f.source.config, ':memory:'); t.after(() => store.close());
  const ctx = { ...f.source, store };
  return { ...f, open, guild, channel, intro, ctx };
}
test('bestaande privé-sollicitatie herstelt ontbrekend dossier en kan daarna worden aangenomen', async t => {
  const f = recoveryFixture(t), actor = f.guild.members.cache.get(ACTOR); let deferred = false, confirmation;
  const interaction = { guild: f.guild, guildId: f.guild.id, channel: f.channel, channelId: f.channel.id, client: f.client,
    member: actor, user: actor.user, memberPermissions: actor.permissions, message: f.intro,
    deferReply: async () => { deferred = true; }, editReply: async payload => { confirmation = payload; } };
  await requestCaseDecision(f.ctx, interaction, f.open.id, 'accept');
  assert.equal(deferred, true); assert.match(confirmation.content, /aannemen/);
  assert.equal(f.ctx.store.caseById(f.open.id).status, 'open');
  await decideCase(f.ctx, interaction, f.open.id, 'accept');
  assert.equal(f.ctx.store.caseById(f.open.id).status, 'accepted');
  assert.equal(f.ctx.store.transcript(f.open.id).state, 'done');
  assert.equal(f.ctx.store.acceptance(f.open.id).status, 'sent');
  assert.equal(f.guild.channels.cache.has(f.channel.id), false);
});
test('dossierherstel weigert gekopieerde knoppen, publieke/gesloten kanalen en heropent geen beslissing', async t => {
  const f = recoveryFixture(t);
  f.intro.author = { id: OTHER_ID };
  assert.equal(await recoverCase(f.ctx, f.guild, f.channel, f.open.id, f.intro), null);
  f.intro.author = f.client.user;
  const everyone = f.channel.permissionOverwrites.cache.get(f.guild.id);
  f.channel.permissionOverwrites.cache.delete(f.guild.id);
  assert.equal(await recoverCase(f.ctx, f.guild, f.channel, f.open.id, f.intro), null);
  f.channel.permissionOverwrites.cache.set(f.guild.id, everyone);
  const owner = f.channel.permissionOverwrites.cache.get(APPLICANT);
  owner.allow.remove(P.SendMessages);
  assert.equal(await recoverCase(f.ctx, f.guild, f.channel, f.open.id, f.intro), null);
  owner.allow.add(P.SendMessages);
  await recoverCase(f.ctx, f.guild, f.channel, f.open.id, f.intro);
  f.ctx.store.closeCase(f.open.id, 'rejected', ACTOR);
  assert.equal((await recoverCase(f.ctx, f.guild, f.channel, f.open.id, f.intro)).status, 'rejected');
});
const OTHER_ID = '100000000000000099';

test('ledenlijst blijft bij restarts en gelijktijdige updates dezelfde embed; alleen eigen duplicaten verdwijnen', async t => {
  const f = dashboardFixture(); t.after(f.close);
  const ctx = f.contexts.values().next().value, guild = f.guilds.get(ctx.config.guildId);
  const channel = guild.channels.cache.get(ctx.config.roster.channelId); let sent = 0, edited = 0, deleted = 0;
  const originalSend = channel.send;
  const decorate = message => { message.embeds = message.embeds.map(e => ({ ...e.toJSON(), toJSON: e.toJSON }));
    message.edit = async payload => { edited++; message.embeds = payload.embeds.map(e => e.toJSON()); return message; };
    message.delete = async () => { deleted++; channel.posted.delete(message.id); }; return message; };
  channel.send = async payload => { sent++; return decorate(await originalSend(payload)); };
  await Promise.all([publishRoster(ctx, guild), publishRoster(ctx, guild)]);
  const id = JSON.parse(ctx.store.setting('roster:messages'))[0]; assert.equal(sent, 1); assert.equal(edited, 1);
  await publishRoster({ ...ctx, rosterRecovered: false }, guild);
  assert.equal(sent, 1); assert.equal(JSON.parse(ctx.store.setting('roster:messages'))[0], id);
  const duplicate = decorate(await originalSend({ embeds: [{ toJSON: () => ({ title: 'Legion — Ledenlijst' }) }] }));
  const foreign = decorate(await originalSend({ embeds: [{ toJSON: () => ({ title: 'Legion — Ledenlijst' }) }] })); foreign.author = { id: OTHER_ID };
  ctx.store.setSetting('roster:messages', '[]');
  await publishRoster({ ...ctx, rosterRecovered: false }, guild);
  assert.equal(sent, 1); assert.equal(deleted, 1); assert.equal(channel.posted.has(duplicate.id), false); assert.equal(channel.posted.has(foreign.id), true);
  assert.equal(JSON.parse(ctx.store.setting('roster:messages'))[0], id);
});
test('standaardconfiguratie start de lokale dashboardverbinding', () => {
  assert.equal(loadConfig({}, false).transcriptViewerMode, 'local');
});
