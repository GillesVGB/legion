import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, IntentsBitField, GatewayIntentBits, PermissionFlagsBits as P } from 'discord.js';
import { Store } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { caseChannelName } from '../src/channel-names.mjs';
import { reconcileCases, cleanupInterviews } from '../src/service.mjs';
import { encryptTranscript, publishTranscriptView } from '../src/viewer.mjs';
import { createTranscriptServer, neutralTunnelURL } from '../src/viewer-server.mjs';
import { archiveTranscript } from '../src/transcripts.mjs';
import { removeClosedCase } from '../src/service.mjs';
const base = loadConfig({}, false), config = { ...base, ...base.guilds[1] };

function exportFixture(t) {
  const local = { ...config, transcriptViewerMode: 'local', transcriptSiteURL: '' };
  const store = new Store(local, ':memory:'); t.after(() => store.close());
  const dossier = store.reserveCase('ticket', 'member', {});
  store.bindCase(dossier.id, 'source'); store.openCase(dossier.id, 'intro'); store.closeCase(dossier.id, 'closed', 'staff');
  const guild = { id: local.guildId, name: 'Legion', members: { me: { id: 'bot' } } };
  const source = { id: 'source', name: 'vraag-voorbeeld', isTextBased: () => true, messages: { fetch: async () => new Collection() } };
  let sent = 0;
  const destination = { id: local.ticketTranscriptChannelId, guildId: local.guildId, guild, isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(P.AttachFiles), messages: { fetch: async () => new Collection() },
    send: async () => ({ id: String(++sent) }) };
  guild.channels = { fetch: async () => source };
  const client = { user: { id: 'bot' }, options: { intents: new IntentsBitField(GatewayIntentBits.MessageContent) },
    channels: { fetch: async () => destination }, guilds: { cache: new Map([[local.guildId, guild]]) } };
  return { ctx: { config: local, store }, dossier, client, guild, sent: () => sent };
}

test('bij een tunnelstoring wordt het hele transcript eerst lokaal bewaard', async t => {
  const f = exportFixture(t);
  assert.equal(await archiveTranscript(f.ctx, f.client, f.dossier.id, async () => {}), false);
  assert.equal(f.ctx.store.transcript(f.dossier.id).chunks.length, 2);
  assert.ok(f.ctx.store.transcriptView(f.dossier.id));
  assert.equal(f.sent(), 0);
  f.guild.channels.fetch = async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); };
  f.ctx.config.transcriptSiteURL = 'https://recovered.trycloudflare.com';
  assert.equal(await archiveTranscript(f.ctx, f.client, f.dossier.id, async () => {}), true);
  assert.equal(f.sent(), 2); assert.equal(f.ctx.store.transcript(f.dossier.id).state, 'done');
});

test('een vóór de export verwijderd kanaal levert geen verzonnen transcript of eindeloze herhaalpogingen', async t => {
  const f = exportFixture(t);
  f.ctx.config.transcriptSiteURL = 'https://recovered.trycloudflare.com';
  f.guild.channels.fetch = async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); };
  assert.equal(await archiveTranscript(f.ctx, f.client, f.dossier.id, async () => {}), false);
  assert.equal(f.ctx.store.transcript(f.dossier.id).state, 'unavailable');
  assert.equal(f.ctx.store.pendingTranscripts(Date.now() + 120000).length, 0);
  assert.equal(f.sent(), 0);
  assert.equal(await removeClosedCase(f.ctx, f.client, f.ctx.store.caseById(f.dossier.id)), true);
  assert.equal(f.ctx.store.pendingCaseCleanup(Date.now() + 120000).length, 0);
});

test('kanaalnamen bevatten de gebruikersnaam en blijven geldige korte namen', () => {
  assert.equal(caseChannelName('application', { username: 'Jean_Dupont' }), 'sollicitatie-jean-dupont');
  assert.equal(caseChannelName('ticket', { username: 'Émile...RP' }), 'vraag-emile-rp');
  assert.equal(caseChannelName('interview', { username: 'Thomas' }), 'gesprek-thomas');
  assert.equal(caseChannelName('ticket', { username: '🦞' }), 'vraag-gebruiker');
  assert.ok(caseChannelName('application', { username: 'a'.repeat(150) }).length <= 100);
});

test('bestaande open tickets worden hernoemd, andere kanalen blijven ongemoeid', async t => {
  const store = new Store(config, ':memory:'); t.after(() => store.close());
  const channels = new Collection(), renamed = [];
  for (const [owner, kind, own] of [['one', 'application', true], ['two', 'ticket', true], ['three', 'ticket', false]]) {
    const dossier = store.reserveCase(kind, owner, { template: true });
    store.bindCase(dossier.id, owner); store.openCase(dossier.id, 'intro');
    channels.set(owner, { id: owner, guildId: config.guildId, type: 0, name: 'oud-ticket', topic: own ? `Legion dossier:${dossier.id} | ${kind}` : '',
      messages: { fetch: async () => null }, setName: async name => renamed.push(name) });
  }
  const guild = { id: config.guildId, channels: { fetch: async () => channels }, members: { me: { id: 'bot' }, fetch: async id => ({ user: { username: id } }) } };
  await reconcileCases({ config, store }, guild);
  assert.deepEqual(renamed, ['sollicitatie-one', 'vraag-two']);
});

test('viewer serveert alleen versleutelde dossiers en openbare assets, geen sleutel of bestanden', async t => {
  const store = new Store(config, ':memory:'); t.after(() => store.close());
  const clear = '<!doctype html><p>Vertrouwelijke fixture</p>';
  const record = store.saveTranscriptView('fixture', encryptTranscript(clear));
  const server = await createTranscriptServer(new Map([['guild', { store }]]));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/transcripts/${record.view_id}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['data', 'iv', 'version']);
  assert.ok(!body.includes(record.secret_key) && !body.includes('Vertrouwelijke'));
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const path of ['/.env', '/data/legion.sqlite', '/api/transcripts', '/api/transcripts/' + 'f'.repeat(32), '/t/invalid', '/%2e%2e/.env']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`${origin}/api/transcripts/${record.view_id}`, { method: 'PUT', body: '{}' })).status, 405);
  assert.equal((await fetch(`${origin}/`, { method: 'HEAD' })).status, 200);
  const page = await (await fetch(`${origin}/t/${record.view_id}`)).text();
  assert.ok(page.includes('LEGION') && !page.includes(record.secret_key));
  assert.ok(!page.includes('allow-scripts'));
});

test('gesprekken met een gebruikersnaam worden na afhandelen ook verwijderd', async t => {
  const store = new Store(config, ':memory:'); t.after(() => store.close());
  const dossier = store.reserveCase('application', 'member', { template: true });
  store.bindCase(dossier.id, 'text'); store.openCase(dossier.id, 'intro'); store.bindInterview(dossier.id, 'voice', 'staff');
  store.closeCase(dossier.id, 'closed', 'staff');
  let deleted = false;
  const channel = { guildId: config.guildId, type: 2, name: 'gesprek-voorbeeldlid', parentId: config.applicationCategoryId,
    permissionOverwrites: { cache: new Map([['member', {}], ['bot', {}]]) }, delete: async () => { deleted = true; } };
  await cleanupInterviews({ config, store }, { id: config.guildId, members: { me: { id: 'bot' } }, channels: { fetch: async () => channel } });
  assert.equal(deleted, true); assert.equal(store.interview(dossier.id), undefined);
});

test('een tunnelwissel werkt bestaande knoppen bij met dezelfde exports en sleutels', async t => {
  const store = new Store({ ...config, transcriptViewerMode: 'local', transcriptSiteURL: 'https://previous.trycloudflare.com' }, ':memory:'); t.after(() => store.close());
  const dossier = store.reserveCase('ticket', 'member', {});
  store.bindCase(dossier.id, 'source'); store.openCase(dossier.id, 'intro'); store.closeCase(dossier.id, 'closed', 'staff');
  store.prepareTranscript(dossier.id, [{ name: 'transcript.html', content: 'fixture' }]);
  store.transcriptPart(dossier.id, 'message'); store.finishTranscript(dossier.id);
  const view = store.saveTranscriptView(dossier.id, encryptTranscript('fixture'));
  store.queueTranscriptLinks();
  assert.equal(store.transcript(dossier.id).state, 'ready');
  assert.deepEqual(store.transcript(dossier.id).message_ids, ['message']);
  const origin = neutralTunnelURL('INF Your tunnel: https://quiet-legion-bridge.trycloudflare.com |');
  assert.equal(origin, 'https://quiet-legion-bridge.trycloudflare.com');
  assert.equal(neutralTunnelURL('https://trycloudflare.com.example.invalid'), null);
  let uploaded = false;
  const url = await publishTranscriptView({ transcriptViewerMode: 'local', transcriptSiteURL: origin }, view, () => { uploaded = true; });
  assert.equal(uploaded, false);
  assert.equal(new URL(url).origin, origin);
  assert.equal(new URL(url).hash, `#k=${view.secret_key}`);
  store.config.transcriptSiteURL = origin;
  store.finishTranscript(dossier.id, 'https://previous.trycloudflare.com');
  assert.equal(store.transcript(dossier.id).state, 'ready');
  store.finishTranscript(dossier.id, origin);
  assert.equal(store.transcript(dossier.id).state, 'done');
});
