import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Collection, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Dashboard } from '../src/dashboard.mjs';
import { Locks } from '../src/locks.mjs';
import { startTranscriptViewer, connectionDiagnostic } from '../src/viewer-server.mjs';
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

test('Bot-Hosting kiest zijn vaste HTTPS-adres en toegewezen poort zonder .env te vervangen', () => {
  const config = loadConfig({ SERVER_PORT: '25237', TRANSCRIPT_PORT: '8793' }, false);
  assert.equal(config.dashboardPublicURL, 'https://wlll36f6gd.apps.bot-hosting.cloud');
  assert.equal(config.transcriptPort, 25237);
  assert.equal(loadConfig({ SERVER_PORT: '25238' }, false).dashboardPublicURL, '');
  const override = loadConfig({ SERVER_PORT: '25238', DASHBOARD_PUBLIC_URL: 'https://other.example/' }, false);
  assert.equal(override.transcriptPort, 25238); assert.equal(override.dashboardPublicURL, 'https://other.example');
  assert.equal(loadConfig({ SERVER_PORT: '25237', DASHBOARD_PUBLIC_URL: '' }, false).dashboardPublicURL, '');
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/dashboard', 'https://example.com#token']) {
    assert.throws(() => loadConfig({ DASHBOARD_PUBLIC_URL: url }, false), /HTTPS-basisadres/);
  }
});
test('vaste hostingmodus bindt 0.0.0.0, start geen tunnel en houdt private dashboarddata afgeschermd', async t => {
  const f = dashboardFixture(); t.after(f.close); let server, ready;
  const connected = new Promise(resolve => ready = resolve);
  const dashboard = new Dashboard({ ...f, locks: new Locks() });
  const config = { ...f.base, transcriptPort: 0, dashboardPublicURL: 'https://host.example' };
  const stop = await startTranscriptViewer(config, f.contexts, ready, dashboard, {
    onListening: value => server = value,
    spawnTunnel: () => { throw new Error('Een tunnel hoort hier niet gestart te worden'); },
    fetchHealth: async () => fetch(`http://127.0.0.1:${server.address().port}/health`)
  }); t.after(stop);
  await connected;
  assert.equal(server.address().address, '0.0.0.0');
  assert.equal(dashboard.currentOrigin(), config.dashboardPublicURL);
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/dashboard')).status, 200);
  assert.equal((await fetch(origin + `/api/dashboard/guilds/${f.source.config.guildId}/summary`)).status, 401);
  assert.equal(f.source.config.transcriptSiteURL, config.dashboardPublicURL);
  assert.equal(new URL(dashboard.issueLogin(ACTOR, f.source.config.guildId)).origin, config.dashboardPublicURL);
});
test('een niet-bereikbaar hostingadres blijft in controle en herstelt zonder Discord te herstarten', async t => {
  const f = dashboardFixture(); t.after(f.close); let ready, attempts = 0;
  const connected = new Promise(resolve => ready = resolve);
  const dashboard = new Dashboard({ ...f, locks: new Locks() });
  const stop = await startTranscriptViewer({ ...f.base, transcriptPort: 0, dashboardPublicURL: 'https://host.example' }, f.contexts, ready, dashboard, {
    healthRetryDelayMs: 5, fetchHealth: async () => ++attempts === 1 ? new Response('', { status: 502 }) : Response.json({ ok: true })
  }); t.after(stop);
  await connected; assert.equal(attempts, 2); assert.equal(dashboard.currentOrigin(), 'https://host.example');
});
test('DNS-, poort- en certificaatfouten worden apart herkend zonder ruwe secrets te loggen', () => {
  assert.equal(connectionDiagnostic('ERR edge discovery: error looking up Cloudflare edge IPs: the DNS query failed'), 'DNS');
  assert.equal(connectionDiagnostic('ERR DialContext error: dial tcp 198.41.200.43:7844: i/o timeout'), 'NETWORK');
  assert.equal(connectionDiagnostic('ERR x509: certificate signed by unknown authority'), 'TLS');
  assert.equal(connectionDiagnostic('INF Registered tunnel connection connIndex=0 protocol=quic'), 'CONNECTED');
  assert.equal(connectionDiagnostic('INF Switching to fallback protocol http2'), 'FALLBACK');
  assert.equal(connectionDiagnostic('token=never-print-this-value'), null);
});
test('bij een verbroken actieve tunnel stopt de oude URL en wordt automatisch opnieuw verbonden', async t => {
  const f = dashboardFixture(); t.after(f.close); let child, spawnCount = 0, healthCount = 0, complete;
  const twice = new Promise(resolve => complete = resolve);
  const dashboard = new Dashboard({ ...f, locks: new Locks() });
  const stop = await startTranscriptViewer({ ...f.base, transcriptPort: 0 }, f.contexts, () => { if (spawnCount === 2) complete(); }, dashboard, {
    monitorDelayMs: 5, healthRetryDelayMs: 5, retryDelayMs: 5,
    spawnTunnel: (_, args) => { assert.equal(args[args.indexOf('--protocol') + 1], 'auto'); assert.equal(args[args.indexOf('--edge-ip-version') + 1], '4');
      const candidate = tunnel(); child = candidate; spawnCount++; setImmediate(() => candidate.stderr.write(`https://attempt-${spawnCount}.trycloudflare.com`)); return candidate; },
    fetchHealth: async () => spawnCount === 1 && ++healthCount > 1 ? new Response('', { status: 530 }) : Response.json({ ok: true })
  }); t.after(stop);
  await twice; assert.equal(spawnCount, 2); assert.equal(dashboard.currentOrigin(), 'https://attempt-2.trycloudflare.com');
});
test('een vastgelopen tunnel zonder URL wordt begrensd en opnieuw gestart', async t => {
  const f = dashboardFixture(); t.after(f.close); let count = 0, ready;
  const connected = new Promise(resolve => ready = resolve);
  const dashboard = new Dashboard({ ...f, locks: new Locks() });
  const stop = await startTranscriptViewer({ ...f.base, transcriptPort: 0 }, f.contexts, ready, dashboard, {
    startupTimeoutMs: 15, retryDelayMs: 5,
    spawnTunnel: () => { const candidate = tunnel(); if (++count === 2) setImmediate(() => candidate.stderr.write('https://fresh-legion.trycloudflare.com')); return candidate; },
    fetchHealth: async () => Response.json({ ok: true })
  }); t.after(stop);
  await connected; assert.equal(count, 2);
});
